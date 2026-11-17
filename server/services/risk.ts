import type { Store } from '../store/store.js';
import type { RiskProfileRecord, ContractRecord, LedgerEntryRecord } from '../execution/types.js';
import { DEFAULT_RISK_PROFILE } from '../execution/types.js';

/**
 * Risk engine.
 *
 * Every execution must pass this gate. It is the single place that decides
 * whether a proposed trade is allowed under the customer's server-enforced
 * limits. It is pure with respect to inputs: it reads the store (open contracts,
 * ledger, recent intents) and returns a decision with explicit, machine-readable
 * reasons. It never submits anything.
 *
 * The engine is deliberately strict and non-negotiable: a caller cannot pass a
 * flag to skip a limit, and every limit is evaluated even when an earlier one
 * has already failed, so the customer is told the full picture.
 *
 * There is no martingale. No limit can be raised automatically after a loss.
 */

export type RiskRuleId =
  | 'profile_missing'
  | 'stake_positive'
  | 'max_stake'
  | 'daily_loss'
  | 'consecutive_losses'
  | 'max_open_contracts'
  | 'max_exposure'
  | 'min_balance'
  | 'execution_frequency'
  | 'trades_per_session'
  | 'signal_freshness'
  | 'symbol_in_use'
  | 'auto_stopped';

export interface RiskRuleResult {
  id: RiskRuleId;
  passed: boolean;
  detail: string;
}

export interface RiskDecision {
  approved: boolean;
  /** Failed rules, in evaluation order. Empty when approved. */
  reasons: RiskRuleId[];
  rules: RiskRuleResult[];
}

