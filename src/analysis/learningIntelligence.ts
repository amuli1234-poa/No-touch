import { ENTRY_MODEL_KIND_LABELS, type EntryModelKind } from '../types/entryModelAI';
import type { MarketFamily, TimeframeKey } from '../types/market';
import type { IndexModelProfile, IndexModelRecord } from '../types/entryModelProfiles';
import type {
  IndexLearningPlan,
  IndexLearningProfile,
  LearningBucketStats,
  LearningIntelligenceReport,
  LearningOutcomeRecord,
  LearningRecommendation,
  TimeframeCombination,
} from '../types/learning';
import {
  MIN_OUT_OF_SAMPLE,
  MIN_RELIABLE_SAMPLE,
  OUT_OF_SAMPLE_FRACTION,
  OVERFIT_DROP_POINTS,
} from './entryModelProfiles';

/**
 * ONE LEARNING INTELLIGENCE AI — pure analysis core.
 *
 * It is the SINGLE learning authority: it consumes the permanently-recorded outcome ledger
 * and derives, per index, which strategies / entry models / timeframes actually work, with
 * rolling statistics, minimum sample requirements and a chronological out-of-sample split
 * (never future data). It detects deterioration and proposes adjustments for approval — it
 * never alters history and never promotes a strategy on a few winning trades.
 */

const MIN_RECOMMENDATION_SAMPLE = 15;
/** A validated baseline losing this many win-rate points in the newest slice is deterioration. */
const DETERIORATION_POINTS = 18;

const SETTLED: ReadonlySet<LearningOutcomeRecord['outcome']> = new Set([
  'TARGET_HIT',
  'STOP_HIT',
  'BREAKEVEN',
  'EXPIRED',
  'INVALIDATED',
]);

function isSettled(r: LearningOutcomeRecord): boolean {
  return SETTLED.has(r.outcome);
}

function winRateOf(records: readonly LearningOutcomeRecord[]): number | null {
  const decided = records.filter((r) => r.outcome === 'TARGET_HIT' || r.outcome === 'STOP_HIT');
  if (decided.length === 0) return null;
  const wins = decided.filter((r) => r.outcome === 'TARGET_HIT').length;
  return Math.round((wins / decided.length) * 1000) / 10;
}

function expectancyOf(records: readonly LearningOutcomeRecord[]): number | null {
  const settled = records.filter(isSettled);
  if (settled.length === 0) return null;
  let total = 0;
  for (const r of settled) {
    if (r.outcome === 'TARGET_HIT') total += r.realisedRr ?? r.plannedRr ?? 1;
    else if (r.outcome === 'STOP_HIT') total -= 1;
    else if (r.outcome === 'BREAKEVEN') total += 0;
    else if (r.outcome === 'INVALIDATED' || r.outcome === 'EXPIRED') total += 0;
  }
  return Math.round((total / settled.length) * 100) / 100;
}

function avgPlannedRrOf(records: readonly LearningOutcomeRecord[]): number | null {
  const rrs = records.map((r) => r.plannedRr).filter((v): v is number => v !== null && v > 0);
  if (rrs.length === 0) return null;
  return Math.round((rrs.reduce((a, b) => a + b, 0) / rrs.length) * 100) / 100;
}

/** Builds one bucket's sample-aware statistics, chronological so out-of-sample is the newest slice. */
function statsFor(
  key: string,
  label: string,
  records: readonly LearningOutcomeRecord[]
): LearningBucketStats {
  const ordered = [...records].sort((a, b) => a.confirmedAt - b.confirmedAt);
  const splitAt = Math.max(0, Math.floor(ordered.length * (1 - OUT_OF_SAMPLE_FRACTION)));
  const inSample = ordered.slice(0, splitAt);
  const outOfSample = ordered.slice(splitAt);

  const wins = ordered.filter((r) => r.outcome === 'TARGET_HIT').length;
  const losses = ordered.filter((r) => r.outcome === 'STOP_HIT').length;
  const breakeven = ordered.filter((r) => r.outcome === 'BREAKEVEN').length;
  const expired = ordered.filter((r) => r.outcome === 'EXPIRED').length;
  const invalidated = ordered.filter((r) => r.outcome === 'INVALIDATED').length;
  const settled = ordered.filter(isSettled).length;
  const decided = wins + losses;

  const inRate = winRateOf(inSample);
  const outRate = winRateOf(outOfSample);
  const outDecided = outOfSample.filter(
    (r) => r.outcome === 'TARGET_HIT' || r.outcome === 'STOP_HIT'
  ).length;
  const overfitRisk =
    outDecided >= MIN_OUT_OF_SAMPLE &&
    inRate !== null &&
    outRate !== null &&
    inRate - outRate > OVERFIT_DROP_POINTS;

  return {
    key,
    label,
    sampleSize: ordered.length,
    settled,
    wins,
    losses,
    breakeven,
    expired,
    invalidated,
    winRatePercent: decided >= MIN_RELIABLE_SAMPLE ? Math.round((wins / decided) * 1000) / 10 : null,
    expectancy: expectancyOf(ordered),
    avgPlannedRr: avgPlannedRrOf(ordered),
    inSampleWinRatePercent: inRate,
    outOfSampleWinRatePercent: outRate,
    reliable: decided >= MIN_RELIABLE_SAMPLE,
    overfitRisk,
  };
}

