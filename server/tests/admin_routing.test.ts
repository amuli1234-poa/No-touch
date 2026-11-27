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
 * Admin console hosting.
 *
 * The admin app is a separate build served under /admin with its own base path.
 * These tests pin the routing contract that makes that work in production, and
 * re-assert that hosting it did not loosen any authentication control: the admin
 * API still demands a password, a TOTP code and a permission, and a trader
 * session still cannot reach it.
 *
 * Fixtures are synthetic temp directories, so nothing depends on the real
 * (gitignored) dist-admin build or on production data.
 */

const SECRET = 'test_session_secret_at_least_32_characters_long_000';

const ADMIN_INDEX = [
  '<!doctype html><html><head><title>WickSentinel Admin</title>',
  '<link rel="stylesheet" href="/admin/assets/index.abc123.css">',
  '</head><body><div id="admin-root"></div>',
  '<script type="module" src="/admin/assets/index.abc123.js"></script>',
  '</body></html>'
].join('');
const TRADER_INDEX = '<!doctype html><html><head><title>WickSentinel</title></head><body><div id="root"></div></body></html>';
const BOT_INDEX = '<!doctype html><html><head><title>Deriv Bot</title></head><body><div id="deriv-bot-root"></div></body></html>';

function makeConfig(dataDir: string, opts: { adminAppDir?: string; botAppDir?: string }): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir,
    storageEngine: 'json',
    adminAppDir: opts.adminAppDir,
    botAppDir: opts.botAppDir,
    deriv: {
      appId: 'test-app-id',
      patAppId: null,
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

interface Harness {
  base: string;
  store: Store;
  close: () => Promise<void>;
}

/**
 * Boots the real app. `adminBuild`/`botBuild` decide whether each optional build
 * exists; the trader shell always exists so the fallback is exercised.
 */
async function startApp(opts: { adminBuild?: boolean; botBuild?: boolean } = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adminroute-data-'));
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adminroute-build-'));

  const adminAppDir = path.join(buildRoot, 'dist-admin');
  if (opts.adminBuild !== false) {
    fs.mkdirSync(path.join(adminAppDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(adminAppDir, 'index.html'), ADMIN_INDEX);
    fs.writeFileSync(path.join(adminAppDir, 'assets', 'index.abc123.js'), 'console.log("admin");');
    fs.writeFileSync(path.join(adminAppDir, 'assets', 'index.abc123.css'), '.admin{color:blue}');
  }

  const botAppDir = path.join(buildRoot, 'bot');
  if (opts.botBuild !== false) {
    fs.mkdirSync(path.join(botAppDir, 'static', 'js'), { recursive: true });
    fs.writeFileSync(path.join(botAppDir, 'index.html'), BOT_INDEX);
    fs.writeFileSync(path.join(botAppDir, 'static', 'js', 'index.abc123.js'), 'console.log("bot");');
  }

  // The trader shell resolves as `<cwd>/dist`, so the fixture must own cwd.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adminroute-cwd-'));
  fs.mkdirSync(path.join(cwd, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), TRADER_INDEX);

  const cfg = makeConfig(dataDir, { adminAppDir, botAppDir });
  const store = new Store(cfg.dataDir, { engine: 'json' });
  await store.load();
  const previousCwd = process.cwd();
  process.chdir(cwd);
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    store,
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          process.chdir(previousCwd);
          r();
        })
      )
  };
}

const get = (base: string, url: string) => fetch(`${base}${url}`, { redirect: 'manual' });

/** Minimal cookie-jar client for the admin API. */
class Client {
  private cookies = new Map<string, string>();
  csrfToken: string | null = null;
  constructor(private base: string) {}

  private store(res: Response): void {
    const raw = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
    for (const c of raw ?? []) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  cookieNames(): string[] {
    return [...this.cookies.keys()];
  }

  async request(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cookies.size) headers['Cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
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
}

async function seedAdmin(
  store: Store,
  opts: { email: string; password: string; role: AdminUserRecord['role'] }
): Promise<{ admin: AdminUserRecord; secret: string }> {
  const secret = generateTotpSecret();
  const admin: AdminUserRecord = {
    id: `adm_${opts.email}`,
    email: opts.email,
    displayName: opts.email.split('@')[0],
    passwordHash: await hashPassword(opts.password),
    role: opts.role,
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
  };
  await store.upsertAdmin(admin);
  return { admin, secret };
}

/* ========================= 1-4. STATIC HOSTING =========================== */

test('admin hosting: /admin/ serves the admin HTML', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    const res = await get(app.base, '/admin/');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /id="admin-root"/, 'must serve the admin shell');
    assert.doesNotMatch(body, /id="root"/, 'must not serve the trader shell');
  } finally {
    await app.close();
  }
});

