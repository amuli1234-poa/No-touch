import type { EntryModelId } from '../types/engine';
import { ENTRY_MODEL_LABELS } from '../types/engine';
import type {
  BacktestReport,
  BacktestStats,
  BacktestTrade,
  TrainingSegment,
} from '../types/training';

/** Minimum settled trades before a win rate is reported at all. */
const MIN_REPORTABLE_SAMPLE = 10;

function emptyStats(): BacktestStats {
  return {
    totalSetups: 0,
    filledTrades: 0,
    wins: 0,
    losses: 0,
    missed: 0,
    invalidated: 0,
    winRatePercent: null,
    averageRr: null,
    maxConsecutiveLosses: 0,
    maxDrawdownR: 0,
    avgFavourablePct: null,
    avgAdversePct: null,
    profitFactor: null,
  };
}

/** Aggregates a set of trades into one honest statistics block (never merges models silently). */
export function aggregateTrades(trades: readonly BacktestTrade[]): BacktestStats {
  if (trades.length === 0) return emptyStats();
  const filled = trades.filter((t) => t.status === 'TARGET_HIT' || t.status === 'STOP_HIT');
  const wins = filled.filter((t) => t.status === 'TARGET_HIT').length;
  const losses = filled.filter((t) => t.status === 'STOP_HIT').length;
  const settled = wins + losses;
  const rrs = filled.map((t) => t.realizedRr).filter((r): r is number => r !== null);

  let maxConsecutiveLosses = 0;
  let streak = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const t of trades) {
    if (t.status === 'STOP_HIT') {
      streak++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
    } else if (t.status === 'TARGET_HIT') {
      streak = 0;
    }
    if (t.realizedRr !== null) {
      equity += t.realizedRr;
      peak = Math.max(peak, equity);
      maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
    }
  }

  const mfes = filled.map((t) => t.maxFavourableExcursionPct);
  const maes = filled.map((t) => t.maxAdverseExcursionPct);
  const grossWin = filled
    .filter((t) => t.status === 'TARGET_HIT')
    .reduce((a, t) => a + (t.realizedRr ?? 0), 0);
  const grossLoss = filled
    .filter((t) => t.status === 'STOP_HIT')
    .reduce((a, t) => a + Math.abs(t.realizedRr ?? 0), 0);

  return {
    totalSetups: trades.length,
    filledTrades: filled.length,
    wins,
    losses,
    missed: trades.filter((t) => t.status === 'MISSED').length,
    invalidated: trades.filter((t) => t.status === 'INVALIDATED').length,
    winRatePercent: settled > 0 ? Number(((wins / settled) * 100).toFixed(1)) : null,
    averageRr:
      rrs.length > 0 ? Number((rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(3)) : null,
    maxConsecutiveLosses,
    maxDrawdownR: Number(maxDrawdownR.toFixed(3)),
    avgFavourablePct:
      mfes.length > 0
        ? Number((mfes.reduce((a, b) => a + b, 0) / mfes.length).toFixed(3))
        : null,
    avgAdversePct:
      maes.length > 0
        ? Number((maes.reduce((a, b) => a + b, 0) / maes.length).toFixed(3))
        : null,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : null,
  };
}

type SegmentKey = 'model' | 'market' | 'timeframe';

function segmentKeyOf(trade: BacktestTrade, key: SegmentKey): { key: string; label: string } {
  if (key === 'model') return { key: trade.model, label: trade.modelLabel };
  if (key === 'market') {
    return { key: trade.symbol, label: `${trade.displayName} (${trade.symbol})` };
  }
  return { key: trade.timeframe, label: `${trade.timeframe} setups` };
}

/** Segments trades by model, market or timeframe. Segments are never blended together. */
export function segmentTrades(
  trades: readonly BacktestTrade[],
  key: SegmentKey
): TrainingSegment[] {
  const buckets = new Map<string, { label: string; trades: BacktestTrade[] }>();
  for (const t of trades) {
    const { key: k, label } = segmentKeyOf(t, key);
    const b = buckets.get(k) ?? { label, trades: [] };
    b.trades.push(t);
    buckets.set(k, b);
  }
  return Array.from(buckets.entries()).map(([k, b]) => {
    const stats = aggregateTrades(b.trades);
    return {
      key: k,
      label: b.label,
      sampleCount: stats.wins + stats.losses,
      wins: stats.wins,
      losses: stats.losses,
      winRatePercent:
        stats.wins + stats.losses >= MIN_REPORTABLE_SAMPLE ? stats.winRatePercent : null,
      averageRr: stats.averageRr,
      maxDrawdownR: stats.maxDrawdownR,
      avgFavourablePct: stats.avgFavourablePct,
      avgAdversePct: stats.avgAdversePct,
    };
  });
}

/** Flattens every trade across all reports (optionally in-sample or out-of-sample only). */
export function collectTrades(
  reports: readonly BacktestReport[],
  scope: 'overall' | 'inSample' | 'outOfSample' = 'overall'
): BacktestTrade[] {
  if (scope === 'overall') return reports.flatMap((r) => r.trades);
  return reports.flatMap((r) =>
    r.trades.filter((t) =>
      scope === 'inSample' ? t.confirmedBarTime <= r.splitBarTime : t.confirmedBarTime > r.splitBarTime
    )
  );
}

export interface ModelRanking {
  model: EntryModelId;
  modelLabel: string;
  stats: BacktestStats;
  /** Win rate is only populated when the out-of-sample settled sample is meaningful. */
  reportable: boolean;
}

/**
 * Ranks models by out-of-sample performance. A model is only "reportable" when its
 * out-of-sample settled sample clears the minimum; below that, its numbers are shown
 * but explicitly flagged as directional context.
 */
export function rankModelsByOutOfSample(reports: readonly BacktestReport[]): ModelRanking[] {
  const byModel = new Map<EntryModelId, BacktestTrade[]>();
  for (const r of reports) {
    const list = byModel.get(r.model) ?? [];
    for (const t of r.trades) {
      if (t.confirmedBarTime > r.splitBarTime) list.push(t);
    }
    byModel.set(r.model, list);
  }
  const rankings: ModelRanking[] = [];
  for (const [model, trades] of byModel.entries()) {
    const stats = aggregateTrades(trades);
    const settled = stats.wins + stats.losses;
    rankings.push({
      model,
      modelLabel: ENTRY_MODEL_LABELS[model],
      stats,
      reportable: settled >= MIN_REPORTABLE_SAMPLE,
    });
  }
  return rankings.sort((a, b) => {
    const ra = a.reportable ? (a.stats.winRatePercent ?? 0) : -1;
    const rb = b.reportable ? (b.stats.winRatePercent ?? 0) : -1;
    if (rb !== ra) return rb - ra;
    return (b.stats.averageRr ?? 0) - (a.stats.averageRr ?? 0);
  });
}

/** Out-of-sample ("forward test") performance aggregated across all reports. */
export function forwardTestStats(reports: readonly BacktestReport[]): BacktestStats {
  return aggregateTrades(collectTrades(reports, 'outOfSample'));
}
