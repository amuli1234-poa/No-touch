import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import {
  resolveAccountForUser,
  resolveTradableAccountForUser,
  parseAccountMode,
  AccountAccessError,
  accountsInMode
} from '../execution/accountGuard.js';
import { loadExecutionFlags, executionPermitted } from '../config/flags.js';
import {
  DEFAULT_RISK_PROFILE,
  CONTRACT_FAMILY_TYPES,
  INTENT_STATES,
  TERMINAL_INTENT_STATES
} from '../execution/types.js';
import type {
  ExecutionPreferencesRecord,
  RiskProfileRecord,
  SignalRecord,
  TradeIntentRecord,
  ContractRecord,
  LedgerEntryRecord,
  NotificationRecord,
  ExecutionAuditRecord
} from '../execution/types.js';

/**
 * Phase 2 tests: multi-tenant isolation, account ownership, DEMO/REAL
 * separation, admin/customer separation, kill switches, and the durable trading
 * records.
 *
 * Everything runs against the real Store and the real guard functions on a
 * temporary data directory. No network, no execution — nothing here places a
 * trade.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-iso-'));
}

function user(id: string, accounts: UserRecord['accounts']): UserRecord {
  const now = Date.now();
  return { id, derivSub: `sub_${id}`, accounts, createdAt: now, updatedAt: now, preferences: {} };
}

const USER_A = user('u_a', [
  { accountId: 'VRTC_A_DEMO', type: 'demo', currency: 'USD', status: 'active' },
  { accountId: 'CR_A_REAL', type: 'real', currency: 'USD', status: 'active' }
]);
const USER_B = user('u_b', [
  { accountId: 'VRTC_B_DEMO', type: 'demo', currency: 'USD', status: 'active' }
]);

/* ------------------------- account ownership guard ------------------------ */

test('guard resolves an owned account and takes the mode from the store', () => {
  const r = resolveAccountForUser(USER_A, 'VRTC_A_DEMO');
  assert.equal(r.mode, 'demo');
  assert.equal(r.accountId, 'VRTC_A_DEMO');
  assert.equal(r.tradable, true);
});

test('guard rejects an account the user does not own (cross-tenant / IDOR)', () => {
  // User B names User A's account id.
  assert.throws(
    () => resolveAccountForUser(USER_B, 'VRTC_A_DEMO'),
    (e: unknown) => e instanceof AccountAccessError && e.code === 'account_not_authorized'
  );
  assert.throws(
    () => resolveAccountForUser(USER_B, 'CR_A_REAL'),
    (e: unknown) => e instanceof AccountAccessError && e.code === 'account_not_authorized'
  );
});

test('guard rejects an unknown or empty account id', () => {
  assert.throws(() => resolveAccountForUser(USER_A, 'nope'), AccountAccessError);
  assert.throws(() => resolveAccountForUser(USER_A, ''), AccountAccessError);
});

test('guard rejects a client-asserted mode that disagrees with the account', () => {
  // The account is demo; a caller claims real. Rejected, not substituted.
  assert.throws(
    () => resolveAccountForUser(USER_A, 'VRTC_A_DEMO', 'real'),
    (e: unknown) => e instanceof AccountAccessError && e.code === 'account_mode_mismatch'
  );
  // The account is real; a caller claims demo. Also rejected.
  assert.throws(
    () => resolveAccountForUser(USER_A, 'CR_A_REAL', 'demo'),
    (e: unknown) => e instanceof AccountAccessError && e.code === 'account_mode_mismatch'
  );
});

test('guard accepts a matching asserted mode', () => {
  assert.equal(resolveAccountForUser(USER_A, 'CR_A_REAL', 'real').mode, 'real');
  assert.equal(resolveAccountForUser(USER_A, 'VRTC_A_DEMO', 'demo').mode, 'demo');
});

test('parseAccountMode accepts only the exact demo/real strings', () => {
  assert.equal(parseAccountMode('demo'), 'demo');
  assert.equal(parseAccountMode('real'), 'real');
  assert.equal(parseAccountMode(undefined), undefined);
  assert.equal(parseAccountMode(''), undefined);
  // Anything else is an error, not silently "no assertion".
  assert.throws(() => parseAccountMode('REAL'), AccountAccessError);
  assert.throws(() => parseAccountMode('live'), AccountAccessError);
  assert.throws(() => parseAccountMode(1), AccountAccessError);
});