function groupBy<T extends string>(
  records: readonly LearningOutcomeRecord[],
  keyOf: (r: LearningOutcomeRecord) => T,
  labelOf: (r: LearningOutcomeRecord) => string
): LearningBucketStats[] {
  const buckets = new Map<T, LearningOutcomeRecord[]>();
  const labels = new Map<T, string>();
  for (const r of records) {
    const k = keyOf(r);
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
    if (!labels.has(k)) labels.set(k, labelOf(r));
  }
  return Array.from(buckets.entries())
    .map(([k, list]) => statsFor(k, labels.get(k) ?? k, list))
    .sort((a, b) => {
      const ea = a.expectancy ?? -Infinity;
      const eb = b.expectancy ?? -Infinity;
      if (eb !== ea) return eb - ea;
      return b.sampleSize - a.sampleSize;
    });
}

/** The strongest RELIABLE, non-overfit bucket (null when none qualifies). */
function strongest(buckets: readonly LearningBucketStats[]): LearningBucketStats | null {
  return buckets.find((b) => b.reliable && !b.overfitRisk && b.expectancy !== null) ?? null;
}

/** The strongest RELIABLE, non-overfit bucket restricted to a set of timeframe keys. */
function strongestWithin(
  buckets: readonly LearningBucketStats[],
  keys: readonly TimeframeKey[]
): LearningBucketStats | null {
  const allowed = new Set<string>(keys);
  return strongest(buckets.filter((b) => allowed.has(b.key)));
}

/**
 * Builds the learned timeframe plan for ONE index: the best analysis timeframe, the best
 * confirmation timeframe, the best top-down combination and the false-signal timeframes.
 * Every value is derived from this index's own verified outcomes — never blended across
 * indices, never promoted from an insufficient sample.
 */
export function buildTimeframePlan(
  symbol: string,
  displayName: string,
  byTimeframe: readonly LearningBucketStats[],
  byStrategyTimeframe: readonly LearningBucketStats[]
): IndexLearningPlan {
  const bestTimeframe = strongest(byTimeframe);

  // The most suitable ANALYSIS timeframe is the strongest reliable intermediate/execution
  // timeframe (where setups are identified), falling back to the best overall timeframe.
  const analysisTimeframe =
    (strongestWithin(byTimeframe, ['M10', 'M7', 'M6', 'M5'])?.key as TimeframeKey | undefined) ??
    (bestTimeframe?.key as TimeframeKey | undefined) ??
    null;

  // The most reliable CONFIRMATION timeframe is the strongest refinement-role timeframe
  // (M4/M3/M2/M1) — the lower timeframes refine / confirm the M5 execution.
  const confirmationTimeframe =
    (strongestWithin(byTimeframe, ['M4', 'M3', 'M2', 'M1'])?.key as TimeframeKey | undefined) ?? null;

  // The best top-down COMBINATION: strongest major + intermediate + refinement around the
  // mandatory M5 execution. The combination's statistics are the M5 bucket's (the execution
  // timeframe is what actually realises the trade) when present, else the strongest available.
  const major = strongestWithin(byTimeframe, ['M30', 'M15']);
  const intermediate = strongestWithin(byTimeframe, ['M10', 'M7', 'M6']);
  const refinement = strongestWithin(byTimeframe, ['M4', 'M3', 'M2', 'M1']);
  const execution = byTimeframe.find((b) => b.key === 'M5') ?? null;

  const comboStats = execution ?? bestTimeframe;
  const requiredAlignment = [major?.key, intermediate?.key].filter(
    (k): k is string => typeof k === 'string'
  ) as TimeframeKey[];

  const bestCombination: TimeframeCombination | null =
    comboStats && (comboStats.reliable || bestTimeframe)
      ? {
          major: (major?.key as TimeframeKey | undefined) ?? null,
          intermediate: (intermediate?.key as TimeframeKey | undefined) ?? null,
          execution: 'M5',
          refinement: (refinement?.key as TimeframeKey | undefined) ?? null,
          winRatePercent: comboStats.winRatePercent,
          expectancy: comboStats.expectancy,
          sampleSize: comboStats.sampleSize,
          reliable: comboStats.reliable,
        }
      : null;

  // False-signal timeframes: a reliable sample that is clearly losing.
  const falseSignalTimeframes = byTimeframe
    .filter((b) => b.reliable && (b.winRatePercent ?? 100) < 40)
    .map((b) => b.key as TimeframeKey);

  return {
    symbol,
    displayName,
    analysisTimeframe,
    confirmationTimeframe,
    executionTimeframe: 'M5',
    requiredAlignment,
    bestCombination,
    falseSignalTimeframes,
  };
}

