import type { EntryModelDecision } from './entryModelAI';
import type { EntryModelKind } from './entryModelAI';
import type { IndexLearningPlan } from './learning';
import type { RankedSetup } from './ranking';
import type { ConnectionStatus, TimeframeKey } from './market';

/**
 * CENTRAL MULTI-MARKET INTELLIGENCE — the one place that collects the candidates submitted
 * by every independent AI, verifies live data, rejects invalid / expired / incomplete /
 * low-quality / duplicate / conflicting setups, applies the index-specific Entry Model AI
 * validation, and produces a single unified ranking.
 *
 * Ranking is driven by VALIDATED historical performance where it exists (per index and per
 * entry model) and by transparent, configurable quality weights everywhere else. An
 * uncalibrated "confidence" number is never the primary sort key.
 */

/** One candidate collected from an independent AI and normalised for central ranking. */
export interface CentralCandidate {
  key: string;
  /** The originating AI label (e.g. 'BOS & CHOCH AI'). */
  sourceLabel: string;
  symbol: string;
  displayName: string;
  marketFamily: RankedSetup['marketFamily'];
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  /** The AI's own setup quality score (0–100), preserved — never overwritten. */
  engineScore: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskRewardRatio: number | null;
  reasons: readonly string[];
  confirmedBarTime: number;
  /** Epoch seconds of the newest confirmed candle read for this candidate. */
  dataTimestamp: number;
  /** Epoch ms after which the candidate is stale. */
  expiresAt: number;
  /** The Entry Model AI's validation decision for this candidate (null when not evaluated). */
  entryDecision: EntryModelDecision | null;
  /**
   * The Learning AI's learned timeframe plan for this index (null when no reliable plan yet).
   * It is advisory evidence attached for ranking/display — it never fabricates a signal.
   */
  learningPlan?: IndexLearningPlan | null;
  /** The Timeframe Alignment AI's alignment score for this index (0–100, null when unread). */
  alignmentScore?: number | null;
  /** The Consolidation & Momentum AI's momentum strength for this index (0–100, null when unread). */
  momentumStrength?: number | null;
  /** The Consolidation & Momentum AI's consolidation probability for this index (0–100, null when unread). */
  consolidationScore?: number | null;
  /** The original ranked setup, so downstream surfaces keep every field. */
  setup: RankedSetup;
}

/** The configurable weights the central ranking applies. Every field is tunable. */
export interface CentralRankingWeights {
  /** Weight on the AI's own setup quality score. */
  quality: number;
  /** Weight on the index-specific validated historical performance (0 when no profile). */
  performance: number;
  /** Weight on the reward-to-risk ratio. */
  rewardRisk: number;
  /** Weight on higher-timeframe alignment. */
  htfAlignment: number;
  /** Weight on the Entry Model AI's confirmation strength. */
  confirmation: number;
  /** Weight on the Learning AI's timeframe-plan suitability for this index. */
  learning: number;
  /** Weight on the Timeframe Alignment AI's multi-timeframe alignment (applied when read). */
  alignment: number;
  /** Weight on the Consolidation & Momentum AI's directional momentum (applied when read). */
  momentum: number;
}

/**
 * The six core components always contribute and sum to 1. `alignment` and `momentum` are
 * ADDITIONAL: they only contribute for a candidate whose index the new AIs have actually read,
 * and the weighted average is normalised by the weights in play. A candidate with no new read
 * therefore scores EXACTLY as it did before these modules existed — no silent regression.
 */
export const DEFAULT_CENTRAL_WEIGHTS: CentralRankingWeights = {
  quality: 0.4,
  performance: 0.23,
  rewardRisk: 0.14,
  htfAlignment: 0.08,
  confirmation: 0.07,
  learning: 0.08,
  alignment: 0.08,
  momentum: 0.06,
};

export type CentralRejectionReason =
  | 'STALE_DATA'
  | 'DISCONNECTED'
  | 'EXPIRED'
  | 'INCOMPLETE'
  | 'LOW_QUALITY'
  | 'ENTRY_NOT_CONFIRMED'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'CONSOLIDATING'
  | 'MOMENTUM_WEAK';

/** A candidate the central engine rejected, with a short, human reason. */
export interface CentralRejection {
  key: string;
  symbol: string;
  displayName: string;
  sourceLabel: string;
  direction: 'RISE' | 'FALL';
  reason: CentralRejectionReason;
  detail: string;
}

/** The component scores behind a ranked candidate's final central score. */
export interface CentralScoreBreakdown {
  quality: number;
  performance: number;
  rewardRisk: number;
  htfAlignment: number;
  confirmation: number;
  /** Learning AI timeframe-plan suitability for this index (0 when no reliable plan). */
  learning: number;
  /** Timeframe Alignment AI's alignment score for this index (0 when unread). */
  alignment: number;
  /** Consolidation & Momentum AI's directional momentum (0 when unread). */
  momentum: number;
  total: number;
  /** True when an index-specific validated profile contributed to the score. */
  usedValidatedPerformance: boolean;
}

/** The actionable state the central engine assigns to a candidate. */
export type CentralOpportunityState = 'APPROVED' | 'WATCH' | 'REJECTED';

/** A final, ranked opportunity produced by the central engine. */
export interface CentralRankedOpportunity {
  rank: number;
  candidate: CentralCandidate;
  score: CentralScoreBreakdown;
  /** Short reasons the central engine selected this candidate. */
  selectionReasons: string[];
  /**
   * APPROVED — cleared every gate and is in the published top-N.
   * WATCH — high quality but not in the top-N yet (or awaiting momentum/alignment); it is
   *         tracked and may be promoted, never shown as an executable signal.
   */
  state: CentralOpportunityState;
}

/** The full result of one central ranking pass. */
export interface CentralRankingResult {
  ranked: CentralRankedOpportunity[];
  rejected: CentralRejection[];
  /** Total candidates considered before any filtering. */
  considered: number;
  /** Epoch ms of the pass. */
  rankedAt: number;
  connectionStatus: ConnectionStatus;
  /**
   * Candidates that cleared quality + entry-model validation but did not make the published
   * top-N. They are tracked (WATCH) and may be promoted on a later pass — never presented as
   * executable signals.
   */
  watchlist: CentralRankedOpportunity[];
}

/** Optional per-index validated performance input (expectancy in R and a win rate). */
export interface IndexValidatedPerformance {
  model: EntryModelKind | null;
  expectancy: number | null;
  winRatePercent: number | null;
  sampleSize: number;
  reliable: boolean;
}
