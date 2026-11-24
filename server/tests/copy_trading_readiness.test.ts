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
import type { AdminUserRecord } from '../admin/types.js';
import { hashPassword } from '../admin/passwords.js';
import { generateTotpSecret, currentTotp } from '../admin/totp.js';
import { seal } from '../lib/crypto.js';
import { buildCopyReadiness } from '../copyTrading/readiness.js';
import type { CopyTradingFollowerRecord } from '../copyTrading/types.js';
import type { TradeIntentRecord } from '../execution/types.js';

/**
 * Copy Trading operational readiness.
 *
 * Two kinds of assertion run here:
 *
 *  1. The state machine. Every one of the six states is reached from real
 *     persisted records — no mock readiness payloads — so a regression in the
 *     projection shows up as a wrong state rather than a wrong fixture.
 *  2. The safety invariants. These are the ones that matter most: computing
 *     readiness must not write anything, a missing control must read as
 *     disabled, and a data wipe must never produce READY.
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

const MASTER_ID = 'u_master_ready';
const OTHER_MASTER_ID = 'u_other_ready';

const NOW = 1_700_000_000_000;

function newStore(): { store: Store; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-copy-readiness-'));
  return { store: new Store(dir, { engine: 'json' }), dir };
}

async function seedMaster(store: Store, id = MASTER_ID): Promise<void> {
  await store.upsertUser({
    id,
    derivSub: `sub_${id}`,
    loginId: `CR${id}`,
    accounts: [{ accountId: `VRTC_${id}`, type: 'demo', currency: 'USD' }],
    createdAt: NOW,
    updatedAt: NOW,
    suspended: false,
    preferences: {}
  });
}

interface FollowerOptions {
  id?: string;
  ownerUserId?: string;
  status?: CopyTradingFollowerRecord['status'];
  tokenExpiresAt?: number;
  tokenSealed?: string;
  accounts?: CopyTradingFollowerRecord['accounts'];
  consent?: boolean;
}

async function seedFollower(store: Store, options: FollowerOptions = {}): Promise<CopyTradingFollowerRecord> {
  const record: CopyTradingFollowerRecord = {
    id: options.id ?? 'f_ready_1',
    ownerUserId: options.ownerUserId ?? MASTER_ID,
    derivSub: 'sub_client_ready',
    authMethod: 'pat',
    loginId: 'CR_CLIENT_READY',
    accounts: options.accounts ?? [{ accountId: 'VRTC_DEMO_READY', type: 'demo', currency: 'USD', status: 'active' }],
    tokenSealed: options.tokenSealed ?? seal('client-token', SECRET),
    tokenExpiresAt: options.tokenExpiresAt ?? 0,
    createdAt: NOW,
    updatedAt: NOW,
    status: options.status ?? 'authorized',
    revision: 1
  };
  await store.putCopyTradingFollower(record);
  if (options.consent !== false) {
    await store.putCopyTradingConsent({
      followerId: record.id,
      ownerUserId: record.ownerUserId,
      method: 'pat',
      recordedByAdminId: null,
      attestedBy: 'test',
      consentedAt: NOW,
      note: null
    });
  }
  return record;
}

async function enableControl(store: Store, ownerUserId = MASTER_ID): Promise<void> {
  await store.putCopyTradingControl({
    ownerUserId,
    enabled: true,
    updatedBy: 'adm',
    updatedByEmail: 'a@x.com',
    updatedAt: NOW,
    stoppedReason: null
  });
}

function readiness(store: Store, ownerUserId = MASTER_ID) {
  return buildCopyReadiness({ store, cfg: makeConfig(os.tmpdir()), now: () => NOW }, ownerUserId);
}

/* ====================================================================== */
/*  State machine — one test per state                                    */
/* ====================================================================== */

test('readiness: NO_FOLLOWERS when no client is connected at all', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);

  const view = readiness(store);
  assert.equal(view.state, 'NO_FOLLOWERS');
  assert.equal(view.counts.followers, 0);
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.pendingInvitations, 0);
  assert.equal(view.control.enabled, false);
  assert.equal(view.guarantee, false);
});

test('readiness: NO_FOLLOWERS when every follower is administratively held', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_paused', status: 'paused' });
  await seedFollower(store, { id: 'f_susp', status: 'suspended', accounts: [{ accountId: 'VRTC_2', type: 'demo', currency: 'USD' }] });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.state, 'NO_FOLLOWERS');
  assert.equal(view.counts.followers, 2);
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.held, 2, 'held followers are counted, not counted as eligible');
  assert.equal(view.counts.disconnected, 0, 'an administrative hold is not a disconnection');
});

test('readiness: AWAITING_AUTHORIZATION when an invitation is outstanding', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await store.putCopyTradingInvitation({
    id: 'inv_1',
    ownerUserId: MASTER_ID,
    tokenHash: 'hash',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedAt: null,
    invitedEmail: 'client@x.com',
    revokedAt: null
  });

  const view = readiness(store);
  assert.equal(view.state, 'AWAITING_AUTHORIZATION');
  assert.equal(view.counts.pendingInvitations, 1);
  assert.equal(view.counts.eligible, 0);
});

