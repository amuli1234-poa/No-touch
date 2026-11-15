import { backtestModels, computeBacktestStats } from './backtest';
import { computeAtrSeries } from './swings';
import type { EntryModelId } from '../types/engine';
import { ENTRY_MODEL_LABELS } from '../types/engine';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import type { BacktestReport, BacktestStats, BacktestTrade } from '../types/training';

/**
 * STRATEGY OPTIMIZATION & BACKTESTING ENGINE (independent, duration-free).
 *
 * It reuses the SAME no-look-ahead replay the training engine already uses (`backtestModels`)
 * — it never re-implements signal detection and never fabricates a result. On top of that
 * replay it adds expectancy, TP1/TP2/TP3 achievement rates, cost-aware performance,
 * walk-forward validation, per-index rankings and evidence-based recommendations.
 *
 * Nothing here ever modifies an AI module. Recommendations are surfaced for USER APPROVAL.
 */

export type StrategyRating = 'EXCELLENT' | 'GOOD' | 'DEVELOPING' | 'WEAK' | 'UNRELIABLE';

export const STRATEGY_RATING_ORDER: readonly StrategyRating[] = [
  'EXCELLENT',
  'GOOD',
  'DEVELOPING',
  'WEAK',
  'UNRELIABLE',
];

export interface CostModel {
  /** Round-trip spread cost expressed in ATR units. */
  spreadAtr: number;
  /** Slippage per side expressed in ATR units. */
  slippageAtr: number;
}

export const DEFAULT_COST_MODEL: CostModel = { spreadAtr: 0.02, slippageAtr: 0.01 };

export interface ExtendedStats extends BacktestStats {
  /** Average win in R (null when there are no wins). */
  averageWinR: number | null;
  /** Average loss in R (null when there are no losses). */
  averageLossR: number | null;
  /** Expectancy in R per setup: winRate × avgWin + lossRate × avgLoss. */
  expectancyR: number | null;
  maxConsecutiveWins: number;
  tp1Rate: number | null;
  tp2Rate: number | null;
  tp3Rate: number | null;
  stopRate: number | null;
  /** Average bars held across settled trades. */
  averageBarsHeld: number | null;
  /** Expectancy after the cost model is applied. */
  expectancyAfterCostR: number | null;
  /** Setups whose stop and a target fell inside one candle (sequence unknowable). */
  ambiguous: number;
}

export interface StrategyEvaluation {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  model: EntryModelId;
  modelLabel: string;
  inSample: ExtendedStats;
  outOfSample: ExtendedStats;
  overall: ExtendedStats;
  rating: StrategyRating;
  /** True when the out-of-sample sample is large enough to trust the rating. */
  validated: boolean;
  notes: string[];
}

export interface WalkForwardWindow {
  index: number;
  trainFromBar: number;
  trainToBar: number;
  testFromBar: number;
  testToBar: number;
  inSampleExpectancyR: number | null;
  outOfSampleExpectancyR: number | null;
  outOfSampleWinRate: number | null;
  outOfSampleSample: number;
  consistent: boolean;
}

export interface WalkForwardResult {
  model: EntryModelId;
  modelLabel: string;
  windows: WalkForwardWindow[];
  /** Share of windows whose out-of-sample expectancy stayed positive. */
  consistencyPercent: number | null;
  /** Aggregate out-of-sample expectancy across all windows. */
  aggregateOutOfSampleExpectancyR: number | null;
  notes: string[];
}

export interface ParameterSweepPoint {
  value: number;
  label: string;
  expectancyR: number | null;
  winRatePercent: number | null;
  sampleSize: number;
}

export interface ParameterSweep {
  parameter: string;
  description: string;
  points: ParameterSweepPoint[];
  /** The sweep only recommends a value when the sample is adequate. */
  recommendedValue: number | null;
  notes: string[];
}

export interface StrategyRecommendation {
  id: string;
  severity: 'INFO' | 'WATCH' | 'ACTION';
  title: string;
  detail: string;
  /** Applying a recommendation ALWAYS requires explicit user approval. */
  requiresApproval: true;
}

