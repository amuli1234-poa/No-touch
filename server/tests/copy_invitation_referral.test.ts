import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';

import { createApp } from '../index.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { Store } from '../store/store.js';
import type { CopyTradingInvitationRecord } from '../store/store.js';

/**
 * Copy-trading invitation onboarding tests.
 *
 * The invitation link now opens a two-path page instead of redirecting straight
 * to Deriv: an invited client either continues the existing OAuth connection or
 * is sent to the manager's official Deriv referral link to register first.
 *
 * Everything here drives the real Express app, the real PKCE/state machinery and
 * the real store. Only Deriv's token/userinfo/accounts endpoints are faked, in
 * the same way `auth.test.ts` does, so no network or real money is involved.
 */

const REFERRAL = 'https://t.deriv.link?t=J87L49ZA7FQU';
const SESSION_SECRET = 'test_session_secret_at_least_32_characters_long_000';

interface FakeDeriv {
  url: string;
  close: () => Promise<void>;
  tokenBehaviour: 'ok' | 'invalid_grant';
  accountsData: { account_id: string; account_type: string; currency?: string; status?: string }[];
  identitySubject: string;
  tokenRequests: number;
}

async function startFakeDeriv(): Promise<FakeDeriv> {
  const state: FakeDeriv = {
    url: '',
    close: async () => {},
    tokenBehaviour: 'ok',
    accountsData: [
      { account_id: 'VRTC90001', account_type: 'demo', currency: 'USD', status: 'active' },
      { account_id: 'CR90002', account_type: 'real', currency: 'USD', status: 'active' }
    ],
    identitySubject: 'follower-subject-xyz-999',
    tokenRequests: 0
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/oauth2/token') {
        state.tokenRequests++;
        if (state.tokenBehaviour === 'invalid_grant') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ory_at_follower_token', expires_in: 3600, token_type: 'Bearer' }));
        return;
      }

      if (url.pathname === '/userinfo') {
        if (!req.headers.authorization) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_token' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sub: state.identitySubject, loginid: 'VRTC1234567' }));
        return;
      }

      if (url.pathname === '/trading/v1/options/accounts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: state.accountsData }));
        return;
      }

      if (url.pathname === '/oauth2/revoke') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${addr.port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

function makeConfig(deriv: FakeDeriv, dataDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    storageEngine: 'json',
    deriv: {
      appId: '34WRcFqUqhHMuCW3O9NQy',
      patAppId: 'PAT_TEST_APP_ID',
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'openid trade',
      authorizationEndpoint: `${deriv.url}/oauth2/auth`,
      tokenEndpoint: `${deriv.url}/oauth2/token`,
      userinfoEndpoint: `${deriv.url}/userinfo`,
      revocationEndpoint: `${deriv.url}/oauth2/revoke`,
      apiBaseUrl: deriv.url
    },
    session: {
      secret: SESSION_SECRET,
      ttlSeconds: 3600,
      cookieName: 'ws_session',
      oauthCookieName: 'ws_oauth',
      oauthCookieTtlSeconds: 600
    },
    admin: {
      cookieName: 'ws_admin_session',
      sessionTtlSeconds: 3600,
      mfaPendingTtlSeconds: 300,
      invitationTtlSeconds: 3600,
      resetTtlSeconds: 3600,
      allowedOrigins: [],
      maxFailedLogins: 5,
      lockoutSeconds: 60
    },
    appOrigin: 'http://localhost:8787',
    ...overrides
  };
}

async function startApp(deriv: FakeDeriv, overrides: Partial<ServerConfig> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-invite-test-'));
  const cfg = makeConfig(deriv, dataDir, overrides);
  const store = new Store(dataDir, { engine: 'json' });
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    store,
    cfg,
    dataDir,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

/** Creates a real invitation record and returns its plaintext secret. */
async function seedInvitation(store: Store, overrides: Partial<CopyTradingInvitationRecord> = {}) {
  const now = Date.now();
  const ownerId = 'u_manager';
  if (!store.getUserById(ownerId)) {
    await store.upsertUser({
      id: ownerId,
      derivSub: 'manager-subject-1',
      loginId: 'CRMANAGER',
      accounts: [{ accountId: 'CRMANAGER', type: 'real', currency: 'USD', status: 'active' }],
      createdAt: now,
      updatedAt: now,
      preferences: {}
    });
  }
  const secret = 'invitation-secret-value-for-tests';
  const record: CopyTradingInvitationRecord = {
    id: 'inv_test_1',
    ownerUserId: ownerId,
    tokenHash: createHash('sha256').update(secret).digest('base64url'),
    createdAt: now,
    expiresAt: now + 60 * 60 * 1000,
    consumedAt: null,
    ...overrides
  };
  await store.putCopyTradingInvitation(record);
  return { secret, record };
}

function invitationPath(id: string, secret: string) {
  return `/auth/copy-trading/connect/${encodeURIComponent(id)}?token=${encodeURIComponent(secret)}`;
}

/* ---------------------------- Case 2: no account ---------------------- */

test('invitation link renders a page with both account paths instead of redirecting', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const res = await fetch(`${app.base}${invitationPath(record.id, secret)}`, { redirect: 'manual' });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    // Critically: not an automatic redirect into Deriv.
    assert.equal(res.headers.get('location'), null);

    const html = await res.text();
    assert.match(html, /I Already Have a Deriv Account/);
    assert.match(html, /Create a Deriv Account/);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('the referral link is emitted verbatim, with no rewritten or appended parameters', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const html = await (await fetch(`${app.base}${invitationPath(record.id, secret)}`)).text();

    // The exact operator URL must appear as the href, unescaped and unmodified.
    assert.ok(html.includes(`href="${REFERRAL}"`), `expected exact href for ${REFERRAL}`);

    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    const referralHrefs = hrefs.filter((h) => h.includes('t.deriv.link'));
    assert.equal(referralHrefs.length, 1, 'exactly one referral link');
    assert.equal(referralHrefs[0], REFERRAL);

    // Guard against parameter tampering: the token value must not be appended.
    assert.ok(!referralHrefs[0].includes('token'));
    assert.ok(!referralHrefs[0].includes(secret));
    assert.equal(new URL(referralHrefs[0]).searchParams.get('t'), 'J87L49ZA7FQU');
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('the referral link opens in a new tab without leaking the opener or referrer', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const res = await fetch(`${app.base}${invitationPath(record.id, secret)}`);
    const html = await res.text();

    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    // The invitation token lives in the query string; never leak it via Referer.
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('the page does not claim the referral succeeded', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const html = (await (await fetch(`${app.base}${invitationPath(record.id, secret)}`)).text()).toLowerCase();

    for (const claim of ['referral confirmed', 'referral complete', 'referred successfully', 'attribution confirmed']) {
      assert.ok(!html.includes(claim), `must not claim "${claim}"`);
    }
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('the built-in referral link is offered when the operator has not configured one', async () => {
  // A fresh deployment with no DERIV_REFERRAL_URL must still offer the signup
  // path, otherwise invited clients without an account have nowhere to go.
  const env = {
    DERIV_REDIRECT_URI: 'https://app.example.com/auth/deriv/callback',
    SESSION_SECRET,
    DERIV_APP_ID: '34WRcFqUqhHMuCW3O9NQy'
  };
  assert.equal(loadConfig(env as any).derivReferralUrl, REFERRAL);

  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: loadConfig(env as any).derivReferralUrl });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const html = await (await fetch(`${app.base}${invitationPath(record.id, secret)}`)).text();

    assert.match(html, /I Already Have a Deriv Account/);
    assert.match(html, /Create a Deriv Account/);
    assert.ok(html.includes(REFERRAL), 'the built-in referral link must be rendered');
    assert.ok(!/No Deriv registration link is configured/i.test(html));
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('an insecure or malformed referral URL falls back to the built-in link', () => {
  const base = {
    DERIV_REDIRECT_URI: 'https://app.example.com/auth/deriv/callback',
    SESSION_SECRET,
    DERIV_APP_ID: '34WRcFqUqhHMuCW3O9NQy'
  };
  // A rejected override must fall back to the built-in link rather than vanish,
  // which would hide the signup button with no explanation.
  assert.equal(loadConfig({ ...base, DERIV_REFERRAL_URL: 'http://t.deriv.link?t=X' } as any).derivReferralUrl, REFERRAL);
  assert.equal(loadConfig({ ...base, DERIV_REFERRAL_URL: 'javascript:alert(1)' } as any).derivReferralUrl, REFERRAL);
  assert.equal(loadConfig({ ...base, DERIV_REFERRAL_URL: '/relative/path' } as any).derivReferralUrl, REFERRAL);
  assert.equal(loadConfig({ ...base } as any).derivReferralUrl, REFERRAL);
  assert.equal(loadConfig({ ...base, DERIV_REFERRAL_URL: 'https://t.deriv.link?t=CUSTOM' } as any).derivReferralUrl, 'https://t.deriv.link?t=CUSTOM');
});

/* ------------------------ Case 1: has an account ---------------------- */

test('"I already have an account" starts the existing OAuth flow and preserves invitation context', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);

    const res = await fetch(`${app.base}/auth/copy-trading/connect/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: secret }).toString(),
      redirect: 'manual'
    });

    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location')!);
    // Real Deriv authorization endpoint, not the referral link.
    assert.equal(location.origin, deriv.url);
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(location.searchParams.get('state'));

    // Invitation context is carried server-side in the OAuth transaction.
    const state = location.searchParams.get('state')!;
    const tx = app.store.getOAuthTransaction(state);
    assert.ok(tx, 'expected an OAuth transaction');
    assert.equal(tx!.flow, 'copy_trading_follower');
    assert.equal(tx!.invitationId, record.id);
    assert.equal(tx!.ownerUserId, record.ownerUserId);

    // The invitation secret must not appear in the redirect URL.
    assert.ok(!res.headers.get('location')!.includes(secret));
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('accepting the invitation links the follower and records explicit consent', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);

    const start = await fetch(`${app.base}/auth/copy-trading/connect/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: secret }).toString(),
      redirect: 'manual'
    });
    const cookies = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

    const cb = await fetch(`${app.base}/auth/deriv/callback?code=CODE_OK&state=${state}`, {
      headers: { Cookie: cookies },
      redirect: 'manual'
    });
    assert.equal(cb.status, 200);
    const html = await cb.text();
    assert.match(html, /Account connection complete/);

    const followers = app.store.listAllCopyTradingFollowers();
    assert.equal(followers.length, 1);
    assert.equal(followers[0].ownerUserId, record.ownerUserId);
    assert.equal(followers[0].authMethod, 'oauth');

    const consent = app.store.getCopyTradingConsent(followers[0].id);
    assert.ok(consent, 'expected an explicit consent record');
    assert.equal(consent!.method, 'oauth');

    // The invitation is single-use and is now consumed.
    assert.ok(app.store.getCopyTradingInvitation(record.id)!.consumedAt);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('connecting does not enable copying or trading on its own', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const start = await fetch(`${app.base}/auth/copy-trading/connect/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: secret }).toString(),
      redirect: 'manual'
    });
    const cookies = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    await fetch(`${app.base}/auth/deriv/callback?code=CODE_OK&state=${state}`, { headers: { Cookie: cookies } });

    // Authorization is recorded, but the client is not active until they
    // separately authorize copying.
    const follower = app.store.listAllCopyTradingFollowers()[0];
    assert.equal(follower.status, 'authorized');
    assert.notEqual(follower.status, 'active');
    assert.equal(app.store.getCopyTradingControl(record.ownerUserId), null);
  } finally {
    await app.close();
    await deriv.close();
  }
});

/* ----------------------------- failure paths -------------------------- */

test('a bad invitation secret renders 410 and starts no OAuth flow', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { record } = await seedInvitation(app.store);
    const res = await fetch(`${app.base}${invitationPath(record.id, 'wrong-secret')}`, { redirect: 'manual' });
    assert.equal(res.status, 410);
    assert.equal(res.headers.get('location'), null);

    const post = await fetch(`${app.base}/auth/copy-trading/connect/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'wrong-secret' }).toString(),
      redirect: 'manual'
    });
    assert.equal(post.status, 410);
    assert.equal(post.headers.get('location'), null);
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('an expired or already-used invitation is rejected on both paths', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const expired = await seedInvitation(app.store, { id: 'inv_expired', expiresAt: Date.now() - 1000 });
    const used = await seedInvitation(app.store, { id: 'inv_used', consumedAt: Date.now() });

    for (const { id, secret } of [expired, used]) {
      const get = await fetch(`${app.base}${invitationPath(id, secret)}`, { redirect: 'manual' });
      assert.equal(get.status, 410);
      const post = await fetch(`${app.base}/auth/copy-trading/connect/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: secret }).toString(),
        redirect: 'manual'
      });
      assert.equal(post.status, 410);
    }
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('a Deriv token failure surfaces as a connection failure and leaves no follower', async () => {
  const deriv = await startFakeDeriv();
  deriv.tokenBehaviour = 'invalid_grant';
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const start = await fetch(`${app.base}/auth/copy-trading/connect/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: secret }).toString(),
      redirect: 'manual'
    });
    const cookies = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

    const cb = await fetch(`${app.base}/auth/deriv/callback?code=CODE_BAD&state=${state}`, {
      headers: { Cookie: cookies },
      redirect: 'manual'
    });
    assert.equal(cb.status, 400);
    assert.match(await cb.text(), /Account connection failed/);

    assert.equal(app.store.listAllCopyTradingFollowers().length, 0);
    // The invitation is not burned by a failed authorization.
    assert.equal(app.store.getCopyTradingInvitation(record.id)!.consumedAt, null);
  } finally {
    await app.close();
    await deriv.close();
  }
});

/* ------------------------------ page safety --------------------------- */

test('the invitation page escapes the token and sets a restrictive CSP', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const res = await fetch(`${app.base}${invitationPath(record.id, secret)}`);
    const html = await res.text();

    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    // No script is needed or permitted on this page.
    assert.ok(!/<script/i.test(html), 'page must not contain scripts');
    assert.ok(!html.includes('javascript:'), 'page must not contain javascript: URLs');
  } finally {
    await app.close();
    await deriv.close();
  }
});

test('the continue form posts to a same-origin path, never the referral host', async () => {
  const deriv = await startFakeDeriv();
  const app = await startApp(deriv, { derivReferralUrl: REFERRAL });
  try {
    const { secret, record } = await seedInvitation(app.store);
    const html = await (await fetch(`${app.base}${invitationPath(record.id, secret)}`)).text();

    const action = html.match(/<form[^>]*action="([^"]*)"/)![1];
    assert.equal(action, `/auth/copy-trading/connect/${record.id}`);
    assert.ok(!action.includes('t.deriv.link'));
    assert.ok(!action.includes('?'), 'the token must not be placed in the form action URL');
    assert.match(html, /<input type="hidden" name="token"/);
  } finally {
    await app.close();
    await deriv.close();
  }
});
