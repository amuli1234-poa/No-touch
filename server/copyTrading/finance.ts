import type { ContractRecord } from '../execution/types.js';
import type { Store } from '../store/store.js';
import { followerPrincipalId } from './performance.js';
import { roundMoney, toMinor, fromMinor, applyBasisPoints } from './money.js';
import { effectiveProfit, type ContractAdjustmentRecord } from './adjustments.js';

/**
 * Copy-trading financial engine.
 *
 * Turns *settled* follower contracts into immutable commission records using a
 * high-water-mark policy, and aggregates them into a per-master statement. It is
 * additive: it reads the existing contract ledger (plus any settlement
 * adjustments) and writes a separate `commissionEntries` collection. It never
 * places, sizes or alters a trade, and it never fabricates a figure — an
 * unsettled contract contributes nothing.
 *
 * Fee policy (normative — see docs/COPY_TRADING_PLATFORM_PLAN.md §2):
 *   - Manager performance commission = 40% of the commission base.
 *   - Client profit allocation        = 60% of the commission base.
 *   - App ID markup                   = 3% of stake (traded volume).
 * The commission base is realised profit *above the follower's high-water mark*,
 * so losses carry forward and no fee is charged until a new profit high is set.
 *
 * Markup is tracked in three distinct states — estimated, reported and confirmed
 * collected. Only a confirmed figure counts as revenue; an estimate never does.
 */

export interface CommissionPolicy {
  managerCommissionRate: number;
  clientProfitShareRate: number;
  appMarkupRate: number;
}

export const FEE_POLICY: CommissionPolicy = {
  managerCommissionRate: 0.4,
  clientProfitShareRate: 0.6,
  appMarkupRate: 0.03
};

const SETTLED = new Set(['won', 'lost', 'sold', 'cancelled']);

export type MarkupStatus = 'estimated' | 'reported' | 'confirmed';

export interface CommissionEntryRecord {
  id: string;
  ownerUserId: string;
  followerId: string;
  principal: string;
  accountId: string;
  contractId: string;
  currency: string;
  stake: number;
  /** Realised profit used at issue time (original + adjustments then known). */
  realisedPnl: number;
  commissionBase: number;
  managerCommission: number;
  clientAllocation: number;
  /** stake × appMarkupRate. */
  estimatedMarkup: number;
  /** Markup reported by Deriv, when available (null otherwise). */
  reportedMarkup: number | null;
  /** Markup confirmed collected via reconciliation (null until then). */
  confirmedMarkup: number | null;
  markupStatus: MarkupStatus;
  highWaterMarkBefore: number;
  highWaterMarkAfter: number;
  dedupeKey: string;
  createdAt: number;
}

export interface FollowerStatement {
  followerId: string;
  loginId: string | null;
  realisedPnl: number;
  commissionBase: number;
  managerCommission: number;
  clientAllocation: number;
  estimatedMarkup: number;
  reportedMarkup: number;
  confirmedMarkup: number;
  highWaterMark: number;
  trades: number;
}

export interface CopyStatement {
  ownerUserId: string;
  generatedAt: number;
  /** Master's own settled P/L, or null when it is not recorded (unavailable). */
  masterRealisedPnl: number | null;
  followers: FollowerStatement[];
  totals: {
    realisedPnl: number;
    managerCommission: number;
    clientAllocation: number;
    estimatedMarkup: number;
    reportedMarkup: number;
    confirmedMarkup: number;
    trades: number;
  };
  /** Issued commission records (historical, traceable). */
  entries: CommissionEntryRecord[];
  /** Settlement adjustments applied to the current figures. */
  adjustments: ContractAdjustmentRecord[];
}

function toMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

function isSettled(contract: ContractRecord): boolean {
  return SETTLED.has(contract.status) && contract.profit !== null && Number.isFinite(contract.profit);
}

function settlementOrder(a: ContractRecord, b: ContractRecord): number {
  const at = toMs(a.settlementTime ?? a.purchaseTime);
  const bt = toMs(b.settlementTime ?? b.purchaseTime);
  if (at !== bt) return at - bt;
  return a.id.localeCompare(b.id);
}

/**
 * Pure: recompute the full commission set for one follower from its settled
 * contracts (using effective profit = original + adjustments). Deterministic and
 * idempotent by construction — the caller inserts only missing dedupeKeys.
 */
