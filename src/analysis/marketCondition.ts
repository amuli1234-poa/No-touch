import type { MarketCondition, RangeAnalysis } from '../types/engine';
import type { MomentumAssessment, StructureBreakEvent } from '../types/analysis';
import type { Candle } from '../types/market';
import type { StructureAnalysisResult } from './structure';
import { getCandleStats } from './swings';

export interface ConditionClassification {
  condition: MarketCondition;
  explanation: string;
  /** Normalized ATR % used for the classification (descriptive). */
  normalizedAtrPct: number;
  /** Candle-overlap ratio in the recent window (1 = pure chop, 0 = clean trend). */
  overlapRatio: number;
  /** Count of BOS/CHoCH events in the recent window (structure clarity). */
  recentBreakCount: number;
}

/**
 * Classifies the market condition WITHOUT any reference to contract duration.
 * Order of precedence: valid sideways range → choppy (worst) → consolidation →
 * transitional → strong trend.
 */
export function classifyMarketCondition(
  candles: readonly Candle[],
  structure: StructureAnalysisResult,
  momentum: MomentumAssessment,
  atr: number,
  range: RangeAnalysis | null = null
): ConditionClassification {
  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const normalizedAtrPct = lastClose > 0 ? Number(((atr / lastClose) * 100).toFixed(3)) : 0;

  const window = candles.slice(-12);
  const ranges = window.map((c) => Math.max(1e-9, c.high - c.low));
  const bodies = window.map((c) => Math.abs(c.close - c.open));
  const avgRange = ranges.reduce((a, b) => a + b, 0) / (ranges.length || 1);
  const avgBody = bodies.reduce((a, b) => a + b, 0) / (bodies.length || 1);
  const overlapRatio = avgRange > 0 ? Number((avgBody / avgRange).toFixed(2)) : 0;

  const recentBreakCount = structure.breaks.filter(
    (b: StructureBreakEvent) => candles.length - 1 - b.index <= 20
  ).length;

  const strongTrendStructure =
    (structure.swingStructureSequence.hh && structure.swingStructureSequence.hl) ||
    (structure.swingStructureSequence.lh && structure.swingStructureSequence.ll);

  const directionalStructure =
    structure.direction === 'BULLISH' || structure.direction === 'BEARISH';

  // Sideways range: a validated M15 range is present. A validated range (confirmed
  // touches on both boundaries, sensible height, price still contained) IS the sideways
  // condition — range-extreme entries only (handled by the model gate downstream).
  // A decisive break of either boundary invalidates the range (price exits it), so
  // breakouts never reach this branch.
  if (range?.valid) {
    return {
      condition: 'SIDEWAYS_RANGE',
      explanation:
        'Validated M15 sideways range — trade only the range extremes (support RISE / resistance FALL); the middle 50% is a no-trade band.',
      normalizedAtrPct,
      overlapRatio,
      recentBreakCount,
    };
  }

  // Choppy / low-quality: heavy overlap, no directional control, exhausted/overextended noise.
  if (
    overlapRatio < 0.34 &&
    !strongTrendStructure &&
    (structure.direction === 'RANGING' || structure.direction === 'NEUTRAL')
  ) {
    return {
      condition: 'CHOPPY',
      explanation:
        'Heavy candle overlap with no directional swing control — low-quality, no-trade condition.',
      normalizedAtrPct,
      overlapRatio,
      recentBreakCount,
    };
  }

  // Consolidation: tight ranging between bounds with no fresh structural break.
  if (
    (structure.direction === 'RANGING' || structure.direction === 'NEUTRAL') &&
    recentBreakCount === 0
  ) {
    return {
      condition: 'CONSOLIDATION',
      explanation:
        'Price oscillating inside a defined range without a fresh structural break — consolidation.',
      normalizedAtrPct,
      overlapRatio,
      recentBreakCount,
    };
  }

  // Strong trend: clean HH/HL (or LH/LL) with confirmed directional structure and momentum.
  const momentumAligned =
    (structure.direction === 'BULLISH' && momentum.state === 'STRONG_BULLISH') ||
    (structure.direction === 'BEARISH' && momentum.state === 'STRONG_BEARISH');

  if (
    strongTrendStructure &&
    directionalStructure &&
    (momentumAligned || momentum.directionalEfficiency >= 0.35) &&
    overlapRatio >= 0.4
  ) {
    return {
      condition: structure.direction === 'BULLISH' ? 'STRONG_UPTREND' : 'STRONG_DOWNTREND',
      explanation:
        structure.direction === 'BULLISH'
          ? 'Clean HH/HL structure with aligned bullish momentum — strong uptrend.'
          : 'Clean LH/LL structure with aligned bearish momentum — strong downtrend.',
      normalizedAtrPct,
      overlapRatio,
      recentBreakCount,
    };
  }

  // Transitional: a recent structural break or a fresh CHoCH without a fully established trend.
  if (recentBreakCount > 0 || structure.latestBreak !== null) {
    return {
      condition: 'TRANSITIONAL',
      explanation:
        'Recent structural shift (BOS/CHoCH) without a fully established trend — transitional market.',
      normalizedAtrPct,
      overlapRatio,
      recentBreakCount,
    };
  }

  // Fallback: directional bias but no clean trend confirmed → transitional.
  if (directionalStructure) {
    return {
      condition: 'TRANSITIONAL',
      explanation:
        'Directional bias present but trend quality unconfirmed — treat as transitional.',
      normalizedAtrPct,
      overlapRatio,
      recentBreakCount,
    };
  }

  return {
    condition: 'CHOPPY',
    explanation: 'Structure and momentum are inconclusive — low-quality condition.',
    normalizedAtrPct,
    overlapRatio,
    recentBreakCount,
  };
}

