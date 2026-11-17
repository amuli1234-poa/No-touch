import type { AiJournalOutcome, AiJournalRecord } from './aiJournal';

/**
 * PERFORMANCE ANALYTICS for the Trade Performance & Learning AI. Pure aggregation: it
 * always reports the sample size, withholds win rates below a meaningful sample, and never
 * merges different indices/models/timeframes into one misleading number.
 */

export type StrategyRating = 'EXCELLENT' | 'GOOD' | 'DEVELOPING' | 'WEAK' | 'UNRELIABLE';

export interface PerformanceSummary {
  total: number;
  confirmed: number;
  pending: number;
  wins: number;
  losses: number;
  ambiguous: number;
  expired: number;
  invalidated: number;
  noTrigger: number;
  settled: number;
  winRatePercent: number | null;
  lossRatePercent: number | null;
  avgRiskReward: number | null;
  profitFactor: number | null;
  tp1Rate: number | null;
  tp2Rate: number | null;
  tp3Rate: number | null;
  stopLossFrequency: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
}

export interface SegmentedPerformance {
  key: string;
  label: string;
  sampleSize: number;
  wins: number;
  losses: number;
  ambiguous: number;
  pending: number;
  winRatePercent: number | null;
  avgRiskReward: number | null;
  tp1Rate: number | null;
  tp2Rate: number | null;
  tp3Rate: number | null;
  rating: StrategyRating;
  note: string;
}

export interface PerformanceAlert {
  severity: 'info' | 'warn' | 'critical';
  title: string;
  evidence: string;
}

const MIN_MEANINGFUL_SAMPLE = 10;

function settledRecords(records: readonly AiJournalRecord[]): AiJournalRecord[] {
  return records.filter(
    (r) => r.outcome === 'WIN' || r.outcome === 'LOSS' || r.outcome === 'AMBIGUOUS'
  );
}

