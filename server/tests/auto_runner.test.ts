import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import { ExecutionGateway, ExecutionError } from '../execution/gateway.js';
import { AutoExecutionRunner } from '../execution/autoRunner.js';
import { contractTypeFor } from '../services/signals.js';
import { ExecutionAuditor } from '../execution/audit.js';
import { FakeBroker } from '../execution/broker/fakeBroker.js';
import type { ServerConfig } from '../config.js';
import type {
  SignalRecord,
  ExecutionPreferencesRecord,
  DerivContractType,
  ContractFamily
} from '../execution/types.js';

/**
 * Phase 7 tests: automatic DEMO execution. The loop is driven with a scripted
 * gateway risk outcome and the deterministic fake broker, so every safety
 * property — mode gating, single-flight, auto-stop, DEMO-only — is proven
 * without a live account.
 */

const NOW = 1_000_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-auto-'));
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

const USER: UserRecord = {
  id: 'u_a',
  derivSub: 'sub_a',
  accounts: [
    { accountId: 'DEMO', type: 'demo', currency: 'USD', status: 'active' },
    { accountId: 'REAL', type: 'real', currency: 'USD', status: 'active' }
  ],
  createdAt: NOW,
  updatedAt: NOW,
  preferences: {}
};

function signal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: 'sig_1',
    userId: 'u_a',
    accountId: 'DEMO',
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

function prefs(overrides: Partial<ExecutionPreferencesRecord> = {}): ExecutionPreferencesRecord {
  return {
    userId: 'u_a',
    mode: 'automatic',
    contractFamily: 'rise_fall',
    preferredAccountId: { demo: 'DEMO' },
    stake: { basis: 'stake', amount: 1, currency: 'USD' },
    parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
    realExecutionAuthorised: false,
    autoStopped: false,
    updatedAt: NOW,
    ...overrides
  };
}

async function harness(opts: { risk?: { approved: boolean; reasons: string[] } } = {}) {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const broker = new FakeBroker();
  const flags = { allowExecution: true, allowDemoExecution: true, allowRealExecution: false };
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
  const runner = new AutoExecutionRunner({ store, gateway, auditor, now: () => NOW });
  return { store, broker, gateway, runner };
}

async function seedSignal(store: Store, overrides: Partial<SignalRecord> = {}): Promise<SignalRecord> {
  const s = signal(overrides);
  await store.putSignal(s);
  return s;
}

/* --------------------------------- gating --------------------------------- */

test('automatic execution runs for an automatic user and buys on the fake broker', async () => {
  const { store, broker, runner } = await harness();
  try {
    await store.putExecutionPreferences(prefs());
    const sig = await seedSignal(store);
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'executed', JSON.stringify(out));
    assert.equal(out.result?.intent.state, 'OPEN');
    assert.equal(broker.buys.length, 1);
  } finally {
    await store.close();
  }
});

