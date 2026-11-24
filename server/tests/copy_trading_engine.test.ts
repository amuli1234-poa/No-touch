import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import { ExecutionGateway } from '../execution/gateway.js';
import { ExecutionAuditor } from '../execution/audit.js';
import { FakeBroker } from '../execution/broker/fakeBroker.js';
import { CopyExecutionEngine } from '../copyTrading/engine.js';
import { seal } from '../lib/crypto.js';
import type { ServerConfig } from '../config.js';
import type { SignalRecord } from '../execution/types.js';
import type { CopyTradingFollowerRecord } from '../copyTrading/types.js';

/**
 * DEMO copy trading.
 *
 * The engine is exercised against the real gateway and the deterministic fake
 * broker, so what is asserted is the true execution path rather than a stand-in.
 * Most tests assert what must NOT happen: a REAL follower is never copied, a
 * held follower is never copied, a REAL master trade is never mirrored, and one
 * follower's refusal never stops the others.
 */

const NOW = 1_000_000;
const SECRET = 'test_session_secret_at_least_32_characters_long_000';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-copy-'));
}

function makeConfig(): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir: os.tmpdir(),
    storageEngine: 'auto',
    telemetry: { retentionDays: 30, scannerSessionTtlSeconds: 120 },
    deriv: {
      appId: 'test-app',
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

const MASTER: UserRecord = {
  id: 'u_master',
  derivSub: 'sub_master',
  accounts: [{ accountId: 'M_DEMO', type: 'demo', currency: 'USD', status: 'active' }],
  createdAt: NOW,
  updatedAt: NOW,
  preferences: {}
};

function masterSignal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: 'sig_master',
    userId: 'u_master',
    accountId: 'M_DEMO',
    accountMode: 'demo',
    symbol: 'R_100',
    timeframe: '5m',
    direction: 'RISE',
    contractFamily: 'rise_fall',
    analysisId: 'an_1',
    zone: null,
    entryPrice: 100,
    confidence: 0.7,
    reason: '',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedByIntentId: null,
    ...overrides
  };
}

function follower(overrides: Partial<CopyTradingFollowerRecord> = {}): CopyTradingFollowerRecord {
  return {
    id: 'f_1',
    ownerUserId: 'u_master',
    derivSub: 'sub_follower_1',
    authMethod: 'pat',
    loginId: 'CR1',
    accounts: [{ accountId: 'F1_DEMO', type: 'demo', currency: 'USD', status: 'active' }],
    tokenSealed: seal('follower-token-1', SECRET),
    tokenExpiresAt: 0,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'active',
    revision: 1,
    ...overrides
  };
}

const PARAMS = {
  duration: 5,
  durationUnit: 'm' as const,
  multiplier: null,
  cancellation: null,
  stopLoss: null,
  takeProfit: null
};

async function harness(opts: { risk?: { approved: boolean; reasons: string[] } } = {}) {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const broker = new FakeBroker();
  const flags = { allowExecution: true, allowDemoExecution: true, allowRealExecution: false, allowAutomaticTrading: true };
  const gateway = new ExecutionGateway({
    store,
    cfg: makeConfig(),
    flags,
    broker,
    balanceProvider: async () => 1000,
    riskEvaluator: () => opts.risk ?? { approved: true, reasons: [] },
    now: () => NOW
  });
  const auditor = new ExecutionAuditor(store, { now: () => NOW });
  const engine = new CopyExecutionEngine({ store, cfg: makeConfig(), gateway, auditor, now: () => NOW });
  return { store, broker, gateway, engine };
}

function mirrorInput(overrides: Partial<Parameters<CopyExecutionEngine['mirrorMasterTrade']>[0]> = {}) {
  return {
    master: MASTER,
    signal: masterSignal(),
    masterIntentId: 'int_master',
    stake: 5,
    basis: 'stake' as const,
    currency: 'USD',
    parameters: PARAMS,
    ...overrides
  };
}

/* --------------------------------- copying -------------------------------- */

test('an active follower copies the master DEMO trade into their own account', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower());
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, 'copied', JSON.stringify(outcomes[0]));
    assert.equal(outcomes[0].accountId, 'F1_DEMO');
    assert.equal(outcomes[0].contractId, 500_000);
    assert.equal(broker.buys.length, 1);
    // The copied purchase was made on the follower's account, not the master's.
    assert.equal(broker.buys[0].accountId, 'F1_DEMO');
  } finally {
    await store.close();
  }
});

