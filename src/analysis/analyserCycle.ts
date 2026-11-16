import type { Candle } from '../types/market';
import type { LearningOutcomeRecord } from '../types/learning';
import type {
  AnalyserCompletionVerdict,
  AnalyserSetupForCompletion,
  AnalyserTradeAccuracy,
  CompletedAnalyserTrade,
  DisplayGuardInput,
  DisplayGuardResult,
  DisplayedSetupIdentity,
} from '../types/analyserCycle';

/**
 * AUTOMATIC CHART RESET & FRESH-ENTRY CYCLE — pure logic.
 *
 * All rules here are deterministic and side-effect free, so they can be tested directly and
 * the live hook stays a thin orchestrator. The three jobs are:
 *   1. verify whether a displayed setup reached its target or stop (against fresh candles
 *      and the live price — never against a stale/forming bar),
 *   2. build the permanent completed-trade record (accuracy + full chart-analysis data),
 *   3. guard what may reach the chart (never a completed, expired or duplicate/conflicting
 *      setup).
 */

/** A candle window is only usable once there is enough context to read structure. */
const MIN_WINDOW = 1;

const NOT_COMPLETED: AnalyserCompletionVerdict = {
  completed: false,
  outcome: null,
  exitPrice: null,
  settledBarTime: null,
  barsHeld: 0,
  verified: false,
  verificationSource: 'CONFIRMED_CANDLE',
  note: 'Setup is still open — neither the target nor the stop has been reached.',
};

function isRise(direction: 'RISE' | 'FALL'): boolean {
  return direction === 'RISE';
}

/**
 * Verifies whether a displayed setup completed, and how.
 *
 * The stop is checked before the target on every bar (a bar that spans both levels settles
 * as a loss — the conservative reading). A bar is only trusted once it is CONFIRMED (the
 * forming bar is excluded by the caller). The live price may additionally confirm a
 * completion that the newest confirmed candle has not yet recorded.
 */
export function evaluateAnalyserCompletion(
  setup: AnalyserSetupForCompletion,
  confirmedCandles: readonly Candle[],
  livePrice: number | null = null
): AnalyserCompletionVerdict {
  const { entry, stopLoss, takeProfit, direction, confirmedBarTime } = setup;
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) {
    return NOT_COMPLETED;
  }
  const rise = isRise(direction);

  // Only candles confirmed at or after the setup's own confirmation bar may settle it.
  const fresh = confirmedCandles.filter((c) => c.time >= confirmedBarTime);
  if (fresh.length < MIN_WINDOW && livePrice === null) return NOT_COMPLETED;

  const lastConfirmedTime =
    confirmedCandles.length > 0 ? confirmedCandles[confirmedCandles.length - 1].time : confirmedBarTime;

  for (let i = 0; i < fresh.length; i++) {
    const bar = fresh[i];
    const hitStop = rise ? bar.low <= stopLoss : bar.high >= stopLoss;
    if (hitStop) {
      return {
        completed: true,
        outcome: 'STOP_HIT',
        exitPrice: stopLoss,
        settledBarTime: bar.time,
        barsHeld: i + 1,
        verified: true,
        verificationSource: 'CONFIRMED_CANDLE',
        note: `Confirmed ${direction} setup reached its stop-loss at ${stopLoss}.`,
      };
    }
    const hitTarget = rise ? bar.high >= takeProfit : bar.low <= takeProfit;
    if (hitTarget) {
      return {
        completed: true,
        outcome: 'TARGET_HIT',
        exitPrice: takeProfit,
        settledBarTime: bar.time,
        barsHeld: i + 1,
        verified: true,
        verificationSource: 'CONFIRMED_CANDLE',
        note: `Confirmed ${direction} setup reached its take-profit at ${takeProfit}.`,
      };
    }
  }

  // No confirmed bar settled it — the live price may still confirm a level was reached.
  if (livePrice !== null && Number.isFinite(livePrice)) {
    const liveStop = rise ? livePrice <= stopLoss : livePrice >= stopLoss;
    const liveTarget = rise ? livePrice >= takeProfit : livePrice <= takeProfit;
    if (liveStop || liveTarget) {
      const outcome = liveStop ? 'STOP_HIT' : 'TARGET_HIT';
      return {
        completed: true,
        outcome,
        exitPrice: liveStop ? stopLoss : takeProfit,
        settledBarTime: lastConfirmedTime,
        barsHeld: fresh.length,
        verified: true,
        verificationSource: 'LIVE_PRICE',
        note: `Live price ${livePrice} confirmed the ${outcome === 'STOP_HIT' ? 'stop-loss' : 'take-profit'} for this ${direction} setup.`,
      };
    }
  }

  return NOT_COMPLETED;
}