export interface RiskEvaluationInput {
  userId: string;
  accountId: string;
  /** Stake about to be risked. */
  stake: number;
  /** Account balance at evaluation time, when known. */
  balance: number | null;
  /** Age of the signal driving this trade, in seconds. */
  signalAgeSeconds: number | null;
  /** Current time. */
  now: number;
  /**
   * The symbol about to be traded. When set, an account may hold only one open
   * contract per symbol, so a burst of correlated signals on the same market
   * collapses to a single trade instead of stacking several at once.
   */
  symbol?: string | null;
  /**
   * The intent currently being submitted. It is excluded from the
   * "time since the last trade" and "trades today" counts, because it is the
   * trade under evaluation, not a preceding one. Without this, an intent that
   * was created moments before its own submission would count as the most
   * recent trade and the frequency rule would reject every first trade.
   */
  excludeIntentId?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the profile or the conservative defaults, so a missing row is safe. */
export function effectiveRiskProfile(store: Store, userId: string): RiskProfileRecord {
  const stored = store.getRiskProfile(userId);
  if (stored) return stored;
  return { userId, ...DEFAULT_RISK_PROFILE, updatedAt: 0 };
}

/** True for a settled contract that lost money. */
function isLoss(c: ContractRecord): boolean {
  return c.status === 'lost' || (c.profit !== null && c.profit < 0);
}

/** Realised P/L for a user on one account since `since`, from the ledger. */
export function realisedPnlSince(
  entries: LedgerEntryRecord[],
  accountId: string,
  since: number
): number {
  return entries
    .filter((e) => e.accountId === accountId && e.createdAt >= since && (e.kind === 'settlement' || e.kind === 'fee'))
    .reduce((sum, e) => sum + e.amount, 0);
}

/**
 * Counts consecutive losses on an account, most recent first. A win or a
 * still-open contract resets the streak, so this measures an unbroken run.
 */
export function consecutiveLosses(contracts: ContractRecord[], accountId: string, resetAfterMs = 0): number {
  const settled = contracts
    .filter((c) => c.accountId === accountId && c.status !== 'open' && c.status !== 'unknown')
    .map((contract) => ({
      contract,
      settledAt: contract.settlementTime === null ? contract.updatedAt : contract.settlementTime * 1000
    }))
    .filter(({ settledAt }) => settledAt >= resetAfterMs)
    .sort((a, b) => b.settledAt - a.settledAt);
  let streak = 0;
  for (const { contract: c } of settled) {
    if (isLoss(c)) streak += 1;
    else break;
  }
  return streak;
}

/**
 * Sum of stakes on open contracts. Filters defensively, so a caller that passes
 * a mixed list still gets the exposure figure rather than a wrong one.
 */
export function currentExposure(contracts: ContractRecord[]): number {
  return contracts.filter((c) => c.status === 'open').reduce((sum, c) => sum + c.stake, 0);
}

/**
 * Evaluates every risk rule and returns a decision. All rules run so the caller
 * sees the complete set of reasons, not just the first failure.
 */
export function evaluateRisk(
  store: Store,
  input: RiskEvaluationInput,
  profileOverride?: RiskProfileRecord
): RiskDecision {
  const profile = profileOverride ?? effectiveRiskProfile(store, input.userId);
  const rules: RiskRuleResult[] = [];
  const push = (id: RiskRuleId, passed: boolean, detail: string) => rules.push({ id, passed, detail });

  // The emergency stop is evaluated first: nothing else matters if it is set.
  push('auto_stopped', !store.getExecutionPreferences(input.userId)?.autoStopped, 'automatic execution stop');

  push('stake_positive', Number.isFinite(input.stake) && input.stake > 0, `stake ${input.stake}`);
  push('max_stake', input.stake <= profile.maxStake, `stake ${input.stake} <= max ${profile.maxStake}`);

  const contracts = store.listContracts(input.userId);
  const ledger = store.listLedgerEntries(input.userId);
  const openContracts = store.listOpenContracts(input.userId, input.accountId);

  const dailyPnl = realisedPnlSince(ledger, input.accountId, input.now - DAY_MS);
  push('daily_loss', dailyPnl > -profile.maxDailyLoss, `daily P/L ${dailyPnl.toFixed(2)} > -${profile.maxDailyLoss}`);

  const resetAt = store.getExecutionPreferences(input.userId)?.lossStreakResetAtByAccount?.[input.accountId] ?? 0;
  const streak = consecutiveLosses(
    contracts,
    input.accountId,
    Number.isFinite(resetAt) && resetAt > 0 ? Math.floor(resetAt / 1000) * 1000 : 0
  );
  push(
    'consecutive_losses',
    streak < profile.maxConsecutiveLosses,
    `${streak} consecutive losses < ${profile.maxConsecutiveLosses}`
  );

  push(
    'max_open_contracts',
    openContracts.length < profile.maxOpenContracts,
    `${openContracts.length} open < ${profile.maxOpenContracts}`
  );

  // One open position per symbol. Several AI modules can confirm the same market
  // in the same direction, so without this the correlated signals would each open
  // their own contract. The account lock serialises evaluations, so the check is
  // race-free; a settled contract no longer counts.
  if (input.symbol) {
    const held = openContracts.filter((c) => c.symbol === input.symbol).length;
    push('symbol_in_use', held === 0, `${held} open on ${input.symbol} = 0`);
  }

  const exposure = currentExposure(openContracts);
  push(
    'max_exposure',
    exposure + input.stake <= profile.maxAccountExposure,
    `exposure ${exposure + input.stake} <= max ${profile.maxAccountExposure}`
  );

  if (input.balance !== null) {
    push(
      'min_balance',
      input.balance - input.stake >= profile.minAvailableBalance,
      `balance ${input.balance} - stake ${input.stake} >= min ${profile.minAvailableBalance}`
    );
  } else {
    // No balance available means we cannot prove the balance rule holds. A risk
    // gate must fail closed, so this counts as a failure rather than a pass.
    push('min_balance', false, 'balance unavailable');
  }

  // Frequency: the most recent *other* trade for this account within the
  // window. The intent under evaluation is excluded — it was created as the
  // first step of this very submission, so counting it would make the rule
  // compare a trade against itself and reject every submission.
  const priorIntents = store
    .listTradeIntents(input.userId)
    .filter((i) => i.accountId === input.accountId && i.id !== input.excludeIntentId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const recent = priorIntents[0];
  const sinceLastSeconds = recent ? (input.now - recent.createdAt) / 1000 : Infinity;
  push(
    'execution_frequency',
    sinceLastSeconds >= profile.maxExecutionFrequencySeconds,
    `${sinceLastSeconds.toFixed(1)}s since last >= ${profile.maxExecutionFrequencySeconds}s`
  );

  // Trades per session: count intents since the start of the UTC day, excluding
  // the one being submitted (it is not yet a completed trade).
  const dayStart = new Date(input.now).setUTCHours(0, 0, 0, 0);
  const todayCount = priorIntents.filter((i) => i.createdAt >= dayStart).length;
  push(
    'trades_per_session',
    todayCount < profile.maxTradesPerSession,
    `${todayCount} today < ${profile.maxTradesPerSession}`
  );

  if (input.signalAgeSeconds !== null) {
    push(
      'signal_freshness',
      input.signalAgeSeconds <= profile.signalFreshnessSeconds,
      `signal age ${input.signalAgeSeconds.toFixed(1)}s <= ${profile.signalFreshnessSeconds}s`
    );
  }

  const reasons = rules.filter((r) => !r.passed).map((r) => r.id);
  return { approved: reasons.length === 0, reasons, rules };
}
