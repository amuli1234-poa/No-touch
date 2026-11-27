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
import { AutoExecutionRunner, DAILY_TRADE_LIMIT, countTradesToday } from '../execution/autoRunner.js';
import { CopyExecutionEngine } from '../copyTrading/engine.js';
import { seal } from '../lib/crypto.js';
import type { ServerConfig } from '../config.js';
import type { SignalRecord, ExecutionPreferencesRecord } from '../execution/types.js';
import type { CopyTradingFollowerRecord } from '../copyTrading/types.js';

/**
 * Daily trade cap (24/UTC day) tests.
 *
 * After 24 trades in a UTC day, automatic trading STOPS. It does NOT queue
 * signals. It resumes automatically at the next UTC midnight when the
 * counter resets. The best signal (RISE/FALL) auto-places the trade when
 * shown — the cap only limits how many per day.
 */

const NOW = 1_000_000;
const SECRET = 'test_session_secret_at_least_32_characters_long_000';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cap-'));
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

function autoPrefs(): ExecutionPreferencesRecord {
  return {
    userId: 'u_master',
    mode: 'automatic',
    stake: { amount: 1, basis: 'stake', currency: 'USD' },
    parameters: {
      duration: 5,
      durationUnit: 'm',
      multiplier: null,
      cancellation: null,
      stopLoss: null,
      takeProfit: null
    },
    realExecutionAuthorised: false,
    autoStopped: false,
    updatedAt: NOW
  };
}

function signal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: `sig_${Math.random().toString(36).slice(2)}`,
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

async function harness(opts: { now?: () => number } = {}) {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  await store.putExecutionPreferences(autoPrefs());
  await store.putCopyTradingControl({
    ownerUserId: 'u_master',
    enabled: true,
    updatedBy: 'adm_test',
    updatedByEmail: 'admin@test',
    updatedAt: NOW,
    stoppedReason: null
  });
  const broker = new FakeBroker();
  const flags = { allowExecution: true, allowDemoExecution: true, allowRealExecution: false, allowAutomaticTrading: true };
  const gateway = new ExecutionGateway({
    store,
    cfg: makeConfig(),
    flags,
    broker,
    balanceProvider: async () => 1000,
    riskEvaluator: () => ({ approved: true, reasons: [] }),
    now: opts.now ?? (() => NOW)
  });
  const auditor = new ExecutionAuditor(store, { now: opts.now ?? (() => NOW) });
  const runner = new AutoExecutionRunner({ store, gateway, auditor, now: opts.now ?? (() => NOW) });
  const engine = new CopyExecutionEngine({ store, cfg: makeConfig(), gateway, auditor, now: opts.now ?? (() => NOW) });
  return { store, broker, gateway, runner, engine };
}

/** Pre-seed `count` executed intents for an account so the cap is reached. */
async function seedIntents(store: Store, userId: string, accountId: string, count: number, now: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.putTradeIntent({
      id: `int_seed_${i}`,
      userId,
      accountId,
      accountMode: 'demo',
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      symbol: 'R_100',
      timeframe: '5m',
      signalId: `sig_seed_${i}`,
      approvedBy: null,
      approvedAt: null,
      approvalExpiresAt: null,
      stake: 1,
      basis: 'stake',
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      state: 'OPEN',
      contractId: null,
      reason: null,
      idempotencyKey: `seed:${i}`,
      createdAt: now - 1000,
      updatedAt: now - 1000
    });
  }
}

/* ------------------------------- daily cap -------------------------------- */

test('the 24th trade executes, the 25th is refused (stop, no queue)', async () => {
  const { store, broker, runner } = await harness();
  try {
    // Pre-seed 23 intents so the next one is #24 (the last allowed).
    await seedIntents(store, 'u_master', 'M_DEMO', DAILY_TRADE_LIMIT - 1, NOW);

    // The 24th trade should execute.
    const s24 = signal({ id: 'sig_24' });
    await store.putSignal(s24);
    const r24 = await runner.runForUser(MASTER, s24, 'master-token');
    assert.equal(r24.outcome, 'executed', `24th should execute: ${JSON.stringify(r24)}`);
    assert.equal(broker.buys.length, 1);

    // The 25th should be refused — no queue, just stop.
    const s25 = signal({ id: 'sig_25' });
    await store.putSignal(s25);
    const r25 = await runner.runForUser(MASTER, s25, 'master-token');
    assert.equal(r25.outcome, 'skipped_daily_limit');
    assert.equal(broker.buys.length, 1, 'the 25th must not buy');
  } finally {
    await store.close();
  }
});

test('trading resumes automatically at the next UTC day', async () => {
  let clock = NOW;
  const { store, broker, runner } = await harness({ now: () => clock });
  try {
    // Fill the cap.
    await seedIntents(store, 'u_master', 'M_DEMO', DAILY_TRADE_LIMIT, NOW);

    // A signal on the same day is refused.
    const s1 = signal({ id: 'sig_cap', createdAt: NOW, expiresAt: NOW + 60_000 });
    await store.putSignal(s1);
    const r1 = await runner.runForUser(MASTER, s1, 'master-token');
    assert.equal(r1.outcome, 'skipped_daily_limit');
    assert.equal(broker.buys.length, 0);

    // Advance to the next UTC day — the counter resets, trading resumes.
    const nextDay = NOW + 24 * 60 * 60 * 1000;
    clock = nextDay;

    const s2 = signal({ id: 'sig_next', createdAt: nextDay, expiresAt: nextDay + 60_000 });
    await store.putSignal(s2);
    const r2 = await runner.runForUser(MASTER, s2, 'master-token');
    assert.equal(r2.outcome, 'executed', `next day should resume: ${JSON.stringify(r2)}`);
    assert.equal(broker.buys.length, 1, 'the next day should buy');
  } finally {
    await store.close();
  }
});