test('a manual-mode user is never auto-submitted', async () => {
  const { store, broker, runner } = await harness();
  try {
    await store.putExecutionPreferences(prefs({ mode: 'manual' }));
    const sig = await seedSignal(store);
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'skipped_manual_mode');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('a user with no preferences is never auto-submitted', async () => {
  const { store, broker, runner } = await harness();
  try {
    const sig = await seedSignal(store);
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'skipped_manual_mode');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('an engaged auto-stop blocks automatic execution', async () => {
  const { store, broker, runner } = await harness();
  try {
    await store.putExecutionPreferences(prefs({ autoStopped: true }));
    const sig = await seedSignal(store);
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'skipped_stopped');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('a REAL signal is never auto-submitted, even for an automatic user', async () => {
  const { store, broker, runner } = await harness();
  try {
    await store.putExecutionPreferences(prefs({ realExecutionAuthorised: true }));
    const sig = await seedSignal(store, { accountId: 'REAL', accountMode: 'real' });
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'skipped_real');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

test('an account the user does not own is rejected', async () => {
  const { store, runner } = await harness();
  try {
    await store.putExecutionPreferences(prefs());
    const sig = await seedSignal(store, { accountId: 'NOT_MINE' });
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'rejected');
  } finally {
    await store.close();
  }
});

/* -------------------------------- auto-stop ------------------------------- */

test('a terminal risk breach engages auto-stop and persists it', async () => {
  const { store, runner } = await harness({ risk: { approved: false, reasons: ['daily_loss'] } });
  try {
    await store.putExecutionPreferences(prefs());
    const sig = await seedSignal(store);
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'rejected');
    assert.equal(store.getExecutionPreferences('u_a')?.autoStopped, true, 'auto-stop must persist');

    // A later signal is now skipped because the stop is engaged.
    const sig2 = await seedSignal(store, { id: 'sig_2' });
    const out2 = await runner.runForUser(USER, sig2, 'tok');
    assert.equal(out2.outcome, 'skipped_stopped');
  } finally {
    await store.close();
  }
});

test('a non-terminal risk rejection does not engage auto-stop', async () => {
  const { store, runner } = await harness({ risk: { approved: false, reasons: ['max_stake'] } });
  try {
    await store.putExecutionPreferences(prefs());
    const sig = await seedSignal(store);
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'rejected');
    assert.equal(store.getExecutionPreferences('u_a')?.autoStopped, false, 'a transient rejection must not stop the user');
  } finally {
    await store.close();
  }
});

/* ------------------------------ single flight ----------------------------- */

test('a second signal for an account in flight is skipped, not queued', async () => {
  const { store, runner } = await harness();
  try {
    await store.putExecutionPreferences(prefs());
    const sigA = await seedSignal(store, { id: 'sig_a' });
    const sigB = await seedSignal(store, { id: 'sig_b' });
    // Fire both at once for the same account.
    const [a, b] = await Promise.all([runner.runForUser(USER, sigA, 'tok'), runner.runForUser(USER, sigB, 'tok')]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ['executed', 'skipped_in_flight']);
  } finally {
    await store.close();
  }
});

/* ------------------------------- kill switch ------------------------------ */

test('automatic execution is skipped when execution is disabled server-side', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    await store.putExecutionPreferences(prefs());
    const broker = new FakeBroker();
    const gateway = new ExecutionGateway({
      store,
      cfg: makeConfig(),
      flags: { allowExecution: false, allowDemoExecution: false, allowRealExecution: false },
      broker,
      balanceProvider: async () => 1000,
      riskEvaluator: () => ({ approved: true, reasons: [] }),
      now: () => NOW
    });
    const runner = new AutoExecutionRunner({ store, gateway, auditor: new ExecutionAuditor(store), now: () => NOW });
    const sig = await seedSignal(store);
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'skipped_disabled');
    assert.equal(broker.buys.length, 0);
  } finally {
    await store.close();
  }
});

/* ------------------------------- contract type ---------------------------- */

test('contractTypeFor maps direction within each family', () => {
  assert.equal(contractTypeFor('RISE', 'rise_fall' as ContractFamily), 'CALL' as DerivContractType);
  assert.equal(contractTypeFor('FALL', 'rise_fall' as ContractFamily), 'PUT' as DerivContractType);
  assert.equal(contractTypeFor('RISE', 'multipliers' as ContractFamily), 'MULTUP' as DerivContractType);
  assert.equal(contractTypeFor('FALL', 'multipliers' as ContractFamily), 'MULTDOWN' as DerivContractType);
  assert.throws(() => contractTypeFor('NONE', 'rise_fall' as ContractFamily));
});

test('automatic execution uses the customer stake from preferences, never the signal', async () => {
  const { store, broker, runner } = await harness();
  try {
    await store.putExecutionPreferences(prefs({ stake: { basis: 'stake', amount: 7, currency: 'USD' } }));
    const sig = await seedSignal(store);
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'executed');
    assert.equal(broker.proposals[0].payload.amount, 7, 'the preference stake is used');
    assert.equal(out.result?.intent.stake, 7);
  } finally {
    await store.close();
  }
});
