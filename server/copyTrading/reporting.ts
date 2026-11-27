import type { Store } from '../store/store.js';
import type { ContractRecord, TradeIntentRecord } from '../execution/types.js';
import { followerPrincipalId } from './performance.js';

/**
 * Read-only reporting aggregations for the admin Copy Trading workspace.
 *
 * Every figure is derived from stored records (contracts, intents, commission
 * entries, invitations). Nothing is projected and no live Deriv call is made
 * here — connected balances are read per client through the existing balance
 * route, so a reporting page never blocks on the network.
 */

/** Deriv reports times in seconds; some records use ms. Normalise to ms. */
function toMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Every trading principal: the real users plus each follower's synthetic id. */
export function allPrincipals(store: Store): string[] {
  const principals = store.listUsers().map((u) => u.id);
  for (const follower of store.listAllCopyTradingFollowers()) {
    principals.push(followerPrincipalId(follower.id));
  }
  return principals;
}

export interface PlatformOverview {
  generatedAt: number;
  clients: {
    total: number;
    active: number;
    pendingAuthorizations: number;
  };
  today: {
    trades: number;
    realisedPnl: number;
  };
  revenue: {
    confirmedMarkup: number;
    estimatedMarkup: number;
    performanceCommissions: number;
  };
  execution: {
    failed: number;
    stuck: number;
  };
  warnings: string[];
}

/** Platform-wide snapshot for the admin overview. All values from stored records. */
export function buildPlatformOverview(store: Store, now = Date.now()): PlatformOverview {
  const followers = store.listAllCopyTradingFollowers();
  const active = followers.filter((f) => {
    const s = f.status ?? 'authorized';
    return s === 'active' || s === 'authorized';
  });
  const pending = store
    .listAllCopyTradingInvitations()
    .filter((i) => i.consumedAt === null && !i.revokedAt && i.expiresAt > now);

  const principals = allPrincipals(store);
  const contracts = store.listContractsForUsers(principals);
  const todayStart = new Date(now).setHours(0, 0, 0, 0);

  let todayTrades = 0;
  let todayPnl = 0;
  for (const c of contracts) {
    if (toMs(c.purchaseTime) >= todayStart) todayTrades += 1;
    if (c.settlementTime !== null && toMs(c.settlementTime) >= todayStart && c.profit !== null) {
      todayPnl = round2(todayPnl + c.profit);
    }
  }

  const entries = store.listAllCommissionEntries();
  let confirmedMarkup = 0;
  let estimatedMarkup = 0;
  let commissions = 0;
  for (const e of entries) {
    confirmedMarkup = round2(confirmedMarkup + (e.confirmedMarkup ?? 0));
    estimatedMarkup = round2(estimatedMarkup + e.estimatedMarkup);
    commissions = round2(commissions + e.managerCommission);
  }

  const intents = principals.flatMap((p) => store.listTradeIntents(p));
  const failed = intents.filter((i) => i.state === 'FAILED' || i.state === 'REJECTED').length;
  const stuck = intents.filter((i) => i.state === 'UNKNOWN' || i.state === 'RECONCILIATION_REQUIRED').length;

  const warnings: string[] = [];
  if (stuck > 0) warnings.push(`${stuck} execution${stuck === 1 ? '' : 's'} awaiting reconciliation.`);
  if (pending.length > 0) warnings.push(`${pending.length} client invitation${pending.length === 1 ? '' : 's'} pending.`);
  if (followers.length === 0) warnings.push('No clients connected yet.');

  return {
    generatedAt: now,
    clients: { total: followers.length, active: active.length, pendingAuthorizations: pending.length },
    today: { trades: todayTrades, realisedPnl: todayPnl },
    revenue: { confirmedMarkup, estimatedMarkup, performanceCommissions: commissions },
    execution: { failed, stuck },
    warnings
  };
}

export interface ReconciliationReport {
  generatedAt: number;
  stuckIntents: Array<{ id: string; userId: string; state: string; contractId: number | null; updatedAt: number }>;
  openContracts: number;
  expiredOpenContracts: number;
  unknownContracts: number;
  note: string;
}

/** Reconciliation view: intents/contracts that need an operator's attention. */
export function buildReconciliation(store: Store, now = Date.now()): ReconciliationReport {
  const principals = allPrincipals(store);
  const intents = principals.flatMap((p) => store.listTradeIntents(p));
  const stuckIntents = intents
    .filter((i) => i.state === 'UNKNOWN' || i.state === 'RECONCILIATION_REQUIRED')
    .map((i) => ({ id: i.id, userId: i.userId, state: i.state, contractId: i.contractId, updatedAt: i.updatedAt }));

  const contracts = store.listContractsForUsers(principals);
  const open = contracts.filter((c) => c.status === 'open');
  const expiredOpen = open.filter((c) => c.expiryTime !== null && toMs(c.expiryTime) < now);
  const unknown = contracts.filter((c) => c.status === 'unknown').length;

  return {
    generatedAt: now,
    stuckIntents,
    openContracts: open.length,
    expiredOpenContracts: expiredOpen.length,
    unknownContracts: unknown,
    note: 'Stuck intents are never retried automatically; use the per-intent reconcile action to read the real state from Deriv.'
  };
}

