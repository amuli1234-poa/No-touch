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
import type { SessionRecord } from '../store/store.js';
import type { AdminUserRecord } from '../admin/types.js';
import { hashPassword } from '../admin/passwords.js';
import { generateTotpSecret, currentTotp } from '../admin/totp.js';
import { sign, seal } from '../lib/crypto.js';
import { BalanceService } from '../services/balance.js';
import type { DerivBalance } from '../lib/balance.js';

/**
 * Client balances on the Copy Trading surfaces.
 *
 * A client's balance is read live from Deriv over that client's own sealed
 * credential, so these tests stub the Deriv reader rather than the service: the
 * ownership check, the DEMO/REAL separation, the "never a fabricated zero"
 * rule and the token handling are all real code.
 *
 * Both surfaces are covered because they are separate routes with separate
 * authorization: the administrator route (`copytrading.read`) and the manager
 * route, which must only ever reach followers the manager owns.
 */

const SECRET = 'test_session_secret_at_least_32_characters_long_000';

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
      apiBaseUrl: 'http://127.0.0.1:1',
      wsUrl: 'ws://127.0.0.1:1',
      appIdDemo: null,
      patAppId: 'PAT_APP_ID'
    },
    session: {
      secret: SECRET,
      cookieName: 'ws_session',
      ttlSeconds: 3600,
      secureCookie: false
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
  } as ServerConfig;
}

const FOLLOWER_ID = 'f_balance_1';
const MASTER_ID = 'u_master';
const OTHER_MASTER_ID = 'u_other_master';

/** A balance service whose Deriv reader returns fixed figures per account. */
function stubbedBalances(cfg: ServerConfig, figures: Record<string, number>) {
  return new BalanceService(cfg, {
    fetcher: async (_cfg, _token, accountId): Promise<DerivBalance> => {
      const value = figures[accountId];
      if (value === undefined) throw new Error(`no stub for ${accountId}`);
      return { balance: value, currency: 'USD', loginId: accountId };
    }
  });
}

async function startApp(figures: Record<string, number>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-copy-balance-'));
  const cfg = makeConfig(dataDir);
  const store = new Store(dataDir, { engine: cfg.storageEngine });
  await store.load();

  // One follower owned by MASTER_ID, with a DEMO and a REAL account so the
  // separation rule is observable.
  await store.putCopyTradingFollower({
    id: FOLLOWER_ID,
    ownerUserId: MASTER_ID,
    derivSub: 'sub_client_1',
    authMethod: 'pat',
    loginId: 'CR_CLIENT_1',
    accounts: [
      { accountId: 'VRTC_DEMO_1', type: 'demo', currency: 'USD', status: 'active' },
      { accountId: 'CR_REAL_1', type: 'real', currency: 'USD', status: 'active' }
    ],
    tokenSealed: seal('client-pat-token', cfg.session.secret),
    tokenExpiresAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'active',
    revision: 1
  });

  const { app } = createApp(cfg, store, undefined, stubbedBalances(cfg, figures));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    store,
    cfg,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

async function seedSession(store: Store, cfg: ServerConfig, userId: string): Promise<string> {
  const now = Date.now();
  await store.upsertUser({
    id: userId,
    derivSub: `sub_${userId}`,
    loginId: `CR${userId}`,
    accounts: [{ accountId: `VRTC_${userId}`, type: 'demo', currency: 'USD' }],
    createdAt: now,
    updatedAt: now,
    suspended: false,
    preferences: {}
  });
  const session: SessionRecord = {
    id: `sess_${userId}`,
    userId,
    createdAt: now,
    expiresAt: now + 3600_000,
    lastSeenAt: now,
    revoked: false,
    derivTokenSealed: seal('master-token', cfg.session.secret),
    derivTokenExpiresAt: now + 3600_000,
    derivSub: `sub_${userId}`
  };
  await store.createSession(session);
  return sign(session.id, cfg.session.secret);
}

async function seedAdmin(store: Store, email: string, role: AdminUserRecord['role']): Promise<string> {
  const secret = generateTotpSecret();
  await store.upsertAdmin({
    id: `adm_${email}`,
    email,
    displayName: 'admin',
    passwordHash: await hashPassword('Str0ng-Passw0rd!'),
    role,
    extraPermissions: [],
    status: 'active',
    mfa: { enrolled: true, secretSealed: seal(secret, SECRET), enrolledAt: Date.now(), recoveryCodeHashes: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastLoginAt: null,
    createdBy: null
  });
  return secret;
}

async function adminLogin(base: string, email: string, secret: string): Promise<string> {
  const login = await fetch(`${base}/api/admin/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Str0ng-Passw0rd!' })
  });
  assert.equal(login.status, 200);
  const cookies = (login.headers as any).getSetCookie() as string[];
  const pending = cookies.map((c) => c.split(';')[0]).join('; ');

  const verify = await fetch(`${base}/api/admin/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pending },
    body: JSON.stringify({ code: currentTotp(secret) })
  });
  assert.equal(verify.status, 200);
  const body = await verify.json();
  const verified = ((verify.headers as any).getSetCookie() as string[]).map((c) => c.split(';')[0]).join('; ');
  return `${verified}; csrf=${body.csrfToken}`;
}