/**
 * Converts the permanent ledger into the per-index entry-model records the retention engine
 * (`buildIndexProfiles`) consumes. Only DECISIVE outcomes are forwarded — a breakeven or an
 * expired (never-triggered) setup is neutral and must not be counted as a win or a loss.
 */
export function toIndexModelRecords(
  records: readonly LearningOutcomeRecord[]
): IndexModelRecord[] {
  const out: IndexModelRecord[] = [];
  for (const r of records) {
    if (r.outcome === 'BREAKEVEN' || r.outcome === 'EXPIRED') continue;
    if (!isSettled(r)) continue;
    out.push({
      symbol: r.symbol,
      displayName: r.displayName,
      marketFamily: r.marketFamily,
      model: r.entryModel,
      timeframe: r.timeframe,
      direction: r.direction,
      riskRewardRatio: r.realisedRr ?? r.plannedRr,
      outcome:
        r.outcome === 'TARGET_HIT'
          ? 'TARGET_HIT'
          : r.outcome === 'STOP_HIT'
            ? 'STOP_HIT'
            : r.outcome === 'INVALIDATED'
              ? 'INVALIDATED'
              : 'MISSED',
      settledAt: r.settledAt,
    });
  }
  return out;
}

/** Builds the learning profile for ONE index from its OWN records only. */
export function buildIndexLearningProfile(
  symbol: string,
  records: readonly LearningOutcomeRecord[],
  modelProfile: IndexModelProfile | null
): IndexLearningProfile {
  const byStrategy = groupBy(
    records,
    (r) => r.strategyId,
    (r) => r.strategyLabel
  );
  const byEntryModel = groupBy(
    records,
    (r) => r.entryModel,
    (r) => (r.entryModel === 'UNKNOWN' ? 'Unclassified' : ENTRY_MODEL_KIND_LABELS[r.entryModel])
  );
  const byTimeframe = groupBy(
    records,
    (r) => r.timeframe,
    (r) => r.timeframe
  );
  const byStrategyTimeframe = groupBy(
    records,
    (r) => `${r.strategyId}@${r.timeframe}`,
    (r) => `${r.strategyLabel} on ${r.timeframe}`
  );

  const bestStrategy = strongest(byStrategy);
  const bestEntryModel = strongest(byEntryModel);
  const bestTimeframe = strongest(byTimeframe);
  const bestStrategyTimeframe = strongest(byStrategyTimeframe);
  const bestConfirmationTimeframe = strongestWithin(byTimeframe, ['M4', 'M3', 'M2', 'M1']);

  const displayName = records[0]?.displayName ?? modelProfile?.displayName ?? symbol;
  const plan = buildTimeframePlan(symbol, displayName, byTimeframe, byStrategyTimeframe);

  const warnings: string[] = [];
  // A recurring false-signal pattern: a reliable strategy whose losses cluster on a timeframe.
  for (const s of byStrategy) {
    if (s.reliable && (s.winRatePercent ?? 100) < 40) {
      warnings.push(
        `${s.label} is losing on ${symbol}: ${s.winRatePercent}% over n=${s.sampleSize} — tighten its confirmation.`
      );
    }
    if (s.overfitRisk) {
      warnings.push(
        `${s.label} on ${symbol} looks overfit: out-of-sample ${s.outOfSampleWinRatePercent}% vs in-sample ${s.inSampleWinRatePercent}%.`
      );
    }
  }
  for (const m of byEntryModel) {
    if (m.reliable && (m.winRatePercent ?? 100) < 40) {
      warnings.push(
        `Entry model "${m.label}" is unreliable on ${symbol}: ${m.winRatePercent}% over n=${m.sampleSize}.`
      );
    }
  }
  // Timeframe-level false signals: a reliable timeframe bucket that is clearly losing.
  for (const t of byTimeframe) {
    if (t.reliable && (t.winRatePercent ?? 100) < 40) {
      warnings.push(
        `${t.label} entries on ${symbol} are failing: ${t.winRatePercent}% over n=${t.sampleSize} — deprioritise this timeframe.`
      );
    }
  }
  // A strategy that only works on SOME timeframes is a combination, not a blanket rule.
  for (const st of byStrategyTimeframe) {
    if (st.reliable && !st.overfitRisk && (st.winRatePercent ?? 0) >= 60) {
      warnings.push(
        `Best combination on ${symbol}: ${st.label} — ${st.winRatePercent}% expectancy ${st.expectancy}R over n=${st.sampleSize}.`
      );
    }
  }

  // Deterioration: the newest slice of a validated model has collapsed vs its baseline.
  let deteriorating = false;
  if (bestEntryModel && bestEntryModel.inSampleWinRatePercent !== null && bestEntryModel.outOfSampleWinRatePercent !== null) {
    deteriorating =
      bestEntryModel.inSampleWinRatePercent - bestEntryModel.outOfSampleWinRatePercent >
      DETERIORATION_POINTS;
  }

  const marketFamily = records[0]?.marketFamily ?? modelProfile?.marketFamily ?? 'OTHER';
  const lastUpdated = records.reduce((max, r) => Math.max(max, r.settledAt), 0) || Date.now();

  return {
    symbol,
    displayName,
    marketFamily,
    totalRecords: records.length,
    settledRecords: records.filter(isSettled).length,
    byStrategy,
    byEntryModel,
    byTimeframe,
    byStrategyTimeframe,
    bestStrategy,
    bestEntryModel,
    bestTimeframe,
    bestStrategyTimeframe,
    bestConfirmationTimeframe,
    plan,
    modelProfile,
    deteriorating,
    warnings,
    lastUpdated,
  };
}

