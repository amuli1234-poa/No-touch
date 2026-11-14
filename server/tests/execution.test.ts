import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import { ExecutionGateway, ExecutionError } from '../execution/gateway.js';
import { ExecutionLocks, LockTimeoutError } from '../execution/locks.js';
import { FakeBroker, uncertainBuyError } from '../execution/broker/fakeBroker.js';
import { BrokerError } from '../execution/broker/types.js';
import { assertTransition, canTransition, IllegalTransitionError } from '../execution/stateMachine.js';
import { redact } from '../execution/audit.js';
import { RISE_FALL_ADAPTER, MULTIPLIERS_ADAPTER, AdapterError } from '../execution/adapters/index.js';
import { loadExecutionFlags } from '../config/flags.js';
import type { ServerConfig } from '../config.js';
import type { SignalRecord, ContractFamily, DerivContractType, ExecutionPreferencesRecord } from '../execution/types.js';

/**
 * Phase 6 tests: the manual DEMO execution gateway, driven by the deterministic
 * fake broker. These prove the safety guarantees — kill switches, ownership,
 * risk gating, single-use signals, idempotency, account locking, honest handling
 * of uncertain outcomes — without touching Deriv or placing a real trade.
 */

const NOW = 1_000_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-exec-'));
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

function user(accounts: UserRecord['accounts']): UserRecord {
  const now = Date.now();
  return { id: 'u_a', derivSub: 'sub_a', accounts, createdAt: now, updatedAt: now, preferences: {} };
}

const USER = user([
  { accountId: 'DEMO', type: 'demo', currency: 'USD', status: 'active' },
  { accountId: 'REAL', type: 'real', currency: 'USD', status: 'active' }
]);

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

interface Harness {
  store: Store;
  broker: FakeBroker;
  gateway: ExecutionGateway;
  flags: ReturnType<typeof loadExecutionFlags>;
}

async function harness(opts: {
  flags?: Partial<ReturnType<typeof loadExecutionFlags>>;
  risk?: { approved: boolean; reasons: string[] };
  balance?: number | null;
  token?: string | null;
  locks?: ExecutionLocks;
  script?: ConstructorParameters<typeof FakeBroker>[0]['script'];
} = {}): Promise<Harness> {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const broker = new FakeBroker({ script: opts.script });
  const flags = { allowExecution: true, allowDemoExecution: true, allowRealExecution: false, ...opts.flags };
  const gateway = new ExecutionGateway({
    store,
    cfg: makeConfig(),
    flags,
    broker,
    balanceProvider: async () => (opts.balance === undefined ? 1000 : opts.balance),
    riskEvaluator: () => opts.risk ?? { approved: true, reasons: [] },
    locks: opts.locks,
    now: () => NOW
  });
  return { store, broker, gateway, flags };
}

async function seedSignal(store: Store, overrides: Partial<SignalRecord> = {}): Promise<SignalRecord> {
  const s = signal(overrides);
  await store.putSignal(s);
  return s;
}

function intentInput(sig: SignalRecord, overrides: Record<string, unknown> = {}) {
  return {
    user: USER,
    accountId: sig.accountId,
    signal: sig,
    contractType: 'CALL' as DerivContractType,
    contractFamily: 'rise_fall' as ContractFamily,
    stake: 1,
    basis: 'stake' as const,
    currency: 'USD',
    parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
    idempotencyKey: 'idem_1',
    manualApproval: { approvedAt: NOW, expiresAt: NOW + 15_000 },
    ...overrides
  };
}

/* ------------------------------- happy path ------------------------------- */

test('a valid manual DEMO intent executes and records contract, ledger and audit', async () => {
  const { store, broker, gateway } = await harness();
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(intentInput(sig));
    assert.equal(intent.state, 'CREATED');

    const result = await gateway.submit(USER, intent.id, 'fake-token');
    assert.equal(result.intent.state, 'OPEN');
    assert.ok(result.contractId);

    // The contract is recorded as open, tenant-scoped.
    const contract = store.getContract('u_a', String(result.contractId));
    assert.equal(contract?.status, 'open');
    assert.equal(contract?.accountId, 'DEMO');

    // The stake is a ledger entry.
    const ledger = store.listLedgerEntries('u_a');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].kind, 'stake');
    assert.ok(ledger[0].amount < 0);

    // The signal is consumed, so it can never drive a second trade.
    assert.equal(store.getSignal('u_a', sig.id)?.consumedByIntentId, intent.id);

    // Attempts are recorded.
    const attempts = store.listExecutionAttempts('u_a', intent.id);
    assert.deepEqual(attempts.map((a) => a.phase), ['proposal', 'purchase']);

    // Audit has an allowed purchase and never contains the token.
    const audit = store.listExecutionAudit();
    assert.ok(audit.some((a) => a.action === 'execution.purchase' && a.outcome === 'allowed'));
    assert.ok(!JSON.stringify(audit).includes('fake-token'));

    // The broker was asked to buy exactly once, at the proposal's ask price
    // (which the fake derives from the requested amount).
    assert.equal(broker.buys.length, 1);
    assert.equal(broker.buys[0].price, broker.proposals[0].payload.amount);
  } finally {
    await store.close();
  }
});

