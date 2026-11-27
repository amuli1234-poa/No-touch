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
import { hashPassword } from '../admin/passwords.js';
import { generateTotpSecret, currentTotp } from '../admin/totp.js';
import { seal } from '../lib/crypto.js';
import type { AdminUserRecord } from '../admin/types.js';

/**
 * Administrative Copy Trading client management.
 *
 * Runs against the real Express app and the real store, with a fake Deriv that
 * answers the accounts and userinfo endpoints. The point of most of these tests
 * is what must NOT happen: no token in a response, no token in an audit record,
 * no duplicate follower, no assignment without consent, no privileged action by
 * a read-only administrator.
 */

const SECRET = 'test_session_secret_at_least_32_characters_long_000';
const PAT = 'pat_client_token_123456789';

interface FakeDeriv {
  url: string;
  close: () => Promise<void>;
  accounts: { account_id: string; account_type: string; currency: string; status: string }[];
  accountsStatus: number;
  identitySubject: string;
  lastAppId: string | null;
  revokeCount: number;
}

async function startFakeDeriv(): Promise<FakeDeriv> {
  const state: FakeDeriv = {
    url: '',
    close: async () => {},
    accounts: [{ account_id: 'VRTC_CLIENT_9', account_type: 'demo', currency: 'USD', status: 'active' }],
    accountsStatus: 200,
    identitySubject: 'deriv-client-subject-456',
    lastAppId: null,
    revokeCount: 0
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/trading/v1/options/accounts') {
      state.lastAppId = typeof req.headers['deriv-app-id'] === 'string' ? req.headers['deriv-app-id'] : null;
      if (state.accountsStatus !== 200) {
        res.writeHead(state.accountsStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ code: state.accountsStatus === 401 ? 'Unauthorized' : 'AccessDenied' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: state.accounts }));
      return;
    }

    if (url.pathname === '/userinfo') {
      if (!req.headers.authorization) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sub: state.identitySubject, loginid: 'CR1234567' }));
      return;
    }

    if (url.pathname === '/oauth2/revoke') {
      state.revokeCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${addr.port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

function makeConfig(dataDir: string, derivUrl: string, patAppId: string | null = 'PAT_APP_ID'): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    storageEngine: (process.env.TEST_STORAGE_ENGINE as ServerConfig['storageEngine']) ?? 'auto',
    deriv: {
      appId: '34WRcFqUqhHMuCW3O9NQy',
      patAppId,
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'trade',
      authorizationEndpoint: `${derivUrl}/oauth2/auth`,
      tokenEndpoint: `${derivUrl}/oauth2/token`,
      userinfoEndpoint: `${derivUrl}/userinfo`,
      revocationEndpoint: `${derivUrl}/oauth2/revoke`,
      apiBaseUrl: derivUrl
    },
    session: {
      secret: SECRET,
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
    appOrigin: 'http://localhost:8787'
  };
}

class Client {
  private cookies = new Map<string, string>();
  csrfToken: string | null = null;
  constructor(private base: string) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private capture(res: Response): void {
    const raw = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : null;
    if (!raw) return;
    for (const c of raw) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method: string, url: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cookies.size) headers['Cookie'] = this.cookieHeader();
    if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${this.base}${url}`, { method, headers, body: payload });
    this.capture(res);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, text };
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, body?: unknown) {
    return this.request('POST', url, body);
  }
  del(url: string) {
    return this.request('DELETE', url);
  }
}

async function startApp(cfg: ServerConfig) {
  const store = new Store(cfg.dataDir, { engine: cfg.storageEngine });
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  return { store, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function seedAdmin(store: Store, email: string, role: AdminUserRecord['role']): Promise<string> {
  const secret = generateTotpSecret();
  await store.upsertAdmin({
    id: `adm_${email}`,
    email,
    displayName: email.split('@')[0],
    passwordHash: await hashPassword('Str0ng-Passw0rd!'),
    role,
    extraPermissions: [],
    status: 'active',
    mfa: {
      enrolled: true,
      secretSealed: seal(secret, SECRET),
      enrolledAt: Date.now(),
      recoveryCodeHashes: []
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastLoginAt: null,
    createdBy: null
  });
  return secret;
}

async function login(base: string, email: string, secret: string): Promise<Client> {
  const c = new Client(base);
  const step1 = await c.post('/api/admin/v1/auth/login', { email, password: 'Str0ng-Passw0rd!' });
  assert.equal(step1.status, 200, `login failed: ${JSON.stringify(step1.json)}`);
  const step2 = await c.post('/api/admin/v1/auth/mfa/verify', { code: currentTotp(secret) });
  assert.equal(step2.status, 200, `mfa failed: ${JSON.stringify(step2.json)}`);
  c.csrfToken = step2.json.csrfToken;
  return c;
}

async function seedTrader(store: Store, opts: { id: string; derivSub: string; suspended?: boolean }) {
  await store.upsertUser({
    id: opts.id,
    derivSub: opts.derivSub,
    loginId: `CR${opts.id}`,
    accounts: [{ accountId: `VRTC${opts.id}`, type: 'demo', currency: 'USD' }],
    createdAt: Date.now() - 5000,
    updatedAt: Date.now(),
    suspended: opts.suspended ?? false,
    preferences: {}
  });
}

async function withApp(
  fn: (ctx: { app: Awaited<ReturnType<typeof startApp>>; deriv: FakeDeriv; admin: Client }) => Promise<void>,
  opts: { patAppId?: string | null; role?: AdminUserRecord['role'] } = {}
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-copyadmin-'));
  const deriv = await startFakeDeriv();
  const cfg = makeConfig(dataDir, deriv.url, opts.patAppId === undefined ? 'PAT_APP_ID' : opts.patAppId);
  const app = await startApp(cfg);
  try {
    const secret = await seedAdmin(app.store, 'a@x.com', opts.role ?? 'SUPER_ADMIN');
    const admin = await login(app.base, 'a@x.com', secret);
    await fn({ app, deriv, admin });
  } finally {
    await app.close();
    await deriv.close();
  }
}

/* ================================ ONBOARDING ============================= */

test('copy trading: an administrator can invite a genuinely new client', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });

    const res = await admin.post('/api/admin/v1/copy-trading/clients/invitations', {
      email: 'client@example.com',
      name: 'New Client',
      phone: '+15550001',
      masterUserId: 'master1'
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.match(res.json.url, /\/auth\/copy-trading\/connect\//);

    const stored = app.store.listAllCopyTradingInvitations();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].invitedEmail, 'client@example.com');
    // The single-use secret is stored only as a hash.
    assert.notEqual(stored[0].tokenHash, new URL(res.json.url).searchParams.get('token'));
  });
});

test('copy trading: a duplicate active invitation is rejected', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    const body = { email: 'client@example.com', masterUserId: 'master1' };
    const first = await admin.post('/api/admin/v1/copy-trading/clients/invitations', body);
    assert.equal(first.status, 201);
    const second = await admin.post('/api/admin/v1/copy-trading/clients/invitations', body);
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'duplicate_invitation');
  });
});

test('copy trading: an invalid email is rejected', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    const res = await admin.post('/api/admin/v1/copy-trading/clients/invitations', {
      email: 'not-an-email',
      masterUserId: 'master1'
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_email');
  });
});

test('copy trading: an invitation requires an eligible master', async () => {
  await withApp(async ({ app, admin }) => {
    const res = await admin.post('/api/admin/v1/copy-trading/clients/invitations', { email: 'c@example.com' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'master_required');
  });
});

test('copy trading: existing clients can be searched by login id', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'client1', derivSub: 'sub_client1' });
    const res = await admin.get('/api/admin/v1/copy-trading/clients/search?q=CRclient1');
    assert.equal(res.status, 200);
    assert.equal(res.json.items.length, 1);
    assert.equal(res.json.items[0].id, 'client1');
    assert.equal(res.json.items[0].hasFollowerConnection, false);
  });
});

/* ============================== TOKEN AUTHORIZATION ====================== */

test('copy trading: a valid client token connects the account and seals the credential', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    deriv.identitySubject = 'deriv-client-subject-456';

    const res = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master1',
      attestedBy: 'client email 2026-11-12'
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const stored = app.store.listAllCopyTradingFollowers();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].ownerUserId, 'master1');
    assert.equal(stored[0].authMethod, 'pat');
    // Sealed at rest, never the plaintext token.
    assert.notEqual(stored[0].tokenSealed, PAT);
    // Consent recorded separately.
    const consent = app.store.getCopyTradingConsent(stored[0].id);
    assert.ok(consent);
    assert.equal(consent!.method, 'pat');

    // The token must not appear anywhere in the response body.
    assert.equal(res.text.includes(PAT), false, 'the token must never be returned');
  });
});

test('copy trading: the PAT app id is used, not the OAuth app id', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    deriv.identitySubject = 'deriv-client-subject-456';
    await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master1'
    });
    assert.equal(deriv.lastAppId, 'PAT_APP_ID');
  });
});

test('copy trading: an invalid token is rejected and nothing is stored', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    deriv.accountsStatus = 401;

    const res = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master1'
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'invalid_token');
    assert.equal(app.store.listAllCopyTradingFollowers().length, 0);
    assert.equal(res.text.includes(PAT), false);
  });
});

test('copy trading: a token without the trade scope is rejected', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    deriv.accountsStatus = 403;

    const res = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master1'
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'trade_scope_required');
    assert.equal(app.store.listAllCopyTradingFollowers().length, 0);
  });
});

test('copy trading: a token belonging to a different account is refused', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    // Deriv says the token belongs to somebody else.
    deriv.identitySubject = 'a-completely-different-subject';

    const res = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master1'
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'account_ownership_mismatch');
    assert.equal(app.store.listAllCopyTradingFollowers().length, 0, 'no follower before ownership is proven');
  });
});

test('copy trading: authorization without consent is refused', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });

    const res = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      masterUserId: 'master1'
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'consent_required');
    assert.equal(app.store.listAllCopyTradingFollowers().length, 0);
  });
});

test('copy trading: token authorization is unavailable without a PAT app id', async () => {
  await withApp(
    async ({ app, admin }) => {
      await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
      await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
      const res = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
        token: PAT,
        consent: true,
        masterUserId: 'master1'
      });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, 'pat_app_not_configured');
    },
    { patAppId: null }
  );
});

test('copy trading: a duplicate connection is updated, not duplicated', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    deriv.identitySubject = 'deriv-client-subject-456';

    const first = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master1'
    });
    assert.equal(first.status, 201);

    const second = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master1'
    });
    assert.equal(second.status, 200);
    assert.equal(app.store.listAllCopyTradingFollowers().length, 1, 'no duplicate follower record');
  });
});

test('copy trading: a token cannot be attached to another manager', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'master2', derivSub: 'sub_master2' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    deriv.identitySubject = 'deriv-client-subject-456';

    const first = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master1'
    });
    assert.equal(first.status, 201);

    const second = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
      token: PAT,
      consent: true,
      masterUserId: 'master2'
    });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'already_linked');
  });
});

/* ============================== FOLLOWER LIFECYCLE ======================= */

async function connectClient(admin: Client, deriv: FakeDeriv, app: { store: Store }) {
  await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
  await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
  deriv.identitySubject = 'deriv-client-subject-456';
  const res = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
    token: PAT,
    consent: true,
    masterUserId: 'master1'
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.client.id as string;
}

test('copy trading: a follower can be paused, resumed and removed', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    const id = await connectClient(admin, deriv, app);

    const paused = await admin.post(`/api/admin/v1/copy-trading/clients/${id}/status`, { status: 'paused' });
    assert.equal(paused.status, 200);
    assert.equal(paused.json.client.status, 'paused');
    // The response must not claim contracts were cancelled.
    assert.match(paused.json.note, /already accepted by the broker are unaffected/);

    const resumed = await admin.post(`/api/admin/v1/copy-trading/clients/${id}/status`, { status: 'active' });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.client.status, 'active');

    const removed = await admin.del(`/api/admin/v1/copy-trading/clients/${id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.removed, true);
    assert.equal(app.store.listAllCopyTradingFollowers().length, 0);
    assert.equal(app.store.getCopyTradingConsent(id), null, 'consent is removed with the connection');
  });
});

