import type { MarketFamily, TimeframeKey } from './market';
import type { EntryModelKind, EntryModelOutcome } from './entryModelAI';

/**
 * PER-INDEX ENTRY MODEL PROFILES.
 *
 * The Entry Model AI learns a SEPARATE profile for every individual index. Performance
 * statistics are never mixed between indices: a model that works on Volatility 75 tells us
 * nothing about Volatility 100, so each index keeps its own record set, its own validated
 * model and its own walk-forward / out-of-sample verdict.
 *
 * Selection is deliberately conservative:
 *  - a challenger is only adopted when it is statistically reliable,
 *  - its out-of-sample performance must not collapse against its in-sample performance
 *    (overfitting guard), and
 *  - it must beat the incumbent by a margin; otherwise the previous validated model is
 *    RETAINED (never silently replaced by a noisy winner).
 */

/** One recorded outcome, attributed to an index, model and timeframe. */
export interface IndexModelRecord {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  model: EntryModelKind | 'UNKNOWN';
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  riskRewardRatio: number | null;
  outcome: EntryModelOutcome;
  settledAt: number;
}

/** Per-model statistics for ONE index (never blended across indices). */
export interface IndexModelStats {
  model: EntryModelKind | 'UNKNOWN';
  label: string;
  sampleSize: number;
  wins: number;
  losses: number;
  missed: number;
  winRatePercent: number | null;
  avgRiskReward: number | null;
  /** Expected value per trade in R multiples (winRate·RR − lossRate). */
  expectancy: number | null;
  /** True only once the sample is large enough to trust the statistics. */
  reliable: boolean;
  /** In-sample win rate (older 70% of records). */
  inSampleWinRatePercent: number | null;
  /** Out-of-sample win rate (newest 30% of records). */
  outOfSampleWinRatePercent: number | null;
  /** True when out-of-sample performance collapses against in-sample (likely overfit). */
  overfitRisk: boolean;
}

/** The learned, validated profile for one index. */
export interface IndexModelProfile {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  /** Total recorded outcomes for this index. */
  totalRecords: number;
  /** Per-model statistics for this index only. */
  models: IndexModelStats[];
  /** The currently retained validated model for this index (null until one qualifies). */
  selected: EntryModelKind | null;
  selectedLabel: string;
  selectedExpectancy: number | null;
  /** A challenger that was evaluated this pass (null when none was considered). */
  challenger: EntryModelKind | null;
  challengerLabel: string | null;
  /** True when a challenger was rejected and the previous validated model retained. */
  retained: boolean;
  /** Human explanation of the retention / adoption decision. */
  retentionReason: string | null;
  /** Epoch ms of the last profile update. */
  lastUpdated: number;
}

/** The per-index historical bonus the selection reads (never a fabricated one). */
export type IndexHistoricalBonus = Map<string, Partial<Record<EntryModelKind, number>>>;
