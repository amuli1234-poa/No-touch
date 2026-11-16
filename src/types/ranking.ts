import type { AiSignal } from './aiModule';
import type { DsSignal } from './demandSupply';
import type { EngineSignal } from './engine';
import type { MarketFamily, TimeframeKey } from './market';
import type { TrendlineSignal } from './trendline';

/**
 * The single ranking view shared by the floating scanner and every "best opportunity"
 * surface. One entry per active setup, aggregated from every engine, ordered strongest
 * first. Nothing here is invented — every field is copied from the owning engine's signal.
 */

/** Where a ranked setup came from. */
export type RankedSignalSource =
  | 'PRICE_ACTION' // Market Scanner / Chart Analyser signal engine
  | 'TRENDLINE' // Trendline AI
  | 'DEMAND_SUPPLY' // Demand & Supply AI
  | 'AI_MODULE'; // Any of the independent AI strategy modules

/** Lifecycle of a ranked setup as tracked by the lifecycle manager. */
export type RankedSetupStatus = 'ACTIVE' | 'COMPLETED' | 'INVALIDATED';

/** A unified, rankable view of one confirmed setup from any engine. */
export interface RankedSetup {
  /** Stable identity: engine + symbol + direction (+ model). Survives re-scans. */
  key: string;
  source: RankedSignalSource;
  /** Engine label for display (e.g. 'BOS & CHOCH AI', 'Market Scanner'). */
  sourceLabel: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  precision: number;
  direction: 'RISE' | 'FALL';
  modelLabel: string;
  /** 0–100 quality / confidence score used for ranking. */
  score: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  riskRewardRatio: number | null;
  /** Short human reasons why this setup qualifies, strongest first. */
  reasons: string[];
  /** Bar time the setup was confirmed (for lifecycle + chart anchoring). */
  confirmedBarTime: number;
  createdAt: number;
  /** Order of arrival, used only as a deterministic tie-breaker. */
  sequence: number;
  /**
   * The entry model the universal Entry Model AI selected for this setup (label).
   * Null until the entry-model evaluation has run for this opportunity.
   */
  entryModelLabel?: string | null;
}

/** A ranked setup plus its live lifecycle verdict from the automatic manager. */
export interface ManagedRankedSetup extends RankedSetup {
  status: RankedSetupStatus;
  /** The status before the manager settled it (for the "was active" test). */
  wasActive: boolean;
  settledAt: number | null;
  /** Realised outcome for the performance ledger (null while ACTIVE). */
  outcome: 'TARGET_HIT' | 'STOP_HIT' | 'INVALIDATED' | null;
}

/** Which engines contribute to the ranking, and how many to keep. */
export interface RankingOptions {
  /** Keep at most this many active setups (default 3 for the floating scanner). */
  limit?: number;
  /** Minimum score a setup must reach to be ranked. */
  minScore?: number;
}

export interface RankedSignalsInput {
  engineSignals: readonly EngineSignal[];
  trendlineSignals: readonly TrendlineSignal[];
  dsSignals: readonly DsSignal[];
  aiSignals: readonly { moduleLabel: string; signal: AiSignal }[];
}

/**
 * The originating AI + analysis details of a setup, preserved when it is opened in the
 * Chart Analysis tab so the selected setup keeps its provenance.
 */
export interface SetupOrigin {
  sourceLabel: string;
  modelLabel: string;
  direction: 'RISE' | 'FALL';
  timeframe: TimeframeKey;
  symbol: string;
  displayName: string;
  score: number;
  /** The universal entry-model evaluation attached to this setup (null when unavailable). */
  entryModelLabel: string | null;
}