function rate(numerator: number, denominator: number, minSample = 5): number | null {
  if (denominator < minSample) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function maxStreak(records: readonly AiJournalRecord[], outcome: AiJournalOutcome): number {
  const ordered = [...records].sort((a, b) => a.createdAt - b.createdAt);
  let best = 0;
  let current = 0;
  for (const r of ordered) {
    if (r.outcome === outcome) {
      current++;
      best = Math.max(best, current);
    } else if (r.outcome === 'WIN' || r.outcome === 'LOSS') {
      current = 0;
    }
  }
  return best;
}

export function summarizePerformance(records: readonly AiJournalRecord[]): PerformanceSummary {
  const settled = settledRecords(records);
  const wins = settled.filter((r) => r.outcome === 'WIN').length;
  const losses = settled.filter((r) => r.outcome === 'LOSS').length;
  const ambiguous = settled.filter((r) => r.outcome === 'AMBIGUOUS').length;
  const rr = records.map((r) => r.riskRewardRatio).filter((v) => v > 0);
  const avgRiskReward = rr.length ? Number((rr.reduce((a, b) => a + b, 0) / rr.length).toFixed(2)) : null;

  const grossWin = settled.filter((r) => r.outcome === 'WIN').reduce((a, b) => a + b.riskRewardRatio, 0);
  const grossLoss = settled.filter((r) => r.outcome === 'LOSS').reduce((a, b) => a + 1, 0);
  const profitFactor = grossLoss > 0 && settled.length >= MIN_MEANINGFUL_SAMPLE ? Number((grossWin / grossLoss).toFixed(2)) : null;

  const tp1 = records.filter((r) => r.highestTargetReached >= 1).length;
  const tp2 = records.filter((r) => r.highestTargetReached >= 2).length;
  const tp3 = records.filter((r) => r.highestTargetReached >= 3).length;

  return {
    total: records.length,
    confirmed: records.filter((r) => r.outcome !== 'NO_TRIGGER').length,
    pending: records.filter((r) => r.outcome === 'PENDING').length,
    wins,
    losses,
    ambiguous,
    expired: records.filter((r) => r.outcome === 'EXPIRED').length,
    invalidated: records.filter((r) => r.outcome === 'INVALIDATED').length,
    noTrigger: records.filter((r) => r.outcome === 'NO_TRIGGER').length,
    settled: settled.length,
    winRatePercent: rate(wins, settled.length),
    lossRatePercent: rate(losses, settled.length),
    avgRiskReward,
    profitFactor,
    tp1Rate: rate(tp1, records.length),
    tp2Rate: rate(tp2, records.length),
    tp3Rate: rate(tp3, records.length),
    stopLossFrequency: rate(losses, settled.length),
    maxConsecutiveWins: maxStreak(records, 'WIN'),
    maxConsecutiveLosses: maxStreak(records, 'LOSS'),
  };
}

function ratingFor(winRate: number | null, sampleSize: number): StrategyRating {
  if (sampleSize < 5) return 'DEVELOPING';
  if (winRate === null) return 'DEVELOPING';
  if (sampleSize < MIN_MEANINGFUL_SAMPLE) return 'DEVELOPING';
  if (winRate >= 60) return 'EXCELLENT';
  if (winRate >= 50) return 'GOOD';
  if (winRate >= 40) return 'WEAK';
  return 'UNRELIABLE';
}

export function segmentPerformance(
  records: readonly AiJournalRecord[],
  groupBy: 'module' | 'symbol' | 'model' | 'condition' | 'direction' | 'timeframe'
): SegmentedPerformance[] {
  const buckets = new Map<string, AiJournalRecord[]>();
  for (const r of records) {
    const key =
      groupBy === 'module'
        ? r.module
        : groupBy === 'symbol'
          ? r.symbol
          : groupBy === 'model'
            ? r.modelId
            : groupBy === 'condition'
              ? r.condition
              : groupBy === 'direction'
                ? r.direction
                : r.timeframe;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  return Array.from(buckets.entries())
    .map(([key, bucket]) => {
      const settled = settledRecords(bucket);
      const wins = settled.filter((r) => r.outcome === 'WIN').length;
      const losses = settled.filter((r) => r.outcome === 'LOSS').length;
      const ambiguous = settled.filter((r) => r.outcome === 'AMBIGUOUS').length;
      const rr = bucket.map((r) => r.riskRewardRatio).filter((v) => v > 0);
      const winRate = rate(wins, settled.length);
      const label =
        groupBy === 'symbol' ? bucket[0].displayName : groupBy === 'model' ? bucket[0].modelLabel : key.replace(/_/g, ' ');
      return {
        key,
        label,
        sampleSize: settled.length,
        wins,
        losses,
        ambiguous,
        pending: bucket.filter((r) => r.outcome === 'PENDING').length,
        winRatePercent: winRate,
        avgRiskReward: rr.length ? Number((rr.reduce((a, b) => a + b, 0) / rr.length).toFixed(2)) : null,
        tp1Rate: rate(bucket.filter((r) => r.highestTargetReached >= 1).length, bucket.length),
        tp2Rate: rate(bucket.filter((r) => r.highestTargetReached >= 2).length, bucket.length),
        tp3Rate: rate(bucket.filter((r) => r.highestTargetReached >= 3).length, bucket.length),
        rating: ratingFor(winRate, settled.length),
        note:
          settled.length < 5
            ? 'Insufficient settled samples — no unsupported percentages.'
            : settled.length < MIN_MEANINGFUL_SAMPLE
              ? `Small sample (n=${settled.length}) — directional context only.`
              : `Sample n=${settled.length}.`,
      };
    })
    .sort((a, b) => b.sampleSize - a.sampleSize);
}

/**
 * Modules whose settled record is proven weak enough that the automatic trader
 * should hold back, rather than keep entering them. A module is only withheld
 * once its settled sample is meaningful; below that threshold every module is
 * left in play, so a cold start is never crippled by a handful of early losses.
 */
export function weakModulesForAutoTrading(
  records: readonly AiJournalRecord[],
  minSample = MIN_MEANINGFUL_SAMPLE,
  minWinRatePercent = 40
): Set<string> {
  const weak = new Set<string>();
  for (const seg of segmentPerformance(records, 'module')) {
    if (seg.sampleSize >= minSample && (seg.winRatePercent ?? 100) < minWinRatePercent) {
      weak.add(seg.key);
    }
  }
  return weak;
}

/** Alerts derived only from verified evidence (never speculation). */
export function performanceAlerts(records: readonly AiJournalRecord[]): PerformanceAlert[] {
  const alerts: PerformanceAlert[] = [];
  const byModule = segmentPerformance(records, 'module');
  const byModel = segmentPerformance(records, 'model');

  for (const m of byModule) {
    if (m.sampleSize >= MIN_MEANINGFUL_SAMPLE && (m.winRatePercent ?? 100) < 40) {
      alerts.push({
        severity: 'critical',
        title: `${m.label} performance is weak`,
        evidence: `${m.winRatePercent}% win rate over n=${m.sampleSize} settled signals.`,
      });
    }
    if (m.sampleSize >= 20 && (m.winRatePercent ?? 0) >= 60) {
      alerts.push({
        severity: 'info',
        title: `${m.label} is performing well`,
        evidence: `${m.winRatePercent}% win rate over n=${m.sampleSize} settled signals.`,
      });
    }
  }

  for (const model of byModel) {
    if (model.sampleSize >= MIN_MEANINGFUL_SAMPLE && (model.winRatePercent ?? 100) < 40) {
      alerts.push({
        severity: 'warn',
        title: `Entry model "${model.label}" is unreliable`,
        evidence: `${model.winRatePercent}% win rate over n=${model.sampleSize} — consider stricter confirmation.`,
      });
    }
  }

  const pendingHeavy = records.filter((r) => r.outcome === 'PENDING').length;
  if (records.length >= 20 && pendingHeavy / records.length > 0.6) {
    alerts.push({
      severity: 'info',
      title: 'Many outcomes are still pending',
      evidence: `${pendingHeavy}/${records.length} signals await enough fresh candles to settle.`,
    });
  }

  return alerts.slice(0, 8);
}