export function computeFollowerCommissions(args: {
  ownerUserId: string;
  followerId: string;
  contracts: readonly ContractRecord[];
  adjustments?: Map<string, ContractAdjustmentRecord[]>;
  now?: number;
  policy?: CommissionPolicy;
}): CommissionEntryRecord[] {
  const { ownerUserId, followerId } = args;
  const policy = args.policy ?? FEE_POLICY;
  const now = args.now ?? Date.now();
  const principal = followerPrincipalId(followerId);
  const adjustments = args.adjustments ?? new Map();

  const settled = args.contracts
    .filter((c) => c.userId === principal && isSettled(c))
    .sort(settlementOrder);

  const entries: CommissionEntryRecord[] = [];
  // All arithmetic is integer minor units — no float ever touches a monetary value.
  const managerBp = BigInt(Math.round(policy.managerCommissionRate * 100));
  const clientBp = BigInt(Math.round(policy.clientProfitShareRate * 100));
  const markupBp = BigInt(Math.round(policy.appMarkupRate * 100));
  let cumulativeMinor = 0n;
  let hwmMinor = 0n;

  for (const contract of settled) {
    const currency = contract.currency;
    const pnlMinor = toMinor(effectiveProfit(contract, adjustments.get(contract.id) ?? []), currency);
    const hwmBeforeMinor = hwmMinor;
    cumulativeMinor += pnlMinor;
    const commissionBaseMinor = cumulativeMinor - hwmBeforeMinor > 0n ? cumulativeMinor - hwmBeforeMinor : 0n;
    const managerMinor = applyBasisPoints(commissionBaseMinor, managerBp);
    const clientMinor = applyBasisPoints(commissionBaseMinor, clientBp);
    hwmMinor = hwmBeforeMinor > cumulativeMinor ? hwmBeforeMinor : cumulativeMinor;

    const stakeMinor = toMinor(contract.stake, currency);
    const estimatedMarkupMinor = applyBasisPoints(stakeMinor, markupBp);

    entries.push({
      id: `comm_${contract.id}`,
      ownerUserId,
      followerId,
      principal,
      accountId: contract.accountId,
      contractId: contract.id,
      currency,
      stake: contract.stake,
      realisedPnl: fromMinor(pnlMinor, currency),
      commissionBase: fromMinor(commissionBaseMinor, currency),
      managerCommission: fromMinor(managerMinor, currency),
      clientAllocation: fromMinor(clientMinor, currency),
      estimatedMarkup: fromMinor(estimatedMarkupMinor, currency),
      reportedMarkup: null,
      confirmedMarkup: null,
      markupStatus: 'estimated',
      highWaterMarkBefore: fromMinor(hwmBeforeMinor, currency),
      highWaterMarkAfter: fromMinor(hwmMinor, currency),
      dedupeKey: `commission:${contract.id}`,
      createdAt: now
    });
  }

  return entries;
}

export interface ApplyResult {
  followers: number;
  inserted: number;
  skipped: number;
  totals: {
    managerCommission: number;
    clientAllocation: number;
    estimatedMarkup: number;
    reportedMarkup: number;
    confirmedMarkup: number;
  };
}

/** Build the contractId -> adjustments map for a set of contracts. */
function adjustmentsMap(store: Store, contracts: readonly ContractRecord[]): Map<string, ContractAdjustmentRecord[]> {
  const map = new Map<string, ContractAdjustmentRecord[]>();
  for (const c of contracts) {
    const list = store.listContractAdjustments(c.id);
    if (list.length > 0) map.set(c.id, list);
  }
  return map;
}

/**
 * Idempotent writer: recompute each follower's plan (effective profit) and insert
 * only missing records. Re-running never charges the same fee twice.
 */
export async function applyFollowerCommissions(
  store: Store,
  ownerUserId: string,
  options: { now?: number; policy?: CommissionPolicy } = {}
): Promise<ApplyResult> {
  const now = options.now ?? Date.now();
  const followers = store.listCopyTradingFollowers(ownerUserId);
  const result: ApplyResult = {
    followers: followers.length,
    inserted: 0,
    skipped: 0,
    totals: { managerCommission: 0, clientAllocation: 0, estimatedMarkup: 0, reportedMarkup: 0, confirmedMarkup: 0 }
  };

  for (const follower of followers) {
    const contracts = store.listContracts(followerPrincipalId(follower.id));
    const adjustments = adjustmentsMap(store, contracts);
    const plan = computeFollowerCommissions({ ownerUserId, followerId: follower.id, contracts, adjustments, now, policy: options.policy });
    for (const entry of plan) {
      const inserted = await store.putCommissionEntry(entry);
      if (inserted) {
        result.inserted += 1;
        result.totals.managerCommission = roundMoney(result.totals.managerCommission + entry.managerCommission, entry.currency);
        result.totals.clientAllocation = roundMoney(result.totals.clientAllocation + entry.clientAllocation, entry.currency);
        result.totals.estimatedMarkup = roundMoney(result.totals.estimatedMarkup + entry.estimatedMarkup, entry.currency);
        result.totals.reportedMarkup = roundMoney(result.totals.reportedMarkup + (entry.reportedMarkup ?? 0), entry.currency);
        result.totals.confirmedMarkup = roundMoney(result.totals.confirmedMarkup + (entry.confirmedMarkup ?? 0), entry.currency);
      } else {
        result.skipped += 1;
      }
    }
  }

  return result;
}