test('copy trading: an invalid follower status is rejected', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    const id = await connectClient(admin, deriv, app);
    const res = await admin.post(`/api/admin/v1/copy-trading/clients/${id}/status`, { status: 'banana' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_status');
  });
});

test('copy trading: removing an OAuth follower revokes the grant at Deriv', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    // Seed an OAuth follower directly, as the callback would.
    await app.store.putCopyTradingFollower({
      id: 'f_oauth',
      ownerUserId: 'master1',
      derivSub: 'deriv-client-subject-456',
      authMethod: 'oauth',
      loginId: 'CR1234567',
      accounts: [{ accountId: 'VRTC_CLIENT_9', type: 'demo', currency: 'USD' }],
      tokenSealed: seal('ory_at_client_oauth_token', SECRET),
      tokenExpiresAt: Date.now() + 3600_000,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const res = await admin.del('/api/admin/v1/copy-trading/clients/f_oauth');
    assert.equal(res.status, 200);
    assert.equal(res.json.providerRevoked, true);
    assert.equal(deriv.revokeCount, 1, 'the OAuth grant must be revoked at Deriv');
  });
});

test('copy trading: a PAT follower is not claimed to be revoked', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    const id = await connectClient(admin, deriv, app);
    const res = await admin.del(`/api/admin/v1/copy-trading/clients/${id}`);
    assert.equal(res.json.providerRevoked, false);
    assert.match(res.json.note, /must revoke the token in Deriv settings/);
    assert.equal(deriv.revokeCount, 0);
  });
});