/* ------------------------------ kill switches ----------------------------- */

test('the master switch off blocks execution and audits the denial', async () => {
  const { store, gateway } = await harness({ flags: { allowExecution: false } });
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(intentInput(sig));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'execution_disabled'
    );
    assert.equal(store.getTradeIntent('u_a', intent.id)?.state, 'REJECTED');
    assert.ok(store.listExecutionAudit().some((a) => a.outcome === 'denied'));
  } finally {
    await store.close();
  }
});

test('DEMO blocked while REAL flag is irrelevant', async () => {
  const { store, gateway } = await harness({ flags: { allowDemoExecution: false } });
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(intentInput(sig));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'execution_disabled'
    );
  } finally {
    await store.close();
  }
});

test('a REAL intent is refused even with execution on, without explicit authorisation', async () => {
  const { store, gateway } = await harness({ flags: { allowRealExecution: true } });
  try {
    const sig = await seedSignal(store, { accountId: 'REAL', accountMode: 'real' });
    const intent = await gateway.createIntent(intentInput(sig, { accountId: 'REAL' }));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'not_authorized'
    );
  } finally {
    await store.close();
  }
});

test('a REAL intent runs only with both the flag and the customer authorisation', async () => {
  const { store, broker, gateway } = await harness({ flags: { allowRealExecution: true } });
  try {
    const prefs: ExecutionPreferencesRecord = {
      userId: 'u_a',
      mode: 'manual',
      contractFamily: 'rise_fall',
      preferredAccountId: { real: 'REAL' },
      stake: { basis: 'stake', amount: 1, currency: 'USD' },
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      realExecutionAuthorised: true,
      autoStopped: false,
      updatedAt: NOW
    };
    await store.putExecutionPreferences(prefs);
    const sig = await seedSignal(store, { accountId: 'REAL', accountMode: 'real' });
    const intent = await gateway.createIntent(intentInput(sig, { accountId: 'REAL' }));
    const result = await gateway.submit(USER, intent.id, 'fake-token');
    assert.equal(result.intent.state, 'OPEN');
    assert.equal(broker.buys.length, 1);
  } finally {
    await store.close();
  }
});

/* --------------------------- ownership and mode --------------------------- */

test('submitting against an account the user does not own is refused', async () => {
  const { store, gateway } = await harness();
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(intentInput(sig));
    // A different user tries to submit this user's intent.
    const other = user([{ accountId: 'DEMO', type: 'demo' }]);
    other.id = 'u_b';
    await assert.rejects(
      () => gateway.submit(other, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'not_found'
    );
  } finally {
    await store.close();
  }
});

test('an expired Deriv authorization blocks execution', async () => {
  const { store, gateway } = await harness();
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(intentInput(sig));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, null),
      (e: unknown) => e instanceof ExecutionError && e.code === 'token_expired'
    );
  } finally {
    await store.close();
  }
});

/* -------------------------------- risk gate ------------------------------- */

test('a risk rejection stops execution before any proposal is requested', async () => {
  const { store, broker, gateway } = await harness({ risk: { approved: false, reasons: ['max_stake'] } });
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(intentInput(sig));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'risk_rejected' && e.reasons.includes('max_stake')
    );
    assert.equal(broker.proposals.length, 0, 'no proposal when risk rejects');
    assert.equal(store.getTradeIntent('u_a', intent.id)?.state, 'REJECTED');
    // The signal is NOT consumed by a rejected trade.
    assert.equal(store.getSignal('u_a', sig.id)?.consumedByIntentId, null);
  } finally {
    await store.close();
  }
});

/* ----------------------------- signal lifecycle --------------------------- */

test('an already-consumed signal cannot drive a second trade', async () => {
  const { store, gateway } = await harness();
  try {
    const sig = await seedSignal(store, { consumedByIntentId: 'other' });
    const intent = await gateway.createIntent(intentInput(sig));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'signal_consumed'
    );
  } finally {
    await store.close();
  }
});