test('readiness: an expired or consumed invitation is not pending', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await store.putCopyTradingInvitation({
    id: 'inv_expired',
    ownerUserId: MASTER_ID,
    tokenHash: 'h1',
    createdAt: NOW - 100_000,
    expiresAt: NOW - 1,
    consumedAt: null,
    revokedAt: null
  });
  await store.putCopyTradingInvitation({
    id: 'inv_used',
    ownerUserId: MASTER_ID,
    tokenHash: 'h2',
    createdAt: NOW - 100_000,
    expiresAt: NOW + 60_000,
    consumedAt: NOW - 5_000,
    revokedAt: null
  });

  const view = readiness(store);
  assert.equal(view.counts.pendingInvitations, 0);
  assert.equal(view.state, 'NO_FOLLOWERS');
});

test('readiness: PAUSED when an eligible follower exists but the control is missing', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);

  const view = readiness(store);
  assert.equal(view.state, 'PAUSED', 'a missing control is disabled, never READY');
  assert.equal(view.control.exists, false);
  assert.equal(view.control.enabled, false);
  assert.equal(view.counts.eligible, 1);
  assert.equal(view.counts.eligibleDerivAccounts, 1);
});

test('readiness: PAUSED when the control exists but is disabled', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);
  await store.putCopyTradingControl({
    ownerUserId: MASTER_ID,
    enabled: false,
    updatedBy: 'adm',
    updatedByEmail: 'a@x.com',
    updatedAt: NOW,
    stoppedReason: 'manual stop'
  });

  const view = readiness(store);
  assert.equal(view.state, 'PAUSED');
  assert.equal(view.control.exists, true);
  assert.equal(view.control.enabled, false);
  assert.equal(view.control.stoppedReason, 'manual stop');
});

test('readiness: READY when an eligible follower exists and the control is enabled', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.state, 'READY');
  assert.equal(view.counts.eligible, 1);
  assert.equal(view.counts.eligibleDerivAccounts, 1);
  assert.equal(view.guarantee, false, 'READY is never an execution guarantee');
  assert.match(view.explanation, /not guaranteed/i);
});

test('readiness: DEGRADED when a follower credential cannot be opened', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_broken', tokenSealed: 'not-a-sealed-token' });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED');
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.disconnected, 1, 'an unreadable credential is a disconnection');
  const connection = view.health.find((c) => c.key === 'connection');
  assert.equal(connection?.status, 'fail');
});

test('readiness: DEGRADED when a purchase outcome is unknown to the broker', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  const follower = await seedFollower(store);
  await enableControl(store);

  const intent = {
    id: 'int_unknown',
    userId: `copy_follower_${follower.id}`,
    accountId: 'VRTC_DEMO_READY',
    accountMode: 'demo',
    signalId: 'sig_1',
    contractType: 'CALL',
    contractFamily: 'rise_fall',
    stake: 1,
    basis: 'stake',
    currency: 'USD',
    parameters: {},
    state: 'UNKNOWN',
    idempotencyKey: 'copy:k:VRTC_DEMO_READY',
    contractId: null,
    approvedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    transitions: []
  } as unknown as TradeIntentRecord;
  await store.putTradeIntent(intent);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED', 'an unknown broker outcome outranks READY');
  const broker = view.health.find((c) => c.key === 'broker');
  assert.equal(broker?.status, 'fail');
});

test('readiness: UNKNOWN when the master record is missing', async () => {
  const { store } = newStore();
  await store.load();

  const view = readiness(store, 'u_does_not_exist');
  assert.equal(view.state, 'UNKNOWN');
  assert.equal(view.master, null);
  assert.equal(view.guarantee, false);
  assert.equal(view.health.every((c) => c.status === 'unknown'), true);
});

/* ====================================================================== */
/*  Empty / partially-formed follower records                             */
/* ====================================================================== */

test('readiness: a follower with no accounts is disconnected, not eligible', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_no_accounts', accounts: [] });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED');
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.disconnected, 1);
  assert.equal(view.counts.eligibleDerivAccounts, 0);
  const authorization = view.health.find((c) => c.key === 'authorization');
  assert.equal(authorization?.status, 'fail');
});

test('readiness: a REAL-only follower never counts as eligible', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, {
    id: 'f_real_only',
    accounts: [{ accountId: 'CR_REAL_1', type: 'real', currency: 'USD', status: 'active' }]
  });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.counts.eligible, 0, 'copying is DEMO-only, so a REAL account cannot make it ready');
  assert.equal(view.state, 'DEGRADED');
});

test('readiness: a follower whose DEMO account is not active is not eligible', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, {
    id: 'f_inactive',
    accounts: [{ accountId: 'VRTC_SUSP', type: 'demo', currency: 'USD', status: 'suspended' }]
  });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.eligibleDerivAccounts, 0);
});

test('readiness: an expired authorization is a fault, not a pause', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_expired', tokenExpiresAt: NOW - 1 });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED');
  assert.equal(view.counts.disconnected, 1);
  assert.equal(view.counts.held, 0);
});

test('readiness: a follower with no consent record is not eligible', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_no_consent', consent: false });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.state, 'DEGRADED');
});

/* ====================================================================== */
/*  Safety invariants                                                     */
/* ====================================================================== */

