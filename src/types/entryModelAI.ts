import type { MarketFamily, TimeframeKey } from './market';

/**
 * UNIVERSAL ENTRY MODEL AI — the shared entry-model taxonomy.
 *
 * One AI evaluates the best possible entry model for EVERY qualified setup submitted by
 * EVERY specialised strategy (Trendline, Supply & Demand, BOS & CHOCH, Technical, SMC,
 * Liquidity, FVG, Order Block, Momentum, Regime, Confluence, Live Scanner, and the
 * price-action scanner/analyser). It never forces one model onto every strategy: it reads
 * the setup's own evidence and market context and selects the model that genuinely fits.
 */

/** The entry-model library (requirement B). */
export type EntryModelKind =
  | 'LIQUIDITY_SWEEP_REVERSAL'
  | 'BOS_RETEST'
  | 'CHOCH_MSS'
  | 'ORDER_BLOCK_MITIGATION'
  | 'FVG_ENTRY'
  | 'BREAKER_MITIGATION_BLOCK'
  | 'SUPPLY_DEMAND_REJECTION'
  | 'SUPPORT_RESISTANCE_RETEST'
  | 'TRENDLINE_REJECTION_CONTINUATION'
  | 'BREAKOUT_RETEST'
  | 'SWING_HIGH_LOW_REJECTION'
  | 'DISPLACEMENT_REJECTION'
  | 'PREMIUM_DISCOUNT';

export const ENTRY_MODEL_KIND_LABELS: Record<EntryModelKind, string> = {
  LIQUIDITY_SWEEP_REVERSAL: 'Liquidity Sweep & Reversal',
  BOS_RETEST: 'BOS & Retest Entry',
  CHOCH_MSS: 'CHoCH / MSS Confirmation',
  ORDER_BLOCK_MITIGATION: 'Order Block Mitigation',
  FVG_ENTRY: 'Fair Value Gap Entry',
  BREAKER_MITIGATION_BLOCK: 'Breaker / Mitigation Block',
  SUPPLY_DEMAND_REJECTION: 'Supply & Demand Rejection',
  SUPPORT_RESISTANCE_RETEST: 'Support & Resistance Retest',
  TRENDLINE_REJECTION_CONTINUATION: 'Trendline Rejection & Continuation',
  BREAKOUT_RETEST: 'Breakout & Retest',
  SWING_HIGH_LOW_REJECTION: 'Swing High/Low Rejection',
  DISPLACEMENT_REJECTION: 'Candlestick Displacement & Rejection',
  PREMIUM_DISCOUNT: 'Premium & Discount Entry',
};

/** Entry confirmation states (requirement D). Never label a watching zone as confirmed. */
export type EntryDecisionState =
  | 'WATCHING'
  | 'WAITING'
  | 'CONFIRMED'
  | 'INVALIDATED'
  | 'MISSED'
  | 'EXPIRED';

/**
 * A setup submitted by a specialised AI, normalised so the universal entry-model AI can
 * evaluate it. The originating detection logic is preserved — nothing here re-derives the
 * strategy's signal, it only reads what the strategy already produced.
 */
export interface EntryModelSetupInput {
  /** Stable identity of the originating setup. */
  key: string;
  /** The originating strategy AI label (e.g. 'BOS & CHOCH AI', 'Trendline AI'). */
  sourceLabel: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  /** The strategy's own entry-model label (its detection logic), preserved. */
  originatingModelLabel: string;
  score: number;
  entryPrice: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskRewardRatio: number | null;
  reasons: readonly string[];
  /** The strategy's confirmation evidence (M1 entry confirmation, BOS, rejection, …). */
  evidence: readonly string[];
  confirmedBarTime: number;
}

/** The market context the entry-model AI reads for a given instrument. */
export interface EntryModelMarketContext {
  /** Latest confirmed close. */
  price: number;
  atr: number;
  /** Higher-timeframe (M15) directional read, or null when indeterminate. */
  htfDirection: 'RISE' | 'FALL' | null;
  /** Historical win-rate bonus per model from recorded outcomes (real learning). */
  historicalBonus?: Partial<Record<EntryModelKind, number>>;
  /**
   * The index-specific validated model learned from THIS index's own outcomes. Only a
   * reliable, non-overfit model is ever surfaced here (never blended across indices).
   */
  indexProfile?: { model: EntryModelKind | null; label: string; retained: boolean } | null;
  /** Epoch seconds of the newest confirmed candle feeding this context (data freshness). */
  dataTimestamp?: number;
}

/** One model's independent evaluation for a setup. */
export interface EntryModelEvaluation {
  kind: EntryModelKind;
  label: string;
  supported: boolean;
  supportScore: number;
  matchedEvidence: string[];
  reason: string;
}

/** The full selected-entry-model output for one opportunity (requirement E). */
export interface EntryModelDecision {
  key: string;
  /** Originating strategy AI. */
  originatingStrategy: string;
  marketName: string;
  symbol: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  state: EntryDecisionState;
  /** The selected entry model (null when no model carries enough confirmation). */
  model: EntryModelKind | null;
  modelLabel: string;
  /** Compatible models that genuinely reinforce the selection. */
  combinedWith: EntryModelKind[];
  htfDirection: 'RISE' | 'FALL' | null;
  watchingZone: { low: number; high: number } | null;
  entryPrice: number | null;
  entryRange: { low: number; high: number } | null;
  requiredConfirmation: string;
  stopLoss: number | null;
  invalidation: { level: number | null; condition: string };
  targets: { tp1: number | null; tp2: number | null; tp3: number | null };
  riskRewardRatio: number | null;
  qualityScore: number;
  /** Bar time of the setup's confirming candle (chart anchor). */
  confirmedBarTime: number;
  /** Epoch seconds of the newest confirmed candle read for this candidate (data freshness). */
  dataTimestamp: number;
  /** Epoch ms after which this candidate is stale and must not be ranked. */
  expiresAt: number;
  /**
   * The index-specific model validated from THIS index's own recorded outcomes (null when
   * the index has no reliable profile yet). Never blended across indices.
   */
  indexValidatedModel: EntryModelKind | null;
  indexValidatedModelLabel: string | null;
  /** Short explanation of why this entry model was selected. */
  explanation: string;
  evaluations: EntryModelEvaluation[];
}

/** An outcome record for model-specific performance tracking (requirement H). */
export type EntryModelOutcome = 'TARGET_HIT' | 'STOP_HIT' | 'INVALIDATED' | 'MISSED';

export interface EntryModelOutcomeRecord {
  model: EntryModelKind | 'UNKNOWN';
  modelLabel: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  /** Analysis timeframe the setup was taken on (attribution, never blended). */
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  riskRewardRatio: number | null;
  outcome: EntryModelOutcome;
  settledAt: number;
}

/** Aggregated, sample-aware performance for one entry model. */
export interface EntryModelPerformance {
  model: EntryModelKind | 'UNKNOWN';
  label: string;
  sampleSize: number;
  wins: number;
  losses: number;
  missed: number;
  winRatePercent: number | null;
  avgRiskReward: number | null;
  /** True only once the sample is large enough to trust the win rate. */
  reliable: boolean;
}