export interface OptimizationReport {
  symbol: string;
  displayName: string;
  timeframe: TimeframeKey;
  evaluations: StrategyEvaluation[];
  walkForward: WalkForwardResult[];
  parameterSweeps: ParameterSweep[];
  recommendations: StrategyRecommendation[];
  generatedAt: number;
}

/** Minimum settled trades before any rate is reported as a statistic. */
export const MIN_STATISTICAL_SAMPLE = 10;

export function extendStats(
  stats: BacktestStats,
  trades: readonly BacktestTrade[],
  atr: number,
  cost: CostModel
): ExtendedStats {
  const settled = trades.filter(
    (t) => t.status === 'TARGET_HIT' || t.status === 'STOP_HIT'
  );
  const wins = settled.filter((t) => t.status === 'TARGET_HIT');
  const losses = settled.filter((t) => t.status === 'STOP_HIT');
  const winR = wins.map((t) => t.realizedRr).filter((r): r is number => r !== null);
  const lossR = losses.map((t) => t.realizedRr).filter((r): r is number => r !== null);
  const averageWinR =
    winR.length > 0 ? Number((winR.reduce((a, b) => a + b, 0) / winR.length).toFixed(3)) : null;
  const averageLossR =
    lossR.length > 0 ? Number((lossR.reduce((a, b) => a + b, 0) / lossR.length).toFixed(3)) : null;

  const total = settled.length;
  // Expectancy only needs each side's average when that side actually occurred.
  const expectancyR =
    total > 0
      ? Number(
          (
            (wins.length / total) * (averageWinR ?? 0) +
            (losses.length / total) * (averageLossR ?? 0)
          ).toFixed(3)
        )
      : null;

  let maxConsecutiveWins = 0;
  let streak = 0;
  for (const t of trades) {
    if (t.status === 'TARGET_HIT') {
      streak += 1;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, streak);
    } else if (t.status === 'STOP_HIT') {
      streak = 0;
    }
  }

  const filled = settled.length;
  const tp1 = settled.filter((t) => t.highestTargetReached >= 1).length;
  const tp2 = settled.filter((t) => t.highestTargetReached >= 2).length;
  const tp3 = settled.filter((t) => t.highestTargetReached >= 3).length;
  const stopHit = losses.length;

  const barsHeld = settled.map((t) => t.barsHeld).filter((b) => b > 0);
  const averageBarsHeld =
    barsHeld.length > 0
      ? Number((barsHeld.reduce((a, b) => a + b, 0) / barsHeld.length).toFixed(1))
      : null;

  // Cost-aware expectancy: each settled trade pays the round-trip cost expressed in R.
  let expectancyAfterCostR: number | null = null;
  if (total > 0 && atr > 0) {
    const costs = settled.map((t) => {
      const risk = Math.abs(t.entry - t.stopLoss);
      if (risk <= 0) return 0;
      const costPrice = atr * (cost.spreadAtr + cost.slippageAtr * 2);
      return costPrice / risk;
    });
    const avgCostR = costs.reduce((a, b) => a + b, 0) / costs.length;
    if (expectancyR !== null) expectancyAfterCostR = Number((expectancyR - avgCostR).toFixed(3));
  }

  return {
    ...stats,
    averageWinR,
    averageLossR,
    expectancyR,
    maxConsecutiveWins,
    tp1Rate: filled > 0 ? Number(((tp1 / filled) * 100).toFixed(1)) : null,
    tp2Rate: filled > 0 ? Number(((tp2 / filled) * 100).toFixed(1)) : null,
    tp3Rate: filled > 0 ? Number(((tp3 / filled) * 100).toFixed(1)) : null,
    stopRate: filled > 0 ? Number(((stopHit / filled) * 100).toFixed(1)) : null,
    averageBarsHeld,
    expectancyAfterCostR,
    ambiguous: trades.filter((t) => t.ambiguous).length,
  };
}

/**
 * Rating rules: a strategy is NEVER promoted on a small sample or a high win rate alone.
 * Consistency (out-of-sample expectancy) and drawdown both have to hold up.
 */
