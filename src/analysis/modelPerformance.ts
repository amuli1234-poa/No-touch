import type {
  EngineSignal,
  ModelPerformanceRecord,
  SegmentedModelPerformance,
  SignalOutcome,
} from '../types/engine';
import type { Candle } from '../types/market';

const STORAGE_KEY = 'lucky_deriv_model_performance_v1';
const MAX_RECORDS = 400;

export function loadModelPerformance(): ModelPerformanceRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ModelPerformanceRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveModelPerformance(records: readonly ModelPerformanceRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
  } catch {
    // Ignore storage write errors
  }
}

export function createModelPerformanceRecord(signal: EngineSignal): ModelPerformanceRecord {
  return {
    id: signal.id,
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    model: signal.model,
    modelLabel: signal.modelLabel,
    direction: signal.direction,
    timeframe: signal.analysisTimeframe,
    condition: signal.condition,
    qualityScore: signal.quality.total,
    entryPrice: signal.entryPrice,
    invalidationPrice: signal.invalidationPrice,
    target1: signal.target1,
    maxFavourableExcursionPct: 0,
    maxAdverseExcursionPct: 0,
    outcome: 'PENDING',
    exitPrice: null,
    createdAt: signal.createdAt,
    settledAt: null,
  };
}

/**
 * Updates MFE/MAE and settles a pending record against fresh candles. A record is
 * settled when price reaches the first target (WIN), the invalidation (LOSS/
 * INVALIDATED), or the evaluation window elapses (WIN/LOSS/TIE by last close).
 * Structural invalidation — not a minute countdown — governs settlement.
 */
export function evaluateModelPerformanceRecord(
  record: ModelPerformanceRecord,
  candles: readonly Candle[],
  maxBars = 240
): ModelPerformanceRecord {
  if (record.outcome !== 'PENDING' || candles.length === 0) return record;

  const entry = record.entryPrice;
  if (entry <= 0) return record;
  const rise = record.direction === 'RISE';

  let mfe = record.maxFavourableExcursionPct;
  let mae = record.maxAdverseExcursionPct;
  let settled: SignalOutcome | null = null;
  let exitPrice: number | null = null;

  const window = candles.slice(-maxBars);
  for (const bar of window) {
    const favorablePct = rise
      ? ((bar.high - entry) / entry) * 100
      : ((entry - bar.low) / entry) * 100;
    const adversePct = rise
      ? ((entry - bar.low) / entry) * 100
      : ((bar.high - entry) / entry) * 100;
    if (favorablePct > mfe) mfe = Math.max(0, favorablePct);
    if (adversePct > mae) mae = Math.max(0, adversePct);

    const hitInvalidation = rise
      ? bar.close < record.invalidationPrice
      : bar.close > record.invalidationPrice;
    const hitTarget =
      record.target1 !== null &&
      (rise ? bar.high >= record.target1 : bar.low <= record.target1);

    if (hitInvalidation) {
      settled = 'INVALIDATED';
      exitPrice = bar.close;
      break;
    }
    if (hitTarget) {
      settled = 'WIN';
      exitPrice = record.target1;
      break;
    }
  }

  if (settled === null) {
    // Not yet resolved within the window: keep PENDING but retain MFE/MAE progress.
    return {
      ...record,
      maxFavourableExcursionPct: Number(mfe.toFixed(3)),
      maxAdverseExcursionPct: Number(mae.toFixed(3)),
    };
  }

  return {
    ...record,
    maxFavourableExcursionPct: Number(mfe.toFixed(3)),
    maxAdverseExcursionPct: Number(mae.toFixed(3)),
    outcome: settled,
    exitPrice,
    settledAt: Date.now(),
  };
}

/**
 * Segmented aggregation by model, market, direction, timeframe or condition.
 * Never merges different models/markets into one misleading win rate, and never
 * claims a win rate below a statistically meaningful sample size.
 */
export function summarizeModelPerformance(
  records: readonly ModelPerformanceRecord[],
  groupBy: 'model' | 'symbol' | 'direction' | 'timeframe' | 'condition'
): SegmentedModelPerformance[] {
  const buckets = new Map<
    string,
    { label: string; wins: number; losses: number; pending: number; mfeSum: number; maeSum: number; mfeCount: number }
  >();

  for (const r of records) {
    let key = '';
    let label = '';
    if (groupBy === 'model') {
      key = r.model;
      label = r.modelLabel;
    } else if (groupBy === 'symbol') {
      key = r.symbol;
      label = `${r.displayName} (${r.symbol})`;
    } else if (groupBy === 'direction') {
      key = r.direction;
      label = r.direction === 'RISE' ? 'RISE (up)' : 'FALL (down)';
    } else if (groupBy === 'timeframe') {
      key = r.timeframe;
      label = `${r.timeframe} setups`;
    } else {
      key = r.condition;
      label = r.condition.replace(/_/g, ' ');
    }

    const b = buckets.get(key) ?? {
      label,
      wins: 0,
      losses: 0,
      pending: 0,
      mfeSum: 0,
      maeSum: 0,
      mfeCount: 0,
    };
    if (r.outcome === 'WIN') b.wins++;
    else if (r.outcome === 'LOSS' || r.outcome === 'INVALIDATED') b.losses++;
    else if (r.outcome === 'PENDING') b.pending++;
    b.mfeSum += r.maxFavourableExcursionPct;
    b.maeSum += r.maxAdverseExcursionPct;
    b.mfeCount++;
    buckets.set(key, b);
  }

  return Array.from(buckets.entries()).map(([key, b]) => {
    const settled = b.wins + b.losses;
    const winRatePercent =
      settled >= 5 ? Number(((b.wins / settled) * 100).toFixed(1)) : null;

    let uncertaintyNote: string;
    if (settled < 5) {
      uncertaintyNote = `Insufficient settled samples (n=${settled}); win rate withheld — no unsupported percentages.`;
    } else if (settled < 20) {
      uncertaintyNote = `Small sample (n=${settled}): treat as directional context only; do not overfit.`;
    } else {
      uncertaintyNote = `Forward/out-of-sample sample n=${settled}; model rankings held fixed.`;
    }

    return {
      key,
      label: b.label,
      sampleCount: settled,
      wins: b.wins,
      losses: b.losses,
      pendingCount: b.pending,
      winRatePercent,
      avgMfePct: b.mfeCount > 0 ? Number((b.mfeSum / b.mfeCount).toFixed(3)) : null,
      avgMaePct: b.mfeCount > 0 ? Number((b.maeSum / b.mfeCount).toFixed(3)) : null,
      uncertaintyNote,
    };
  });
}