test('a non-active account is not tradable, but is still resolvable for display', () => {
  const suspended = user('u_s', [{ accountId: 'VRTC_S', type: 'demo', status: 'suspended' }]);
  assert.equal(resolveAccountForUser(suspended, 'VRTC_S').tradable, false);
  assert.throws(
    () => resolveTradableAccountForUser(suspended, 'VRTC_S'),
    (e: unknown) => e instanceof AccountAccessError && e.code === 'account_unavailable'
  );
});

test('accountsInMode separates DEMO and REAL without mixing them', () => {
  assert.deepEqual(
    accountsInMode(USER_A, 'demo').map((a) => a.accountId),
    ['VRTC_A_DEMO']
  );
  assert.deepEqual(
    accountsInMode(USER_A, 'real').map((a) => a.accountId),
    ['CR_A_REAL']
  );
});

/* ------------------------------ kill switches ----------------------------- */

test('all execution flags default to false when the environment is empty', () => {
  const flags = loadExecutionFlags({});
  assert.deepEqual(flags, { allowExecution: false, allowDemoExecution: false, allowRealExecution: false });
});

test('flags require the exact string "true"', () => {
  const flags = loadExecutionFlags({ ALLOW_EXECUTION: 'TRUE', ALLOW_DEMO_EXECUTION: '1' });
  assert.equal(flags.allowExecution, false);
  assert.equal(flags.allowDemoExecution, false);
});

test('REAL execution stays disabled even when its own flag is set but the master switch is off', () => {
  const flags = loadExecutionFlags({ ALLOW_REAL_EXECUTION: 'true' });
  assert.equal(flags.allowRealExecution, false, 'REAL must not run while ALLOW_EXECUTION is false');
});

test('REAL execution requires BOTH the master switch and its own flag', () => {
  const flags = loadExecutionFlags({ ALLOW_EXECUTION: 'true', ALLOW_REAL_EXECUTION: 'true' });
  assert.equal(flags.allowRealExecution, true);
});

test('executionPermitted reports a reason for every refusal', () => {
  const off = loadExecutionFlags({});
  assert.deepEqual(executionPermitted(off, 'demo'), { permitted: false, reason: 'global_execution_disabled' });

  const demoOnly = loadExecutionFlags({ ALLOW_EXECUTION: 'true', ALLOW_DEMO_EXECUTION: 'true' });
  assert.deepEqual(executionPermitted(demoOnly, 'demo'), { permitted: true, reason: null });
  assert.deepEqual(executionPermitted(demoOnly, 'real'), { permitted: false, reason: 'real_execution_disabled' });

  const masterOnly = loadExecutionFlags({ ALLOW_EXECUTION: 'true' });
  assert.deepEqual(executionPermitted(masterOnly, 'demo'), { permitted: false, reason: 'demo_execution_disabled' });
});

/* --------------------------- contract-type truth -------------------------- */

test('contract families map to the verified Deriv contract types', () => {
  assert.deepEqual([...CONTRACT_FAMILY_TYPES.rise_fall], ['CALL', 'PUT']);
  assert.deepEqual([...CONTRACT_FAMILY_TYPES.multipliers], ['MULTUP', 'MULTDOWN']);
});

test('the intent state machine declares the required durable states', () => {
  for (const s of [
    'CREATED',
    'VALIDATING',
    'RISK_APPROVED',
    'PROPOSAL_REQUESTED',
    'PROPOSAL_VALIDATED',
    'PURCHASE_PENDING',
    'OPEN',
    'CLOSE_PENDING',
    'SETTLED',
    'REJECTED',
    'FAILED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED'
  ]) {
    assert.ok((INTENT_STATES as readonly string[]).includes(s), `missing state ${s}`);
  }
  // A timeout after submission must have somewhere honest to land.
  assert.ok((INTENT_STATES as readonly string[]).includes('UNKNOWN'));
  assert.ok((INTENT_STATES as readonly string[]).includes('RECONCILIATION_REQUIRED'));
  assert.ok(TERMINAL_INTENT_STATES.includes('SETTLED'));
});

