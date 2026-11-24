import type { Store } from '../store/store.js';
import type { ContractRecord, ContractStatus } from '../execution/types.js';
import type { CopyTradingFollowerRecord } from './types.js';

/**
 * Copy-trading performance reporting.
 *
 * A copied trade is owned by the follower's synthetic principal
 * (`copy_follower_<id>`), not by the manager, so the manager's own
 * `listContracts` never sees it. Reporting therefore reads contracts for the
 * manager *and* every follower principal and attributes each contract back to
 * the account it was placed on.
 *
 * Nothing here places, sizes or alters a trade. It is a read-only projection
 * over contracts the execution gateway already recorded.
 */

/** Statuses whose profit will not change again. */
const SETTLED: ReadonlySet<ContractStatus> = new Set(['won', 'lost', 'sold', 'cancelled']);

export interface AccountPerformance {
  /** `null` identifies the manager's own account rather than a follower's. */
  followerId: string | null;
  /** Deriv login the account belongs to, when known. */
  loginId: string | null;
  accountId: string;
  accountMode: 'demo' | 'real';
  currency: string;
  trades: number;
  settledTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  /** Sum of realised profit across settled contracts. */
  realisedPnl: number;
  /** Sum of buy prices across settled contracts. */
  staked: number;
  /** Stake still at risk on open contracts. */
  openStake: number;
  lastTradeAt: number | null;
}

export interface DailyPerformance {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  realisedPnl: number;
  trades: number;
}

export interface CopyPerformanceSummary {
  generatedAt: number;
  ownerUserId: string;
  /** Whether the master's copy switch is on. */
  enabled: boolean;
  /** Distinct follower connections included in the report. */
  followers: number;
  totals: {
    accounts: number;
    trades: number;
    settledTrades: number;
    openTrades: number;
    wins: number;
    losses: number;
    realisedPnl: number;
    staked: number;
    openStake: number;
    /** Realised P&L as a percentage of staked amount, when any stake settled. */
    roiPercent: number | null;
  };
  /** Per-account rows, manager's own accounts first. */
  accounts: AccountPerformance[];
  /** Realised P&L per UTC day, oldest first. */
  daily: DailyPerformance[];
}