test('readiness: computing it never writes to the store', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);

  const before = JSON.stringify({
    controls: store.getCopyTradingControl(MASTER_ID),
    followers: store.listAllCopyTradingFollowers(),
    consents: store.getCopyTradingConsent('f_ready_1'),
    audit: store.listExecutionAudit().length
  });

  readiness(store);
  readiness(store);

  const after = JSON.stringify({
    controls: store.getCopyTradingControl(MASTER_ID),
    followers: store.listAllCopyTradingFollowers(),
    consents: store.getCopyTradingConsent('f_ready_1'),
    audit: store.listExecutionAudit().length
  });

  assert.equal(after, before, 'readiness is a projection and must not persist anything');
});

test('readiness: a missing control is not created by reading readiness', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);

  readiness(store);

  assert.equal(
    store.getCopyTradingControl(MASTER_ID),
    null,
    'the control must stay absent — creating it would be an implicit enable'
  );
});

test('readiness: a data wipe reports not-ready, never READY', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);
  await enableControl(store);
  assert.equal(readiness(store).state, 'READY');

  // Simulate the wipe: the follower rows go. This is the dangerous shape — the
  // control record is still enabled, exactly as it would be if only the client
  // records were lost. An enabled switch with nobody to copy to must never read
  // as READY, or the console would claim copying is live when it is inert.
  await store.deleteCopyTradingFollower(MASTER_ID, 'f_ready_1');

  const view = readiness(store);
  assert.equal(view.state, 'NO_FOLLOWERS');
  assert.equal(view.control.exists, true, 'the leftover control is reported, not hidden');
  assert.equal(view.control.enabled, true);
  assert.equal(view.counts.followers, 0);
  assert.equal(view.counts.eligible, 0);
});

test('readiness: after a full wipe only the users survive, and that is not READY', async () => {
  // The real post-purge store: users and sessions kept, every copy-trading
  // collection empty. Readiness must describe that honestly.
  const { store } = newStore();
  await store.load();
  await seedMaster(store);

  const view = readiness(store);
  assert.equal(view.state, 'NO_FOLLOWERS');
  assert.equal(view.control.exists, false, 'no control was recreated by reading readiness');
  assert.equal(view.counts.followers, 0);
  assert.equal(view.counts.eligibleDerivAccounts, 0);
  assert.equal(view.lastCopy, null);
});

/* ====================================================================== */
/*  Last copy / last failure reporting                                    */
/* ====================================================================== */

test('readiness: the last successful copy is reported with a masked account', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  const follower = await seedFollower(store);
  await enableControl(store);

  await store.appendExecutionAudit({
    id: 'aud_old',
    timestamp: NOW - 10_000,
    userId: `copy_follower_${follower.id}`,
    action: 'execution.copy',
    outcome: 'allowed',
    accountId: 'VRTC_OLD_ACCOUNT',
    intentId: 'int_old',
    detail: { followerId: follower.id, masterUserId: MASTER_ID, contractId: 111 }
  });
  await store.appendExecutionAudit({
    id: 'aud_new',
    timestamp: NOW - 1_000,
    userId: `copy_follower_${follower.id}`,
    action: 'execution.copy',
    outcome: 'allowed',
    accountId: 'VRTC_NEW_ACCOUNT',
    intentId: 'int_new',
    detail: { followerId: follower.id, masterUserId: MASTER_ID, contractId: 222 }
  });

  const view = readiness(store);
  assert.equal(view.lastCopy?.contractId, 222, 'the most recent success wins');
  assert.equal(view.lastCopy?.at, NOW - 1_000);
  assert.equal(view.lastCopy?.accountId?.includes('VRTC_NEW_ACCOUNT'), false, 'the account id is masked');
});

test('readiness: the last failure is reported and its detail is redacted', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  const follower = await seedFollower(store);
  await enableControl(store);

  // The auditor redacts on write; this entry is written directly to prove the
  // readiness projection redacts again rather than trusting its input.
  await store.appendExecutionAudit({
    id: 'aud_fail',
    timestamp: NOW - 500,
    userId: `copy_follower_${follower.id}`,
    action: 'execution.copy',
    outcome: 'denied',
    accountId: 'VRTC_DEMO_READY',
    intentId: 'int_fail',
    detail: {
      followerId: follower.id,
      reason: 'broker_rejected',
      accessToken: 'super-secret-token',
      nested: { clientSecret: 'another-secret' }
    }
  });

  const view = readiness(store);
  assert.equal(view.lastFailure?.reason, 'broker_rejected');
  const serialised = JSON.stringify(view);
  assert.equal(serialised.includes('super-secret-token'), false, 'a token must never reach the console');
  assert.equal(serialised.includes('another-secret'), false, 'nested secrets are redacted too');
});

test('readiness: another master\'s copy history is not attributed to this one', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store, MASTER_ID);
  await seedMaster(store, OTHER_MASTER_ID);
  await seedFollower(store, { id: 'f_mine' });
  await seedFollower(store, { id: 'f_theirs', ownerUserId: OTHER_MASTER_ID });
  await enableControl(store);

  await store.appendExecutionAudit({
    id: 'aud_theirs',
    timestamp: NOW - 100,
    userId: `copy_follower_f_theirs`,
    action: 'execution.copy',
    outcome: 'allowed',
    accountId: 'VRTC_THEIRS',
    intentId: 'int_theirs',
    detail: { followerId: 'f_theirs', masterUserId: OTHER_MASTER_ID, contractId: 999 }
  });

  const view = readiness(store);
  assert.equal(view.lastCopy, null, 'a different master\'s copy must not appear here');
});

