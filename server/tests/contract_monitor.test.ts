import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import { ExecutionGateway } from '../execution/gateway.js';
import { AutoExecutionRunner } from '../execution/autoRunner.js';
import { ContractMonitor } from '../execution/contractMonitor.js';
import { ExecutionAuditor } from '../execution/audit.js';
import { FakeBroker, uncertainBuyError } from '../execution/broker/fakeBroker.js';
import type { ServerConfig } from '../config.js';
import type { SignalRecord, ExecutionPreferencesRecord } from '../execution/types.js';

/**
 * Phase 8 tests: contract monitoring and reconciliation.
 *
 * Proves settlement is idempotent (a replayed update never double-posts), that
 * the ledger and the intent both reach the right terminal state, and that an
 * UNKNOWN purchase is reconciled against Deriv's record — opened, settled, or
 * failed — never retried.
 */

const NOW = 1_000_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-monitor-'));
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
  accounts: [{ accountId: 'DEMO', type: 'demo', currency: 'USD', status: 'active' }],
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

async function harness(opts: { script?: any } = {}) {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const broker = new FakeBroker({ script: opts.script });
  const flags = { allowExecution: true, allowDemoExecution: true, allowRealExecution: false };
  const gateway = new ExecutionGateway({
    store,
    cfg: makeConfig(),
    flags,
    broker,
    balanceProvider: async () => 1000,
    riskEvaluator: () => ({ approved: true, reasons: [] }),
    now: () => NOW
  });
  const auditor = new ExecutionAuditor(store, { now: () => NOW });
  const monitor = new ContractMonitor({ store, broker, auditor, now: () => NOW });
  // Wire the gateway to the monitor the way production composition does.
  (gateway as any).onContractOpened = (user: UserRecord, contract: any, token: string) =>
    monitor.monitor(user, contract, token);
  const runner = new AutoExecutionRunner({ store, gateway, auditor, now: () => NOW });
  return { store, broker, gateway, monitor, runner };
}

async function openOneContract(store: Store, broker: FakeBroker, runner: AutoExecutionRunner) {
  await store.putExecutionPreferences(prefs());
  const sig = signal();
  await store.putSignal(sig);
  const out = await runner.runForUser(USER, sig, 'tok');
  assert.equal(out.outcome, 'executed', JSON.stringify(out));
  const contract = store.listContracts('u_a')[0];
  return { sig, contract, intentId: out.result!.intent.id };
}

/* -------------------------------- settlement ------------------------------ */

test('a winning contract settles once and posts exactly one settlement entry', async () => {
  const { store, broker, monitor, runner } = await harness();
  try {
    const { contract } = await openOneContract(store, broker, runner);
    assert.equal(store.listLedgerEntries('u_a').length, 1, 'stake entry only, before settlement');

    broker.emitContract(Number(contract.id), 'won', 0.95);
    // The update is delivered asynchronously through the subscription.
    await new Promise((r) => setTimeout(r, 5));

    const settled = store.getContract('u_a', contract.id)!;
    assert.equal(settled.status, 'won');
    assert.equal(settled.profit, 0.95);

    const ledger = store.listLedgerEntries('u_a');
    const settlements = ledger.filter((e) => e.kind === 'settlement');
    assert.equal(settlements.length, 1, 'exactly one settlement entry');
    assert.equal(settlements[0].amount, 0.95);
    assert.equal(store.getTradeIntent('u_a', store.listTradeIntents('u_a')[0].id)!.state, 'SETTLED');
  } finally {
    monitor.close();
    await store.close();
  }
});

test('a replayed settlement update does not double-post to the ledger', async () => {
  const { store, broker, monitor, runner } = await harness();
  try {
    const { contract } = await openOneContract(store, broker, runner);
    const settledContract = store.getContract('u_a', contract.id)!;
    await monitor.settle(USER, settledContract, {
      contractId: Number(contract.id),
      status: 'won',
      profit: 0.95,
      isExpired: true,
      entrySpot: 100,
      exitSpot: 101,
      currentSpot: 101,
      payout: 1.95,
      dateStart: NOW,
      dateExpiry: NOW,
      dateSettlement: NOW
    });
    // Replay the same terminal update.
    await monitor.settle(USER, store.getContract('u_a', contract.id)!, {
      contractId: Number(contract.id),
      status: 'won',
      profit: 0.95,
      isExpired: true,
      entrySpot: 100,
      exitSpot: 101,
      currentSpot: 101,
      payout: 1.95,
      dateStart: NOW,
      dateExpiry: NOW,
      dateSettlement: NOW
    });
    const settlements = store.listLedgerEntries('u_a').filter((e) => e.kind === 'settlement');
    assert.equal(settlements.length, 1, 'the dedupeKey prevents a double-post');
  } finally {
    monitor.close();
    await store.close();
  }
});