test('an expired signal cannot be executed', async () => {
  const { store, gateway } = await harness();
  try {
    const sig = await seedSignal(store, { expiresAt: NOW - 1 });
    const intent = await gateway.createIntent(intentInput(sig));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'signal_invalid'
    );
  } finally {
    await store.close();
  }
});

/* ------------------------------ idempotency ------------------------------- */

test('creating an intent twice with the same key returns the same intent', async () => {
  const { store, gateway } = await harness();
  try {
    const sig = await seedSignal(store);
    const a = await gateway.createIntent(intentInput(sig));
    const b = await gateway.createIntent(intentInput(sig));
    assert.equal(a.id, b.id);
    assert.equal(store.listTradeIntents('u_a').length, 1);
  } finally {
    await store.close();
  }
});

/* ------------------------------ approval window --------------------------- */

test('an expired manual approval is refused', async () => {
  const { store, gateway } = await harness();
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(
      intentInput(sig, { manualApproval: { approvedAt: NOW - 60_000, expiresAt: NOW - 1 } })
    );
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'approval_expired'
    );
  } finally {
    await store.close();
  }
});

/* ----------------------------- uncertain outcome -------------------------- */

test('an uncertain purchase becomes UNKNOWN then RECONCILIATION_REQUIRED, never retried', async () => {
  const { store, broker, gateway } = await harness({ script: { buyError: uncertainBuyError() } });
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(intentInput(sig));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'broker_uncertain'
    );
    const stored = store.getTradeIntent('u_a', intent.id)!;
    assert.equal(stored.state, 'RECONCILIATION_REQUIRED');
    // The attempt is recorded as unknown, so the uncertainty is provable.
    const attempts = store.listExecutionAttempts('u_a', intent.id);
    assert.ok(attempts.some((a) => a.phase === 'purchase' && a.outcome === 'unknown'));
    // Exactly one buy attempt was made — no blind retry.
    assert.equal(broker.buys.length, 1);
  } finally {
    await store.close();
  }
});

test('a definite broker rejection fails the intent', async () => {
  const { store, gateway } = await harness({ script: { buyError: new BrokerError('rejected', 'nope') } });
  try {
    const sig = await seedSignal(store);
    const intent = await gateway.createIntent(intentInput(sig));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'broker_rejected'
    );
    assert.equal(store.getTradeIntent('u_a', intent.id)?.state, 'FAILED');
  } finally {
    await store.close();
  }
});

/* -------------------------------- locking --------------------------------- */

test('the account lock serialises submissions so a stateful risk check cannot be raced', async () => {
  // A risk check that counts open contracts at decision time. Without the lock,
  // both concurrent submissions would read zero open contracts and both pass;
  // with the lock, the second sees the first's contract and is rejected.
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const broker = new FakeBroker();
  const gateway = new ExecutionGateway({
    store,
    cfg: makeConfig(),
    flags: { allowExecution: true, allowDemoExecution: true, allowRealExecution: false },
    broker,
    balanceProvider: async () => 1000,
    riskEvaluator: (u, accountId) => {
      const open = store.listOpenContracts(u.id, accountId).length;
      return open >= 1 ? { approved: false, reasons: ['max_open_contracts'] } : { approved: true, reasons: [] };
    },
    now: () => NOW
  });
  try {
    const sigA = await seedSignal(store, { id: 'sig_a' });
    const sigB = await seedSignal(store, { id: 'sig_b' });
    const iA = await gateway.createIntent(intentInput(sigA, { idempotencyKey: 'k_a' }));
    const iB = await gateway.createIntent(intentInput(sigB, { idempotencyKey: 'k_b' }));
    const results = await Promise.allSettled([gateway.submit(USER, iA.id, 'fake-token'), gateway.submit(USER, iB.id, 'fake-token')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, 'exactly one submission should succeed');
    assert.equal(broker.buys.length, 1, 'exactly one purchase should reach the broker');
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(
      rejected.reason instanceof ExecutionError && rejected.reason.code === 'risk_rejected',
      'the second submission is rejected by risk, not silently allowed'
    );
  } finally {
    await store.close();
  }
});

test('the execution lock rejects a second holder on timeout', async () => {
  const locks = new ExecutionLocks();
  let releaseFirst!: () => void;
  const first = locks.withLock('ACC', () => new Promise<void>((r) => (releaseFirst = r)), 1000);
  // Second caller times out quickly while the first holds the lock.
  await assert.rejects(() => locks.withLock('ACC', async () => {}, 10), LockTimeoutError);
  releaseFirst();
  await first;
  assert.equal(locks.isLocked('ACC'), false);
});

/* ----------------------------- state machine ------------------------------ */

test('illegal intent transitions are rejected', () => {
  assert.equal(canTransition('CREATED', 'VALIDATING'), true);
  assert.equal(canTransition('SETTLED', 'OPEN'), false);
  assert.throws(() => assertTransition('SETTLED', 'OPEN'), IllegalTransitionError);
  // A timeout after submission has somewhere honest to land.
  assert.equal(canTransition('PURCHASE_PENDING', 'UNKNOWN'), true);
  assert.equal(canTransition('UNKNOWN', 'RECONCILIATION_REQUIRED'), true);
});

/* ------------------------------- audit redaction -------------------------- */

test('audit redaction strips tokens and secrets at any depth', () => {
  const out = redact({
    accountId: 'DEMO',
    accessToken: 'super-secret',
    nested: { clientSecret: 'x', authorization: 'Bearer y', ok: 1 },
    list: [{ password: 'p' }]
  }) as any;
  assert.equal(out.accessToken, '[redacted]');
  assert.equal(out.nested.clientSecret, '[redacted]');
  assert.equal(out.nested.authorization, '[redacted]');
  assert.equal(out.list[0].password, '[redacted]');
  assert.equal(out.nested.ok, 1);
  assert.equal(out.accountId, 'DEMO');
});

/* -------------------------------- adapters -------------------------------- */

test('the Rise/Fall adapter builds the documented CALL/PUT payload', () => {
  const p = RISE_FALL_ADAPTER.buildProposal({
    directionContractType: 'CALL',
    amount: 1,
    basis: 'stake',
    currency: 'USD',
    symbol: 'R_100',
    parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null }
  });
  assert.equal(p.contract_type, 'CALL');
  assert.equal(p.underlying_symbol, 'R_100');
  assert.equal(p.duration, 5);
  assert.equal(p.duration_unit, 'm');
});