/* ====================================================================== */
/*  Admin route                                                           */
/* ====================================================================== */

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-copy-readiness-http-'));
  const cfg = makeConfig(dataDir);
  const store = new Store(dataDir, { engine: cfg.storageEngine });
  await store.load();
  const { app } = createApp(cfg, store);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    store,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

async function seedAdmin(store: Store, email: string): Promise<string> {
  const secret = generateTotpSecret();
  await store.upsertAdmin({
    id: `adm_${email}`,
    email,
    displayName: 'admin',
    passwordHash: await hashPassword('Str0ng-Passw0rd!'),
    role: 'SUPER_ADMIN',
    extraPermissions: [],
    status: 'active',
    mfa: { enrolled: true, secretSealed: seal(secret, SECRET), enrolledAt: Date.now(), recoveryCodeHashes: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastLoginAt: null,
    createdBy: null
  } satisfies AdminUserRecord);
  return secret;
}

async function adminLogin(base: string, email: string, secret: string): Promise<string> {
  const login = await fetch(`${base}/api/admin/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Str0ng-Passw0rd!' })
  });
  assert.equal(login.status, 200);
  const pending = ((login.headers as any).getSetCookie() as string[]).map((c) => c.split(';')[0]).join('; ');

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

test('admin route: readiness is served read-only and reports the real state', async () => {
  const app = await startApp();
  try {
    await seedMaster(app.store);
    await seedFollower(app.store);
    await enableControl(app.store);

    const secret = await seedAdmin(app.store, 'r@x.com');
    const cookieHeader = await adminLogin(app.base, 'r@x.com', secret);
    const csrf = cookieHeader.split('csrf=')[1];
    const cookie = cookieHeader.split('; csrf=')[0];

    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/readiness?masterUserId=${MASTER_ID}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.readiness.state, 'READY');
    assert.equal(body.readiness.counts.followers, 1);
    assert.equal(body.readiness.guarantee, false);

    // Reading must not have created or changed the control.
    const stored = app.store.getCopyTradingControl(MASTER_ID);
    assert.equal(stored?.enabled, true);
    assert.equal(stored?.updatedBy, 'adm', 'the readiness read must not rewrite the control');
    assert.ok(csrf);
  } finally {
    await app.close();
  }
});

test('admin route: readiness requires authentication', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/readiness?masterUserId=${MASTER_ID}`);
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('admin route: an unknown master is a 404', async () => {
  const app = await startApp();
  try {
    const secret = await seedAdmin(app.store, 'r2@x.com');
    const cookieHeader = await adminLogin(app.base, 'r2@x.com', secret);
    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/readiness?masterUserId=u_missing`, {
      headers: { Cookie: cookieHeader.split('; csrf=')[0] }
    });
    assert.equal(res.status, 404);
  } finally {
    await app.close();
  }
});

test('admin route: the list view includes every master with a follower or control', async () => {
  const app = await startApp();
  try {
    await seedMaster(app.store);
    await seedFollower(app.store);

    const secret = await seedAdmin(app.store, 'r3@x.com');
    const cookieHeader = await adminLogin(app.base, 'r3@x.com', secret);
    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/readiness`, {
      headers: { Cookie: cookieHeader.split('; csrf=')[0] }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].ownerUserId, MASTER_ID);
    assert.equal(body.items[0].state, 'PAUSED');
  } finally {
    await app.close();
  }
});

/* ====================================================================== */
/*  Roster distinctions                                                   */
/*                                                                        */
/*  All four of these leave copying with nothing to do, so they share the  */
/*  NO_FOLLOWERS state. They are separated by `roster` because the operator */
/*  action differs: invite someone, release a hold, fix a credential, or    */
/*  wait for a client to finish authorizing.                               */
/* ====================================================================== */

test('roster: no follower records at all is EMPTY', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);

  const view = readiness(store);
  assert.equal(view.roster, 'EMPTY');
  assert.equal(view.state, 'NO_FOLLOWERS');
  assert.equal(view.counts.followers, 0);
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.held, 0);
  assert.equal(view.counts.pendingInvitations, 0);
  assert.match(view.explanation, /No client is connected/i);
});

test('roster: records exist but every one is held is ALL_HELD', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_h1', status: 'paused' });
  await seedFollower(store, { id: 'f_h2', status: 'suspended' });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.roster, 'ALL_HELD');
  assert.equal(view.state, 'NO_FOLLOWERS');
  assert.equal(view.counts.followers, 2, 'the roster is reported, not hidden');
  assert.equal(view.counts.held, 2);
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.disconnected, 0, 'a hold is not a fault');
  assert.match(view.explanation, /paused or suspended/i);
});