export interface PerformanceOptions {
  /** How many days of daily history to return. Defaults to 30. */
  days?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

/** The synthetic principal the copy engine uses for a follower. */
export function followerPrincipalId(followerId: string): string {
  return `copy_follower_${followerId}`;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyRow(
  followerId: string | null,
  loginId: string | null,
  accountId: string,
  accountMode: 'demo' | 'real',
  currency: string
): AccountPerformance {
  return {
    followerId,
    loginId,
    accountId,
    accountMode,
    currency,
    trades: 0,
    settledTrades: 0,
    openTrades: 0,
    wins: 0,
    losses: 0,
    realisedPnl: 0,
    staked: 0,
    openStake: 0,
    lastTradeAt: null
  };
}

/**
 * Builds a performance summary for one master and every follower they manage.
 *
 * Accounts are enumerated from the manager and follower records rather than
 * from contracts, so an account that has not traded yet still appears with a
 * zero row — a manager can see the whole book, not only the accounts that
 * happen to have activity.
 */
export function buildCopyPerformance(
  store: Store,
  ownerUserId: string,
  options: PerformanceOptions = {}
): CopyPerformanceSummary {
  const now = options.now ?? (() => Date.now());
  const days = Math.max(1, Math.min(365, options.days ?? 30));

  const master = store.getUserById(ownerUserId);
  const followers = store.listAllCopyTradingFollowers().filter((f) => f.ownerUserId === ownerUserId);

  const rows = new Map<string, AccountPerformance>();
  const rowKey = (followerId: string | null, accountId: string) => `${followerId ?? 'master'}:${accountId}`;

  if (master) {
    for (const account of master.accounts) {
      const mode = account.type === 'real' ? 'real' : 'demo';
      rows.set(
        rowKey(null, account.accountId),
        emptyRow(null, master.loginId ?? null, account.accountId, mode, account.currency ?? 'USD')
      );
    }
  }

  const principals: string[] = master ? [master.id] : [];
  for (const follower of followers) {
    principals.push(followerPrincipalId(follower.id));
    for (const account of follower.accounts) {
      const mode = account.type === 'real' ? 'real' : 'demo';
      rows.set(
        rowKey(follower.id, account.accountId),
        emptyRow(follower.id, follower.loginId ?? null, account.accountId, mode, account.currency ?? 'USD')
      );
    }
  }

  // Attribute each contract to the follower it belongs to, if any.
  const followerByPrincipal = new Map<string, CopyTradingFollowerRecord>();
  for (const follower of followers) followerByPrincipal.set(followerPrincipalId(follower.id), follower);

  const daily = new Map<string, DailyPerformance>();
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const contracts: ContractRecord[] = store.listContractsForUsers(principals);

  for (const contract of contracts) {
    const follower = followerByPrincipal.get(contract.userId) ?? null;
    const followerId = follower?.id ?? null;
    const key = rowKey(followerId, contract.accountId);
    let row = rows.get(key);
    if (!row) {
      // A contract for an account no longer on the record: keep its history
      // rather than dropping P&L from the totals.
      const mode = contract.accountMode === 'real' ? 'real' : 'demo';
      row = emptyRow(followerId, follower?.loginId ?? null, contract.accountId, mode, contract.currency);
      rows.set(key, row);
    }

    row.trades += 1;
    row.lastTradeAt = Math.max(row.lastTradeAt ?? 0, contract.purchaseTime) || null;

    if (SETTLED.has(contract.status)) {
      row.settledTrades += 1;
      row.staked += contract.buyPrice;
      const profit = contract.profit;
      if (profit !== null && Number.isFinite(profit)) {
        row.realisedPnl += profit;
        if (profit > 0) row.wins += 1;
        else if (profit < 0) row.losses += 1;
      }
      if (contract.purchaseTime >= cutoff) {
        const day = dayKey(contract.purchaseTime);
        const bucket = daily.get(day) ?? { date: day, realisedPnl: 0, trades: 0 };
        bucket.realisedPnl += profit !== null && Number.isFinite(profit) ? profit : 0;
        bucket.trades += 1;
        daily.set(day, bucket);
      }
    } else {
      row.openTrades += 1;
      row.openStake += contract.stake;
    }
  }

  const accounts = [...rows.values()].sort((a, b) => {
    // Manager's own accounts first, then followers by login/account.
    if (a.followerId !== b.followerId) {
      if (a.followerId === null) return -1;
      if (b.followerId === null) return 1;
      return a.followerId.localeCompare(b.followerId);
    }
    return a.accountId.localeCompare(b.accountId);
  });

  const totals = accounts.reduce(
    (acc, row) => {
      acc.trades += row.trades;
      acc.settledTrades += row.settledTrades;
      acc.openTrades += row.openTrades;
      acc.wins += row.wins;
      acc.losses += row.losses;
      acc.realisedPnl += row.realisedPnl;
      acc.staked += row.staked;
      acc.openStake += row.openStake;
      return acc;
    },
    {
      accounts: accounts.length,
      trades: 0,
      settledTrades: 0,
      openTrades: 0,
      wins: 0,
      losses: 0,
      realisedPnl: 0,
      staked: 0,
      openStake: 0,
      roiPercent: null as number | null
    }
  );
  totals.realisedPnl = Math.round(totals.realisedPnl * 100) / 100;
  totals.staked = Math.round(totals.staked * 100) / 100;
  totals.openStake = Math.round(totals.openStake * 100) / 100;
  if (totals.staked > 0) totals.roiPercent = Math.round((totals.realisedPnl / totals.staked) * 10000) / 100;

  const control = store.getCopyTradingControl(ownerUserId);

  return {
    generatedAt: now(),
    ownerUserId,
    enabled: Boolean(control?.enabled),
    followers: followers.length,
    totals,
    accounts,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}