/* ---------------------- durable store: tenant isolation ------------------- */

test('store keeps per-user records isolated by owner', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    const now = Date.now();
    const prefsA: ExecutionPreferencesRecord = {
      userId: USER_A.id,
      mode: 'manual',
      contractFamily: 'rise_fall',
      preferredAccountId: { demo: 'VRTC_A_DEMO' },
      stake: { basis: 'stake', amount: 1, currency: 'USD' },
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      realExecutionAuthorised: false,
      autoStopped: false,
      updatedAt: now
    };
    await store.putExecutionPreferences(prefsA);
    assert.equal(store.getExecutionPreferences(USER_A.id)?.mode, 'manual');
    // User B has no preferences: reading by another id must not leak A's row.
    assert.equal(store.getExecutionPreferences(USER_B.id), null);

    const signal: SignalRecord = {
      id: 'sig_1',
      userId: USER_A.id,
      accountId: 'VRTC_A_DEMO',
      accountMode: 'demo',
      symbol: 'R_100',
      timeframe: '5m',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      analysisId: 'an_1',
      zone: { low: 100, high: 101 },
      entryPrice: 100.5,
      confidence: 0.6,
      reason: 'test',
      createdAt: now,
      expiresAt: now + 60_000,
      consumedByIntentId: null
    };
    await store.putSignal(signal);
    // Owner can read it; another tenant cannot, even knowing the exact id.
    assert.equal(store.getSignal(USER_A.id, 'sig_1')?.id, 'sig_1');
    assert.equal(store.getSignal(USER_B.id, 'sig_1'), null);
    assert.equal(store.listSignals(USER_B.id).length, 0);

    const intent: TradeIntentRecord = {
      id: 'int_1',
      userId: USER_A.id,
      accountId: 'VRTC_A_DEMO',
      accountMode: 'demo',
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      symbol: 'R_100',
      timeframe: '5m',
      signalId: 'sig_1',
      approvedBy: 'customer',
      approvedAt: now,
      approvalExpiresAt: now + 15_000,
      stake: 1,
      basis: 'stake',
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      state: 'CREATED',
      contractId: null,
      reason: null,
      idempotencyKey: 'idem_1',
      createdAt: now,
      updatedAt: now
    };
    await store.putTradeIntent(intent);
    assert.equal(store.getTradeIntent(USER_B.id, 'int_1'), null);
    assert.equal(store.getTradeIntent(USER_A.id, 'int_1')?.state, 'CREATED');
    // Idempotency key lookup is per-tenant.
    assert.equal(store.findTradeIntentByIdempotencyKey(USER_A.id, 'idem_1')?.id, 'int_1');
    assert.equal(store.findTradeIntentByIdempotencyKey(USER_B.id, 'idem_1'), null);

    const contract: ContractRecord = {
      id: '555',
      userId: USER_A.id,
      accountId: 'VRTC_A_DEMO',
      accountMode: 'demo',
      intentId: 'int_1',
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      symbol: 'R_100',
      buyPrice: 1,
      stake: 1,
      currency: 'USD',
      payout: 1.95,
      entrySpot: 100,
      exitSpot: null,
      purchaseTime: now,
      startTime: now,
      expiryTime: null,
      settlementTime: null,
      status: 'open',
      profit: null,
      soldFor: null,
      buyTransactionId: 42,
      updatedAt: now
    };
    await store.putContract(contract);
    assert.equal(store.getContract(USER_B.id, '555'), null);
    assert.equal(store.listContracts(USER_B.id).length, 0);
    assert.equal(store.listOpenContracts(USER_A.id, 'VRTC_A_DEMO').length, 1);
    // A different account owned by the same user is a different exposure bucket.
    assert.equal(store.listOpenContracts(USER_A.id, 'CR_A_REAL').length, 0);
  } finally {
    await store.close();
  }
});