test('roster: records exist, none held, none eligible is NONE_ELIGIBLE', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  // Expired authorization: a fault, not a hold, so this is not ALL_HELD.
  await seedFollower(store, { id: 'f_x1', tokenExpiresAt: NOW - 1 });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.roster, 'NONE_ELIGIBLE');
  assert.equal(view.state, 'DEGRADED', 'the fault still outranks the roster shape');
  assert.equal(view.counts.followers, 1);
  assert.equal(view.counts.held, 0, 'a credential fault is not counted as held');
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.disconnected, 1);
});

test('roster: a healthy roster with no eligible client reports NONE_ELIGIBLE', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  // A missing consent record leaves the client ineligible without any admin
  // hold. This is the honest shape: ineligible-and-not-held always implies a
  // failing follower check, so the roster says NONE_ELIGIBLE and the state
  // still says DEGRADED.
  await seedFollower(store, { id: 'f_nc', consent: false });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.roster, 'NONE_ELIGIBLE');
  assert.equal(view.state, 'DEGRADED');
  assert.equal(view.counts.followers, 1);
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.held, 0);
  assert.equal(view.counts.disconnected, 1);
});

test('roster: an outstanding invitation with no records is AWAITING_AUTHORIZATION', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await store.putCopyTradingInvitation({
    id: 'inv_a',
    ownerUserId: MASTER_ID,
    tokenHash: 'h',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedAt: null,
    invitedEmail: 'a@x.com',
    revokedAt: null
  });

  const view = readiness(store);
  assert.equal(view.roster, 'AWAITING_AUTHORIZATION');
  assert.equal(view.state, 'AWAITING_AUTHORIZATION');
  assert.equal(view.counts.pendingInvitations, 1);
  assert.equal(view.counts.followers, 0);
});

test('roster: an invitation alongside all-held records does not claim awaiting', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_held_only', status: 'paused' });
  await store.putCopyTradingInvitation({
    id: 'inv_b',
    ownerUserId: MASTER_ID,
    tokenHash: 'h',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedAt: null,
    revokedAt: null
  });

  const view = readiness(store);
  assert.equal(view.roster, 'ALL_HELD', 'the roster is the operator action, not the invitation');
  assert.equal(view.state, 'NO_FOLLOWERS');
  assert.equal(view.counts.followers, 1);
  assert.equal(view.counts.held, 1);
  assert.equal(view.counts.pendingInvitations, 1, 'the invitation is still counted accurately');
});

test('roster: HAS_ELIGIBLE once one client is eligible', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_ok' });
  await seedFollower(store, { id: 'f_held', status: 'paused' });

  const view = readiness(store);
  assert.equal(view.roster, 'HAS_ELIGIBLE');
  assert.equal(view.counts.followers, 2);
  assert.equal(view.counts.eligible, 1);
  assert.equal(view.counts.held, 1);
});

test('roster: counts add up — followers equals eligible + held + rest', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_a' });
  await seedFollower(store, { id: 'f_b', status: 'paused' });
  await seedFollower(store, { id: 'f_c', tokenExpiresAt: NOW - 1 });
  await seedFollower(store, { id: 'f_d', tokenSealed: 'garbage' });

  const view = readiness(store);
  const { followers, eligible, held, disconnected } = view.counts;
  assert.equal(followers, 4);
  assert.equal(eligible, 1);
  assert.equal(held, 1);
  assert.equal(disconnected, 2);
  assert.equal(
    eligible + held + disconnected,
    followers,
    'every follower lands in exactly one bucket, so the numbers reconcile'
  );
});

/* ====================================================================== */
/*  Follower health vs master execution health                            */
/* ====================================================================== */

test('scope: every check is tagged follower or execution', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);

  const view = readiness(store);
  const byKey = Object.fromEntries(view.health.map((c) => [c.key, c.scope]));
  assert.deepEqual(byKey, {
    connection: 'follower',
    authorization: 'follower',
    broker: 'execution',
    reconciliation: 'execution'
  });
});

test('scope: a follower fault degrades with only the follower scope', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_bad', tokenSealed: 'not-sealed' });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED');
  assert.deepEqual(view.degraded?.by, ['follower']);
  assert.deepEqual(view.degraded?.follower, ['connection']);
  assert.deepEqual(view.degraded?.execution, []);
  assert.match(view.degraded?.summary ?? '', /client health/i);
});

test('scope: a master execution fault degrades with only the execution scope', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store); // a perfectly healthy client
  await enableControl(store);
  await store.putTradeIntent({
    id: 'int_rec',
    userId: MASTER_ID,
    accountId: 'VRTC_MASTER',
    accountMode: 'demo',
    signalId: 'sig',
    contractType: 'CALL',
    contractFamily: 'rise_fall',
    stake: 1,
    basis: 'stake',
    currency: 'USD',
    parameters: {},
    state: 'RECONCILIATION_REQUIRED',
    idempotencyKey: 'k',
    contractId: null,
    approvedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    transitions: []
  } as unknown as TradeIntentRecord);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED', 'execution health must never allow READY');
  assert.equal(view.counts.eligible, 1, 'the client really is eligible');
  assert.deepEqual(view.degraded?.by, ['execution']);
  assert.deepEqual(view.degraded?.follower, []);
  assert.deepEqual(view.degraded?.execution, ['reconciliation']);
  assert.match(view.degraded?.summary ?? '', /master execution health/i);
});

