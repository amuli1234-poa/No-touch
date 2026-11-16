import type { StructuredMarketRead, StructuredTradeLevels } from './structuredRead';

/**
 * The Market Consolidation & Momentum AI's classification of the current market state.
 * The first six are the requested classes; VOLATILITY_CONTRACTION / RANGING are additional
 * neutral states used while a market is coiling or ranging without directional momentum.
 */
export type ConsolidationClass =
  | 'STRONG_BULLISH'
  | 'STRONG_BEARISH'
  | 'WEAK_MOMENTUM'
  | 'CONSOLIDATING'
  | 'VOLATILITY_EXPANSION'
  | 'UNCERTAIN'
  | 'VOLATILITY_CONTRACTION'
  | 'RANGING';

/** Which way, if any, the market is expanding out of consolidation. */
export type ExpansionState = 'NONE' | 'BUILDING' | 'CONFIRMED' | 'FADING';

/** The individual consolidation evidence signals the module detects. */
export interface ConsolidationSignals {
  /** Sideways / range-bound price (overlapping candles). */
  sideways: boolean;
  /** Price contained inside a tight band. */
  consolidation: boolean;
  /** Candle ranges / bodies contracting against the prior window. */
  candleCompression: boolean;
  /** Realised volatility declining. */
  decliningVolatility: boolean;
  /** Directional momentum is weak (low ADX / efficiency). */
  weakMomentum: boolean;
  /** Low net price displacement relative to effort. */
  lowDisplacement: boolean;
  /** Repeated reactions at the same support / resistance. */
  repeatedSupportResistance: boolean;
  /** Liquidity sweeps detected at the range edges. */
  liquiditySweeps: boolean;
  /** A break that failed and reversed back inside (false breakout). */
  falseBreakout: boolean;
  /** Early signs of consolidation forming. */
  earlyConsolidation: boolean;
  /** Early signs of momentum expansion beginning. */
  earlyExpansion: boolean;
}

/**
 * The Market Consolidation & Momentum AI's structured result for one index. Extends the
 * shared structured contract with the classification, the evidence signals and the
 * momentum/consolidation probabilities.
 */
export interface ConsolidationRead extends StructuredMarketRead {
  classification: ConsolidationClass;
  /** 0–100 bullish momentum strength (independent of the bearish score). */
  bullishMomentum: number;
  /** 0–100 bearish momentum strength. */
  bearishMomentum: number;
  /** 0–100 consolidation probability. */
  consolidationScore: number;
  /** 0–100 volatility-expansion pressure (coiled spring). */
  expansionPressure: number;
  /** Which way, if any, the market is expanding. */
  expansion: ExpansionState;
  /** The evidence signals behind the classification. */
  signals: ConsolidationSignals;
  /** True when the module suppressed a weak directional continuation signal. */
  continuationSuppressed: boolean;
  /** True when the market is genuinely consolidating (not a slow trend or pullback). */
  genuineConsolidation: boolean;
  /** True when a breakout has cleared structural break + momentum expansion. */
  breakoutApproved: boolean;
  /** Whether the market is a slow directional trend rather than consolidating. */
  slowTrend: boolean;
  /** The invalidation level of the read (the consolidation boundary or trend level). */
  invalidationLevel: number | null;
  /** A structurally valid breakout trade plan when approved (null otherwise). */
  trade: StructuredTradeLevels | null;
}
