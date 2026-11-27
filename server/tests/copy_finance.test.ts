import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import type { ContractRecord, ContractStatus } from '../execution/types.js';
import type { CopyTradingFollowerRecord } from '../copyTrading/types.js';
import {
  FEE_POLICY,
  computeFollowerCommissions,
  applyFollowerCommissions,
  buildStatement
} from '../copyTrading/finance.js';
import { followerPrincipalId } from '../copyTrading/performance.js';

/**
 * Copy-trading financial engine.
 *
 * Pure commission math (high-water-mark, loss carry-forward, 40/60 split, 3%
 * markup), idempotent application, and the per-master statement. No broker, no
 * gateway: contracts are seeded directly, so what is asserted is the fee policy
 * itself rather than the execution path (covered elsewhere).
 */

const NOW = 2_000_000;
const SECRET = 'test_session_secret_at_least_32_characters_long_000';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-finance-'));
}

const MASTER: UserRecord = {
  id: 'u_master',
  derivSub: 'sub_master',
  accounts: [{ accountId: 'M_DEMO', type: 'demo', currency: 'USD', status: 'active' }],
  createdAt: NOW,
  updatedAt: NOW,
  preferences: {}
};

function follower(overrides: Partial<CopyTradingFollowerRecord> = {}): CopyTradingFollowerRecord {
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
    revision: 1,
    ...overrides
  };
}

let contractSeq = 0;
function contract(overrides: Partial<ContractRecord> = {}): ContractRecord {
  contractSeq += 1;
  const id = overrides.id ?? `c_${contractSeq}`;
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
    status: 'won' as ContractStatus,
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

/* ------------------------------ commission math --------------------------- */

test('a winning contract charges 40% manager / 60% client on its profit', async () => {
  const store = await harness();
  try {
    const entries = computeFollowerCommissions({
      ownerUserId: 'u_master',
      followerId: 'f_1',
      contracts: [contract({ profit: 10, stake: 10 })],
      now: NOW
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].commissionBase, 10);
    assert.equal(entries[0].managerCommission, 4);
    assert.equal(entries[0].clientAllocation, 6);
    assert.equal(entries[0].highWaterMarkAfter, 10);
  } finally {
    await store.close();
  }
});

test('a loss carries forward: no commission until a new profit high', async () => {
  const store = await harness();
  try {
    const entries = computeFollowerCommissions({
      ownerUserId: 'u_master',
      followerId: 'f_1',
      contracts: [
        contract({ id: 'c_lose', profit: -10, status: 'lost', settlementTime: NOW - 2000 }),
        contract({ id: 'c_small', profit: 5, status: 'won', settlementTime: NOW - 1000 }),
        contract({ id: 'c_high', profit: 8, status: 'won', settlementTime: NOW })
      ],
      now: NOW
    });
    // cumulative: -10 -> -5 -> 3 ; HWM stays 0 until cumulative exceeds 0.
    assert.equal(entries[0].commissionBase, 0);
    assert.equal(entries[1].commissionBase, 0);
    assert.equal(entries[2].commissionBase, 3);
    assert.equal(entries[2].managerCommission, 1.2);
    assert.equal(entries[2].highWaterMarkAfter, 3);
  } finally {
    await store.close();
  }
});

test('markup is estimated at 3% of stake and never auto-confirmed', async () => {
  const store = await harness();
  try {
    const entries = computeFollowerCommissions({
      ownerUserId: 'u_master',
      followerId: 'f_1',
      contracts: [contract({ profit: 10, stake: 30 })],
      now: NOW
    });
    assert.equal(entries[0].estimatedMarkup, 0.9);
    assert.equal(entries[0].confirmedMarkup, null);
    assert.equal(entries[0].markupStatus, 'estimated');
  } finally {
    await store.close();
  }
});

test('unconfirmed markup is never counted as confirmed platform revenue', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_mk', profit: 10, stake: 30 }));
    await applyFollowerCommissions(store, 'u_master', { now: NOW });
    const statement = buildStatement(store, 'u_master', NOW);
    assert.equal(statement.totals.estimatedMarkup, 0.9);
    assert.equal(statement.totals.confirmedMarkup, 0);
  } finally {
    await store.close();
  }
});

