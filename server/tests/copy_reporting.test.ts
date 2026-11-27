import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import type { ContractRecord, TradeIntentRecord, IntentState } from '../execution/types.js';
import type { CopyTradingFollowerRecord, CopyTradingInvitationRecord } from '../copyTrading/types.js';
import type { CommissionEntryRecord } from '../copyTrading/finance.js';
import {
  buildPlatformOverview,
  buildReconciliation,
  buildExecutions,
  followerPnl,
  allPrincipals,
  buildClientSummary
} from '../copyTrading/reporting.js';
import { followerPrincipalId } from '../copyTrading/performance.js';

/**
 * Admin reporting aggregations. Pure functions over stored records — no broker,
 * no network. What is asserted is that the overview/reconciliation/executions
 * figures are derived correctly and never fabricated.
 */

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-report-'));
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
    purchaseTime: Math.floor(NOW / 1000),
    startTime: Math.floor(NOW / 1000),
    expiryTime: null,
    settlementTime: Math.floor(NOW / 1000),
    status: 'won',
    profit: 9,
    soldFor: null,
    buyTransactionId: null,
    updatedAt: NOW,
    ...overrides
  };
}

function intent(overrides: Partial<TradeIntentRecord> = {}): TradeIntentRecord {
  seq += 1;
  const id = overrides.id ?? `int_${seq}`;
  return {
    id,
    userId: followerPrincipalId('f_1'),
    accountId: 'F1_DEMO',
    accountMode: 'demo',
    contractFamily: 'rise_fall',
    contractType: 'CALL',
    symbol: 'R_100',
    timeframe: '5m',
    signalId: `sig_${id}`,
    approvedBy: 'copy',
    approvedAt: NOW,
    approvalExpiresAt: null,
    stake: 10,
    basis: 'stake',
    currency: 'USD',
    parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
    state: 'OPEN' as IntentState,
    contractId: null,
    reason: null,
    idempotencyKey: `key_${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function invitation(overrides: Partial<CopyTradingInvitationRecord> = {}): CopyTradingInvitationRecord {
  return {
    id: 'inv_1',
    ownerUserId: 'u_master',
    tokenHash: 'hash',
    createdAt: NOW,
    expiresAt: NOW + DAY,
    consumedAt: null,
    ...overrides
  };
}

function commission(overrides: Partial<CommissionEntryRecord> = {}): CommissionEntryRecord {
  return {
    id: 'comm_c_1',
    ownerUserId: 'u_master',
    followerId: 'f_1',
    principal: followerPrincipalId('f_1'),
    accountId: 'F1_DEMO',
    contractId: 'c_1',
    currency: 'USD',
    stake: 10,
    realisedPnl: 10,
    commissionBase: 10,
    managerCommission: 4,
    clientAllocation: 6,
    estimatedMarkup: 0.3,
    reportedMarkup: null,
    confirmedMarkup: 0.3,
    markupStatus: 'confirmed',
    highWaterMarkBefore: 0,
    highWaterMarkAfter: 10,
    dedupeKey: 'commission:c_1',
    createdAt: NOW,
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

test('allPrincipals spans the real user and the follower principal', async () => {
  const store = await harness();
  try {
    const principals = allPrincipals(store);
    assert.ok(principals.includes('u_master'));
    assert.ok(principals.includes(followerPrincipalId('f_1')));
  } finally {
    await store.close();
  }
});

test('overview counts clients, pending invitations, today trades and revenue', async () => {
  const store = await harness();
  try {
    await store.putCopyTradingInvitation(invitation());
    await store.putContract(contract({ id: 'c_today', profit: 9 }));
    await store.putCommissionEntry(commission());
    await store.putTradeIntent(intent({ id: 'int_fail', state: 'FAILED' }));
    await store.putTradeIntent(intent({ id: 'int_stuck', state: 'RECONCILIATION_REQUIRED' }));

    const overview = buildPlatformOverview(store, NOW);
    assert.equal(overview.clients.total, 1);
    assert.equal(overview.clients.active, 1);
    assert.equal(overview.clients.pendingAuthorizations, 1);
    assert.equal(overview.today.trades, 1);
    assert.equal(overview.today.realisedPnl, 9);
    assert.equal(overview.revenue.confirmedMarkup, 0.3);
    assert.equal(overview.revenue.performanceCommissions, 4);
    assert.equal(overview.execution.failed, 1);
    assert.equal(overview.execution.stuck, 1);
    assert.ok(overview.warnings.some((w) => w.includes('reconciliation')));
  } finally {
    await store.close();
  }
});

test('a consumed or expired invitation is not counted as pending', async () => {
  const store = await harness();
  try {
    await store.putCopyTradingInvitation(invitation({ id: 'inv_used', consumedAt: NOW }));
    await store.putCopyTradingInvitation(invitation({ id: 'inv_expired', expiresAt: NOW - DAY }));
    const overview = buildPlatformOverview(store, NOW);
    assert.equal(overview.clients.pendingAuthorizations, 0);
  } finally {
    await store.close();
  }
});

test('reconciliation lists stuck intents and counts open/expired contracts', async () => {
  const store = await harness();
  try {
    await store.putTradeIntent(intent({ id: 'int_unknown', state: 'UNKNOWN' }));
    await store.putContract(contract({ id: 'c_open', status: 'open', profit: null, settlementTime: null, expiryTime: Math.floor((NOW + DAY) / 1000) }));
    await store.putContract(contract({ id: 'c_expired', status: 'open', profit: null, settlementTime: null, expiryTime: Math.floor((NOW - DAY) / 1000) }));

    const report = buildReconciliation(store, NOW);
    assert.equal(report.stuckIntents.length, 1);
    assert.equal(report.stuckIntents[0].id, 'int_unknown');
    assert.equal(report.openContracts, 2);
    assert.equal(report.expiredOpenContracts, 1);
  } finally {
    await store.close();
  }
});

test('executions are newest first and respect the limit', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_old', purchaseTime: Math.floor((NOW - 2 * DAY) / 1000) }));
    await store.putContract(contract({ id: 'c_new', purchaseTime: Math.floor(NOW / 1000) }));
    const rows = buildExecutions(store, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].contractId, 'c_new');
  } finally {
    await store.close();
  }
});

test('followerPnl sums only settled contracts', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_won', status: 'won', profit: 9 }));
    await store.putContract(contract({ id: 'c_lost', status: 'lost', profit: -10 }));
    await store.putContract(contract({ id: 'c_open', status: 'open', profit: null, settlementTime: null }));
    const pnl = followerPnl(store, 'f_1');
    assert.equal(pnl.trades, 2);
    assert.equal(pnl.realisedPnl, -1);
  } finally {
    await store.close();
  }
});

/* ------------------------------ client portal ----------------------------- */

test('client summary reports the caller own trading and earnings', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_cw', status: 'won', profit: 9 }));
    await store.putContract(contract({ id: 'c_cl', status: 'lost', profit: -10 }));
    await store.putCommissionEntry(commission({ id: 'comm_x', contractId: 'c_cw', clientAllocation: 6, managerCommission: 4, confirmedMarkup: 0.3 }));
    const summary = buildClientSummary(store, 'sub_follower_1', NOW);
    assert.equal(summary.followers.length, 1);
    assert.equal(summary.followers[0].masterLoginId, null);
    assert.equal(summary.trading.trades, 2);
    assert.equal(summary.trading.wins, 1);
    assert.equal(summary.trading.losses, 1);
    assert.equal(summary.trading.realisedPnl, -1);
    assert.equal(summary.earnings.clientAllocation, 6);
    assert.equal(summary.earnings.confirmedMarkup, 0.3);
  } finally {
    await store.close();
  }
});

test('a client can never read another client data (identity isolation)', async () => {
  const store = await harness();
  try {
    await store.putContract(contract({ id: 'c_hidden', status: 'won', profit: 9 }));
    const stranger = buildClientSummary(store, 'sub_someone_else', NOW);
    assert.equal(stranger.followers.length, 0);
    assert.equal(stranger.trading.trades, 0);
    assert.equal(stranger.earnings.clientAllocation, 0);
  } finally {
    await store.close();
  }
});