/* ============================== AUTHORIZATION ============================ */

test('copy trading: an unauthenticated caller is blocked', async () => {
  await withApp(async ({ app }) => {
    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/clients`);
    assert.equal(res.status, 401);
  });
});

test('copy trading: a trader session cookie cannot reach the admin endpoints', async () => {
  await withApp(async ({ app }) => {
    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/clients`, {
      headers: { Cookie: `ws_session=forged-trader-session` }
    });
    assert.equal(res.status, 401);
  });
});

test('copy trading: an analyst can read but cannot authorize or manage', async () => {
  await withApp(
    async ({ app, admin }) => {
      // Seed the connection directly: the analyst cannot create one, which is
      // exactly what the rest of this test asserts.
      await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
      await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
      await app.store.putCopyTradingFollower({
        id: 'f_readonly',
        ownerUserId: 'master1',
        derivSub: 'deriv-client-subject-456',
        authMethod: 'pat',
        loginId: 'CR1234567',
        accounts: [{ accountId: 'VRTC_CLIENT_9', type: 'demo', currency: 'USD' }],
        tokenSealed: seal(PAT, SECRET),
        tokenExpiresAt: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      const id = 'f_readonly';

      // Read is allowed.
      const list = await admin.get('/api/admin/v1/copy-trading/clients');
      assert.equal(list.status, 200);

      // Privileged actions are refused.
      const authorize = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
        token: PAT,
        consent: true,
        masterUserId: 'master1'
      });
      assert.equal(authorize.status, 403);
      assert.equal(authorize.json.error, 'forbidden');

      const invite = await admin.post('/api/admin/v1/copy-trading/clients/invitations', {
        email: 'x@example.com',
        masterUserId: 'master1'
      });
      assert.equal(invite.status, 403);

      const status = await admin.post(`/api/admin/v1/copy-trading/clients/${id}/status`, { status: 'paused' });
      assert.equal(status.status, 403);

      const remove = await admin.del(`/api/admin/v1/copy-trading/clients/${id}`);
      assert.equal(remove.status, 403);
    },
    { role: 'ANALYST' }
  );
});

