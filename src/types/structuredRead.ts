import type { MarketFamily, TimeframeKey } from './market';

/**
 * Shared structured result contract for the market-intelligence AI modules
 * (Timeframe Alignment AI, Market Consolidation & Momentum AI).
 *
 * Requirement: every module returns a structured result containing the market, the
 * timeframe, a directional bias, an alignment score, a momentum strength, a consolidation
 * probability, a preferred strategy, a confidence, plus explicit confirmation and
 * invalidation conditions. Fields a given module does not own are null, never fabricated.
 */
export interface StructuredMarketRead {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  /** The timeframe the read is anchored to (execution TF for alignment; scan TF for momentum). */
  timeframe: TimeframeKey;
  /** Trade direction the read authorises (null when the read authorises no entry). */
  direction: 'RISE' | 'FALL' | null;
  directionalBias: 'bullish' | 'bearish' | 'neutral' | 'conflicting';
  /** 0–100 multi-timeframe agreement (null for modules that do not own alignment). */
  alignmentScore: number | null;
  /** 0–100 directional momentum strength (null for modules that do not own momentum). */
  momentumStrength: number | null;
  /** 0–100 probability the market is consolidating (null when not owned). */
  consolidationProbability: number | null;
  /** The strategy this module prefers for the current condition. */
  preferredStrategy: string;
  /** 0–100 confidence in this read. */
  confidence: number;
  /** The condition that must confirm before an entry is valid. */
  confirmationCondition: string;
  /** The condition that invalidates the read. */
  invalidationCondition: string;
}

/** A concrete, structurally valid trade plan produced by a module (or null when none). */
export interface StructuredTradeLevels {
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number | null;
  riskRewardRatio: number;
}