test('the copied intent belongs to the follower principal, not the master', async () => {
  const { store, gateway, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower());
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    const intent = store.getTradeIntent('copy_follower_f_1', outcomes[0].intentId!);
    assert.ok(intent, 'the intent must be stored under the follower principal');
    assert.equal(intent!.accountId, 'F1_DEMO');
    assert.equal(intent!.accountMode, 'demo');
    assert.equal(intent!.stake, 5);
    assert.equal(store.getTradeIntent('u_master', outcomes[0].intentId!), null);
  } finally {
    await store.close();
  }
});

test('a paused follower is skipped and never buys', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower({ status: 'paused' }));
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(outcomes[0].outcome, 'skipped');
    assert.equal(outcomes[0].reason, 'follower_held');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('a suspended follower is skipped and never buys', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower({ status: 'suspended' }));
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(outcomes[0].outcome, 'skipped');
    assert.equal(outcomes[0].reason, 'follower_held');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('a follower with only a REAL account is never copied', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(
      follower({ accounts: [{ accountId: 'F1_REAL', type: 'real', currency: 'USD', status: 'active' }] })
    );
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(outcomes[0].outcome, 'skipped');
    assert.equal(outcomes[0].reason, 'no_demo_account');
    assert.equal(broker.buys.length, 0, 'a REAL account must never be bought for');
  } finally {
    await store.close();
  }
});

test('a REAL master trade is never mirrored', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower());
    const outcomes = await engine.mirrorMasterTrade(
      mirrorInput({ signal: masterSignal({ accountMode: 'real' }) })
    );
    assert.deepEqual(outcomes, []);
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('a follower that fails does not stop the next follower from copying', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower({ id: 'f_1', status: 'paused' }));
    await store.putCopyTradingFollower(
      follower({
        id: 'f_2',
        derivSub: 'sub_follower_2',
        accounts: [{ accountId: 'F2_DEMO', type: 'demo', currency: 'USD', status: 'active' }],
        tokenSealed: seal('follower-token-2', SECRET)
      })
    );
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].outcome, 'skipped');
    assert.equal(outcomes[1].outcome, 'copied', JSON.stringify(outcomes[1]));
    assert.equal(broker.buys.length, 1);
  } finally {
    await store.close();
  }
});

test('an untradable (non-active) demo account is not copied', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(
      follower({ accounts: [{ accountId: 'F1_DEMO', type: 'demo', currency: 'USD', status: 'suspended' }] })
    );
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(outcomes[0].reason, 'no_demo_account');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('an expired follower token is skipped', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower({ tokenExpiresAt: NOW - 1 }));
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(outcomes[0].reason, 'token_expired');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('the kill switches still gate a copied trade', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const broker = new FakeBroker();
  // Master switch on, DEMO switch OFF: copying must not buy.
  const gateway = new ExecutionGateway({
    store,
    cfg: makeConfig(),
    flags: { allowExecution: true, allowDemoExecution: false, allowRealExecution: false, allowAutomaticTrading: false },
    broker,
    balanceProvider: async () => 1000,
    riskEvaluator: () => ({ approved: true, reasons: [] }),
    now: () => NOW
  });
  const auditor = new ExecutionAuditor(store, { now: () => NOW });
  const engine = new CopyExecutionEngine({ store, cfg: makeConfig(), gateway, auditor, now: () => NOW });
  try {
    await store.putCopyTradingFollower(follower());
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(outcomes[0].outcome, 'rejected');
    assert.equal(outcomes[0].reason, 'execution_disabled');
    assert.equal(broker.buys.length, 0, 'the demo kill switch must stop copying');
  } finally {
    await store.close();
  }
});

test('a follower held by risk is rejected, not copied', async () => {
  const { store, broker, engine } = await harness({ risk: { approved: false, reasons: ['daily_loss'] } });
  try {
    await store.putCopyTradingFollower(follower());
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(outcomes[0].outcome, 'rejected');
    assert.equal(outcomes[0].reason, 'risk_rejected');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('a follower owned by another manager is not mirrored', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower({ ownerUserId: 'u_someone_else' }));
    const outcomes = await engine.mirrorMasterTrade(mirrorInput());
    assert.deepEqual(outcomes, []);
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('the same master trade cannot be copied twice (idempotent)', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower());
    await engine.mirrorMasterTrade(mirrorInput());
    const second = await engine.mirrorMasterTrade(mirrorInput());
    assert.equal(broker.buys.length, 1, 'the retry must not place a second copy');
    assert.equal(second[0].outcome, 'skipped', JSON.stringify(second[0]));
    assert.equal(second[0].reason, 'already_copied');
  } finally {
    await store.close();
  }
});