test('copy trading: a support agent cannot authorize a client', async () => {
  await withApp(
    async ({ app, admin }) => {
      await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
      await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
      const res = await admin.post('/api/admin/v1/copy-trading/clients/client1/authorize-token', {
        token: PAT,
        consent: true,
        masterUserId: 'master1'
      });
      assert.equal(res.status, 403);
    },
    { role: 'SUPPORT_AGENT' }
  );
});

test('copy trading: CSRF token is required for state-changing requests', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    admin.csrfToken = null;
    const res = await admin.post('/api/admin/v1/copy-trading/clients/invitations', {
      email: 'c@example.com',
      masterUserId: 'master1'
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'csrf_failed');
  });
});

/* ============================== AUDIT ==================================== */

test('copy trading: actions are audited without any credential', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    const id = await connectClient(admin, deriv, app);
    await admin.post(`/api/admin/v1/copy-trading/clients/${id}/status`, { status: 'paused', reason: 'client request' });

    const logs = app.store.listAudit();
    const actions = logs.map((l) => l.action);
    assert.ok(actions.includes('copytrading.token.authorize'), 'token authorization must be audited');
    assert.ok(actions.includes('copytrading.follower.paused'), 'pause must be audited');

    // No audit record may contain the token, in any field.
    const serialised = JSON.stringify(logs);
    assert.equal(serialised.includes(PAT), false, 'the token must never enter the audit log');
  });
});

test('copy trading: the client listing never exposes a credential', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await connectClient(admin, deriv, app);
    const res = await admin.get('/api/admin/v1/copy-trading/clients');
    assert.equal(res.status, 200);
    assert.equal(res.text.includes(PAT), false);
    assert.equal(res.text.includes('tokenSealed'), false, 'the sealed token must not be serialised');
    // Account ids are masked.
    assert.equal(res.text.includes('VRTC_CLIENT_9'), false);
  });
});