test('admin hosting: /admin normalises to /admin/', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    const res = await get(app.base, '/admin');
    assert.equal(res.status, 301, 'bare mount must redirect');
    assert.equal(res.headers.get('location'), '/admin/');
    const followed = await get(app.base, '/admin/');
    assert.equal(followed.status, 200);
    assert.match(await followed.text(), /id="admin-root"/);
  } finally {
    await app.close();
  }
});

test('admin hosting: assets load from /admin/assets and are not the trader assets', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    const js = await get(app.base, '/admin/assets/index.abc123.js');
    assert.equal(js.status, 200);
    assert.match(await js.text(), /admin/);

    const css = await get(app.base, '/admin/assets/index.abc123.css');
    assert.equal(css.status, 200);

    // The built HTML must reference the /admin/ prefix, never a root /assets/.
    const html = await (await get(app.base, '/admin/')).text();
    assert.match(html, /src="\/admin\/assets\//, 'script must be admin-prefixed');
    assert.doesNotMatch(html, /src="\/assets\//, 'must not reference root-level assets');
  } finally {
    await app.close();
  }
});

test('admin hosting: deep links serve the admin SPA, not the trader shell', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    for (const url of ['/admin/users', '/admin/audit', '/admin/copy-trading/clients', '/admin/configuration']) {
      const res = await get(app.base, url);
      const body = await res.text();
      assert.equal(res.status, 200, `${url} should be 200, got ${res.status}`);
      assert.match(body, /id="admin-root"/, `${url} must serve the admin shell`);
      assert.doesNotMatch(body, /id="root"/, `${url} must not serve the trader shell`);
      assert.doesNotMatch(body, /WickSentinel<\/title>/, `${url} must not serve the trader document`);
    }
  } finally {
    await app.close();
  }
});

test('admin hosting: a missing admin asset 404s instead of falling through to the trader app', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    for (const url of ['/admin/assets/missing.js', '/admin/nope.css', '/admin/deep/asset.js']) {
      const res = await get(app.base, url);
      const body = await res.text();
      assert.equal(res.status, 404, `${url} should be 404, got ${res.status}`);
      assert.doesNotMatch(body, /id="root"/, `${url} must not serve the trader shell`);
      assert.doesNotMatch(body, /id="admin-root"/, `${url} must not serve the admin shell as a fallback`);
    }
  } finally {
    await app.close();
  }
});

/* ======================= 6. MISSING ADMIN BUILD ========================== */

test('admin hosting: a missing build answers 503 admin_build_missing, never the trader shell', async () => {
  const app = await startApp({ adminBuild: false });
  try {
    for (const url of ['/admin/', '/admin', '/admin/users', '/admin/some/deep/route']) {
      const res = await get(app.base, url);
      const body = await res.text();
      assert.equal(res.status, 503, `${url} should be 503, got ${res.status}`);
      assert.doesNotMatch(body, /id="root"/, `${url} must not serve the trader shell`);
      assert.doesNotMatch(body, /id="admin-root"/, `${url} must not serve an admin shell`);
      const json = JSON.parse(body);
      assert.equal(json.error, 'admin_build_missing');
      assert.match(json.message, /build:admin/, 'message must name the fix');
    }
  } finally {
    await app.close();
  }
});

/* ================= 7-8. TRADER AND BOT STILL WORK ======================== */

test('admin hosting: trader routes are unaffected', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    for (const url of ['/', '/dashboard', '/scanner', '/settings']) {
      const res = await get(app.base, url);
      const body = await res.text();
      assert.equal(res.status, 200, `${url} should be 200, got ${res.status}`);
      assert.match(body, /id="root"/, `${url} must serve the trader shell`);
      assert.doesNotMatch(body, /id="admin-root"/, `${url} must not serve the admin shell`);
    }
  } finally {
    await app.close();
  }
});

test('admin hosting: Bot Builder routing is unaffected', async () => {
  const app = await startApp({ adminBuild: true, botBuild: true });
  try {
    const res = await get(app.base, '/bot/');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /deriv-bot-root/, 'must serve the bot shell');
    assert.doesNotMatch(body, /id="admin-root"/);
  } finally {
    await app.close();
  }
});

test('admin hosting: /admin does not shadow /bot when both builds exist', async () => {
  const app = await startApp({ adminBuild: true, botBuild: true });
  try {
    const bot = await get(app.base, '/bot/static/js/index.abc123.js');
    assert.equal(bot.status, 200, 'bot assets must still resolve');
    const admin = await get(app.base, '/admin/assets/index.abc123.js');
    assert.equal(admin.status, 200, 'admin assets must resolve');
  } finally {
    await app.close();
  }
});

/* ================== 9-11. SECURITY STILL ENFORCED ======================== */