test('a losing contract records a zero-or-negative settlement and no profit', async () => {
  const { store, broker, monitor, runner } = await harness();
  try {
    const { contract } = await openOneContract(store, broker, runner);
    broker.emitContract(Number(contract.id), 'lost', -1);
    await new Promise((r) => setTimeout(r, 5));
    const settled = store.getContract('u_a', contract.id)!;
    assert.equal(settled.status, 'lost');
    assert.equal(settled.profit, -1);
    const settlements = store.listLedgerEntries('u_a').filter((e) => e.kind === 'settlement');
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].amount, -1);
  } finally {
    monitor.close();
    await store.close();
  }
});

test('an open update refreshes the live fields without settling', async () => {
  const { store, broker, monitor, runner } = await harness();
  try {
    const { contract } = await openOneContract(store, broker, runner);
    await monitor.onUpdate(USER, contract.id, {
      contractId: Number(contract.id),
      status: 'open',
      profit: null,
      isExpired: false,
      entrySpot: 100,
      exitSpot: null,
      currentSpot: 103,
      payout: 1.95,
      dateStart: NOW,
      dateExpiry: NOW + 300,
      dateSettlement: null
    });
    const refreshed = store.getContract('u_a', contract.id)!;
    assert.equal(refreshed.status, 'open');
    assert.equal(refreshed.payout, 1.95);
    assert.equal(store.listLedgerEntries('u_a').filter((e) => e.kind === 'settlement').length, 0);
  } finally {
    monitor.close();
    await store.close();
  }
});

/* ------------------------------ reconciliation ---------------------------- */

test('an UNKNOWN purchase is reconciled to OPEN when Deriv has the contract', async () => {
  const { store, broker, gateway, monitor } = await harness({ script: { buyError: uncertainBuyError() } });
  try {
    await store.putExecutionPreferences(prefs());
    const sig = signal();
    await store.putSignal(sig);
    const intent = await gateway.createIntent({
      user: USER,
      accountId: 'DEMO',
      signal: sig,
      contractType: 'CALL',
      contractFamily: 'rise_fall',
      stake: 1,
      basis: 'stake',
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      idempotencyKey: 'k1'
    });
    await assert.rejects(() => gateway.submit(USER, intent.id, 'tok'));
    const stuck = store.getTradeIntent('u_a', intent.id)!;
    assert.equal(stuck.state, 'RECONCILIATION_REQUIRED');

    // Deriv does have the contract: the portfolio reports it, even though we
    // never received its id in the buy response.
    const contractId = broker.issuedContractIds()[0];
    broker.setScript({
      openContracts: [
        {
          contractId,
          status: 'open',
          profit: null,
          isExpired: false,
          entrySpot: 100,
          exitSpot: null,
          currentSpot: 100,
          payout: 1.95,
          dateStart: NOW,
          dateExpiry: NOW + 300,
          dateSettlement: null
        }
      ]
    });
    const reconciled = await monitor.reconcile(USER, intent.id, 'tok');
    assert.equal(reconciled!.state, 'OPEN');
    assert.equal(reconciled!.contractId, contractId);
  } finally {
    monitor.close();
    await store.close();
  }
});

test('an UNKNOWN purchase with no Deriv contract fails safely', async () => {
  const { store, gateway, monitor } = await harness({ script: { buyError: uncertainBuyError() } });
  try {
    await store.putExecutionPreferences(prefs());
    const sig = signal();
    await store.putSignal(sig);
    const intent = await gateway.createIntent({
      user: USER,
      accountId: 'DEMO',
      signal: sig,
      contractType: 'CALL',
      contractFamily: 'rise_fall',
      stake: 1,
      basis: 'stake',
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      idempotencyKey: 'k2'
    });
    // Give the intent a contract id the fake knows nothing about, so the probe
    // times out (no update arrives) — the purchase never landed.
    await assert.rejects(() => gateway.submit(USER, intent.id, 'tok'));
    const stuck = store.getTradeIntent('u_a', intent.id)!;
    stuck.contractId = 424242;
    await store.putTradeIntent(stuck);

    const reconciled = await monitor.reconcile(USER, intent.id, 'tok');
    assert.equal(reconciled!.state, 'FAILED');
  } finally {
    monitor.close();
    await store.close();
  }
});

test('reconciling an intent that is not stuck is a no-op', async () => {
  const { store, broker, monitor, runner } = await harness();
  try {
    const { intentId } = await openOneContract(store, broker, runner);
    const result = await monitor.reconcile(USER, intentId, 'tok');
    assert.equal(result!.state, 'OPEN', 'an OPEN intent is returned unchanged');
  } finally {
    monitor.close();
    await store.close();
  }
});