test('copy trading: the dashboard reports real connection counts', async () => {
  await withApp(async ({ app, admin, deriv }) => {
    await connectClient(admin, deriv, app);
    const res = await admin.get('/api/admin/v1/dashboard/summary');
    assert.equal(res.status, 200);
    assert.equal(res.json.copyTrading.clients, 1);
    assert.equal(res.json.copyTrading.tokenConnections, 1);
    assert.equal(res.json.copyTrading.engine.implemented, true, 'the DEMO copy engine is implemented');
    assert.match(res.json.copyTrading.engine.note, /REAL-account copying is not enabled/);
  });
});

/* ============================== BOT BUILDER ============================== */

test('bots: import and run records are readable and demo-only', async () => {
  await withApp(async ({ app, admin }) => {
    const res = await admin.get('/api/admin/v1/bots/summary');
    assert.equal(res.status, 200);
    assert.equal(res.json.safety.accountMode, 'demo');
    assert.equal(res.json.bots.total, 0);
  });
});

test('bots: the imports endpoint never upgrades a compatibility verdict', async () => {
  await withApp(async ({ app, admin }) => {
    await app.store.putImportedBot({
      id: 'bot_1',
      userId: 'client1',
      name: 'Partial Bot',
      sourceFormat: 'deriv-dbot-xml',
      originalFilename: 'partial.xml',
      sourceHash: 'hash1',
      sourceXml: '<xml/>',
      compatibility: 'partial',
      compatibilityReason: 'Unsupported block: contract_check',
      status: 'imported',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bot: { unknownBlocks: [{ type: 'contract_check', count: 1 }] } as any,
      warnings: [{ code: 'unsupported_block', message: 'contract_check is not supported' }],
      executionNote: 'Imported bots are inert.'
    });

    const res = await admin.get('/api/admin/v1/bots/imports');
    assert.equal(res.status, 200);
    assert.equal(res.json.items[0].compatibility, 'partial');
    assert.equal(res.json.items[0].unknownBlocks[0].type, 'contract_check');
  });
});

/* ============================ CONTROL + PERFORMANCE ====================== */

/** Connects a client to a master the way the console does, returning the follower id. */
async function linkClientToMaster(
  ctx: { app: Awaited<ReturnType<typeof startApp>>; admin: Client },
  clientId: string,
  masterId: string
): Promise<string> {
  const res = await ctx.admin.post(`/api/admin/v1/copy-trading/clients/${clientId}/authorize-token`, {
    token: PAT,
    consent: true,
    masterUserId: masterId
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.client.id as string;
}

test('copy control: a master with no clients cannot be started', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    const res = await admin.post('/api/admin/v1/copy-trading/control', { masterUserId: 'master1', enabled: true });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'no_followers');
  });
});

test('copy control: starting and stopping is persisted and audited', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    await linkClientToMaster({ app, admin }, 'client1', 'master1');

    // Off by default: copying is opt-in.
    const initial = await admin.get('/api/admin/v1/copy-trading/control?masterUserId=master1');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.control.enabled, false);
    assert.equal(initial.json.control.followers.total, 1);

    const started = await admin.post('/api/admin/v1/copy-trading/control', {
      masterUserId: 'master1',
      enabled: true
    });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.equal(started.json.control.enabled, true);
    assert.equal(app.store.getCopyTradingControl('master1')?.enabled, true);
    assert.equal(app.store.getCopyTradingControl('master1')?.updatedByEmail, 'a@x.com');

    const stopped = await admin.post('/api/admin/v1/copy-trading/control', {
      masterUserId: 'master1',
      enabled: false,
      reason: 'client requested a pause'
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.control.enabled, false);
    assert.equal(stopped.json.control.stoppedReason, 'client requested a pause');

    const actions = app.store.listAudit().map((a: any) => a.action);
    assert.ok(actions.includes('copytrading.control.started'), actions.join(','));
    assert.ok(actions.includes('copytrading.control.stopped'), actions.join(','));
  });
});

test('copy control: an unknown master is rejected', async () => {
  await withApp(async ({ app: _app, admin }) => {
    const res = await admin.post('/api/admin/v1/copy-trading/control', { masterUserId: 'nope', enabled: true });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'master_not_found');
  });
});

