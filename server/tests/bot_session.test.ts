import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { createApp } from '../index.js';
import type { ServerConfig } from '../config.js';
import { Store } from '../store/store.js';
import type { SessionRecord, UserRecord } from '../store/store.js';
import { seal, sign } from '../lib/crypto.js';

const ACCESS_TOKEN = 'server_only_test_deriv_access_token';
const SOCKET_URL = 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=single-use-test';

function makeConfig(dataDir: string): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    storageEngine: 'json',
    deriv: {
      appId: 'test-app',
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'trade',
      authorizationEndpoint: 'http://127.0.0.1:1/oauth2/auth',
      tokenEndpoint: 'http://127.0.0.1:1/oauth2/token',
      userinfoEndpoint: 'http://127.0.0.1:1/userinfo',
      revocationEndpoint: 'http://127.0.0.1:1/oauth2/revoke',
      apiBaseUrl: 'http://deriv.test'
    },
    session: {
      secret: 'test_session_secret_at_least_32_characters_long_000',
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
    telemetry: { retentionDays: 90, scannerSessionTtlSeconds: 3600 },
    appOrigin: 'http://localhost:3000'
  };
}

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bot-session-test-'));
  const cfg = makeConfig(dataDir);
  const store = new Store(dataDir, { engine: cfg.storageEngine });
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    cfg,
    store,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

async function seedSession(
  store: Store,
  cfg: ServerConfig,
  accounts: UserRecord['accounts'],
  options: { tokenExpired?: boolean } = {}
): Promise<string> {
  const now = Date.now();
  const user: UserRecord = {
    id: 'user-1',
    derivSub: 'deriv-sub-1',
    loginId: 'CR123456',
    accounts,
    createdAt: now,
    updatedAt: now,
    preferences: {}
  };
  await store.upsertUser(user);
  const session: SessionRecord = {
    id: 'session-1',
    userId: user.id,
    createdAt: now,
    expiresAt: now + 3600_000,
    lastSeenAt: now,
    revoked: false,
    derivTokenSealed: seal(ACCESS_TOKEN, cfg.session.secret),
    derivTokenExpiresAt: options.tokenExpired ? now - 1 : now + 3600_000,
    derivSub: user.derivSub
  };
  await store.createSession(session);
  return sign(session.id, cfg.session.secret);
}

function stubDeriv(fetcher: typeof fetch, tracker: { calls: Array<{ url: string; authorization: string | null }> }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('http://deriv.test/')) return original(input, init);
    tracker.calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    return fetcher(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function postSession(
  base: string,
  cookie: string | null,
  body: unknown = {},
  origin = 'http://localhost:3000',
  extraHeaders: Record<string, string> = {}
) {
  return fetch(`${base}/api/bot/session`, {
    method: 'POST',
    headers: {
      ...(cookie ? { Cookie: `ws_session=${cookie}` } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...extraHeaders,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

test('Deriv Bot session requires WickSentinel authentication and same origin', async () => {
  const app = await startApp();
  try {
    assert.equal((await postSession(app.base, null)).status, 401);
    const cookie = await seedSession(app.store, app.cfg, [{ accountId: 'VRTC100', type: 'demo' }]);
    const crossOrigin = await postSession(app.base, cookie, {}, 'https://other.example');
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error, 'same_origin_required');
  } finally {
    await app.close();
  }
});

test('Deriv Bot session accepts the deployment host behind a proxy', async () => {
  const app = await startApp();
  try {
    const cookie = await seedSession(app.store, app.cfg, [{ accountId: 'VRTC100', type: 'demo' }]);
    // A proxy rewrites Host to the upstream address, so the browser's host only
    // survives in X-Forwarded-Host. Rejecting that would leave the bot unable to
    // adopt the session on any host that is not the configured OAuth origin.
    const proxied = await postSession(
      app.base,
      cookie,
      {},
      'https://preview.example',
      { 'X-Forwarded-Host': 'preview.example' }
    );
    assert.notEqual(proxied.status, 403);
  } finally {
    await app.close();
  }
});

test('Deriv Bot handoff uses the server token and only returns the selected user account', async () => {
  const app = await startApp();
  const tracker = { calls: [] as Array<{ url: string; authorization: string | null }> };
  const restoreFetch = stubDeriv(
    async () =>
      new Response(JSON.stringify({ data: { url: SOCKET_URL } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }),
    tracker
  );
  try {
    const cookie = await seedSession(app.store, app.cfg, [
      { accountId: 'CR90002', type: 'real', currency: 'USD' },
      { accountId: 'VRTC90001', type: 'demo', currency: 'USD' }
    ]);
    const response = await postSession(app.base, cookie);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.account.account_id, 'VRTC90001', 'default is demo when available');
    assert.deepEqual(body.accounts.map((account: any) => account.account_id), ['CR90002', 'VRTC90001']);
    assert.equal(body.websocket_url, SOCKET_URL);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(tracker.calls.length, 1);
    assert.equal(tracker.calls[0].authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.ok(tracker.calls[0].url.endsWith('/accounts/VRTC90001/otp'));
    assert.ok(!JSON.stringify(body).includes(ACCESS_TOKEN), 'long-lived access token must not reach the browser');
  } finally {
    restoreFetch();
    await app.close();
  }
});

test('Deriv Bot handoff rejects foreign accounts and expired Deriv authorization', async () => {
  const app = await startApp();
  const tracker = { calls: [] as Array<{ url: string; authorization: string | null }> };
  const restoreFetch = stubDeriv(
    async () => new Response(JSON.stringify({ data: { url: SOCKET_URL } }), { status: 200 }),
    tracker
  );
  try {
    const cookie = await seedSession(app.store, app.cfg, [{ accountId: 'VRTC100', type: 'demo' }]);
    const foreignAccount = await postSession(app.base, cookie, { accountId: 'CR_FOREIGN' });
    assert.equal(foreignAccount.status, 403);
    assert.equal((await foreignAccount.json()).error, 'account_not_authorized');
    assert.equal(tracker.calls.length, 0);

    const expiredCookie = await seedSession(app.store, app.cfg, [{ accountId: 'VRTC200', type: 'demo' }], {
      tokenExpired: true
    });
    const expired = await postSession(app.base, expiredCookie);
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error, 'deriv_authorization_expired');
    assert.equal(tracker.calls.length, 0);
  } finally {
    restoreFetch();
    await app.close();
  }
});
