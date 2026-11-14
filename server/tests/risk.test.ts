import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import {
  evaluateRisk,
  effectiveRiskProfile,
  consecutiveLosses,
  currentExposure,
  realisedPnlSince
} from '../services/risk.js';
import { DEFAULT_RISK_PROFILE } from '../execution/types.js';
import type {
  ContractRecord,
  LedgerEntryRecord,
  RiskProfileRecord,
  TradeIntentRecord,
  ExecutionPreferencesRecord
} from '../execution/types.js';

/**
 * Phase 5 tests: the risk engine. Every rule is exercised in isolation and in
 * combination, including the fail-closed behaviour when data is missing.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // a fixed midday, so "today" is stable

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-risk-'));
}

async function storeWith(): Promise<Store> {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  return store;
}

function profile(overrides: Partial<RiskProfileRecord> = {}): RiskProfileRecord {
  return { userId: 'u_a', ...DEFAULT_RISK_PROFILE, updatedAt: 0, ...overrides };
}

function contract(overrides: Partial<ContractRecord> = {}): ContractRecord {
  return {
    id: 'c_' + Math.random().toString(36).slice(2),
    userId: 'u_a',
    accountId: 'ACC',
    accountMode: 'demo',
    intentId: 'i_1',
    contractFamily: 'rise_fall',
    contractType: 'CALL',
    symbol: 'R_100',
    buyPrice: 1,
    stake: 1,
    currency: 'USD',
    payout: 1.9,
    entrySpot: 100,
    exitSpot: null,
    purchaseTime: NOW,
    startTime: NOW,
    expiryTime: null,
    settlementTime: null,
    status: 'open',
    profit: null,
    soldFor: null,
    buyTransactionId: null,
    updatedAt: NOW,
    ...overrides
  };
}

function intent(overrides: Partial<TradeIntentRecord> = {}): TradeIntentRecord {
  return {
    id: 'i_' + Math.random().toString(36).slice(2),
    userId: 'u_a',
    accountId: 'ACC',
    accountMode: 'demo',
    contractFamily: 'rise_fall',
    contractType: 'CALL',
    symbol: 'R_100',
    timeframe: '5m',
    signalId: 's_1',
    approvedBy: 'customer',
    approvedAt: NOW,
    approvalExpiresAt: NOW + 15_000,
    stake: 1,
    basis: 'stake',
    currency: 'USD',
    parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
    state: 'CREATED',
    contractId: null,
    reason: null,
    idempotencyKey: 'k_' + Math.random().toString(36).slice(2),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function ledger(overrides: Partial<LedgerEntryRecord> = {}): LedgerEntryRecord {
  return {
    id: 'l_' + Math.random().toString(36).slice(2),
    userId: 'u_a',
    accountId: 'ACC',
    accountMode: 'demo',
    contractId: null,
    intentId: null,
    kind: 'settlement',
    amount: 0,
    currency: 'USD',
    derivTransactionId: null,
    dedupeKey: 'd_' + Math.random().toString(36).slice(2),
    settled: true,
    createdAt: NOW,
    ...overrides
  };
}

const baseInput = { userId: 'u_a', accountId: 'ACC', stake: 1, balance: 100, signalAgeSeconds: 1, now: NOW };

/* ------------------------------ helper logic ------------------------------ */

test('effectiveRiskProfile falls back to conservative defaults when none is stored', async () => {
  const store = await storeWith();
  try {
    const p = effectiveRiskProfile(store, 'u_a');
    assert.equal(p.maxStake, DEFAULT_RISK_PROFILE.maxStake);
    assert.equal(p.updatedAt, 0);
  } finally {
    await store.close();
  }
});

test('consecutiveLosses counts only an unbroken most-recent run', () => {
  const contracts = [
    contract({ id: '1', status: 'lost', profit: -1, settlementTime: 500 }),
    contract({ id: '2', status: 'lost', profit: -1, settlementTime: 400 }),
    contract({ id: '3', status: 'won', profit: 2, settlementTime: 300 }),
    contract({ id: '4', status: 'lost', profit: -1, settlementTime: 200 })
  ];
  assert.equal(consecutiveLosses(contracts, 'ACC'), 2);
});

test('currentExposure sums open stakes only', () => {
  const contracts = [
    contract({ id: '1', status: 'open', stake: 2 }),
    contract({ id: '2', status: 'open', stake: 3 }),
    contract({ id: '3', status: 'won', stake: 9 })
  ];
  assert.equal(currentExposure(contracts), 5);
});

test('realisedPnlSince sums settlement and fee entries within the window', () => {
  const entries = [
    ledger({ amount: -5, kind: 'settlement', createdAt: NOW - 1000 }),
    ledger({ amount: 3, kind: 'fee', createdAt: NOW - 500 }),
    ledger({ amount: -100, kind: 'settlement', createdAt: NOW - 2 * 24 * 60 * 60 * 1000 })
  ];
  assert.equal(realisedPnlSince(entries, 'ACC', NOW - 24 * 60 * 60 * 1000), -2);
});

/* ------------------------------ the decision ------------------------------ */

test('a clean proposal under limits is approved', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile());
    const decision = evaluateRisk(store, baseInput);
    assert.equal(decision.approved, true, JSON.stringify(decision.reasons));
    assert.deepEqual(decision.reasons, []);
  } finally {
    await store.close();
  }
});

test('max_stake rejects a stake above the profile', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxStake: 5 }));
    const decision = evaluateRisk(store, { ...baseInput, stake: 6 });
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('max_stake'));
  } finally {
    await store.close();
  }
});

