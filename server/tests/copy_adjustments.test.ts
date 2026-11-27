import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import type { ContractRecord } from '../execution/types.js';
import type { CopyTradingFollowerRecord } from '../copyTrading/types.js';
import { applyContractAdjustment, effectiveProfit } from '../copyTrading/adjustments.js';
import { applyFollowerCommissions, buildStatement, computeFollowerCommissions } from '../copyTrading/finance.js';
import { followerPrincipalId } from '../copyTrading/performance.js';
import { currencyDigits, roundMoney } from '../copyTrading/money.js';

/**
 * Settlement adjustments (Phase 1) and currency precision (Phase 4).
 * Adjustments are immutable and idempotent; the original settlement is never
 * overwritten; commission is recomputed from effective profit.
 */

const NOW = 3_000_000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-adj-'));
}

const MASTER: UserRecord = {
  id: 'u_master',
  derivSub: 'sub_master',
  accounts: [{ accountId: 'M_DEMO', type: 'demo', currency: 'USD', status: 'active' }],
  createdAt: NOW,
  updatedAt: NOW,
  preferences: {}
};

function follower(): CopyTradingFollowerRecord {
  return {
    id: 'f_1',
    ownerUserId: 'u_master',
    derivSub: 'sub_follower_1',
    authMethod: 'pat',
    loginId: 'CR1',
    accounts: [{ accountId: 'F1_DEMO', type: 'demo', currency: 'USD', status: 'active' }],
    tokenSealed: 'sealed',
    tokenExpiresAt: 0,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'active',
    revision: 1
  };
}

let seq = 0;
function contract(overrides: Partial<ContractRecord> = {}): ContractRecord {
  seq += 1;
  const id = overrides.id ?? `c_${seq}`;
  return {
    id,
    userId: followerPrincipalId('f_1'),
    accountId: 'F1_DEMO',
    accountMode: 'demo',
    intentId: `int_${id}`,
    contractFamily: 'rise_fall',
    contractType: 'CALL',
    symbol: 'R_100',
    buyPrice: 10,
    stake: 10,
    currency: 'USD',
    payout: 19,
    entrySpot: 100,
    exitSpot: null,
    purchaseTime: NOW - 1000,
    startTime: NOW - 1000,
    expiryTime: null,
    settlementTime: NOW,
    status: 'won',
    profit: 9,
    soldFor: null,
    buyTransactionId: null,
    updatedAt: NOW,
    ...overrides
  };
}

async function harness() {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  await store.upsertUser(MASTER);
  await store.putCopyTradingFollower(follower());
  return store;
}

/* ------------------------------ adjustments ------------------------------- */

test('a correction appends an adjustment and never mutates the original', async () => {
  const store = await harness();
  try {
    const c = contract({ id: 'c_adj', profit: 9 });
    await store.putContract(c);
    const result = await applyContractAdjustment(store, {
      contractId: 'c_adj',
      deltaProfit: -4,
      reason: 'deriv corrected profit',
      source: 'deriv_reconciliation',
      key: 'r1',
      now: NOW
    });
    assert.equal(result.applied, true);
    assert.equal(result.effectiveProfit, 5);
    // Original contract profit is untouched (immutable history).
    assert.equal(store.findContractById('c_adj')!.profit, 9);
    const adjustments = store.listContractAdjustments('c_adj');
    assert.equal(adjustments.length, 1);
    assert.equal(adjustments[0].deltaProfit, -4);
    assert.equal(effectiveProfit(c, adjustments), 5);
  } finally {
    await store.close();
  }
});

test('a duplicate adjustment event is rejected idempotently', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_dup', profit: 9 }));
    const first = await applyContractAdjustment(store, { contractId: 'c_dup', deltaProfit: -4, reason: 'x', source: 's', key: 'same', now: NOW });
    const second = await applyContractAdjustment(store, { contractId: 'c_dup', deltaProfit: -4, reason: 'x', source: 's', key: 'same', now: NOW });
    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(store.listContractAdjustments('c_dup').length, 1);
  } finally {
    await store.close();
  }
});

test('a reversal (delta = -profit) brings effective profit to zero', async () => {
  const store = await harness();
  try {
    const c = contract({ id: 'c_rev', profit: 9 });
    await store.putContract(c);
    await applyContractAdjustment(store, { contractId: 'c_rev', deltaProfit: -9, reason: 'reversed', source: 'deriv_reconciliation', key: 'rev', now: NOW });
    assert.equal(effectiveProfit(store.findContractById('c_rev')!, store.listContractAdjustments('c_rev')), 0);
  } finally {
    await store.close();
  }
});