/**
 * The full learning report: one profile per index plus the recommendations the learning core
 * surfaces (for user approval). Statistics are NEVER mixed between indices.
 */
export function buildLearningReport(
  records: readonly LearningOutcomeRecord[],
  modelProfiles: ReadonlyMap<string, IndexModelProfile> = new Map()
): LearningIntelligenceReport {
  const bySymbol = new Map<string, LearningOutcomeRecord[]>();
  for (const r of records) {
    const arr = bySymbol.get(r.symbol) ?? [];
    arr.push(r);
    bySymbol.set(r.symbol, arr);
  }

  const profiles: IndexLearningProfile[] = [];
  const recommendations: LearningRecommendation[] = [];

  for (const [symbol, list] of bySymbol) {
    const profile = buildIndexLearningProfile(symbol, list, modelProfiles.get(symbol) ?? null);
    profiles.push(profile);

    if (profile.deteriorating && profile.bestEntryModel) {
      recommendations.push({
        symbol,
        displayName: profile.displayName,
        severity: 'warn',
        title: `${profile.displayName}: "${profile.bestEntryModel.label}" is deteriorating`,
        evidence: `Out-of-sample win rate ${profile.bestEntryModel.outOfSampleWinRatePercent}% vs in-sample ${profile.bestEntryModel.inSampleWinRatePercent}% (n=${profile.bestEntryModel.sampleSize}).`,
        action: 'Reduce the weighting of this entry model on this index until it re-stabilises.',
        rollbackModel: profile.modelProfile?.selected ?? null,
      });
    }

    for (const s of profile.byStrategy) {
      if (s.settled >= MIN_RECOMMENDATION_SAMPLE && s.reliable && !s.overfitRisk && (s.winRatePercent ?? 0) >= 60) {
        recommendations.push({
          symbol,
          displayName: profile.displayName,
          severity: 'info',
          title: `${profile.displayName}: "${s.label}" is reliable`,
          evidence: `${s.winRatePercent}% win rate, expectancy ${s.expectancy}R over n=${s.sampleSize}.`,
          action: 'Increase this strategy\'s weighting for this index in the central scanner.',
          rollbackModel: profile.modelProfile?.selected ?? null,
        });
      }
      if (s.settled >= MIN_RECOMMENDATION_SAMPLE && s.reliable && (s.winRatePercent ?? 100) < 40) {
        recommendations.push({
          symbol,
          displayName: profile.displayName,
          severity: 'critical',
          title: `${profile.displayName}: "${s.label}" is underperforming`,
          evidence: `${s.winRatePercent}% win rate over n=${s.sampleSize} settled trades.`,
          action: 'Suspend this strategy on this index pending user approval.',
          rollbackModel: profile.modelProfile?.selected ?? null,
        });
      }
    }

    // Timeframe intelligence — the best analysis/confirmation timeframe for THIS index.
    const plan = profile.plan;
    if (plan.analysisTimeframe && plan.bestCombination?.reliable) {
      recommendations.push({
        symbol,
        displayName: profile.displayName,
        severity: 'info',
        title: `${profile.displayName}: best timeframe is ${plan.analysisTimeframe}`,
        evidence: `M5 execution expectancy ${plan.bestCombination.expectancy}R, win rate ${plan.bestCombination.winRatePercent}% over n=${plan.bestCombination.sampleSize}.`,
        action: `Prioritise ${plan.analysisTimeframe} analysis with M5 execution and ${plan.confirmationTimeframe ?? 'any'} confirmation for this index.`,
        rollbackModel: profile.modelProfile?.selected ?? null,
      });
    }
    for (const tf of plan.falseSignalTimeframes) {
      recommendations.push({
        symbol,
        displayName: profile.displayName,
        severity: 'warn',
        title: `${profile.displayName}: ${tf} produces false signals`,
        evidence: `${tf} entries on this index are losing over a reliable sample.`,
        action: `Deprioritise ${tf} for this index in the central scanner.`,
        rollbackModel: profile.modelProfile?.selected ?? null,
      });
    }
  }

  profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
  recommendations.sort((a, b) => {
    const order = { critical: 0, warn: 1, info: 2 } as const;
    return order[a.severity] - order[b.severity];
  });

  return {
    profiles,
    recommendations,
    totalRecords: records.length,
    indexCount: bySymbol.size,
    generatedAt: Date.now(),
  };
}