test('multiple signals on the capped day are all refused (no queue builds up)', async () => {
  const { store, broker, runner } = await harness();
  try {
    await seedIntents(store, 'u_master', 'M_DEMO', DAILY_TRADE_LIMIT, NOW);

    // Fire 5 signals — all should be refused, none queued.
    for (let i = 0; i < 5; i++) {
      const s = signal({ id: `sig_${i}` });
      await store.putSignal(s);
      const r = await runner.runForUser(MASTER, s, 'master-token');
      assert.equal(r.outcome, 'skipped_daily_limit', `signal ${i} should be refused`);
    }
    assert.equal(broker.buys.length, 0, 'no buys on the capped day');
  } finally {
    await store.close();
  }
});

/* --------------------------- copy cap per follower ------------------------ */

test('follower copies count toward the follower own daily cap, not the master', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower());
    const input = {
      master: MASTER,
      masterAccessToken: 'master-token',
      signal: signal(),
      masterIntentId: 'int_master_1',
      stake: 1,
      basis: 'stake' as const,
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm' as const, multiplier: null, cancellation: null, stopLoss: null, takeProfit: null }
    };
    const outcomes = await engine.mirrorMasterTrade(input);
    assert.equal(outcomes[0].outcome, 'copied');
    assert.equal(broker.buys.length, 1);
  } finally {
    await store.close();
  }
});

test('a follower at the daily cap is skipped, not copied', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower());
    // Pre-seed the follower's account to the cap.
    await seedIntents(store, 'copy_follower_f_1', 'F1_DEMO', DAILY_TRADE_LIMIT, NOW);

    const input = {
      master: MASTER,
      masterAccessToken: 'master-token',
      signal: signal(),
      masterIntentId: 'int_master_2',
      stake: 1,
      basis: 'stake' as const,
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm' as const, multiplier: null, cancellation: null, stopLoss: null, takeProfit: null }
    };
    const outcomes = await engine.mirrorMasterTrade(input);
    assert.equal(outcomes[0].outcome, 'skipped');
    assert.equal(outcomes[0].reason, 'daily_limit_reached');
    assert.equal(broker.buys.length, 0, 'a capped follower must not buy');
  } finally {
    await store.close();
  }
});

test('the master cap does not affect the follower cap (independent counters)', async () => {
  const { store, broker, engine } = await harness();
  try {
    await store.putCopyTradingFollower(follower());
    // Master is at the cap, but the follower is not.
    await seedIntents(store, 'u_master', 'M_DEMO', DAILY_TRADE_LIMIT, NOW);

    const input = {
      master: MASTER,
      masterAccessToken: 'master-token',
      signal: signal(),
      masterIntentId: 'int_master_3',
      stake: 1,
      basis: 'stake' as const,
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm' as const, multiplier: null, cancellation: null, stopLoss: null, takeProfit: null }
    };
    const outcomes = await engine.mirrorMasterTrade(input);
    assert.equal(outcomes[0].outcome, 'copied', `follower should copy despite master cap: ${JSON.stringify(outcomes[0])}`);
    assert.equal(broker.buys.length, 1);
  } finally {
    await store.close();
  }
});

/* ------------------------------ countTradesToday -------------------------- */

test('countTradesToday counts only intents since UTC midnight', async () => {
  const { store } = await harness();
  try {
    const dayStart = new Date(NOW).setUTCHours(0, 0, 0, 0);
    // One intent before midnight, one after.
    await store.putTradeIntent({
      id: 'int_old', userId: 'u_master', accountId: 'M_DEMO', accountMode: 'demo',
      contractFamily: 'rise_fall', contractType: 'CALL', symbol: 'R_100', timeframe: '5m',
      signalId: 'sig_old', approvedBy: null, approvedAt: null, approvalExpiresAt: null,
      stake: 1, basis: 'stake', currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      state: 'OPEN', contractId: null, reason: null, idempotencyKey: 'old',
      createdAt: dayStart - 1, updatedAt: dayStart - 1
    });
    await store.putTradeIntent({
      id: 'int_new', userId: 'u_master', accountId: 'M_DEMO', accountMode: 'demo',
      contractFamily: 'rise_fall', contractType: 'CALL', symbol: 'R_100', timeframe: '5m',
      signalId: 'sig_new', approvedBy: null, approvedAt: null, approvalExpiresAt: null,
      stake: 1, basis: 'stake', currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      state: 'OPEN', contractId: null, reason: null, idempotencyKey: 'new',
      createdAt: dayStart + 1, updatedAt: dayStart + 1
    });

    assert.equal(countTradesToday(store, 'u_master', 'M_DEMO', NOW), 1, 'only the post-midnight intent counts');
  } finally {
    await store.close();
  }
});