test('unsettled contracts are never commissioned', async () => {
  const store = await harness();
  try {
    const entries = computeFollowerCommissions({
      ownerUserId: 'u_master',
      followerId: 'f_1',
      contracts: [contract({ status: 'open', profit: null, settlementTime: null })],
      now: NOW
    });
    assert.equal(entries.length, 0);
  } finally {
    await store.close();
  }
});

test('fees are never charged on projected or null profit', async () => {
  const store = await harness();
  try {
    const entries = computeFollowerCommissions({
      ownerUserId: 'u_master',
      followerId: 'f_1',
      contracts: [contract({ status: 'sold', profit: null })],
      now: NOW
    });
    assert.equal(entries.length, 0);
  } finally {
    await store.close();
  }
});

/* -------------------------------- idempotency ----------------------------- */

test('applying twice never double-charges (idempotent by dedupeKey)', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_dup', profit: 10, stake: 10 }));
    const first = await applyFollowerCommissions(store, 'u_master', { now: NOW });
    const second = await applyFollowerCommissions(store, 'u_master', { now: NOW });
    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0);
    assert.equal(second.skipped, 1);
    assert.equal(store.listCommissionEntries('u_master').length, 1);
    assert.equal(store.listCommissionEntries('u_master')[0].managerCommission, 4);
  } finally {
    await store.close();
  }
});

test('a new settled contract is appended without re-charging earlier ones', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_a', profit: 10, settlementTime: NOW - 1000 }));
    await applyFollowerCommissions(store, 'u_master', { now: NOW });
    await store.putContract(contract({ id: 'c_b', profit: 10, settlementTime: NOW }));
    const result = await applyFollowerCommissions(store, 'u_master', { now: NOW });
    assert.equal(result.inserted, 1);
    const entries = store.listCommissionEntries('u_master');
    assert.equal(entries.length, 2);
    // Second contract's base is 0 (cumulative 20, HWM already 10 -> base 10).
    const second = entries.find((e) => e.contractId === 'c_b');
    assert.equal(second?.commissionBase, 10);
  } finally {
    await store.close();
  }
});

/* -------------------------------- statement ------------------------------- */

test('statement aggregates the master own P/L and each follower, never mixing them', async () => {
  const store = await harness();
  try {
    // Master's own settled contract (not commissioned).
    await store.putContract(
      contract({ id: 'c_master', userId: 'u_master', accountId: 'M_DEMO', profit: 50, settlementTime: NOW })
    );
    await store.putContract(contract({ id: 'c_follower', profit: 10, settlementTime: NOW }));
    await applyFollowerCommissions(store, 'u_master', { now: NOW });

    const statement = buildStatement(store, 'u_master', NOW);
    assert.equal(statement.masterRealisedPnl, 50);
    assert.equal(statement.totals.managerCommission, 4);
    assert.equal(statement.totals.clientAllocation, 6);
    assert.equal(statement.followers.length, 1);
    assert.equal(statement.followers[0].realisedPnl, 10);
    assert.equal(statement.followers[0].managerCommission, 4);
  } finally {
    await store.close();
  }
});

test('clearTradingData also clears the commission ledger', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_x', profit: 10 }));
    await applyFollowerCommissions(store, 'u_master', { now: NOW });
    assert.equal(store.listCommissionEntries('u_master').length, 1);
    await store.clearTradingData(['u_master', followerPrincipalId('f_1')]);
    assert.equal(store.listCommissionEntries('u_master').length, 0);
  } finally {
    await store.close();
  }
});

test('the published fee policy is 40/60 with a 3% markup', () => {
  assert.equal(FEE_POLICY.managerCommissionRate, 0.4);
  assert.equal(FEE_POLICY.clientProfitShareRate, 0.6);
  assert.equal(FEE_POLICY.appMarkupRate, 0.03);
  assert.equal(FEE_POLICY.managerCommissionRate + FEE_POLICY.clientProfitShareRate, 1);
});