/** Computes the accuracy block for a completed trade from its locked levels. */
export function computeTradeAccuracy(
  direction: 'RISE' | 'FALL',
  entry: number,
  takeProfit: number,
  stopLoss: number,
  outcome: 'TARGET_HIT' | 'STOP_HIT'
): AnalyserTradeAccuracy {
  const riskDistance = Math.abs(entry - stopLoss);
  const rewardDistance = Math.abs(takeProfit - entry);
  const plannedRr = riskDistance > 0 ? rewardDistance / riskDistance : null;
  const won = outcome === 'TARGET_HIT';
  const realisedRr = won ? (plannedRr !== null && plannedRr > 0 ? plannedRr : 1) : -1;
  const breakEvenAccuracyPercent = plannedRr !== null ? 100 / (1 + plannedRr) : null;
  return {
    plannedRr: plannedRr !== null ? Number(plannedRr.toFixed(3)) : null,
    realisedRr: Number(realisedRr.toFixed(3)),
    rewardDistance: Number(rewardDistance.toFixed(6)),
    riskDistance: Number(riskDistance.toFixed(6)),
    accuracyPercent: won ? 100 : 0,
    breakEvenAccuracyPercent:
      breakEvenAccuracyPercent !== null ? Number(breakEvenAccuracyPercent.toFixed(2)) : null,
    signedOutcome: won ? 1 : -1,
  };
}

export interface BuildCompletedTradeParams {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: CompletedAnalyserTrade['marketFamily'];
  precision: number;
  timeframe: CompletedAnalyserTrade['timeframe'];
  direction: 'RISE' | 'FALL';
  strategyLabel: string;
  strategyId: string;
  modelId: CompletedAnalyserTrade['modelId'];
  modelLabel: string;
  entryModel: CompletedAnalyserTrade['entryModel'];
  entryModelLabel: string;
  entry: number;
  takeProfit: number;
  stopLoss: number;
  invalidationPrice: number;
  entryZone: [number, number] | null;
  riskRewardRatio: number;
  verdict: AnalyserCompletionVerdict;
  confirmedAt: number;
  chartAnalysis: CompletedAnalyserTrade['chartAnalysis'];
  now: number;
}

/**
 * Builds the permanent completed-trade record. Only called with a verified completion
 * verdict; the outcome, exit price and settlement bar come straight from that verdict.
 */
export function buildCompletedAnalyserTrade(params: BuildCompletedTradeParams): CompletedAnalyserTrade {
  const { verdict } = params;
  if (!verdict.completed || verdict.outcome === null || verdict.exitPrice === null) {
    throw new Error('buildCompletedAnalyserTrade requires a verified completion verdict.');
  }
  return {
    id: params.id,
    symbol: params.symbol,
    displayName: params.displayName,
    marketFamily: params.marketFamily,
    precision: params.precision,
    timeframe: params.timeframe,
    direction: params.direction,
    strategyLabel: params.strategyLabel,
    strategyId: params.strategyId,
    modelId: params.modelId,
    modelLabel: params.modelLabel,
    entryModel: params.entryModel,
    entryModelLabel: params.entryModelLabel,
    entry: params.entry,
    takeProfit: params.takeProfit,
    stopLoss: params.stopLoss,
    invalidationPrice: params.invalidationPrice,
    entryZone: params.entryZone,
    riskRewardRatio: params.riskRewardRatio,
    outcome: verdict.outcome,
    exitPrice: verdict.exitPrice,
    settledBarTime: verdict.settledBarTime ?? 0,
    settledAt: params.now,
    barsHeld: verdict.barsHeld,
    verified: verdict.verified,
    verificationSource: verdict.verificationSource,
    accuracy: computeTradeAccuracy(
      params.direction,
      params.entry,
      params.takeProfit,
      params.stopLoss,
      verdict.outcome
    ),
    chartAnalysis: params.chartAnalysis,
    confirmedAt: params.confirmedAt,
  };
}