test('copy control: a read-only administrator cannot start copying', async () => {
  await withApp(
    async ({ app, admin }) => {
      await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
      // Seeded directly: an analyst cannot authorize clients, which is the
      // point of the permission being tested below.
      await app.store.putCopyTradingFollower({
        id: 'f_analyst',
        ownerUserId: 'master1',
        derivSub: 'sub_client1',
        authMethod: 'pat',
        loginId: 'CRclient1',
        accounts: [{ accountId: 'VRTC_CLIENT_9', type: 'demo', currency: 'USD', status: 'active' }],
        tokenSealed: seal(PAT, SECRET),
        tokenExpiresAt: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        revision: 1
      });
      // The analyst has copytrading.read but not copytrading.control.
      const res = await admin.post('/api/admin/v1/copy-trading/control', { masterUserId: 'master1', enabled: true });
      assert.equal(res.status, 403);
      assert.equal(app.store.getCopyTradingControl('master1'), null);
    },
    { role: 'ANALYST' }
  );
});

test('copy performance: a manager sees their own and every follower account', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    await linkClientToMaster({ app, admin }, 'client1', 'master1');

    const res = await admin.get('/api/admin/v1/copy-trading/performance?masterUserId=master1');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    // The master's own account plus the client's Deriv account on the follower
    // record. An account that has not traded still appears, with a zero row.
    assert.equal(res.json.totals.accounts, 2);
    assert.equal(res.json.followers, 1);
    const ids = res.json.accounts.map((a: any) => a.accountId).sort();
    assert.deepEqual(ids, ['VRTC_CLIENT_9', 'VRTCmaster1']);
    const clientRow = res.json.accounts.find((a: any) => a.accountId === 'VRTC_CLIENT_9');
    assert.equal(clientRow.trades, 0);
    assert.equal(clientRow.realisedPnl, 0);
  });
});

test('copy performance: realised profit is attributed to the trading account', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    const followerId = await linkClientToMaster({ app, admin }, 'client1', 'master1');

    const now = Date.now();
    // The master's own settled win.
    await app.store.putContract({
      id: 'c_master',
      userId: 'master1',
      accountId: 'VRTCmaster1',
      accountMode: 'demo',
      intentId: 'i_master',
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      symbol: 'R_100',
      buyPrice: 10,
      stake: 10,
      currency: 'USD',
      payout: 19,
      entrySpot: 100,
      exitSpot: 101,
      purchaseTime: now - 1000,
      startTime: now - 1000,
      expiryTime: now,
      settlementTime: now,
      status: 'won',
      profit: 9,
      soldFor: null,
      buyTransactionId: 1,
      updatedAt: now
    });
    // A copied trade on the client's account, owned by the follower principal.
    await app.store.putContract({
      id: 'c_client',
      userId: `copy_follower_${followerId}`,
      accountId: 'VRTC_CLIENT_9',
      accountMode: 'demo',
      intentId: 'i_client',
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      symbol: 'R_100',
      buyPrice: 10,
      stake: 10,
      currency: 'USD',
      payout: 0,
      entrySpot: 100,
      exitSpot: 99,
      purchaseTime: now - 1000,
      startTime: now - 1000,
      expiryTime: now,
      settlementTime: now,
      status: 'lost',
      profit: -10,
      soldFor: null,
      buyTransactionId: 2,
      updatedAt: now
    });

    const res = await admin.get('/api/admin/v1/copy-trading/performance?masterUserId=master1');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.totals.realisedPnl, -1);
    assert.equal(res.json.totals.wins, 1);
    assert.equal(res.json.totals.losses, 1);
    assert.equal(res.json.totals.staked, 20);
    assert.equal(res.json.totals.roiPercent, -5);

    const masterRow = res.json.accounts.find((a: any) => a.accountId === 'VRTCmaster1');
    const clientRow = res.json.accounts.find((a: any) => a.accountId === 'VRTC_CLIENT_9');
    assert.equal(masterRow.followerId, null);
    assert.equal(masterRow.realisedPnl, 9);
    assert.equal(clientRow.followerId, followerId);
    assert.equal(clientRow.realisedPnl, -10);
  });
});

test('copy performance: another manager cannot read this master\'s numbers', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master1', derivSub: 'sub_master1' });
    await seedTrader(app.store, { id: 'master2', derivSub: 'sub_master2' });
    await seedTrader(app.store, { id: 'client1', derivSub: 'deriv-client-subject-456' });
    await linkClientToMaster({ app, admin }, 'client1', 'master1');

    const res = await admin.get('/api/admin/v1/copy-trading/performance?masterUserId=master2');
    assert.equal(res.status, 200);
    assert.equal(res.json.followers, 0);
    assert.equal(res.json.accounts.every((a: any) => a.followerId === null), true);
  });
});