test('the ledger refuses a duplicate dedupeKey so a settlement cannot double-post', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    const now = Date.now();
    const entry: LedgerEntryRecord = {
      id: 'led_1',
      userId: USER_A.id,
      accountId: 'VRTC_A_DEMO',
      accountMode: 'demo',
      contractId: '555',
      intentId: 'int_1',
      kind: 'settlement',
      amount: 0.95,
      currency: 'USD',
      derivTransactionId: 99,
      dedupeKey: 'settle:555',
      settled: true,
      createdAt: now
    };
    assert.equal(await store.putLedgerEntry(entry), true);
    // Same dedupeKey, different id: must be refused.
    assert.equal(await store.putLedgerEntry({ ...entry, id: 'led_2' }), false);
    assert.equal(store.listLedgerEntries(USER_A.id).length, 1);
    // Another tenant with the same dedupeKey is unaffected (keyed per user).
    assert.equal(
      await store.putLedgerEntry({ ...entry, id: 'led_3', userId: USER_B.id, accountId: 'VRTC_B_DEMO' }),
      true
    );
    assert.equal(store.listLedgerEntries(USER_B.id).length, 1);
  } finally {
    await store.close();
  }
});

test('notifications and execution audit are tenant-scoped and append-only', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    const now = Date.now();
    const note: NotificationRecord = {
      id: 'n_1',
      userId: USER_A.id,
      kind: 'trade_executed',
      title: 'Executed',
      body: 'Demo trade executed',
      intentId: 'int_1',
      contractId: '555',
      readAt: null,
      createdAt: now
    };
    await store.putNotification(note);
    assert.equal(store.getNotification(USER_B.id, 'n_1'), null);
    assert.equal(store.listNotifications(USER_B.id).length, 0);
    assert.equal(store.listNotifications(USER_A.id).length, 1);

    const audit: ExecutionAuditRecord = {
      id: 'a_1',
      timestamp: now,
      userId: USER_A.id,
      action: 'execution.denied',
      outcome: 'denied',
      accountId: 'VRTC_A_DEMO',
      intentId: 'int_1',
      detail: { reason: 'global_execution_disabled' }
    };
    await store.appendExecutionAudit(audit);
    await store.appendExecutionAudit({ ...audit, id: 'a_2', action: 'execution.denied' });
    assert.equal(store.listExecutionAudit().length, 2, 'audit is append-only');
  } finally {
    await store.close();
  }
});

test('trading collections persist across a store reload (durability)', async () => {
  const dir = tmpDir();
  const now = Date.now();
  const first = new Store(dir, { unsafeDisableLock: true, engine: 'json' });
  await first.load();
  await first.putRiskProfile({ userId: USER_A.id, ...DEFAULT_RISK_PROFILE, updatedAt: now });
  await first.putSignal({
    id: 'sig_persist',
    userId: USER_A.id,
    accountId: 'VRTC_A_DEMO',
    accountMode: 'demo',
    symbol: 'R_100',
    timeframe: '5m',
    direction: 'RISE',
    contractFamily: 'rise_fall',
    analysisId: 'an',
    zone: null,
    entryPrice: null,
    confidence: null,
    reason: 'r',
    createdAt: now,
    expiresAt: now + 1000,
    consumedByIntentId: null
  });
  await first.close();

  const second = new Store(dir, { unsafeDisableLock: true, engine: 'json' });
  await second.load();
  try {
    assert.equal(second.getRiskProfile(USER_A.id)?.maxStake, DEFAULT_RISK_PROFILE.maxStake);
    assert.equal(second.getSignal(USER_A.id, 'sig_persist')?.symbol, 'R_100');
  } finally {
    await second.close();
  }
});

test('a fresh risk profile carries the conservative defaults and no escalation field', () => {
  const profile: RiskProfileRecord = { userId: USER_A.id, ...DEFAULT_RISK_PROFILE, updatedAt: Date.now() };
  assert.equal(profile.maxStake, 10);
  assert.equal(profile.maxConsecutiveLosses, 3);
  // No martingale: there is deliberately no field to escalate a stake after a loss.
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'martingale'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'stakeEscalation'), false);
});