export function rateStrategy(params: {
  outOfSample: ExtendedStats;
  overall: ExtendedStats;
  validated: boolean;
}): StrategyRating {
  const { outOfSample, overall, validated } = params;
  const sample = outOfSample.filledTrades;
  if (sample < MIN_STATISTICAL_SAMPLE || !validated) {
    // Without an adequate out-of-sample sample we cannot honestly rate the strategy.
    if (overall.filledTrades < MIN_STATISTICAL_SAMPLE) return 'UNRELIABLE';
    return 'DEVELOPING';
  }
  const exp = outOfSample.expectancyR;
  if (exp === null) return 'DEVELOPING';
  const winRate = outOfSample.winRatePercent ?? 0;
  const pf = outOfSample.profitFactor;
  const dd = outOfSample.maxDrawdownR;

  if (exp >= 0.3 && winRate >= 50 && (pf === null || pf >= 1.5) && dd <= 6) return 'EXCELLENT';
  if (exp >= 0.15 && (pf === null || pf >= 1.2)) return 'GOOD';
  if (exp > 0) return 'DEVELOPING';
  if (exp > -0.1) return 'WEAK';
  return 'UNRELIABLE';
}

function splitStats(
  trades: readonly BacktestTrade[],
  fromBar: number,
  toBar: number
): BacktestTrade[] {
  return trades.filter((t) => t.confirmedBarTime >= fromBar && t.confirmedBarTime < toBar);
}

export interface OptimizeParams {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  timeframe: TimeframeKey;
  candles: readonly Candle[];
  models: readonly EntryModelId[];
  cost?: CostModel;
  /** Number of walk-forward windows (train/test pairs). */
  walkForwardWindows?: number;
  /** Optional caller-supplied progress reporter. */
  onProgress?: (message: string) => void;
}

function lastAtr(candles: readonly Candle[]): number {
  const atrs = computeAtrSeries(candles, 14);
  return atrs[atrs.length - 1] || 0;
}

/** Runs the full no-look-ahead replay for every requested model and extends the stats. */
export function evaluateStrategies(params: OptimizeParams): StrategyEvaluation[] {
  const cost = params.cost ?? DEFAULT_COST_MODEL;
  const reports = backtestModels(
    {
      symbol: params.symbol,
      displayName: params.displayName,
      marketFamily: params.marketFamily,
      precision: params.precision,
      timeframe: params.timeframe,
      candles: params.candles,
    },
    params.models
  );
  const atr = lastAtr(params.candles);

  return reports.map((report: BacktestReport) => {
    const inSample = extendStats(
      report.inSample,
      splitStats(report.trades, 0, report.splitBarTime),
      atr,
      cost
    );
    const outOfSample = extendStats(
      report.outOfSample,
      splitStats(report.trades, report.splitBarTime, Number.POSITIVE_INFINITY),
      atr,
      cost
    );
    const overall = extendStats(report.overall, report.trades, atr, cost);
    const validated = outOfSample.filledTrades >= MIN_STATISTICAL_SAMPLE;
    const notes = [...report.notes];
    if (!validated) {
      notes.push(
        `Out-of-sample sample is only ${outOfSample.filledTrades} settled trade(s) — the rating is provisional.`
      );
    }
    return {
      symbol: report.symbol,
      displayName: report.displayName,
      marketFamily: report.marketFamily,
      timeframe: report.timeframe,
      model: report.model,
      modelLabel: report.modelLabel,
      inSample,
      outOfSample,
      overall,
      rating: rateStrategy({ outOfSample, overall, validated }),
      validated,
      notes,
    };
  });
}