test('stake must be positive and finite', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile());
    for (const bad of [0, -1, NaN, Infinity]) {
      const decision = evaluateRisk(store, { ...baseInput, stake: bad });
      assert.equal(decision.approved, false, `stake ${bad} must be rejected`);
      assert.ok(decision.reasons.includes('stake_positive'));
    }
  } finally {
    await store.close();
  }
});

test('daily_loss rejects once the day loss limit is reached', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxDailyLoss: 10 }));
    await store.putLedgerEntry(ledger({ amount: -12, createdAt: NOW - 60_000 }));
    const decision = evaluateRisk(store, baseInput);
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('daily_loss'));
  } finally {
    await store.close();
  }
});

test('yesterday losses do not count toward today', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxDailyLoss: 10 }));
    await store.putLedgerEntry(ledger({ amount: -50, createdAt: NOW - 2 * 24 * 60 * 60 * 1000 }));
    const decision = evaluateRisk(store, baseInput);
    assert.equal(decision.approved, true, JSON.stringify(decision.reasons));
  } finally {
    await store.close();
  }
});

test('consecutive_losses locks trading after the configured run', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxConsecutiveLosses: 2 }));
    await store.putContract(contract({ id: '1', status: 'lost', profit: -1, settlementTime: NOW - 100 }));
    await store.putContract(contract({ id: '2', status: 'lost', profit: -1, settlementTime: NOW - 200 }));
    const decision = evaluateRisk(store, baseInput);
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('consecutive_losses'));
  } finally {
    await store.close();
  }
});

test('max_open_contracts and max_exposure are both enforced', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxOpenContracts: 2, maxAccountExposure: 3 }));
    await store.putContract(contract({ id: '1', status: 'open', stake: 1.5 }));
    await store.putContract(contract({ id: '2', status: 'open', stake: 1.5 }));
    // Two open contracts hits the count limit; 1.5+1.5+1 exceeds exposure.
    const decision = evaluateRisk(store, { ...baseInput, stake: 1 });
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('max_open_contracts'));
    assert.ok(decision.reasons.includes('max_exposure'));
  } finally {
    await store.close();
  }
});

test('min_balance fails closed when no balance is available', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile());
    const decision = evaluateRisk(store, { ...baseInput, balance: null });
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('min_balance'));
  } finally {
    await store.close();
  }
});

test('min_balance rejects a stake that would breach the floor', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ minAvailableBalance: 5 }));
    const decision = evaluateRisk(store, { ...baseInput, balance: 5, stake: 1 });
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('min_balance'));
  } finally {
    await store.close();
  }
});

test('execution_frequency rejects a trade too soon after the last one', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxExecutionFrequencySeconds: 30 }));
    await store.putTradeIntent(intent({ createdAt: NOW - 5_000 }));
    const decision = evaluateRisk(store, baseInput);
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('execution_frequency'));
  } finally {
    await store.close();
  }
});

test('trades_per_session rejects once the daily count is reached', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxTradesPerSession: 2, maxExecutionFrequencySeconds: 0 }));
    await store.putTradeIntent(intent({ createdAt: NOW - 100_000 }));
    await store.putTradeIntent(intent({ createdAt: NOW - 50_000 }));
    const decision = evaluateRisk(store, baseInput);
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('trades_per_session'));
  } finally {
    await store.close();
  }
});

test('signal_freshness rejects a stale signal', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ signalFreshnessSeconds: 30 }));
    const decision = evaluateRisk(store, { ...baseInput, signalAgeSeconds: 45 });
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('signal_freshness'));
  } finally {
    await store.close();
  }
});

test('the emergency stop blocks every proposal', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile());
    const prefs: ExecutionPreferencesRecord = {
      userId: 'u_a',
      mode: 'automatic',
      contractFamily: 'rise_fall',
      preferredAccountId: { demo: 'ACC' },
      stake: { basis: 'stake', amount: 1, currency: 'USD' },
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      realExecutionAuthorised: false,
      autoStopped: true,
      updatedAt: NOW
    };
    await store.putExecutionPreferences(prefs);
    const decision = evaluateRisk(store, baseInput);
    assert.equal(decision.approved, false);
    assert.ok(decision.reasons.includes('auto_stopped'));
  } finally {
    await store.close();
  }
});

test('every rule runs, so a caller sees the full set of reasons', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxStake: 1, minAvailableBalance: 100 }));
    const decision = evaluateRisk(store, { ...baseInput, stake: 5, balance: 10, signalAgeSeconds: 9999 });
    assert.equal(decision.approved, false);
    // Multiple independent failures are all reported.
    assert.ok(decision.reasons.length >= 3, JSON.stringify(decision.reasons));
    assert.ok(decision.rules.length >= 8);
  } finally {
    await store.close();
  }
});

test('DEMO and REAL exposure are tracked per account, not mixed', async () => {
  const store = await storeWith();
  try {
    await store.putRiskProfile(profile({ maxOpenContracts: 1 }));
    // One open contract on the DEMO account.
    await store.putContract(contract({ id: '1', accountId: 'DEMO', accountMode: 'demo', status: 'open', stake: 1 }));
    // Evaluating a REAL account is unaffected by the DEMO open contract.
    const decision = evaluateRisk(store, { ...baseInput, accountId: 'REAL' });
    assert.equal(decision.approved, true, JSON.stringify(decision.reasons));
  } finally {
    await store.close();
  }
});
