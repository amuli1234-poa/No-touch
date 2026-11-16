import type { MarketFamily, TimeframeKey } from './market';
import type { EntryModelKind } from './entryModelAI';
import type { IndexModelProfile } from './entryModelProfiles';

/**
 * ONE LEARNING INTELLIGENCE AI — the single persistent learning core.
 *
 * Every retained strategy AI submits its setups; every settled setup (TP / SL / breakeven /
 * expiry) is recorded here permanently with FULL attribution: originating AI, strategy,
 * entry model, index, timeframe, direction and realised R. The learning core then builds a
 * SEPARATE performance profile per index (statistics are never mixed between indices),
 * identifies what works and what fails, detects deterioration and recommends adjustments.
 *
 * It never alters a recorded outcome, never counts an incomplete setup as a completed trade
 * and never uses future data (out-of-sample splits are chronological).
 */

/** How a recorded setup finally resolved. Breakeven and expiry are first-class. */
export type LearningOutcome =
  | 'TARGET_HIT'
  | 'STOP_HIT'
  | 'BREAKEVEN'
  | 'EXPIRED'
  | 'INVALIDATED'
  | 'MISSED';

/** One permanently-recorded setup outcome with complete attribution. */
export interface LearningOutcomeRecord {
  id: string;
  /** Originating strategy AI (never merged across AIs). */
  sourceLabel: string;
  /** The strategy/model id the AI itself detected (its detection logic). */
  strategyId: string;
  strategyLabel: string;
  /** The entry model the Entry Model AI selected for this setup. */
  entryModel: EntryModelKind | 'UNKNOWN';
  entryModelLabel: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  /** Planned reward-to-risk at entry. */
  plannedRr: number | null;
  /** Realised R multiple at exit (null when it never triggered). */
  realisedRr: number | null;
  /** Which target was reached (0 = none, 1 = TP1 …). */
  highestTargetReached: 0 | 1 | 2 | 3;
  /** Whether price returned to the entry (breakeven stop) before resolving. */
  reachedBreakeven: boolean;
  outcome: LearningOutcome;
  /** The setup's own conditions, preserved verbatim for later analysis. */
  conditions: string[];
  /** Epoch ms the setup was confirmed. */
  confirmedAt: number;
  /** Epoch ms the outcome was settled. */
  settledAt: number;
}

/** Sample-aware statistics for one bucket (strategy / model / timeframe) within ONE index. */
export interface LearningBucketStats {
  key: string;
  label: string;
  sampleSize: number;
  settled: number;
  wins: number;
  losses: number;
  breakeven: number;
  expired: number;
  invalidated: number;
  winRatePercent: number | null;
  /** Expected value per trade in R (null until there is a settled sample). */
  expectancy: number | null;
  avgPlannedRr: number | null;
  /** In-sample win rate (older 70% of the bucket, chronological). */
  inSampleWinRatePercent: number | null;
  /** Out-of-sample win rate (newest 30%). */
  outOfSampleWinRatePercent: number | null;
  /** True once the sample is large enough to trust. */
  reliable: boolean;
  /** True when out-of-sample collapses against in-sample (likely overfit). */
  overfitRisk: boolean;
}

/** A recommendation the learning core surfaces for user approval (never auto-applied). */
export interface LearningRecommendation {
  symbol: string;
  displayName: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  evidence: string;
  /** The adjustment proposed. */
  action: string;
  /** The previous validated model, so the change can be rolled back. */
  rollbackModel: EntryModelKind | null;
}

/** A learned best timeframe COMBINATION for one index (top-down roles). */
export interface TimeframeCombination {
  /** The best major-timeframe bias timeframe (M30/M15). */
  major: TimeframeKey | null;
  /** The best intermediate-timeframe setup timeframe (M10/M7/M6). */
  intermediate: TimeframeKey | null;
  /** The execution / entry-confirmation timeframe — always M5. */
  execution: TimeframeKey;
  /** The best lower-timeframe refinement timeframe (M4/M3/M2/M1). */
  refinement: TimeframeKey | null;
  winRatePercent: number | null;
  expectancy: number | null;
  sampleSize: number;
  reliable: boolean;
}

/**
 * The learned timeframe plan for ONE index: which timeframe analyses best, which confirms
 * best, which must align, and which timeframes have produced false signals. This is what the
 * central scanner reads — the Learning AI never creates a separate module.
 */
export interface IndexLearningPlan {
  symbol: string;
  displayName: string;
  /** The most suitable analysis timeframe for this index (null until reliable). */
  analysisTimeframe: TimeframeKey | null;
  /** The most reliable confirmation timeframe for this index (null until reliable). */
  confirmationTimeframe: TimeframeKey | null;
  /** The mandatory execution timeframe — always M5. */
  executionTimeframe: TimeframeKey;
  /** The higher timeframes the best combination relies on for alignment. */
  requiredAlignment: TimeframeKey[];
  /** The best-scoring top-down timeframe combination (null until reliable). */
  bestCombination: TimeframeCombination | null;
  /** Timeframes that reliably produce losing signals for this index. */
  falseSignalTimeframes: TimeframeKey[];
}

/** The complete learning profile for ONE index. */
export interface IndexLearningProfile {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  totalRecords: number;
  settledRecords: number;
  /** Per-strategy statistics for this index only. */
  byStrategy: LearningBucketStats[];
  /** Per-entry-model statistics for this index only. */
  byEntryModel: LearningBucketStats[];
  /** Per-timeframe statistics for this index only. */
  byTimeframe: LearningBucketStats[];
  /** Per strategy×timeframe statistics for this index only. */
  byStrategyTimeframe: LearningBucketStats[];
  /** The strongest strategy for this index (null until reliable). */
  bestStrategy: LearningBucketStats | null;
  /** The strongest entry model for this index (null until reliable). */
  bestEntryModel: LearningBucketStats | null;
  /** The strongest timeframe for this index (null until reliable). */
  bestTimeframe: LearningBucketStats | null;
  /** The strongest strategy-on-a-timeframe for this index (null until reliable). */
  bestStrategyTimeframe: LearningBucketStats | null;
  /** The most reliable confirmation (refinement-role) timeframe (null until reliable). */
  bestConfirmationTimeframe: LearningBucketStats | null;
  /** The learned timeframe plan the central scanner consumes. */
  plan: IndexLearningPlan;
  /** The validated entry-model profile (retention + rollback state). */
  modelProfile: IndexModelProfile | null;
  /** True when recent performance has deteriorated against the validated baseline. */
  deteriorating: boolean;
  /** Warnings for this index (weak confirmations, false-signal clusters). */
  warnings: string[];
  lastUpdated: number;
}

/** The full learning intelligence report across every index. */
export interface LearningIntelligenceReport {
  profiles: IndexLearningProfile[];
  recommendations: LearningRecommendation[];
  /** Total permanently-recorded outcomes. */
  totalRecords: number;
  /** Distinct indices with at least one recorded outcome. */
  indexCount: number;
  generatedAt: number;
}