/* ------------------------------ manager route ---------------------------- */

test('manager: a client balance is read live and DEMO/REAL stay separate', async () => {
  const app = await startApp({ VRTC_DEMO_1: 10_500.25, CR_REAL_1: 42 });
  try {
    const cookie = await seedSession(app.store, app.cfg, MASTER_ID);
    const res = await fetch(`${app.base}/api/copy-trading/followers/${FOLLOWER_ID}/balance`, {
      headers: { Cookie: `ws_session=${cookie}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.available, true);
    assert.equal(body.accounts.length, 2);

    const demo = body.accounts.find((a: any) => a.mode === 'demo');
    const real = body.accounts.find((a: any) => a.mode === 'real');
    assert.equal(demo.balance, 10_500.25);
    assert.equal(real.balance, 42);
    assert.equal(demo.state, 'ok');
    assert.equal(real.state, 'ok');

    // The client's credential must never appear in the response.
    assert.equal(JSON.stringify(body).includes('client-pat-token'), false);
  } finally {
    await app.close();
  }
});

test('manager: another manager cannot read a client they do not own', async () => {
  const app = await startApp({ VRTC_DEMO_1: 10, CR_REAL_1: 20 });
  try {
    const cookie = await seedSession(app.store, app.cfg, OTHER_MASTER_ID);
    const res = await fetch(`${app.base}/api/copy-trading/followers/${FOLLOWER_ID}/balance`, {
      headers: { Cookie: `ws_session=${cookie}` }
    });
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});

test('manager: the balance route requires a session', async () => {
  const app = await startApp({ VRTC_DEMO_1: 10 });
  try {
    const res = await fetch(`${app.base}/api/copy-trading/followers/${FOLLOWER_ID}/balance`);
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('manager: an unreadable figure is unavailable, never zero', async () => {
  // No stub for the demo account, so the reader throws for it.
  const app = await startApp({ CR_REAL_1: 20 });
  try {
    const cookie = await seedSession(app.store, app.cfg, MASTER_ID);
    const res = await fetch(`${app.base}/api/copy-trading/followers/${FOLLOWER_ID}/balance`, {
      headers: { Cookie: `ws_session=${cookie}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    const demo = body.accounts.find((a: any) => a.mode === 'demo');
    assert.equal(demo.balance, null, 'a failed read is null, not 0');
    assert.equal(demo.state, 'unavailable');
    assert.equal(body.available, true, 'the REAL read still succeeded');
  } finally {
    await app.close();
  }
});

/* ------------------------------ admin route ------------------------------ */

test('admin: a client balance is visible to a reader with copytrading.read', async () => {
  const app = await startApp({ VRTC_DEMO_1: 7_777, CR_REAL_1: 1 });
  try {
    const secret = await seedAdmin(app.store, 'a@x.com', 'SUPER_ADMIN');
    const cookieHeader = await adminLogin(app.base, 'a@x.com', secret);
    const csrf = cookieHeader.split('csrf=')[1];

    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/clients/${FOLLOWER_ID}/balance`, {
      headers: { Cookie: cookieHeader.split('; csrf=')[0], 'X-CSRF-Token': csrf }
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.available, true);
    assert.equal(body.accounts.length, 2);
    // Account identifiers are masked on the admin surface.
    const demo = body.accounts.find((a: any) => a.mode === 'demo');
    assert.equal(demo.balance, 7_777);
    assert.equal(demo.accountId.includes('VRTC_DEMO_1'), false);
  } finally {
    await app.close();
  }
});

test('admin: an unknown client id is a 404', async () => {
  const app = await startApp({ VRTC_DEMO_1: 1 });
  try {
    const secret = await seedAdmin(app.store, 'a@x.com', 'SUPER_ADMIN');
    const cookieHeader = await adminLogin(app.base, 'a@x.com', secret);
    const csrf = cookieHeader.split('csrf=')[1];

    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/clients/f_missing/balance`, {
      headers: { Cookie: cookieHeader.split('; csrf=')[0], 'X-CSRF-Token': csrf }
    });
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});
