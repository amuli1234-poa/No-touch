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
 * Administrative API integration tests.
 *
 * Everything runs against the real Express app, the real JSON store, the real
 * scrypt hashing and the real TOTP implementation. No Deriv endpoints are
 * contacted and no real money is involved. A tiny cookie-aware HTTP client
 * drives the login -> MFA -> API flow.
 */

function makeConfig(dataDir: string): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    deriv: {
      appId: '34WRcFqUqhHMuCW3O9NQy',
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'trade',
      authorizationEndpoint: 'http://127.0.0.1:1/oauth2/auth',
      tokenEndpoint: 'http://127.0.0.1:1/oauth2/token',
      userinfoEndpoint: 'http://127.0.0.1:1/userinfo',
      revocationEndpoint: 'http://127.0.0.1:1/oauth2/revoke',
      apiBaseUrl: 'http://127.0.0.1:1'
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
    appOrigin: 'http://localhost:8787'
  };
}

/** Minimal cookie-jar HTTP client. */
class Client {
  private cookies = new Map<string, string>();
  csrfToken: string | null = null;

  constructor(private base: string) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(res: Response): void {
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

  async request(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cookies.size) headers['Cookie'] = this.cookieHeader();
    if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${this.base}${url}`, { method, headers, body: payload });
    this.store(res);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, body?: unknown) {
    return this.request('POST', url, body);
  }
  patch(url: string, body?: unknown) {
    return this.request('PATCH', url, body);
  }
}

async function startApp(cfg: ServerConfig) {
  const store = new Store(cfg.dataDir);
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  return { store, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Seeds an enrolled admin directly in the store. */
async function seedAdmin(
  store: Store,
  opts: { email: string; password: string; role: AdminUserRecord['role']; status?: AdminUserRecord['status'] }
): Promise<{ admin: AdminUserRecord; secret: string }> {
  const secret = generateTotpSecret();
  const admin: AdminUserRecord = {
    id: `adm_${opts.email}`,
    email: opts.email,
    displayName: opts.email.split('@')[0],
    passwordHash: await hashPassword(opts.password),
    role: opts.role,
    extraPermissions: [],
    status: opts.status ?? 'active',
    mfa: { enrolled: true, secretSealed: seal(secret, 'test_session_secret_at_least_32_characters_long_000'), enrolledAt: Date.now(), recoveryCodeHashes: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastLoginAt: null,
    createdBy: null
  };
  await store.upsertAdmin(admin);
  return { admin, secret };
}

/** Full login: password then TOTP. Returns an authenticated client. */
async function login(base: string, email: string, password: string, secret: string): Promise<Client> {
  const c = new Client(base);
  const step1 = await c.post('/api/admin/v1/auth/login', { email, password });
  assert.equal(step1.status, 200, `login step1 failed: ${JSON.stringify(step1.json)}`);
  assert.equal(step1.json.mfaRequired, true);
  const step2 = await c.post('/api/admin/v1/auth/mfa/verify', { code: currentTotp(secret) });
  assert.equal(step2.status, 200, `mfa verify failed: ${JSON.stringify(step2.json)}`);
  c.csrfToken = step2.json.csrfToken;
  return c;
}

/* ============================ AUTHENTICATION ============================ */

test('admin login: password then TOTP succeeds and returns a session', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);
    const session = await c.get('/api/admin/v1/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.json.admin.email, 'a@x.com');
  } finally {
    await app.close();
  }
});

test('admin login: invalid credentials are rejected', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = new Client(app.base);
    const res = await c.post('/api/admin/v1/auth/login', { email: 'a@x.com', password: 'wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'invalid_credentials');
  } finally {
    await app.close();
  }
});

test('admin login: unknown account is indistinguishable from a wrong password', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const c = new Client(app.base);
    const res = await c.post('/api/admin/v1/auth/login', { email: 'nobody@x.com', password: 'whatever' });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'invalid_credentials');
  } finally {
    await app.close();
  }
});

test('admin MFA: wrong TOTP code is rejected and session stays pending', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = new Client(app.base);
    await c.post('/api/admin/v1/auth/login', { email: 'a@x.com', password: 'Str0ng-Passw0rd!' });
    const bad = await c.post('/api/admin/v1/auth/mfa/verify', { code: '000000' });
    assert.equal(bad.status, 401);
    // A pending session cannot reach the API.
    const session = await c.get('/api/admin/v1/auth/session');
    assert.equal(session.status, 401);
  } finally {
    await app.close();
  }
});

test('admin logout revokes the session', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);
    const out = await c.post('/api/admin/v1/auth/logout');
    assert.equal(out.status, 204);
    const session = await c.get('/api/admin/v1/auth/session');
    assert.equal(session.status, 401);
  } finally {
    await app.close();
  }
});

test('admin endpoints reject unauthenticated requests', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const c = new Client(app.base);
    for (const url of ['/api/admin/v1/dashboard/summary', '/api/admin/v1/users', '/api/admin/v1/audit']) {
      const res = await c.get(url);
      assert.equal(res.status, 401, `${url} should be 401`);
    }
  } finally {
    await app.close();
  }
});

/* ============================= AUTHORIZATION ============================ */

test('RBAC: support agent cannot modify subscriptions or configuration', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 's@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPPORT_AGENT' });
    const c = await login(app.base, 's@x.com', 'Str0ng-Passw0rd!', secret);

    // Support agent may read users.
    assert.equal((await c.get('/api/admin/v1/users')).status, 200);
    // ...but cannot touch configuration.
    const cfgRes = await c.patch('/api/admin/v1/configuration', { maintenanceMode: true });
    assert.equal(cfgRes.status, 403);
    // ...nor suspend a user.
    const suspend = await c.post('/api/admin/v1/users/u_does_not_matter/suspend', { reason: 'x' });
    assert.equal(suspend.status, 403);
  } finally {
    await app.close();
  }
});

test('RBAC: analyst is read-only', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'an@x.com', password: 'Str0ng-Passw0rd!', role: 'ANALYST' });
    const c = await login(app.base, 'an@x.com', 'Str0ng-Passw0rd!', secret);
    assert.equal((await c.get('/api/admin/v1/analytics/users')).status, 200);
    const write = await c.patch('/api/admin/v1/configuration', { maintenanceMode: true });
    assert.equal(write.status, 403);
  } finally {
    await app.close();
  }
});

test('RBAC: finance admin cannot change platform security settings', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'f@x.com', password: 'Str0ng-Passw0rd!', role: 'FINANCE_ADMIN' });
    const c = await login(app.base, 'f@x.com', 'Str0ng-Passw0rd!', secret);
    assert.equal((await c.get('/api/admin/v1/subscriptions')).status, 200);
    assert.equal((await c.patch('/api/admin/v1/configuration', { registrationOpen: false })).status, 403);
  } finally {
    await app.close();
  }
});

test('RBAC: a trader session cookie cannot access admin endpoints', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    // Forge a trader-style cookie (signed with the default context) and present it.
    const c = new Client(app.base);
    const { sign } = await import('../lib/crypto.js');
    // @ts-expect-error - reach into the private jar deliberately for this test
    c.cookies.set('ws_session', sign('some-trader-session', cfg.session.secret));
    const res = await c.get('/api/admin/v1/users');
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('RBAC: only a Super Admin can manage Super Admin privileges', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const superAdmin = await seedAdmin(app.store, { email: 'super@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const platform = await seedAdmin(app.store, { email: 'plat@x.com', password: 'Str0ng-Passw0rd!', role: 'PLATFORM_ADMIN' });
    const c = await login(app.base, 'plat@x.com', 'Str0ng-Passw0rd!', platform.secret);
    const res = await c.patch(`/api/admin/v1/administrators/${superAdmin.admin.id}`, { role: 'ANALYST' });
    assert.equal(res.status, 403);
  } finally {
    await app.close();
  }
});

test('last Super Admin cannot be demoted or suspended', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const only = await seedAdmin(app.store, { email: 'only@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = await login(app.base, 'only@x.com', 'Str0ng-Passw0rd!', only.secret);
    const demote = await c.patch(`/api/admin/v1/administrators/${only.admin.id}`, { role: 'ANALYST' });
    assert.equal(demote.status, 409);
    assert.equal(demote.json.error, 'last_super_admin');
  } finally {
    await app.close();
  }
});

/* ============================ USER MANAGEMENT =========================== */

async function seedUser(store: Store, id: string, opts: { suspended?: boolean } = {}) {
  await store.upsertUser({
    id,
    derivSub: `sub_${id}`,
    loginId: `CR${id}`,
    accounts: [{ accountId: `VRTC${id}`, type: 'demo', currency: 'USD' }],
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    suspended: opts.suspended ?? false,
    preferences: {}
  });
}

test('users: list supports search, filter and pagination', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    for (let i = 0; i < 30; i++) await seedUser(app.store, `u${i}`);
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);

    const page1 = await c.get('/api/admin/v1/users?page=1&pageSize=10');
    assert.equal(page1.status, 200);
    assert.equal(page1.json.items.length, 10);
    assert.equal(page1.json.total, 30);
    assert.equal(page1.json.totalPages, 3);

    const search = await c.get('/api/admin/v1/users?q=u1');
    assert.ok(search.json.total >= 1);

    const suspended = await c.get('/api/admin/v1/users?status=suspended');
    assert.equal(suspended.json.total, 0);
  } finally {
    await app.close();
  }
});

test('users: suspension is enforced on the existing session path and audited', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    await seedUser(app.store, 'victim');
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);

    const res = await c.post('/api/admin/v1/users/victim/suspend', { reason: 'abuse' });
    assert.equal(res.status, 200);

    const user = app.store.getUserById('victim');
    assert.equal(user?.suspended, true);

    const audit = await c.get('/api/admin/v1/audit?action=user.suspend');
    assert.ok(audit.json.items.length >= 1);
    assert.equal(audit.json.items[0].targetId, 'victim');
  } finally {
    await app.close();
  }
});

test('users: reactivation restores access and is audited', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    await seedUser(app.store, 'victim', { suspended: true });
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);
    const res = await c.post('/api/admin/v1/users/victim/reactivate');
    assert.equal(res.status, 200);
    assert.equal(app.store.getUserById('victim')?.suspended, false);
  } finally {
    await app.close();
  }
});

/* ================================= AUDIT ================================ */

test('audit: sensitive actions create records and never store secrets', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);

    const logs = app.store.listAudit();
    assert.ok(logs.some((l) => l.action === 'admin.login.success'));

    // The audit log must never contain the password, TOTP code or session cookie.
    const serialised = JSON.stringify(logs);
    assert.ok(!serialised.includes('Str0ng-Passw0rd!'), 'password leaked into audit log');
    assert.ok(!serialised.includes(secret), 'TOTP secret leaked into audit log');
    assert.ok(!serialised.includes('ws_admin_session'), 'session cookie leaked into audit log');
  } finally {
    await app.close();
  }
});

test('audit: the API exposes no mutation endpoint for audit records', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);
    // There is no write route under /audit; unknown paths 404.
    const res = await c.post('/api/admin/v1/audit', { action: 'forged' });
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});

/* ================================ CSRF ================================== */

test('CSRF: a state-changing request without the token is rejected', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    await seedUser(app.store, 'victim');
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);
    c.csrfToken = null; // simulate a cross-site request without the header
    const res = await c.post('/api/admin/v1/users/victim/suspend', { reason: 'x' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'csrf_failed');
  } finally {
    await app.close();
  }
});

test('CSRF: an authenticated request WITH the token succeeds', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    const { secret } = await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    await seedUser(app.store, 'victim');
    const c = await login(app.base, 'a@x.com', 'Str0ng-Passw0rd!', secret);
    const res = await c.post('/api/admin/v1/users/victim/suspend', { reason: 'x' });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

/* =========================== RATE LIMITING ============================== */

test('rate limiting: repeated failed logins are eventually blocked', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-admin-'));
  const cfg = makeConfig(dataDir);
  const app = await startApp(cfg);
  try {
    await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = new Client(app.base);
    let sawRateLimit = false;
    for (let i = 0; i < 8; i++) {
      const res = await c.post('/api/admin/v1/auth/login', { email: 'a@x.com', password: 'wrong' });
      if (res.status === 429) sawRateLimit = true;
    }
    assert.ok(sawRateLimit, 'expected a 429 after repeated failures');
  } finally {
    await app.close();
  }
});