/* ====================================================================== */
/*  Switch safety                                                        */
/*                                                                        */
/*  The switch used to fail as "network error" while the write had in     */
/*  fact persisted, because this Express version does not catch a reject  */
/*  from an async handler: the request was left with no response at all.  */
/*  These pin every outcome the operator can be shown, and the invariant  */
/*  that matters most — the console must never be told "nothing changed"  */
/*  about a write that did.                                               */
/* ====================================================================== */

const CONTROL = '/api/admin/v1/copy-trading/control';

/** Seeds a master with one eligible client so the switch is allowed to start. */
async function seedControllableMaster(store: Store, masterId = 'master_sw'): Promise<void> {
  await seedTrader(store, { id: masterId, derivSub: `sub_${masterId}` });
  await store.putCopyTradingFollower({
    id: `f_${masterId}`,
    ownerUserId: masterId,
    derivSub: `sub_client_${masterId}`,
    authMethod: 'pat',
    loginId: `CRclient_${masterId}`,
    accounts: [{ accountId: 'VRTC_SW', type: 'demo', currency: 'USD', status: 'active' }],
    tokenSealed: seal(PAT, SECRET),
    tokenExpiresAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'active',
    revision: 1
  });
}

test('switch: an authorized admin can start, and the backend holds it afterwards', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);

    const started = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.equal(started.json.control.enabled, true);
    assert.equal(app.store.getCopyTradingControl('master_sw')?.enabled, true, 'persisted, not just echoed');

    // A fresh read is the authority the console refreshes from.
    const refreshed = await admin.get(`${CONTROL}?masterUserId=master_sw`);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.control.enabled, true);
    assert.equal(refreshed.json.control.updatedByEmail, 'a@x.com');
  });
});

test('switch: an authorized admin can pause, and the stop reason is persisted', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });

    const stopped = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: false, reason: 'client asked' });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
    assert.equal(stopped.json.control.enabled, false);
    assert.equal(stopped.json.control.stoppedReason, 'client asked');
    assert.equal(app.store.getCopyTradingControl('master_sw')?.enabled, false);
  });
});

test('switch: a missing control is reported off and is never created by reading', async () => {
  await withApp(async ({ app, admin }) => {
    await seedTrader(app.store, { id: 'master_sw', derivSub: 'sub_master_sw' });
    assert.equal(app.store.getCopyTradingControl('master_sw'), null);

    const read = await admin.get(`${CONTROL}?masterUserId=master_sw`);
    assert.equal(read.status, 200);
    assert.equal(read.json.control.enabled, false, 'absent reads as stopped');
    assert.equal(app.store.getCopyTradingControl('master_sw'), null, 'reading must not create one');

    // Readiness is read-only too: it must not create the record either.
    await admin.get(`/api/admin/v1/copy-trading/readiness?masterUserId=master_sw`);
    assert.equal(app.store.getCopyTradingControl('master_sw'), null);
  });
});

test('switch: an admin without copytrading.control is refused and nothing is written', async () => {
  await withApp(
    async ({ app, admin }) => {
      await seedControllableMaster(app.store);
      const res = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
      assert.equal(res.status, 403);
      assert.equal(res.json.error, 'forbidden');
      assert.equal(app.store.getCopyTradingControl('master_sw'), null, 'a refused switch writes nothing');
    },
    { role: 'ANALYST' }
  );
});

test('switch: an expired session is a 401, distinct from a network failure', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    // Expire the stored session rather than deleting it, so the cookie is still
    // presented and the server has to reject it on its own merits.
    const sessions = Object.values((app.store as any).db.adminSessions) as any[];
    assert.ok(sessions.length > 0, 'the admin has a session to expire');
    for (const s of sessions) {
      await app.store.updateAdminSession({ ...s, expiresAt: Date.now() - 1000 });
    }
    const res = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'admin_unauthorized');
    assert.equal(app.store.getCopyTradingControl('master_sw'), null);
  });
});

test('switch: a missing CSRF token is a 403 and writes nothing', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    const saved = admin.csrfToken;
    admin.csrfToken = null;
    try {
      const res = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
      assert.equal(res.status, 403);
      assert.equal(res.json.error, 'csrf_failed');
      assert.equal(app.store.getCopyTradingControl('master_sw'), null);
    } finally {
      admin.csrfToken = saved;
    }
  });
});

test('switch: a wrong CSRF token is refused, and the right one still works after', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    const saved = admin.csrfToken;
    admin.csrfToken = 'not-the-session-token';
    const bad = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
    assert.equal(bad.status, 403);
    assert.equal(bad.json.error, 'csrf_failed');
    assert.equal(app.store.getCopyTradingControl('master_sw'), null);

    admin.csrfToken = saved;
    const good = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
    assert.equal(good.status, 200);
    assert.equal(app.store.getCopyTradingControl('master_sw')?.enabled, true);
  });
});