test('scope: both halves failing names both scopes', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_bad2', tokenExpiresAt: NOW - 1 });
  await enableControl(store);
  await store.putTradeIntent({
    id: 'int_unk2',
    userId: MASTER_ID,
    accountId: 'VRTC_MASTER',
    accountMode: 'demo',
    signalId: 'sig',
    contractType: 'CALL',
    contractFamily: 'rise_fall',
    stake: 1,
    basis: 'stake',
    currency: 'USD',
    parameters: {},
    state: 'UNKNOWN',
    idempotencyKey: 'k2',
    contractId: null,
    approvedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    transitions: []
  } as unknown as TradeIntentRecord);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED');
  assert.deepEqual(view.degraded?.by, ['follower', 'execution']);
  assert.deepEqual(view.degraded?.follower, ['authorization']);
  assert.deepEqual(view.degraded?.execution, ['broker']);
  assert.match(view.degraded?.summary ?? '', /client health.*master execution health/i);
});

test('scope: an unresolved master purchase outcome blocks READY even with eligible clients', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);
  await enableControl(store);
  // Baseline: everything else is ready.
  assert.equal(readiness(store).state, 'READY');

  await store.putTradeIntent({
    id: 'int_unk3',
    userId: MASTER_ID,
    accountId: 'VRTC_MASTER',
    accountMode: 'demo',
    signalId: 'sig',
    contractType: 'CALL',
    contractFamily: 'rise_fall',
    stake: 1,
    basis: 'stake',
    currency: 'USD',
    parameters: {},
    state: 'UNKNOWN',
    idempotencyKey: 'k3',
    contractId: null,
    approvedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    transitions: []
  } as unknown as TradeIntentRecord);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED', 'fail-safe: an unknown outcome outranks READY');
  assert.equal(view.control.enabled, true, 'the switch is untouched');
  assert.deepEqual(view.degraded?.execution, ['broker']);
});

test('scope: degraded is null whenever the state is not DEGRADED', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);

  const empty = readiness(store);
  assert.equal(empty.degraded, null);

  await seedFollower(store);
  assert.equal(readiness(store).degraded, null, 'PAUSED carries no degraded reason');

  await enableControl(store);
  const ready = readiness(store);
  assert.equal(ready.state, 'READY');
  assert.equal(ready.degraded, null);

  const unknown = readiness(store, 'u_missing');
  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(unknown.degraded, null);
});

test('scope: execution health is still reported when there are no clients', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await store.putTradeIntent({
    id: 'int_unk4',
    userId: MASTER_ID,
    accountId: 'VRTC_MASTER',
    accountMode: 'demo',
    signalId: 'sig',
    contractType: 'CALL',
    contractFamily: 'rise_fall',
    stake: 1,
    basis: 'stake',
    currency: 'USD',
    parameters: {},
    state: 'UNKNOWN',
    idempotencyKey: 'k4',
    contractId: null,
    approvedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    transitions: []
  } as unknown as TradeIntentRecord);

  const view = readiness(store);
  assert.equal(view.counts.followers, 0);
  assert.equal(view.roster, 'EMPTY');
  assert.equal(view.state, 'DEGRADED', 'a stuck purchase is visible before any client connects');
  assert.deepEqual(view.degraded?.by, ['execution']);
});

test('scope: reading readiness still writes nothing with the new fields', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store);
  await enableControl(store);

  const snapshot = () =>
    JSON.stringify({
      control: store.getCopyTradingControl(MASTER_ID),
      followers: store.listAllCopyTradingFollowers(),
      audit: store.listExecutionAudit().length,
      intents: store.listTradeIntents(MASTER_ID).length
    });

  const before = snapshot();
  readiness(store);
  readiness(store);
  assert.equal(snapshot(), before);
});