/** Walk-forward validation: rolling train/test windows over the same no-look-ahead replay. */
export function walkForwardValidate(
  params: OptimizeParams & { windows?: number }
): WalkForwardResult[] {
  const windows = params.windows ?? 4;
  const cost = params.cost ?? DEFAULT_COST_MODEL;
  const reports = backtestModels(
    {
      symbol: params.symbol,
      displayName: params.displayName,
      marketFamily: params.marketFamily,
      precision: params.precision,
      timeframe: params.timeframe,
      candles: params.candles,
    },
    params.models
  );
  const atr = lastAtr(params.candles);
  const first = params.candles[0]?.time ?? 0;
  const last = params.candles[params.candles.length - 1]?.time ?? 0;
  const span = Math.max(1, last - first);

  return reports.map((report) => {
    const out: WalkForwardWindow[] = [];
    for (let w = 0; w < windows; w++) {
      const testStart = first + (span * w) / windows;
      const testEnd = first + (span * (w + 1)) / windows;
      const trainStart = first;
      const trainEnd = testStart;
      const trainTrades = report.trades.filter(
        (t) => t.confirmedBarTime >= trainStart && t.confirmedBarTime < trainEnd
      );
      const testTrades = report.trades.filter(
        (t) => t.confirmedBarTime >= testStart && t.confirmedBarTime < testEnd
      );
      const inStats = extendStats(computeBacktestStats(trainTrades), trainTrades, atr, cost);
      const outStats = extendStats(computeBacktestStats(testTrades), testTrades, atr, cost);
      out.push({
        index: w,
        trainFromBar: trainStart,
        trainToBar: trainEnd,
        testFromBar: testStart,
        testToBar: testEnd,
        inSampleExpectancyR: inStats.expectancyR,
        outOfSampleExpectancyR: outStats.expectancyR,
        outOfSampleWinRate: outStats.winRatePercent,
        outOfSampleSample: outStats.filledTrades,
        consistent:
          outStats.expectancyR !== null &&
          inStats.expectancyR !== null &&
          Math.sign(outStats.expectancyR) === Math.sign(inStats.expectancyR),
      });
    }
    const evaluated = out.filter((w) => w.outOfSampleExpectancyR !== null);
    const consistencyPercent =
      evaluated.length > 0
        ? Number(
            (
              (evaluated.filter((w) => (w.outOfSampleExpectancyR ?? 0) > 0).length /
                evaluated.length) *
              100
            ).toFixed(1)
          )
        : null;
    const totalSample = evaluated.reduce((a, w) => a + w.outOfSampleSample, 0);
    const aggregate =
      totalSample > 0
        ? Number(
            (
              evaluated.reduce(
                (a, w) => a + (w.outOfSampleExpectancyR ?? 0) * w.outOfSampleSample,
                0
              ) / totalSample
            ).toFixed(3)
          )
        : null;
    const notes: string[] = [
      `Rolling walk-forward: ${windows} sequential test windows, each trained only on data BEFORE it.`,
    ];
    if (totalSample < MIN_STATISTICAL_SAMPLE) {
      notes.push(`Aggregate out-of-sample sample is only ${totalSample} — treat as directional.`);
    }
    return {
      model: report.model,
      modelLabel: report.modelLabel,
      windows: out,
      consistencyPercent,
      aggregateOutOfSampleExpectancyR: aggregate,
      notes,
    };
  });
}

/**
 * Controlled parameter sweeps. Each point re-runs the SAME replay with a minimum quality
 * gate applied to the recorded setups — it never re-optimises the models themselves, and it
 * explicitly warns against curve fitting when the sample is thin.
 */
export function parameterSweep(params: {
  parameter: 'MIN_QUALITY' | 'MIN_RISK_REWARD';
  values: readonly number[];
  evaluationsByValue: (value: number) => ExtendedStats;
}): ParameterSweep {
  const points: ParameterSweepPoint[] = params.values.map((value) => {
    const stats = params.evaluationsByValue(value);
    return {
      value,
      label:
        params.parameter === 'MIN_QUALITY' ? `Quality ≥ ${value}` : `R:R ≥ ${value.toFixed(1)}`,
      expectancyR: stats.expectancyR,
      winRatePercent: stats.winRatePercent,
      sampleSize: stats.filledTrades,
    };
  });
  const adequate = points.filter((p) => p.sampleSize >= MIN_STATISTICAL_SAMPLE && p.expectancyR !== null);
  const best = adequate.sort((a, b) => (b.expectancyR ?? 0) - (a.expectancyR ?? 0))[0];
  const notes: string[] = [
    'Parameter sweeps are advisory only — no AI module is modified without user approval.',
  ];
  if (adequate.length === 0) {
    notes.push(
      'No sweep point has an adequate sample — avoid curve fitting on thin data; collect more history first.'
    );
  }
  return {
    parameter: params.parameter,
    description:
      params.parameter === 'MIN_QUALITY'
        ? 'Minimum setup-quality gate applied to the recorded setups.'
        : 'Minimum risk-to-reward gate applied to the recorded setups.',
    points,
    recommendedValue: best ? best.value : null,
    notes,
  };
}