export interface ExecutionRow {
  contractId: string;
  userId: string;
  accountId: string;
  symbol: string;
  contractType: string;
  stake: number;
  currency: string;
  status: string;
  profit: number | null;
  purchaseTime: number;
}

/** Recent executions across the whole book, newest first. */
export function buildExecutions(store: Store, limit = 50): ExecutionRow[] {
  const principals = allPrincipals(store);
  return store
    .listContractsForUsers(principals)
    .sort((a, b) => toMs(b.purchaseTime) - toMs(a.purchaseTime))
    .slice(0, Math.max(1, Math.min(500, limit)))
    .map((c) => ({
      contractId: c.id,
      userId: c.userId,
      accountId: c.accountId,
      symbol: c.symbol,
      contractType: c.contractType,
      stake: c.stake,
      currency: c.currency,
      status: c.status,
      profit: c.profit,
      purchaseTime: toMs(c.purchaseTime)
    }));
}

/** A single follower's settled-contract P/L, for the client-detail page. */
export function followerPnl(store: Store, followerId: string): { trades: number; realisedPnl: number } {
  const contracts = store.listContracts(followerPrincipalId(followerId));
  let trades = 0;
  let realisedPnl = 0;
  for (const c of contracts) {
    if (c.status === 'won' || c.status === 'lost' || c.status === 'sold' || c.status === 'cancelled') {
      trades += 1;
      if (c.profit !== null) realisedPnl = round2(realisedPnl + c.profit);
    }
  }
  return { trades, realisedPnl };
}

export type { ContractRecord, TradeIntentRecord };

/* ------------------------------ client portal ----------------------------- */

export interface ClientAccountView {
  accountId: string;
  type: string;
  currency: string | null;
}

export interface ClientSummary {
  generatedAt: number;
  followers: Array<{
    id: string;
    status: string;
    masterLoginId: string | null;
    accounts: ClientAccountView[];
    authorizationExpiresAt: number | null;
    authorizationExpired: boolean;
  }>;
  trading: {
    trades: number;
    openTrades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    realisedPnl: number;
    maxDrawdown: number;
  };
  earnings: {
    clientAllocation: number;
    confirmedMarkup: number;
    estimatedMarkup: number;
    managerCommission: number;
  };
}

/**
 * Everything a signed-in client may see about their own copied trading. Scoped
 * strictly by the client's own Deriv identity (`derivSub`): a client can only
 * ever read the follower records that carry their identity, never another's.
 */
export function buildClientSummary(store: Store, derivSub: string, now = Date.now()): ClientSummary {
  const followers = store.listAllCopyTradingFollowers().filter((f) => f.derivSub === derivSub);

  let trades = 0;
  let openTrades = 0;
  let wins = 0;
  let losses = 0;
  let realisedPnl = 0;
  let clientAllocation = 0;
  let confirmedMarkup = 0;
  let estimatedMarkup = 0;
  let managerCommission = 0;

  const pnlSeries: number[] = [];

  for (const follower of followers) {
    const contracts = store
      .listContracts(followerPrincipalId(follower.id))
      .sort((a, b) => toMs(a.purchaseTime) - toMs(b.purchaseTime));
    for (const c of contracts) {
      if (c.status === 'open') {
        openTrades += 1;
      } else if (SETTLED_CLIENT.has(c.status)) {
        trades += 1;
        const pnl = c.profit ?? 0;
        realisedPnl = round2(realisedPnl + pnl);
        if (pnl > 0) wins += 1;
        else if (pnl < 0) losses += 1;
        pnlSeries.push(realisedPnl);
      }
    }
    for (const e of store.listCommissionEntries(follower.ownerUserId)) {
      if (e.followerId !== follower.id) continue;
      clientAllocation = round2(clientAllocation + e.clientAllocation);
      confirmedMarkup = round2(confirmedMarkup + (e.confirmedMarkup ?? 0));
      estimatedMarkup = round2(estimatedMarkup + e.estimatedMarkup);
      managerCommission = round2(managerCommission + e.managerCommission);
    }
  }

  // Max drawdown from the running equity curve.
  let peak = 0;
  let maxDrawdown = 0;
  for (const equity of pnlSeries) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }

  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : null;

  return {
    generatedAt: now,
    followers: followers.map((f) => {
      const master = store.getUserById(f.ownerUserId);
      const expired = f.tokenExpiresAt > 0 && f.tokenExpiresAt <= now;
      return {
        id: f.id,
        status: f.status ?? 'authorized',
        masterLoginId: master?.loginId ?? null,
        accounts: f.accounts.map((a) => ({ accountId: a.accountId, type: a.type, currency: a.currency ?? null })),
        authorizationExpiresAt: f.tokenExpiresAt > 0 ? f.tokenExpiresAt : null,
        authorizationExpired: expired
      };
    }),
    trading: { trades, openTrades, wins, losses, winRate, realisedPnl, maxDrawdown },
    earnings: { clientAllocation, confirmedMarkup, estimatedMarkup, managerCommission }
  };
}

const SETTLED_CLIENT = new Set(['won', 'lost', 'sold', 'cancelled']);