test('switch: an unavailable backend yields a real network error, not a hang', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    const base = app.base;
    await app.close();
    // The client keeps its cookie; nothing is listening any more.
    const c = new Client(base);
    await assert.rejects(
      () => c.post(CONTROL, { masterUserId: 'master_sw', enabled: true }),
      (err: unknown) => {
        // The browser surfaces a rejected fetch; the console maps that to
        // `network_error` and shows "state unknown", never "did not change".
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});

test('switch: a request that persists then loses its response is not reported as failed', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);

    // The control write succeeds, then the audit append throws — the real shape of
    // a store conflict or a poisoned backend. Before the fix this left the request
    // with no response at all: the write persisted and the client saw a timeout.
    const original = app.store.appendAudit.bind(app.store);
    (app.store as any).appendAudit = async () => {
      throw new Error('data file changed by another process');
    };
    try {
      const res = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
      // The switch really did change, so the honest answer is 200, not a 500.
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.control.enabled, true);
      assert.equal(app.store.getCopyTradingControl('master_sw')?.enabled, true, 'the write persisted');
    } finally {
      (app.store as any).appendAudit = original;
    }
  });
});

test('switch: an unhandled async failure answers 500 instead of hanging', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    // Force the failure that previously stranded the request: the handler rejects
    // after doing its work. Without terminal error middleware there is no response
    // and `fetch` reports a network error for a request that persisted.
    const original = app.store.putCopyTradingControl.bind(app.store);
    let calls = 0;
    (app.store as any).putCopyTradingControl = async (record: any) => {
      calls += 1;
      if (calls === 1) {
        await original(record); // persisted
        throw new Error('post-persist failure');
      }
      return original(record);
    };
    try {
      const res = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
      assert.equal(res.status, 500, 'a real status, not a silent hang');
      assert.equal(res.json.error, 'internal_error');
      assert.equal(res.text.includes('post-persist failure'), false, 'internals are not leaked');
      assert.equal(app.store.getCopyTradingControl('master_sw')?.enabled, true, 'the write had persisted');
    } finally {
      (app.store as any).putCopyTradingControl = original;
    }
  });
});

test('switch: a duplicate start request is idempotent and leaves it started once', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    const first = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
    const second = await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'repeating a start is safe, not a conflict');
    assert.equal(second.json.control.enabled, true);
    assert.equal(app.store.getCopyTradingControl('master_sw')?.enabled, true);

    const audit = app.store.listAudit().filter((a) => a.action === 'copytrading.control.started');
    assert.equal(audit.length, 2, 'each accepted request is audited once');
  });
});

test('switch: concurrent start and stop settle on one persisted value', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    await Promise.all([
      admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true }),
      admin.post(CONTROL, { masterUserId: 'master_sw', enabled: false })
    ]);
    const final = app.store.getCopyTradingControl('master_sw');
    assert.ok(final, 'a record exists');
    // Whichever won, what the console refreshes must equal what is stored.
    const read = await admin.get(`${CONTROL}?masterUserId=master_sw`);
    assert.equal(read.json.control.enabled, final!.enabled);
  });
});

test('switch: the audit records the previous state, not the new one twice', async () => {
  await withApp(async ({ app, admin }) => {
    await seedControllableMaster(app.store);
    await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: true });
    await admin.post(CONTROL, { masterUserId: 'master_sw', enabled: false });

    const stops = app.store.listAudit().filter((a) => a.action === 'copytrading.control.stopped');
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0].previousState, { enabled: true }, 'a reader can see what changed');
    assert.deepEqual(stops[0].newState, { enabled: false });
  });
});

test('switch: a cross-origin console is answered only from an allowlisted origin', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cors-'));
  const deriv = await startFakeDeriv();
  const cfg = makeConfig(dataDir, deriv.url);
  cfg.admin.allowedOrigins = ['https://admin.example.com'];
  const app = await startApp(cfg);
  try {
    // Allowlisted: echo the origin and permit credentials.
    const ok = await fetch(`${app.base}${CONTROL}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://admin.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-csrf-token'
      }
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://admin.example.com');
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');

    // Not allowlisted: an explicit refusal, not an opaque empty response the
    // browser would surface as a network failure.
    const bad = await fetch(`${app.base}${CONTROL}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    assert.equal((await bad.json()).error, 'origin_not_allowed');
  } finally {
    await app.close();
    await deriv.close();
  }
});