test('commission is recomputed from effective profit after a correction', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_comm', profit: 10 }));
    await applyFollowerCommissions(store, 'u_master', { now: NOW });
    const before = buildStatement(store, 'u_master', NOW);
    assert.equal(before.totals.managerCommission, 4);

    // Correct the settlement down to 4.
    await applyContractAdjustment(store, { contractId: 'c_comm', deltaProfit: -6, reason: 'corrected', source: 'deriv_reconciliation', key: 'corr', now: NOW });
    const after = buildStatement(store, 'u_master', NOW);
    assert.equal(after.totals.managerCommission, 1.6); // 40% of 4
    assert.equal(after.totals.clientAllocation, 2.4);
    assert.equal(after.adjustments.length, 1);
    // Issued entries remain for traceability.
    assert.equal(after.entries.length, 1);
  } finally {
    await store.close();
  }
});

test('a repeated identical correction is a no-op for commission', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_rep', profit: 10 }));
    await applyContractAdjustment(store, { contractId: 'c_rep', deltaProfit: -6, reason: 'corrected', source: 's', key: 'k', now: NOW });
    await applyContractAdjustment(store, { contractId: 'c_rep', deltaProfit: -6, reason: 'corrected', source: 's', key: 'k', now: NOW });
    const statement = buildStatement(store, 'u_master', NOW);
    assert.equal(statement.totals.managerCommission, 1.6); // not 0 or negative
    assert.equal(statement.adjustments.length, 1);
  } finally {
    await store.close();
  }
});

/* --------------------------- currency precision --------------------------- */

test('currency digits are correct for fiat and non-fiat', () => {
  assert.equal(currencyDigits('USD'), 2);
  assert.equal(currencyDigits('JPY'), 0);
  assert.equal(currencyDigits('BTC'), 8);
  assert.equal(currencyDigits('XRP'), 6);
  assert.equal(currencyDigits('UNKNOWN'), 2);
});

test('roundMoney respects currency precision (no float drift)', () => {
  assert.equal(roundMoney(1.005, 'USD'), 1.01);
  assert.equal(roundMoney(0.1 + 0.2, 'USD'), 0.3);
  assert.equal(roundMoney(1.123456789, 'BTC'), 1.12345679);
  assert.equal(roundMoney(1.6, 'JPY'), 2);
});

test('commission math is currency-aware for an 8-decimal currency', async () => {
  const store = await harness();
  try {
    const entries = computeFollowerCommissions({
      ownerUserId: 'u_master',
      followerId: 'f_1',
      contracts: [contract({ id: 'c_btc', currency: 'BTC', stake: 0.0001, profit: 0.00005 })],
      now: NOW
    });
    assert.equal(entries[0].managerCommission, 0.00002);
    assert.equal(entries[0].clientAllocation, 0.00003);
  } finally {
    await store.close();
  }
});

test('concurrent identical adjustments apply exactly once', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_conc', profit: 9 }));
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        applyContractAdjustment(store, { contractId: 'c_conc', deltaProfit: -4, reason: 'x', source: 's', key: 'same', now: NOW })
      )
    );
    assert.equal(results.filter((r) => r.applied).length, 1);
    assert.equal(store.listContractAdjustments('c_conc').length, 1);
    assert.equal(effectiveProfit(store.findContractById('c_conc')!, store.listContractAdjustments('c_conc')), 5);
  } finally {
    await store.close();
  }
});

test('commission processing recovers after a crash without double-charging', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_rec', profit: 10 }));
    // First pass issues the commission (as the settlement hook would).
    const first = await applyFollowerCommissions(store, 'u_master', { now: NOW });
    assert.equal(first.inserted, 1);
    // Simulate a crash/restart: the process re-runs the authoritative settlement.
    const second = await applyFollowerCommissions(store, 'u_master', { now: NOW });
    assert.equal(second.inserted, 0); // idempotent replay — no second charge
    const statement = buildStatement(store, 'u_master', NOW);
    assert.equal(statement.totals.managerCommission, 4); // not 8
    assert.equal(statement.entries.length, 1);
  } finally {
    await store.close();
  }
});

test('estimated markup is never counted as collected revenue', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_markup', profit: 10, stake: 10 }));
    await applyFollowerCommissions(store, 'u_master', { now: NOW });
    const statement = buildStatement(store, 'u_master', NOW);
    assert.equal(statement.entries[0].markupStatus, 'estimated');
    assert.equal(statement.entries[0].confirmedMarkup, null);
    assert.equal(statement.totals.confirmedMarkup, 0); // collected revenue is zero
    assert.ok(statement.totals.estimatedMarkup > 0); // estimate is tracked separately
  } finally {
    await store.close();
  }
});