/**
 * Models eligible for each market condition. The engine will not force a model that
 * does not suit the condition (e.g. no pure continuation model inside consolidation).
 */
export const CONDITION_MODEL_PRIORITY: Record<MarketCondition, string[]> = {
  STRONG_UPTREND: [
    'MODEL_1_TREND_PULLBACK_CONTINUATION',
    'MODEL_8_MOMENTUM_BOS',
    'MODEL_2_BREAKOUT_AND_RETEST',
    'MODEL_6_TRENDLINE_BREAK_RETEST',
    'MODEL_4_SUPPLY_DEMAND_REACTION',
  ],
  STRONG_DOWNTREND: [
    'MODEL_1_TREND_PULLBACK_CONTINUATION',
    'MODEL_8_MOMENTUM_BOS',
    'MODEL_2_BREAKOUT_AND_RETEST',
    'MODEL_6_TRENDLINE_BREAK_RETEST',
    'MODEL_4_SUPPLY_DEMAND_REACTION',
  ],
  CONSOLIDATION: [
    'MODEL_2_BREAKOUT_AND_RETEST',
    'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
    'MODEL_7_CHART_PATTERN_BREAKOUT',
    'MODEL_5_LIQUIDITY_SWEEP_CHOCH',
    'MODEL_4_SUPPLY_DEMAND_REACTION',
  ],
  // Sideways range: RANGE EXTREMES ONLY. The only models allowed are the
  // support/resistance rejection (range-extreme entries, gated to the outer 25%
  // bands + a confirmed M5 rejection) and the breakout-and-retest model (range
  // breakouts are handled separately, never as a range-extreme trade).
  SIDEWAYS_RANGE: [
    'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
    'MODEL_2_BREAKOUT_AND_RETEST',
  ],
  TRANSITIONAL: [
    'MODEL_5_LIQUIDITY_SWEEP_CHOCH',
    'MODEL_2_BREAKOUT_AND_RETEST',
    'MODEL_8_MOMENTUM_BOS',
    'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
    'MODEL_7_CHART_PATTERN_BREAKOUT',
    'MODEL_4_SUPPLY_DEMAND_REACTION',
    'MODEL_6_TRENDLINE_BREAK_RETEST',
  ],
  // CHOPPY still evaluates structure-first models so a genuine breakout is not missed,
  // but the quality gate will reject anything that does not genuinely qualify.
  CHOPPY: [
    'MODEL_2_BREAKOUT_AND_RETEST',
    'MODEL_5_LIQUIDITY_SWEEP_CHOCH',
    'MODEL_8_MOMENTUM_BOS',
    'MODEL_7_CHART_PATTERN_BREAKOUT',
  ],
};

export function isChoppyCandle(candle: Candle, atr: number): boolean {
  const stats = getCandleStats(candle);
  return stats.bodyRatio < 0.2 && stats.range < atr * 0.4;
}