/**
 * Duplicate / conflict prevention. A candidate may reach the chart only when it is a
 * genuine, freshly confirmed setup that does not collide with what is already displayed:
 *  - a setup that already completed is never shown again (its id is in `completedIds`),
 *  - a candidate whose confirmation bar is not yet closed is expired/not actionable,
 *  - while a setup is displayed, no second setup for the same market + strategy may appear
 *    (this blocks both duplicates and simultaneous opposite-direction conflicts).
 */
export function canDisplaySetup(
  candidate: DisplayGuardInput,
  displayed: DisplayedSetupIdentity | null,
  completedIds: ReadonlySet<string>
): DisplayGuardResult {
  if (completedIds.has(candidate.id)) {
    return { display: false, reason: 'Setup already completed — a settled setup is never reused.' };
  }
  if (candidate.confirmedBarTime > candidate.latestConfirmedBarTime) {
    return { display: false, reason: 'Setup is not yet confirmed on a closed candle.' };
  }
  if (displayed) {
    if (displayed.id === candidate.id) {
      return { display: false, reason: 'Setup is already displayed — duplicate suppressed.' };
    }
    if (
      displayed.symbol === candidate.symbol &&
      displayed.strategyId === candidate.strategyId
    ) {
      return {
        display: false,
        reason:
          'Another setup for this market and strategy is already active — simultaneous duplicate/conflicting setups are not allowed.',
      };
    }
  }
  return { display: true, reason: 'Fresh, confirmed and non-conflicting setup.' };
}

/** Maps a completed analyser trade onto the ONE Learning Intelligence AI's outcome record. */
export function completedTradeToLearningRecord(trade: CompletedAnalyserTrade): LearningOutcomeRecord {
  return {
    id: trade.id,
    sourceLabel: trade.strategyLabel,
    strategyId: trade.strategyId,
    strategyLabel: trade.strategyLabel,
    entryModel: trade.entryModel,
    entryModelLabel: trade.entryModelLabel,
    symbol: trade.symbol,
    displayName: trade.displayName,
    marketFamily: trade.marketFamily,
    timeframe: trade.timeframe,
    direction: trade.direction,
    plannedRr: trade.accuracy.plannedRr,
    realisedRr: trade.accuracy.realisedRr,
    highestTargetReached: trade.outcome === 'TARGET_HIT' ? 1 : 0,
    reachedBreakeven: false,
    outcome: trade.outcome,
    conditions: trade.chartAnalysis.reasons,
    confirmedAt: trade.confirmedAt,
    settledAt: trade.settledAt,
  };
}

/**
 * Append-only merge for the completed-trade ledger. An id already present is never
 * overwritten and nothing is ever removed, so completed history is permanent.
 */
export function mergeCompletedTrades(
  existing: readonly CompletedAnalyserTrade[],
  incoming: readonly CompletedAnalyserTrade[]
): CompletedAnalyserTrade[] {
  if (incoming.length === 0) return existing as CompletedAnalyserTrade[];
  const byId = new Map(existing.map((t) => [t.id, t]));
  let changed = false;
  for (const trade of incoming) {
    if (byId.has(trade.id)) continue;
    byId.set(trade.id, trade);
    changed = true;
  }
  if (!changed) return existing as CompletedAnalyserTrade[];
  return Array.from(byId.values()).sort((a, b) => a.settledAt - b.settledAt);
}