test('admin security: the admin API rejects unauthenticated requests', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    const c = new Client(app.base);
    for (const url of ['/api/admin/v1/auth/session', '/api/admin/v1/dashboard/summary', '/api/admin/v1/users']) {
      const res = await c.get(url);
      assert.equal(res.status, 401, `${url} must be 401, got ${res.status}`);
    }
  } finally {
    await app.close();
  }
});

test('admin security: serving /admin adds no public registration route', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    const c = new Client(app.base);
    for (const url of ['/api/admin/v1/auth/register', '/api/admin/v1/auth/signup', '/api/admin/v1/register']) {
      const res = await c.post(url, { email: 'attacker@example.com', password: 'x' });
      assert.equal(res.status, 404, `${url} must not exist, got ${res.status}`);
    }
  } finally {
    await app.close();
  }
});

test('admin security: password alone does not grant API access (MFA still required)', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    const { secret } = await seedAdmin(app.store, {
      email: 'a@x.com',
      password: 'Str0ng-Passw0rd!',
      role: 'SUPER_ADMIN'
    });
    const c = new Client(app.base);
    const step1 = await c.post('/api/admin/v1/auth/login', { email: 'a@x.com', password: 'Str0ng-Passw0rd!' });
    assert.equal(step1.status, 200);
    assert.equal(step1.json.mfaRequired, true, 'login must stop at the MFA step');

    // The pre-MFA session must not reach a protected route.
    const blocked = await c.get('/api/admin/v1/auth/session');
    assert.equal(blocked.status, 401, 'pre-MFA session must not authorize the API');

    // And the full two-step flow still works.
    const step2 = await c.post('/api/admin/v1/auth/mfa/verify', { code: currentTotp(secret) });
    assert.equal(step2.status, 200);
    c.csrfToken = step2.json.csrfToken;
    const ok = await c.get('/api/admin/v1/auth/session');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.admin.email, 'a@x.com');
  } finally {
    await app.close();
  }
});

test('admin security: a wrong TOTP code is rejected', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    await seedAdmin(app.store, { email: 'a@x.com', password: 'Str0ng-Passw0rd!', role: 'SUPER_ADMIN' });
    const c = new Client(app.base);
    await c.post('/api/admin/v1/auth/login', { email: 'a@x.com', password: 'Str0ng-Passw0rd!' });
    const res = await c.post('/api/admin/v1/auth/mfa/verify', { code: '000000' });
    assert.notEqual(res.status, 200, 'a wrong TOTP must not authenticate');
    const after = await c.get('/api/admin/v1/auth/session');
    assert.equal(after.status, 401);
  } finally {
    await app.close();
  }
});

test('admin security: admin sessions stay separate from trader sessions', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    const { secret } = await seedAdmin(app.store, {
      email: 'a@x.com',
      password: 'Str0ng-Passw0rd!',
      role: 'SUPER_ADMIN'
    });
    const admin = new Client(app.base);
    await admin.post('/api/admin/v1/auth/login', { email: 'a@x.com', password: 'Str0ng-Passw0rd!' });
    const mfa = await admin.post('/api/admin/v1/auth/mfa/verify', { code: currentTotp(secret) });
    assert.equal(mfa.status, 200);

    // The admin cookie must be ws_admin_session, never the trader ws_session.
    assert.ok(admin.cookieNames().includes('ws_admin_session'), 'must set ws_admin_session');
    assert.ok(!admin.cookieNames().includes('ws_session'), 'must not set a trader session cookie');

    // A client holding only a trader-style cookie cannot reach the admin API.
    const traderOnly = new Client(app.base);
    (traderOnly as any).cookies.set('ws_session', 'forged-trader-session');
    const res = await traderOnly.get('/api/admin/v1/auth/session');
    assert.equal(res.status, 401, 'a trader cookie must not authorize the admin API');
  } finally {
    await app.close();
  }
});

test('admin security: admin mutations still require the CSRF token', async () => {
  const app = await startApp({ adminBuild: true });
  try {
    const { secret } = await seedAdmin(app.store, {
      email: 'a@x.com',
      password: 'Str0ng-Passw0rd!',
      role: 'SUPER_ADMIN'
    });
    const c = new Client(app.base);
    await c.post('/api/admin/v1/auth/login', { email: 'a@x.com', password: 'Str0ng-Passw0rd!' });
    const mfa = await c.post('/api/admin/v1/auth/mfa/verify', { code: currentTotp(secret) });
    assert.equal(mfa.status, 200);
    // Deliberately omit the CSRF token on a state-changing request.
    const res = await c.post('/api/admin/v1/announcements', { title: 'x', body: 'y' });
    assert.equal(res.status, 403, `expected 403 csrf_failed, got ${res.status}`);
    assert.equal(res.json.error, 'csrf_failed');
  } finally {
    await app.close();
  }
});