test('admin route: the payload exposes roster and degraded source', async () => {
  const app = await startApp();
  try {
    await seedMaster(app.store);
    await seedFollower(app.store);
    await enableControl(app.store);
    await app.store.putTradeIntent({
      id: 'int_route',
      userId: MASTER_ID,
      accountId: 'VRTC_MASTER',
      accountMode: 'demo',
      signalId: 'sig',
      contractType: 'CALL',
      contractFamily: 'rise_fall',
      stake: 1,
      basis: 'stake',
      currency: 'USD',
      parameters: {},
      state: 'UNKNOWN',
      idempotencyKey: 'k_route',
      contractId: null,
      approvedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
      transitions: []
    } as unknown as TradeIntentRecord);

    const secret = await seedAdmin(app.store, 'scope@x.com');
    const cookieHeader = await adminLogin(app.base, 'scope@x.com', secret);
    const res = await fetch(`${app.base}/api/admin/v1/copy-trading/readiness?masterUserId=${MASTER_ID}`, {
      headers: { Cookie: cookieHeader.split('; csrf=')[0] }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.readiness.state, 'DEGRADED');
    assert.equal(body.readiness.roster, 'HAS_ELIGIBLE');
    assert.deepEqual(body.readiness.degraded.by, ['execution']);
    assert.deepEqual(body.readiness.degraded.execution, ['broker']);
    assert.equal(body.readiness.counts.followers, 1);
    assert.equal(body.readiness.counts.eligible, 1);
    assert.equal(body.readiness.counts.held, 0);
    assert.equal(
      body.readiness.health.every((c: { scope: string }) => c.scope === 'follower' || c.scope === 'execution'),
      true
    );
  } finally {
    await app.close();
  }
});

/* ====================================================================== */
/*  Credential faults are independent of an administrative hold           */
/*                                                                        */
/*  A held client is skipped by the engine, so it is tempting to stop      */
/*  diagnosing it. That would let the connection check report "readable"   */
/*  about a credential that provably is not, and would hide a rotated      */
/*  session secret behind an admin hold. These pin the independence.       */
/* ====================================================================== */

test('held: an unreadable credential is still a connection fault', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_held_bad', status: 'paused', tokenSealed: 'not-a-sealed-token' });
  await enableControl(store);

  const view = readiness(store);
  const connection = view.health.find((c) => c.key === 'connection');
  assert.equal(connection?.status, 'fail', 'an admin hold must not mask an unreadable credential');
  assert.match(connection?.detail ?? '', /could not be opened/i);
  assert.equal(view.state, 'DEGRADED');
  assert.deepEqual(view.degraded?.by, ['follower']);
  assert.deepEqual(view.degraded?.follower, ['connection']);
  assert.equal(view.roster, 'ALL_HELD', 'the roster is still accurately described as held');
  assert.equal(view.counts.held, 1);
  assert.equal(view.counts.disconnected, 0, 'a hold is still not counted as a fault');
});

test('held: a readable credential keeps the connection check ok', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_held_ok', status: 'paused' });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.health.find((c) => c.key === 'connection')?.status, 'ok');
  assert.equal(view.state, 'NO_FOLLOWERS', 'a held client is not a fault on its own');
  assert.equal(view.roster, 'ALL_HELD');
});

test('held: a suspended client is diagnosed exactly like a paused one', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_susp_bad', status: 'suspended', tokenSealed: 'broken' });

  const view = readiness(store);
  assert.equal(view.health.find((c) => c.key === 'connection')?.status, 'fail');
  assert.equal(view.roster, 'ALL_HELD');
});

test('held: mixing a broken held client with a good one still degrades', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_mix_ok' });
  await seedFollower(store, { id: 'f_mix_held_bad', status: 'paused', tokenSealed: 'broken' });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.state, 'DEGRADED', 'one good client does not excuse a broken credential');
  assert.deepEqual(view.degraded?.follower, ['connection']);
  assert.equal(view.counts.eligible, 1, 'the good client is still counted as eligible');
  assert.equal(view.counts.held, 1);
  assert.equal(view.roster, 'HAS_ELIGIBLE');
});

/* ====================================================================== */
/*  AWAITING_AUTHORIZATION means nobody has connected                     */
/* ====================================================================== */

test('awaiting: records plus an invitation is not AWAITING_AUTHORIZATION', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  // Connected, but the credential is dead: a fault, not a wait.
  await seedFollower(store, { id: 'f_exp_inv', tokenExpiresAt: NOW - 1 });
  await store.putCopyTradingInvitation({
    id: 'inv_with_records',
    ownerUserId: MASTER_ID,
    tokenHash: 'h',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedAt: null,
    revokedAt: null
  });

  const view = readiness(store);
  assert.notEqual(view.roster, 'AWAITING_AUTHORIZATION', 'a record exists, so nobody is merely awaited');
  assert.equal(view.roster, 'NONE_ELIGIBLE');
  assert.equal(view.state, 'DEGRADED');
  assert.equal(view.counts.pendingInvitations, 1, 'the invitation is still counted');
  assert.equal(view.counts.followers, 1, 'the existing record is not hidden');
});

test('awaiting: an ineligible-but-not-held client with an invitation reads NONE_ELIGIBLE', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, {
    id: 'f_real_only',
    accounts: [{ accountId: 'CR_REAL', type: 'real', currency: 'USD', status: 'active' }]
  });
  await store.putCopyTradingInvitation({
    id: 'inv_real',
    ownerUserId: MASTER_ID,
    tokenHash: 'h2',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedAt: null,
    revokedAt: null
  });

  const view = readiness(store);
  assert.equal(view.roster, 'NONE_ELIGIBLE');
  assert.equal(view.counts.followers, 1);
  assert.equal(view.counts.eligible, 0);
  assert.equal(view.counts.held, 0);
  assert.equal(view.counts.pendingInvitations, 1);
});

test('awaiting: state and roster agree that nobody has connected', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await store.putCopyTradingInvitation({
    id: 'inv_only',
    ownerUserId: MASTER_ID,
    tokenHash: 'h3',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedAt: null,
    revokedAt: null
  });

  const view = readiness(store);
  assert.equal(view.state, 'AWAITING_AUTHORIZATION');
  assert.equal(view.roster, 'AWAITING_AUTHORIZATION');
  assert.equal(view.counts.followers, 0, 'awaiting implies zero records');
  assert.equal(view.counts.pendingInvitations, 1);
});