test('the Rise/Fall adapter refuses parameters it does not support', () => {
  const base = {
    directionContractType: 'CALL' as DerivContractType,
    amount: 1,
    basis: 'stake' as const,
    currency: 'USD',
    symbol: 'R_100'
  };
  assert.throws(
    () => RISE_FALL_ADAPTER.buildProposal({ ...base, parameters: { duration: 0, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null } }),
    AdapterError
  );
  assert.throws(
    () => RISE_FALL_ADAPTER.buildProposal({ ...base, parameters: { duration: 5, durationUnit: 'm', multiplier: 100, cancellation: null, stopLoss: null, takeProfit: null } }),
    AdapterError
  );
  assert.throws(
    () => RISE_FALL_ADAPTER.buildProposal({ ...base, parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: 1, takeProfit: null } }),
    AdapterError
  );
});

test('the Multipliers adapter builds MULTUP/MULTDOWN with multiplier and limit order', () => {
  const p = MULTIPLIERS_ADAPTER.buildProposal({
    directionContractType: 'MULTUP',
    amount: 5,
    basis: 'stake',
    currency: 'USD',
    symbol: 'R_100',
    parameters: { duration: 0, durationUnit: 'm', multiplier: 100, cancellation: '60m', stopLoss: 2, takeProfit: 4 }
  });
  assert.equal(p.contract_type, 'MULTUP');
  assert.equal(p.multiplier, 100);
  assert.equal(p.cancellation, '60m');
  assert.deepEqual(p.limit_order, { stop_loss: 2, take_profit: 4 });
  // Multipliers are always staked.
  assert.equal(p.basis, 'stake');
});

test('the Multipliers adapter requires a multiplier and a valid cancellation', () => {
  const base = {
    directionContractType: 'MULTUP' as DerivContractType,
    amount: 5,
    basis: 'stake' as const,
    currency: 'USD',
    symbol: 'R_100'
  };
  assert.throws(
    () => MULTIPLIERS_ADAPTER.buildProposal({ ...base, parameters: { duration: 0, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null } }),
    AdapterError
  );
  assert.throws(
    () => MULTIPLIERS_ADAPTER.buildProposal({ ...base, parameters: { duration: 0, durationUnit: 'm', multiplier: 100, cancellation: '1m', stopLoss: null, takeProfit: null } }),
    AdapterError
  );
});

/* ------------------------------- defaults --------------------------------- */

test('gateway defaults never allow REAL without both flag and authorisation', async () => {
  const { store, gateway } = await harness({ flags: { allowRealExecution: false } });
  try {
    const sig = await seedSignal(store, { accountId: 'REAL', accountMode: 'real' });
    const intent = await gateway.createIntent(intentInput(sig, { accountId: 'REAL' }));
    await assert.rejects(
      () => gateway.submit(USER, intent.id, 'fake-token'),
      (e: unknown) => e instanceof ExecutionError && e.code === 'execution_disabled'
    );
  } finally {
    await store.close();
  }
});