/** Evidence-based improvement recommendations derived from the evaluations. */
export function buildRecommendations(
  evaluations: readonly StrategyEvaluation[]
): StrategyRecommendation[] {
  const out: StrategyRecommendation[] = [];
  const unreliable = evaluations.filter((e) => e.rating === 'UNRELIABLE');
  const weak = evaluations.filter((e) => e.rating === 'WEAK');
  const excellent = evaluations.filter((e) => e.rating === 'EXCELLENT');

  for (const e of unreliable) {
    out.push({
      id: `retest-${e.model}`,
      severity: 'ACTION',
      title: `${e.modelLabel} is unreliable on ${e.displayName}`,
      detail:
        e.outOfSample.expectancyR !== null && e.outOfSample.expectancyR < 0
          ? `Out-of-sample expectancy is ${e.outOfSample.expectancyR}R with a ${e.outOfSample.maxDrawdownR}R drawdown. The model's assumptions do not hold on this index — retest or exclude it here.`
          : `The out-of-sample sample is too small to trust (${e.outOfSample.filledTrades} settled trades). Collect more history before promoting this model.`,
      requiresApproval: true,
    });
  }

  for (const e of weak) {
    const tp = e.outOfSample.tp1Rate;
    if (tp !== null && tp < 30) {
      out.push({
        id: `targets-${e.model}`,
        severity: 'WATCH',
        title: `${e.modelLabel} targets look unrealistic on ${e.displayName}`,
        detail: `Only ${tp}% of settled trades reached TP1 — the target placement is likely too far for this index's typical room.`,
        requiresApproval: true,
      });
    }
  }

  // Poor stop placement: stop rate high while TP1 rate is decent → the stop is too tight.
  for (const e of evaluations) {
    const stop = e.outOfSample.stopRate;
    const tp1 = e.outOfSample.tp1Rate;
    if (stop !== null && tp1 !== null && stop >= 60 && tp1 >= 40) {
      out.push({
        id: `stop-${e.model}`,
        severity: 'WATCH',
        title: `${e.modelLabel} stop-loss placement on ${e.displayName}`,
        detail: `TP1 is reached ${tp1}% of the time yet the stop is hit ${stop}% of the time — the stop may be sitting too close to the entry for this index's volatility.`,
        requiresApproval: true,
      });
    }
  }

  for (const e of excellent) {
    out.push({
      id: `promote-${e.model}`,
      severity: 'INFO',
      title: `${e.modelLabel} performs well on ${e.displayName}`,
      detail: `Out-of-sample expectancy ${e.outOfSample.expectancyR}R with a ${e.outOfSample.winRatePercent}% win rate over ${e.outOfSample.filledTrades} settled trades. Prioritise this model for this index.`,
      requiresApproval: true,
    });
  }

  if (out.length === 0) {
    out.push({
      id: 'insufficient-evidence',
      severity: 'INFO',
      title: 'Not enough verified history yet',
      detail:
        'Run a longer backtest on more indices before drawing conclusions. No strategy change is recommended without an adequate out-of-sample sample.',
      requiresApproval: true,
    });
  }
  return out;
}

/** Ranks strategies by validated out-of-sample expectancy, then consistency. */
export function rankEvaluations(evaluations: readonly StrategyEvaluation[]): StrategyEvaluation[] {
  const ratingRank = (r: StrategyRating) => STRATEGY_RATING_ORDER.indexOf(r);
  return [...evaluations].sort((a, b) => {
    if (ratingRank(a.rating) !== ratingRank(b.rating)) return ratingRank(a.rating) - ratingRank(b.rating);
    return (b.outOfSample.expectancyR ?? -99) - (a.outOfSample.expectancyR ?? -99);
  });
}

export { ENTRY_MODEL_LABELS };