test('awaiting: state is never AWAITING while records exist', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_present', status: 'paused' });
  await store.putCopyTradingInvitation({
    id: 'inv_held',
    ownerUserId: MASTER_ID,
    tokenHash: 'h4',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedAt: null,
    revokedAt: null
  });

  const view = readiness(store);
  assert.notEqual(view.state, 'AWAITING_AUTHORIZATION');
  assert.equal(view.state, 'NO_FOLLOWERS');
  assert.equal(view.roster, 'ALL_HELD');
  assert.equal(view.counts.followers, 1);
  assert.equal(view.counts.held, 1);
  assert.equal(view.counts.pendingInvitations, 1);
});

/* ====================================================================== */
/*  The four required roster distinctions, side by side                    */
/* ====================================================================== */

test('roster: the four required distinctions are mutually exclusive and complete', async () => {
  // Each scenario is built from real persisted records, then labelled.
  const build = async (seed: (s: Store) => Promise<void>) => {
    const { store } = newStore();
    await store.load();
    await seedMaster(store);
    await seed(store);
    return readiness(store);
  };

  const invite = async (s: Store, id: string) =>
    s.putCopyTradingInvitation({
      id,
      ownerUserId: MASTER_ID,
      tokenHash: `h_${id}`,
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      consumedAt: null,
      revokedAt: null
    });

  const none = await build(async () => {});
  const awaiting = await build(async (s) => { await invite(s, 'i_a'); });
  const allHeld = await build(async (s) => {
    await seedFollower(s, { id: 'f_r1', status: 'paused' });
    await seedFollower(s, { id: 'f_r2', status: 'suspended' });
  });
  const noneEligible = await build(async (s) => {
    await seedFollower(s, { id: 'f_r3', tokenExpiresAt: NOW - 1 });
  });

  assert.deepEqual(
    [none.roster, awaiting.roster, allHeld.roster, noneEligible.roster],
    ['EMPTY', 'AWAITING_AUTHORIZATION', 'ALL_HELD', 'NONE_ELIGIBLE']
  );

  // Counts are the thing an operator acts on, so assert them explicitly.
  assert.deepEqual(
    [none.counts.followers, awaiting.counts.followers, allHeld.counts.followers, noneEligible.counts.followers],
    [0, 0, 2, 1],
    'roster count reflects real records, not eligibility'
  );
  assert.deepEqual(
    [none.counts.pendingInvitations, awaiting.counts.pendingInvitations, allHeld.counts.pendingInvitations, noneEligible.counts.pendingInvitations],
    [0, 1, 0, 0]
  );
  assert.deepEqual(
    [allHeld.counts.held, noneEligible.counts.held],
    [2, 0],
    'held counts administrative holds only, never credential faults'
  );
  for (const view of [none, awaiting, allHeld, noneEligible]) {
    assert.equal(view.counts.eligible, 0);
    assert.equal(view.state === 'READY', false, 'none of these may ever report READY');
  }
});

test('counts: followers, eligible and held are accurate across a mixed roster', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'c_ok1' });
  await seedFollower(store, { id: 'c_ok2' });
  await seedFollower(store, { id: 'c_held1', status: 'paused' });
  await seedFollower(store, { id: 'c_held2', status: 'suspended' });
  await seedFollower(store, { id: 'c_exp', tokenExpiresAt: NOW - 1 });
  await enableControl(store);

  const view = readiness(store);
  assert.equal(view.counts.followers, 5);
  assert.equal(view.counts.eligible, 2);
  assert.equal(view.counts.held, 2);
  assert.equal(view.counts.disconnected, 1);
  assert.equal(view.counts.eligible, 2, 'held clients are never also eligible');
  assert.equal(view.roster, 'HAS_ELIGIBLE');
  assert.equal(view.state, 'DEGRADED', 'the expired client still degrades the whole view');
});

test('counts: only this master\'s followers are counted', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedMaster(store, OTHER_MASTER_ID);
  await seedFollower(store, { id: 'own_1' });
  await seedFollower(store, { id: 'own_held', status: 'paused' });
  await seedFollower(store, { id: 'theirs_1', ownerUserId: OTHER_MASTER_ID });
  await seedFollower(store, { id: 'theirs_2', ownerUserId: OTHER_MASTER_ID });

  const view = readiness(store);
  assert.equal(view.counts.followers, 2, 'another master\'s clients are not counted');
  assert.equal(view.counts.eligible, 1);
  assert.equal(view.counts.held, 1);
});

test('counts: an expired invitation is not counted as pending', async () => {
  const { store } = newStore();
  await store.load();
  await seedMaster(store);
  await seedFollower(store, { id: 'f_pending_ok' });
  await store.putCopyTradingInvitation({
    id: 'inv_old',
    ownerUserId: MASTER_ID,
    tokenHash: 'hx',
    createdAt: NOW - 200_000,
    expiresAt: NOW - 1,
    consumedAt: null,
    revokedAt: null
  });
  await store.putCopyTradingInvitation({
    id: 'inv_live',
    ownerUserId: MASTER_ID,
    tokenHash: 'hy',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedAt: null,
    revokedAt: null
  });

  const view = readiness(store);
  assert.equal(view.counts.pendingInvitations, 1, 'only the live one counts');
  assert.equal(view.roster, 'HAS_ELIGIBLE', 'a live invitation does not change a healthy roster');
});