/**
 * Read-only statement across the master's own account and every follower.
 * Figures are recomputed from effective profit (original + adjustments), so a
 * correction is reflected immediately; the issued `entries` are returned for
 * traceability. The master's own P/L is null (unavailable) when not recorded.
 */
export function buildStatement(store: Store, ownerUserId: string, now = Date.now()): CopyStatement {
  const master = store.getUserById(ownerUserId);
  const followers = store.listCopyTradingFollowers(ownerUserId);
  const issued = store.listCommissionEntries(ownerUserId);

  const masterContracts = master ? store.listContracts(ownerUserId) : [];
  let masterRealisedPnl: number | null;
  if (masterContracts.length === 0) {
    masterRealisedPnl = null; // not recorded (e.g. /bot trades) — never a fabricated 0
  } else {
    const adj = adjustmentsMap(store, masterContracts);
    masterRealisedPnl = 0;
    for (const c of masterContracts) {
      if (isSettled(c)) masterRealisedPnl = roundMoney((masterRealisedPnl ?? 0) + effectiveProfit(c, adj.get(c.id) ?? []), c.currency);
    }
  }

  const byFollower = new Map<string, FollowerStatement>();
  for (const follower of followers) {
    byFollower.set(follower.id, {
      followerId: follower.id,
      loginId: follower.loginId ?? null,
      realisedPnl: 0,
      commissionBase: 0,
      managerCommission: 0,
      clientAllocation: 0,
      estimatedMarkup: 0,
      reportedMarkup: 0,
      confirmedMarkup: 0,
      highWaterMark: 0,
      trades: 0
    });
  }

  const totals = {
    realisedPnl: masterRealisedPnl ?? 0,
    managerCommission: 0,
    clientAllocation: 0,
    estimatedMarkup: 0,
    reportedMarkup: 0,
    confirmedMarkup: 0,
    trades: 0
  };

  const allAdjustments: ContractAdjustmentRecord[] = [];

  for (const follower of followers) {
    const contracts = store.listContracts(followerPrincipalId(follower.id));
    const adj = adjustmentsMap(store, contracts);
    const plan = computeFollowerCommissions({ ownerUserId, followerId: follower.id, contracts, adjustments: adj, now });
    const row = byFollower.get(follower.id)!;
    for (const entry of plan) {
      row.realisedPnl = roundMoney(row.realisedPnl + entry.realisedPnl, entry.currency);
      row.commissionBase = roundMoney(row.commissionBase + entry.commissionBase, entry.currency);
      row.managerCommission = roundMoney(row.managerCommission + entry.managerCommission, entry.currency);
      row.clientAllocation = roundMoney(row.clientAllocation + entry.clientAllocation, entry.currency);
      row.estimatedMarkup = roundMoney(row.estimatedMarkup + entry.estimatedMarkup, entry.currency);
      row.reportedMarkup = roundMoney(row.reportedMarkup + (entry.reportedMarkup ?? 0), entry.currency);
      row.confirmedMarkup = roundMoney(row.confirmedMarkup + (entry.confirmedMarkup ?? 0), entry.currency);
      row.highWaterMark = entry.highWaterMarkAfter;
      row.trades += 1;
      totals.realisedPnl = roundMoney(totals.realisedPnl + entry.realisedPnl, entry.currency);
      totals.managerCommission = roundMoney(totals.managerCommission + entry.managerCommission, entry.currency);
      totals.clientAllocation = roundMoney(totals.clientAllocation + entry.clientAllocation, entry.currency);
      totals.estimatedMarkup = roundMoney(totals.estimatedMarkup + entry.estimatedMarkup, entry.currency);
      totals.reportedMarkup = roundMoney(totals.reportedMarkup + (entry.reportedMarkup ?? 0), entry.currency);
      totals.confirmedMarkup = roundMoney(totals.confirmedMarkup + (entry.confirmedMarkup ?? 0), entry.currency);
      totals.trades += 1;
      allAdjustments.push(...(adj.get(entry.contractId) ?? []));
    }
  }

  return {
    ownerUserId,
    generatedAt: now,
    masterRealisedPnl,
    followers: [...byFollower.values()],
    totals,
    entries: issued,
    adjustments: allAdjustments
  };
}