/** Finds the learning profile for one index (null when it has no recorded outcomes yet). */
export function profileForSymbol(
  report: LearningIntelligenceReport,
  symbol: string
): IndexLearningProfile | null {
  return report.profiles.find((p) => p.symbol === symbol) ?? null;
}

/** Everything the ledger needs to attribute one settled setup, gathered by the caller. */
export interface LearningAttribution {
  /** Stable setup id — the ledger's dedupe key (a settled setup is recorded exactly once). */
  id: string;
  sourceLabel: string;
  strategyId: string;
  strategyLabel: string;
  entryModel: EntryModelKind | 'UNKNOWN';
  entryModelLabel: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  plannedRr: number | null;
  realisedRr: number | null;
  highestTargetReached: 0 | 1 | 2 | 3;
  reachedBreakeven: boolean;
  outcome: LearningOutcomeRecord['outcome'];
  conditions: string[];
  confirmedAt: number;
  settledAt: number;
}

/**
 * Builds an immutable ledger record from an attributed settled setup. The caller supplies the
 * real realised R and the exit facts; nothing here invents a result.
 */
export function buildLearningRecord(attribution: LearningAttribution): LearningOutcomeRecord {
  return { ...attribution };
}

/**
 * The realised R multiple for a settled outcome. A win realises the planned reward-to-risk,
 * a loss realises −1R; breakeven, expiry and invalidation are 0R (neutral — never counted as
 * a win or a loss). Never fabricates a result for an unsettled setup.
 */
export function realisedRFrom(
  outcome: LearningOutcomeRecord['outcome'],
  plannedRr: number | null
): number | null {
  if (outcome === 'TARGET_HIT') return plannedRr !== null && plannedRr > 0 ? plannedRr : 1;
  if (outcome === 'STOP_HIT') return -1;
  if (outcome === 'BREAKEVEN' || outcome === 'EXPIRED' || outcome === 'INVALIDATED') return 0;
  return null;
}
