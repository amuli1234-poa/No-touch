import type {
  ChartPatternStructure,
  LiquiditySweepEvent,
  MarketDirection,
  MomentumAssessment,
  StructureBreakEvent,
  SupportResistanceLevel,
  SupplyDemandZone,
  SwingPoint,
  TrendlineStructure,
} from '../types/analysis';
import type {
  EntryModelCandidate,
  EntryModelId,
  IndicatorSnapshot,
  MarketCondition,
  RangeAnalysis,
} from '../types/engine';
import { ENTRY_MODEL_LABELS } from '../types/engine';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import { formatPrice } from '../utils/derivParser';
import type { StructureAnalysisResult } from './structure';
import { computeTradeTargetsAndStopLoss } from './signalCalculations';
import { detectBoundaryRejection, classifyRangeZone } from './rangeAnalysis';
import { computeAtrSeries, getCandleStats, getRecentAverageBody } from './swings';

export interface ModelDetectionContext {
  symbol: string;
  timeframe: TimeframeKey;
  marketFamily: MarketFamily;
  precision: number;
  atr: number;
  candles: readonly Candle[]; // confirmed closed candles only (live bar excluded)
  structure: StructureAnalysisResult;
  swings: readonly SwingPoint[];
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
  trendlines: readonly TrendlineStructure[];
  patterns: readonly ChartPatternStructure[];
  momentum: MomentumAssessment;
  htfBias: {
    macro: MarketDirection;
    structural: MarketDirection;
    macroLabel: TimeframeKey;
    structuralLabel: TimeframeKey;
  };
  indicators: IndicatorSnapshot;
  condition: MarketCondition;
  /** Validated M15 sideways range (null when no range / not sideways). */
  range: RangeAnalysis | null;
  /** Confirmed M5 candles used to confirm a range-boundary rejection (entry timeframe). */
  entryCandles?: readonly Candle[];
}

type ModelDirection = 'RISE' | 'FALL';

interface RawDetection {
  model: EntryModelId;
  direction: ModelDirection;
  structuralLevelPrice: number;
  retestPrice: number | null;
  retestTime: number | null;
  invalidationPrice: number;
  invalidationCondition: string;
  confirmationExplanation: string;
  bosChochEvidence: string[];
  supportResistance: number[];
  momentumEvidence: string[];
  reasons: string[];
  invalidations: string[];
  scores: EntryModelCandidate['scores'];
}

/** Room to the nearest opposing level/zone, in ATR multiples. Shared by all models. */
export function computeAvailableSpace(
  ctx: ModelDetectionContext,
  direction: ModelDirection,
  entryPrice: number
): { availableSpaceAtr: number; availableSpaceLabel: string } {
  const { atr, supportResistance, supplyDemand, precision } = ctx;
  if (atr <= 0 || entryPrice <= 0) {
    return { availableSpaceAtr: 0, availableSpaceLabel: 'N/A' };
  }
  let nearest = Infinity;
  let barrier: number | null = null;
  if (direction === 'RISE') {
    for (const l of supportResistance) {
      if (l.status === 'active' && l.type === 'resistance' && l.price > entryPrice) {
        if (l.price - entryPrice < nearest) {
          nearest = l.price - entryPrice;
          barrier = l.price;
        }
      }
    }
    for (const z of supplyDemand) {
      if (z.status !== 'invalidated' && z.type === 'supply' && z.lowerPrice > entryPrice) {
        if (z.lowerPrice - entryPrice < nearest) {
          nearest = z.lowerPrice - entryPrice;
          barrier = z.lowerPrice;
        }
      }
    }
  } else {
    for (const l of supportResistance) {
      if (l.status === 'active' && l.type === 'support' && l.price < entryPrice) {
        if (entryPrice - l.price < nearest) {
          nearest = entryPrice - l.price;
          barrier = l.price;
        }
      }
    }
    for (const z of supplyDemand) {
      if (z.status !== 'invalidated' && z.type === 'demand' && z.upperPrice < entryPrice) {
        if (entryPrice - z.upperPrice < nearest) {
          nearest = entryPrice - z.upperPrice;
          barrier = z.upperPrice;
        }
      }
    }
  }
  if (!Number.isFinite(nearest) || barrier === null) {
    return { availableSpaceAtr: 3.5, availableSpaceLabel: 'Open space (> 3.5x ATR)' };
  }
  const spaceAtr = Number((nearest / atr).toFixed(2));
  return {
    availableSpaceAtr: spaceAtr,
    availableSpaceLabel: `${spaceAtr}x ATR to ${formatPrice(barrier, precision)}`,
  };
}

function htfScore(ctx: ModelDetectionContext, direction: ModelDirection): number {
  const want = direction === 'RISE' ? 'BULLISH' : 'BEARISH';
  const macroOk = ctx.htfBias.macro === want;
  const structOk = ctx.htfBias.structural === want;
  if (macroOk && structOk) return 10;
  if (structOk) return 7;
  if (macroOk) return 6;
  if (ctx.htfBias.macro === 'NEUTRAL' || ctx.htfBias.structural === 'NEUTRAL') return 4;
  return 1;
}

function indicatorConfirms(ctx: ModelDetectionContext, direction: ModelDirection): number {
  const want = direction === 'RISE' ? 'BULLISH' : 'BEARISH';
  let pts = 0;
  if (ctx.indicators.trendConfirm === want) pts += 1;
  if (ctx.indicators.momentumConfirm === want) pts += 1;
  if (ctx.indicators.strengthConfirm) pts += 1;
  return pts; // 0..3, used as a tie-breaker bonus, never as the primary evidence
}

/** Fills targets, space, HTF and indicator confirmation into a final candidate. */
function finalize(
  ctx: ModelDetectionContext,
  raw: RawDetection,
  entryPrice: number
): EntryModelCandidate {
  const targets = computeTradeTargetsAndStopLoss({
    direction: raw.direction,
    entryPrice,
    invalidationPrice: raw.invalidationPrice,
    atr: ctx.atr,
    supportResistance: ctx.supportResistance,
    supplyDemand: ctx.supplyDemand,
    trendlines: ctx.trendlines,
    patterns: ctx.patterns,
    precision: ctx.precision,
  });
  const space = computeAvailableSpace(ctx, raw.direction, entryPrice);
  const indicatorBonus = indicatorConfirms(ctx, raw.direction);

  const scores = {
    structure: raw.scores.structure,
    levelZone: raw.scores.levelZone,
    entryConfirmation: Math.min(
      25,
      raw.scores.entryConfirmation + (indicatorBonus >= 2 ? 2 : indicatorBonus === 1 ? 1 : 0)
    ),
    momentum: Math.min(15, raw.scores.momentum + (indicatorBonus >= 2 ? 1 : 0)),
    multiTimeframe: htfScore(ctx, raw.direction),
    availableSpace: space.availableSpaceAtr >= 1.5 ? 10 : space.availableSpaceAtr >= 0.8 ? 6 : 2,
  };

  return {
    model: raw.model,
    modelLabel: ENTRY_MODEL_LABELS[raw.model],
    direction: raw.direction,
    entryPrice,
    structuralLevelPrice: raw.structuralLevelPrice,
    retestPrice: raw.retestPrice,
    retestTime: raw.retestTime,
    invalidationPrice: raw.invalidationPrice,
    invalidationCondition: raw.invalidationCondition,
    target1: targets.takeProfit1,
    target2: targets.takeProfit2,
    stopLoss: targets.stopLoss,
    riskRewardRatio: targets.riskRewardRatio,
    confirmationExplanation: raw.confirmationExplanation,
    bosChochEvidence: raw.bosChochEvidence,
    supportResistance: raw.supportResistance,
    momentumEvidence: raw.momentumEvidence,
    reasons: raw.reasons,
    invalidations: raw.invalidations,
    availableSpaceAtr: space.availableSpaceAtr,
    availableSpaceLabel: space.availableSpaceLabel,
    scores,
  };
}

// ---------------------------------------------------------------------------
// MODEL 1 — Trend Pullback Continuation
// ---------------------------------------------------------------------------
function model1TrendPullback(ctx: ModelDetectionContext): RawDetection | null {
  const { candles, structure, momentum, swings, atr, precision, timeframe } = ctx;
  const last = candles[candles.length - 1];
  const stats = getCandleStats(last);
  const avgBody = getRecentAverageBody(candles, candles.length - 1, 14);
  const lastIdx = candles.length - 1;

  const recentBos = [...structure.breaks]
    .reverse()
    .find((b) => b.kind === 'BOS' && lastIdx - b.index <= 12);
  if (!recentBos) return null;

  const bull = recentBos.direction === 'bullish';
  const trendOk = bull
    ? structure.swingStructureSequence.hh && structure.swingStructureSequence.hl
    : structure.swingStructureSequence.lh && structure.swingStructureSequence.ll;
  if (!trendOk) return null;

  const direction: ModelDirection = bull ? 'RISE' : 'FALL';
  const level = recentBos.brokenLevel;
  const lvlText = formatPrice(level, precision);

  // Retracement into the level/zone then rejection + renewed momentum.
  const afterBreak = candles.slice(recentBos.index + 1);
  if (afterBreak.length < 2) return null;
  const pulledBack = afterBreak.some((b) =>
    bull ? b.low <= level + atr * 0.6 : b.high >= level - atr * 0.6
  );
  if (!pulledBack) return null;

  const rejection = bull
    ? stats.isBullish && stats.closePosition >= 0.55 && stats.body >= avgBody * 0.8
    : stats.isBearish && stats.closePosition <= 0.45 && stats.body >= avgBody * 0.8;
  if (!rejection) return null;

  const recentSwings = swings.filter((s) => (bull ? s.type === 'low' : s.type === 'high'));
  const defended = recentSwings.length > 0 ? recentSwings[recentSwings.length - 1] : null;
  const invalidation = bull
    ? Math.min(level - atr * 0.25, defended ? defended.price - atr * 0.1 : level - atr * 0.5)
    : Math.max(level + atr * 0.25, defended ? defended.price + atr * 0.1 : level + atr * 0.5);

  const structureScore = 14 + (momentum.directionalEfficiency >= 0.4 ? 6 : 3);
  const momentumScore = Math.min(
    15,
    6 +
      (momentum.state === (bull ? 'STRONG_BULLISH' : 'STRONG_BEARISH') ? 6 : 2) +
      (momentum.pullbackQuality === 'CLEAN' ? 3 : 0)
  );

  return {
    model: 'MODEL_1_TREND_PULLBACK_CONTINUATION',
    direction,
    structuralLevelPrice: level,
    retestPrice: defended?.price ?? null,
    retestTime: defended?.time ?? null,
    invalidationPrice: invalidation,
    invalidationCondition: `Trend continuation fails on a close beyond ${formatPrice(invalidation, precision)}.`,
    confirmationExplanation: `${timeframe} ${bull ? 'bullish' : 'bearish'} trend (HH/HL) with confirmed BOS at ${lvlText}, healthy retracement into the level, and a ${bull ? 'bullish' : 'bearish'} rejection candle reasserting momentum.`,
    bosChochEvidence: [recentBos.reason],
    supportResistance: [level],
    momentumEvidence: [
      momentum.summary,
      `Pullback quality: ${momentum.pullbackQuality}.`,
    ],
    reasons: [
      `${bull ? 'Bullish' : 'Bearish'} HH/HL structure intact with a confirmed BOS at ${lvlText}.`,
      'Price retraced into the structural level and was rejected with renewed momentum.',
      ...(ctx.trendlines.some((t) => t.direction === (bull ? 'bullish' : 'bearish') && !t.broken)
        ? [`${bull ? 'Ascending' : 'Descending'} trendline support remains valid.`]
        : []),
    ],
    invalidations: [
      `Close beyond ${formatPrice(invalidation, precision)} invalidates the continuation.`,
    ],
    scores: {
      structure: Math.min(20, structureScore),
      levelZone: 17,
      entryConfirmation: 23,
      momentum: momentumScore,
      multiTimeframe: 0,
      availableSpace: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// MODEL 2 — Breakout & Retest
// ---------------------------------------------------------------------------
function model2BreakoutRetest(ctx: ModelDetectionContext): RawDetection | null {
  const { candles, structure, momentum, atr, precision, timeframe, supportResistance } = ctx;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);
  const avgBody = getRecentAverageBody(candles, lastIdx, 14);

  const bos = [...structure.breaks]
    .reverse()
    .find((b) => b.kind === 'BOS' && lastIdx - b.index >= 1 && lastIdx - b.index <= 8);
  if (!bos) return null;

  const bull = bos.direction === 'bullish';
  const direction: ModelDirection = bull ? 'RISE' : 'FALL';
  const level = bos.brokenLevel;

  // Sideways range: breakouts only count at a RANGE BOUNDARY. An internal-level break
  // (e.g. at the equilibrium/midpoint) must never yield a signal inside the range — the
  // middle 50% is a hard no-trade band. Range-boundary breaks that close back inside
  // cannot satisfy the held-retest requirement, so genuine breakouts still resolve once
  // the range is invalidated (condition no longer SIDEWAYS_RANGE).
  if (ctx.condition === 'SIDEWAYS_RANGE' && ctx.range?.valid) {
    const nearBoundary =
      Math.abs(level - ctx.range.resistance) <= atr * 0.5 ||
      Math.abs(level - ctx.range.support) <= atr * 0.5;
    if (!nearBoundary) return null;
  }

  // Reject wick-only pokes: the break candle must have closed beyond the level.
  const breakBar = candles[bos.index];
  const breakStats = getCandleStats(breakBar);
  const closedBeyond = bull
    ? breakBar.close > level + atr * 0.05
    : breakBar.close < level - atr * 0.05;
  const wickOnly = bull
    ? breakBar.close <= level && breakBar.high > level
    : breakBar.close >= level && breakBar.low < level;
  if (!closedBeyond || wickOnly) return null;

  // Retest of the broken level, then continuation confirmation.
  const after = candles.slice(bos.index + 1);
  const retestBar = after.find((b) =>
    bull ? b.low <= level + atr * 0.35 : b.high >= level - atr * 0.35
  );
  const heldRetest = after.every((b) => (bull ? b.close >= level - atr * 0.2 : b.close <= level + atr * 0.2));
  const confirm = bull
    ? stats.isBullish && stats.body >= avgBody * 0.7 && stats.closePosition >= 0.5
    : stats.isBearish && stats.body >= avgBody * 0.7 && stats.closePosition <= 0.5;
  if (!heldRetest || !confirm) return null;

  const invalidation = bull ? level - atr * 0.5 : level + atr * 0.5;
  const lvlText = formatPrice(level, precision);
  const srNear = supportResistance
    .filter((l) => Math.abs(l.price - level) <= atr)
    .map((l) => l.price);

  return {
    model: 'MODEL_2_BREAKOUT_AND_RETEST',
    direction,
    structuralLevelPrice: level,
    retestPrice: retestBar?.low ?? null,
    retestTime: retestBar?.time ?? null,
    invalidationPrice: invalidation,
    invalidationCondition: `Breakout fails on a close back beyond ${formatPrice(invalidation, precision)}.`,
    confirmationExplanation: `A meaningful ${bull ? 'resistance' : 'support'} level at ${lvlText} was broken with a decisive candle close beyond it, held on retest, and continued ${bull ? 'upward' : 'downward'}.`,
    bosChochEvidence: [bos.reason],
    supportResistance: srNear.length > 0 ? srNear : [level],
    momentumEvidence: [momentum.summary, `Break candle closed decisively beyond ${lvlText} (not a wick).`],
    reasons: [
      `Candle closed beyond the ${bull ? 'resistance' : 'support'} at ${lvlText} — wick-only pokes rejected.`,
      'Level held on retest without closing back through it.',
      'Continuation candle confirmed in the breakout direction.',
    ],
    invalidations: [`Close back through ${formatPrice(level, precision)} invalidates the breakout.`],
    scores: {
      structure: 16,
      levelZone: 17,
      entryConfirmation: 23,
      momentum: Math.min(15, 7 + (momentum.displacementCandle ? 5 : 2)),
      multiTimeframe: 0,
      availableSpace: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// MODEL 3 — Support & Resistance Rejection
// ---------------------------------------------------------------------------

/**
 * Range-extreme rejection (sideways markets). Only the outer 25% bands may trade:
 *  - RISE at the range low (support) after a confirmed M5 bullish rejection.
 *  - FALL at the range high (resistance) after a confirmed M5 bearish rejection.
 * The middle 50% is a hard no-trade band and price outside the range is a breakout
 * (handled by Model 2), never a range-extreme entry.
 */
function detectRangeExtremeRejection(
  ctx: ModelDetectionContext,
  range: RangeAnalysis
): RawDetection | null {
  const { candles, momentum, atr, precision } = ctx;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);
  const avgBody = getRecentAverageBody(candles, lastIdx, 14);

  const support = formatPrice(range.support, precision);
  const resistance = formatPrice(range.resistance, precision);
  const equilibrium = formatPrice(range.equilibrium, precision);

  // Price must be trading inside the range, not breaking out of it.
  if (last.close > range.resistance || last.close < range.support) return null;

  const entryCandles = ctx.entryCandles ?? candles;
  const entryAtrs = computeAtrSeries(entryCandles.length > 2 ? entryCandles.slice(0, -1) : entryCandles, 14);
  const entryAtr = entryAtrs[entryAtrs.length - 1] || atr;

  const zone = classifyRangeZone(last.close, range);
  if (zone === 'MIDDLE') return null; // middle 50% → NO TRADE
  const inLower = zone === 'LOWER';
  const inUpper = zone === 'UPPER';
  if (!inLower && !inUpper) return null; // breakout (above/below range) → handled by Model 2

  if (inLower) {
    const rej = detectBoundaryRejection({
      candles: entryCandles,
      boundary: range.support,
      direction: 'RISE',
      atr: entryAtr,
    });
    if (!rej.confirmed) return null;
    if (!(stats.isBullish && stats.closePosition >= 0.5)) return null;

    const invalidation = range.support - atr * 0.75;
    const structuralScore = Math.min(20, 14 + range.supportTouches * 2);
    const entryScore = Math.min(
      25,
      21 + (stats.lowerWick >= stats.body * 0.5 ? 2 : 0)
    );
    const momentumScore = Math.min(15, 8 + (stats.body >= avgBody ? 3 : 1));

    return {
      model: 'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
      direction: 'RISE',
      structuralLevelPrice: range.support,
      retestPrice: last.low,
      retestTime: last.time,
      invalidationPrice: invalidation,
      invalidationCondition: `Range low fails on a close below ${formatPrice(invalidation, precision)}.`,
      confirmationExplanation: `Price traded into the lower range boundary (support ${support}) and produced a confirmed M5 bullish rejection. Range high ${resistance}, equilibrium ${equilibrium}; the middle 50% is not traded.`,
      bosChochEvidence: [rej.reason],
      supportResistance: [range.support, range.equilibrium, range.resistance],
      momentumEvidence: [momentum.summary, rej.reason],
      reasons: [
        `Validated M15 sideways range: support ${support}, resistance ${resistance}, equilibrium ${equilibrium}.`,
        'Price is in the lower 25% (support trading area).',
        rej.reason,
      ],
      invalidations: [
        `Close below ${formatPrice(invalidation, precision)} invalidates the range low.`,
        'A decisive break of either boundary invalidates the range (breakouts use Model 2).',
      ],
      scores: {
        structure: structuralScore,
        levelZone: Math.min(20, 15 + range.supportTouches * 2),
        entryConfirmation: entryScore,
        momentum: momentumScore,
        multiTimeframe: 0,
        availableSpace: 0,
      },
    };
  }

  const rej = detectBoundaryRejection({
    candles: entryCandles,
    boundary: range.resistance,
    direction: 'FALL',
    atr: entryAtr,
  });
  if (!rej.confirmed) return null;
  if (!(stats.isBearish && stats.closePosition <= 0.5)) return null;

  const invalidation = range.resistance + atr * 0.75;
  const structuralScore = Math.min(20, 14 + range.resistanceTouches * 2);
  const entryScore = Math.min(25, 21 + (stats.upperWick >= stats.body * 0.5 ? 2 : 0));
  const momentumScore = Math.min(15, 8 + (stats.body >= avgBody ? 3 : 1));

  return {
    model: 'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
    direction: 'FALL',
    structuralLevelPrice: range.resistance,
    retestPrice: last.high,
    retestTime: last.time,
    invalidationPrice: invalidation,
    invalidationCondition: `Range high fails on a close above ${formatPrice(invalidation, precision)}.`,
    confirmationExplanation: `Price traded into the upper range boundary (resistance ${resistance}) and produced a confirmed M5 bearish rejection. Range low ${support}, equilibrium ${equilibrium}; the middle 50% is not traded.`,
    bosChochEvidence: [rej.reason],
    supportResistance: [range.resistance, range.equilibrium, range.support],
    momentumEvidence: [momentum.summary, rej.reason],
    reasons: [
      `Validated M15 sideways range: support ${support}, resistance ${resistance}, equilibrium ${equilibrium}.`,
      'Price is in the upper 25% (resistance trading area).',
      rej.reason,
    ],
    invalidations: [
      `Close above ${formatPrice(invalidation, precision)} invalidates the range high.`,
      'A decisive break of either boundary invalidates the range (breakouts use Model 2).',
    ],
    scores: {
      structure: structuralScore,
      levelZone: Math.min(20, 15 + range.resistanceTouches * 2),
      entryConfirmation: entryScore,
      momentum: momentumScore,
      multiTimeframe: 0,
      availableSpace: 0,
    },
  };
}

function model3SrRejection(ctx: ModelDetectionContext): RawDetection | null {
  const { candles, structure, momentum, atr, precision, timeframe, supportResistance, range } = ctx;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);
  const avgBody = getRecentAverageBody(candles, lastIdx, 14);

  // Sideways range: RANGE EXTREMES ONLY. RISE at the lower boundary and FALL at the
  // upper boundary, each after a confirmed M5 rejection. The middle 50% is never
  // traded, and a breakout (price outside the range) is not a range-extreme entry.
  if (ctx.condition === 'SIDEWAYS_RANGE' && range?.valid) {
    return detectRangeExtremeRejection(ctx, range);
  }

  for (const level of supportResistance.filter((l) => l.status === 'active' && l.importance === 'major')) {
    const dist = Math.abs(last.close - level.price);
    if (dist > atr * 0.8) continue;

    const touchesLevel = last.low <= level.price + atr * 0.4 && last.high >= level.price - atr * 0.4;
    if (!touchesLevel) continue;

    if (level.type === 'support') {
      const rejected = stats.isBullish && stats.closePosition >= 0.6 && stats.lowerWick >= stats.body * 0.5;
      if (!rejected) continue;
      const invalidation = level.price - atr * 0.6;
      return {
        model: 'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
        direction: 'RISE',
        structuralLevelPrice: level.price,
        retestPrice: last.low,
        retestTime: last.time,
        invalidationPrice: invalidation,
        invalidationCondition: `Support fails on a close below ${formatPrice(invalidation, precision)}.`,
        confirmationExplanation: `Price returned to major historical support at ${formatPrice(level.price, precision)} and was rejected by a bullish candle with a supportive lower wick and structural evidence.`,
        bosChochEvidence: structure.latestBreak ? [structure.latestBreak.reason] : [],
        supportResistance: [level.price],
        momentumEvidence: [momentum.summary],
        reasons: [
          `Major historical support at ${formatPrice(level.price, precision)} (${level.touches} touches).`,
          'Directional bullish rejection candle with lower-wick rejection at the level.',
          'No immediate opposing level blocks the move upward.',
        ],
        invalidations: [`Close below ${formatPrice(invalidation, precision)} invalidates the support.`],
        scores: {
          structure: 15,
          levelZone: Math.min(20, 14 + level.touches * 2),
          entryConfirmation: 21,
          momentum: Math.min(15, 8 + (stats.body >= avgBody ? 3 : 1)),
          multiTimeframe: 0,
          availableSpace: 0,
        },
      };
    }

    const rejected = stats.isBearish && stats.closePosition <= 0.4 && stats.upperWick >= stats.body * 0.5;
    if (!rejected) continue;
    const invalidation = level.price + atr * 0.6;
    return {
      model: 'MODEL_3_SUPPORT_RESISTANCE_REJECTION',
      direction: 'FALL',
      structuralLevelPrice: level.price,
      retestPrice: last.high,
      retestTime: last.time,
      invalidationPrice: invalidation,
      invalidationCondition: `Resistance fails on a close above ${formatPrice(invalidation, precision)}.`,
      confirmationExplanation: `Price returned to major historical resistance at ${formatPrice(level.price, precision)} and was rejected by a bearish candle with an upper wick and structural evidence.`,
      bosChochEvidence: structure.latestBreak ? [structure.latestBreak.reason] : [],
      supportResistance: [level.price],
      momentumEvidence: [momentum.summary],
      reasons: [
        `Major historical resistance at ${formatPrice(level.price, precision)} (${level.touches} touches).`,
        'Directional bearish rejection candle with upper-wick rejection at the level.',
        'No immediate opposing level blocks the move downward.',
      ],
      invalidations: [`Close above ${formatPrice(invalidation, precision)} invalidates the resistance.`],
      scores: {
        structure: 15,
        levelZone: Math.min(20, 14 + level.touches * 2),
        entryConfirmation: 21,
        momentum: Math.min(15, 8 + (stats.body >= avgBody ? 3 : 1)),
        multiTimeframe: 0,
        availableSpace: 0,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// MODEL 4 — Supply & Demand Reaction
// ---------------------------------------------------------------------------
function model4SupplyDemand(ctx: ModelDetectionContext): RawDetection | null {
  const { candles, structure, momentum, atr, precision, timeframe, supplyDemand } = ctx;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);
  const avgBody = getRecentAverageBody(candles, lastIdx, 14);

  for (const zone of supplyDemand.filter((z) => z.status !== 'invalidated')) {
    const inZone =
      zone.type === 'demand'
        ? last.low <= zone.upperPrice && last.low >= zone.lowerPrice - atr * 0.3
        : last.high >= zone.lowerPrice && last.high <= zone.upperPrice + atr * 0.3;
    if (!inZone) continue;

    // Origin must have broken meaningful structure.
    const brokeStructure = structure.breaks.some(
      (b) =>
        Math.abs(b.index - zone.originIndex) <= 6 &&
        ((zone.type === 'demand' && b.direction === 'bullish') ||
          (zone.type === 'supply' && b.direction === 'bearish'))
    );
    if (!brokeStructure) continue;

    if (zone.type === 'demand') {
      const rejection = stats.isBullish && stats.closePosition >= 0.55;
      if (!rejection) continue;
      const invalidation = zone.lowerPrice - atr * 0.3;
      return {
        model: 'MODEL_4_SUPPLY_DEMAND_REACTION',
        direction: 'RISE',
        structuralLevelPrice: zone.upperPrice,
        retestPrice: zone.lowerPrice,
        retestTime: zone.originTime,
        invalidationPrice: invalidation,
        invalidationCondition: `Demand zone fails on a close below ${formatPrice(invalidation, precision)}.`,
        confirmationExplanation: `A fresh demand zone (${formatPrice(zone.lowerPrice, precision)}–${formatPrice(zone.upperPrice, precision)}) formed from strong bullish displacement that broke structure; price returned and reacted bullishly.`,
        bosChochEvidence: structure.breaks
          .filter((b) => Math.abs(b.index - zone.originIndex) <= 6)
          .map((b) => b.reason),
        supportResistance: [zone.lowerPrice, zone.upperPrice],
        momentumEvidence: [momentum.summary, zone.reason],
        reasons: [
          zone.reason,
          'Origin displacement broke meaningful structure.',
          'Price returned to the fresh zone and produced a bullish reaction.',
        ],
        invalidations: [`Close below ${formatPrice(invalidation, precision)} invalidates the demand zone.`],
        scores: {
          structure: 15,
          levelZone: Math.min(20, 14 + Math.round(zone.displacementAtr)),
          entryConfirmation: 21,
          momentum: Math.min(15, 8 + Math.round(zone.displacementAtr)),
          multiTimeframe: 0,
          availableSpace: 0,
        },
      };
    }

    const rejection = stats.isBearish && stats.closePosition <= 0.45;
    if (!rejection) continue;
    const invalidation = zone.upperPrice + atr * 0.3;
    return {
      model: 'MODEL_4_SUPPLY_DEMAND_REACTION',
      direction: 'FALL',
      structuralLevelPrice: zone.lowerPrice,
      retestPrice: zone.upperPrice,
      retestTime: zone.originTime,
      invalidationPrice: invalidation,
      invalidationCondition: `Supply zone fails on a close above ${formatPrice(invalidation, precision)}.`,
      confirmationExplanation: `A fresh supply zone (${formatPrice(zone.lowerPrice, precision)}–${formatPrice(zone.upperPrice, precision)}) formed from strong bearish displacement that broke structure; price returned and reacted bearishly.`,
      bosChochEvidence: structure.breaks
        .filter((b) => Math.abs(b.index - zone.originIndex) <= 6)
        .map((b) => b.reason),
      supportResistance: [zone.lowerPrice, zone.upperPrice],
      momentumEvidence: [momentum.summary, zone.reason],
      reasons: [
        zone.reason,
        'Origin displacement broke meaningful structure.',
        'Price returned to the fresh zone and produced a bearish reaction.',
      ],
      invalidations: [`Close above ${formatPrice(invalidation, precision)} invalidates the supply zone.`],
      scores: {
        structure: 15,
        levelZone: Math.min(20, 14 + Math.round(zone.displacementAtr)),
        entryConfirmation: 21,
        momentum: Math.min(15, 8 + Math.round(zone.displacementAtr)),
        multiTimeframe: 0,
        availableSpace: 0,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// MODEL 5 — Liquidity Sweep & CHoCH
// ---------------------------------------------------------------------------
function model5LiquiditySweepChoch(ctx: ModelDetectionContext): RawDetection | null {
  const { candles, structure, momentum, atr, precision, timeframe } = ctx;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);

  const sweep: LiquiditySweepEvent | undefined = [...structure.liquiditySweeps]
    .reverse()
    .find((s) => lastIdx - s.index <= 10);
  if (!sweep) return null;

  const bull = sweep.type === 'BULLISH_SWEEP';
  const direction: ModelDirection = bull ? 'RISE' : 'FALL';

  // A sweep alone is never an entry: require a CHoCH after the sweep + displacement close.
  const choch: StructureBreakEvent | undefined = structure.breaks.find(
    (b) =>
      b.kind === 'CHOCH' &&
      b.index > sweep.index &&
      b.direction === (bull ? 'bullish' : 'bearish') &&
      lastIdx - b.index <= 6
  );
  if (!choch) return null;

  const confirm = bull ? stats.isBullish && stats.closePosition >= 0.55 : stats.isBearish && stats.closePosition <= 0.45;
  if (!confirm) return null;

  const invalidation = bull ? sweep.sweepPrice - atr * 0.2 : sweep.sweepPrice + atr * 0.2;
  const level = choch.brokenLevel;

  return {
    model: 'MODEL_5_LIQUIDITY_SWEEP_CHOCH',
    direction,
    structuralLevelPrice: level,
    retestPrice: sweep.sweepPrice,
    retestTime: sweep.time,
    invalidationPrice: invalidation,
    invalidationCondition: `Sweep reclaim fails on a close beyond ${formatPrice(invalidation, precision)}.`,
    confirmationExplanation: `Liquidity was swept ${bull ? 'below sell-side' : 'above buy-side'} levels, price closed back inside, and a ${bull ? 'bullish' : 'bearish'} CHoCH with directional displacement confirmed the reversal.`,
    bosChochEvidence: [sweep.reason, choch.reason],
    supportResistance: [sweep.sweptLevel, level],
    momentumEvidence: [momentum.summary, 'Displacement close after the CHoCH.'],
    reasons: [
      sweep.reason,
      choch.reason,
      'Sweep alone was not traded — confirmation required a CHoCH and displacement.',
    ],
    invalidations: [`Close beyond ${formatPrice(invalidation, precision)} invalidates the reclaim.`],
    scores: {
      structure: 16,
      levelZone: 16,
      entryConfirmation: 24,
      momentum: Math.min(15, 8 + (momentum.displacementCandle ? 4 : 1)),
      multiTimeframe: 0,
      availableSpace: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// MODEL 6 — Trendline Break & Retest
// ---------------------------------------------------------------------------
function model6TrendlineBreakRetest(ctx: ModelDetectionContext): RawDetection | null {
  const { candles, structure, momentum, atr, precision, timeframe, trendlines } = ctx;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);
  const avgBody = getRecentAverageBody(candles, lastIdx, 14);

  for (const tl of trendlines) {
    if (!tl.broken || tl.breakDirection === undefined) continue;
    if (lastIdx - candles.findIndex((c) => c.time === tl.breakTime) > 10) continue;

    const bull = tl.breakDirection === 'bullish';
    const direction: ModelDirection = bull ? 'RISE' : 'FALL';
    const breakLevel = tl.breakPrice ?? tl.endPrice;

    const brokeWithDisplacement =
      tl.touches >= 2 &&
      (bull ? stats.isBullish : stats.isBearish) &&
      stats.body >= avgBody * 0.6;
    if (!brokeWithDisplacement) continue;

    const retested = candles
      .slice(lastIdx - 6)
      .some((b) => Math.abs((bull ? b.high : b.low) - breakLevel) <= atr * 0.6);
    if (!retested) continue;

    const rejection = bull ? stats.isBullish && stats.closePosition >= 0.5 : stats.isBearish && stats.closePosition <= 0.5;
    if (!rejection) continue;

    const invalidation = bull ? breakLevel - atr * 0.5 : breakLevel + atr * 0.5;

    return {
      model: 'MODEL_6_TRENDLINE_BREAK_RETEST',
      direction,
      structuralLevelPrice: breakLevel,
      retestPrice: breakLevel,
      retestTime: last.time,
      invalidationPrice: invalidation,
      invalidationCondition: `Trendline break fails on a close back beyond ${formatPrice(invalidation, precision)}.`,
      confirmationExplanation: `A ${tl.touches}-touch trendline was broken with a candle close beyond it (BOS/displacement), then retested and rejected in the breakout direction.`,
      bosChochEvidence: structure.latestBreak ? [structure.latestBreak.reason] : [],
      supportResistance: [breakLevel],
      momentumEvidence: [momentum.summary, tl.reason],
      reasons: [
        tl.reason,
        'Candle closed beyond the trendline with displacement (BOS).',
        'Retest of the broken trendline held with a directional rejection.',
      ],
      invalidations: [`Close back beyond ${formatPrice(invalidation, precision)} invalidates the break.`],
      scores: {
        structure: 16,
        levelZone: 16,
        entryConfirmation: 24,
        momentum: Math.min(15, 10 + (momentum.displacementCandle ? 3 : 0)),
        multiTimeframe: 0,
        availableSpace: 0,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// MODEL 7 — Chart Pattern Breakout
// ---------------------------------------------------------------------------
function model7ChartPattern(ctx: ModelDetectionContext): RawDetection | null {
  const { candles, structure, momentum, atr, precision, timeframe, patterns } = ctx;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);
  const avgBody = getRecentAverageBody(candles, lastIdx, 14);

  for (const p of patterns) {
    if (!p.confirmed || !p.breakTime) continue;
    const breakIdx = candles.findIndex((c) => c.time === p.breakTime);
    if (breakIdx < 0 || lastIdx - breakIdx > 8) continue;

    const bull = p.bias === 'bullish';
    const direction: ModelDirection = bull ? 'RISE' : 'FALL';
    const boundary = p.necklinePrice ?? p.breakPrice ?? last.close;

    const momentumOk = bull
      ? stats.isBullish && stats.body >= avgBody * 0.6
      : stats.isBearish && stats.body >= avgBody * 0.6;
    if (!momentumOk) continue;

    const invalidation = bull ? boundary - atr * 0.6 : boundary + atr * 0.6;

    return {
      model: 'MODEL_7_CHART_PATTERN_BREAKOUT',
      direction,
      structuralLevelPrice: boundary,
      retestPrice: boundary,
      retestTime: p.breakTime,
      invalidationPrice: invalidation,
      invalidationCondition: `Pattern fails on a close back beyond ${formatPrice(invalidation, precision)}.`,
      confirmationExplanation: `${p.name} with identifiable boundaries confirmed a ${bull ? 'bullish' : 'bearish'} breakout at ${formatPrice(boundary, precision)} with follow-through momentum.`,
      bosChochEvidence: structure.latestBreak ? [structure.latestBreak.reason] : [],
      supportResistance: [boundary],
      momentumEvidence: [momentum.summary, p.reason],
      reasons: [
        p.reason,
        `${p.name} boundaries clearly identifiable and breakout confirmed.`,
        'Momentum follow-through present after the breakout.',
      ],
      invalidations: [`Close back beyond ${formatPrice(invalidation, precision)} invalidates the pattern breakout.`],
      scores: {
        structure: 16,
        levelZone: 16,
        entryConfirmation: 24,
        momentum: Math.min(15, 10 + (momentum.displacementCandle ? 3 : 0)),
        multiTimeframe: 0,
        availableSpace: 0,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// MODEL 8 — Momentum BOS
// ---------------------------------------------------------------------------
function model8MomentumBos(ctx: ModelDetectionContext): RawDetection | null {
  const { candles, structure, momentum, atr, precision, timeframe } = ctx;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);

  const bos = [...structure.breaks]
    .reverse()
    .find((b) => b.kind === 'BOS' && lastIdx - b.index <= 3 && b.momentumConfirmed);
  if (!bos) return null;

  const bull = bos.direction === 'bullish';
  const direction: ModelDirection = bull ? 'RISE' : 'FALL';

  const strongDisplacement =
    stats.body >= atr * 1.1 &&
    stats.bodyRatio >= 0.5 &&
    (bull ? stats.closePosition >= 0.65 : stats.closePosition <= 0.35);
  if (!strongDisplacement) return null;

  // Reject late entries: do not chase if price has already run far beyond structure.
  if (momentum.isOverextended) return null;
  if (momentum.nearOpposingStructure) return null;

  const level = bos.brokenLevel;
  const invalidation = bull ? level - atr * 0.4 : level + atr * 0.4;

  return {
    model: 'MODEL_8_MOMENTUM_BOS',
    direction,
    structuralLevelPrice: level,
    retestPrice: null,
    retestTime: null,
    invalidationPrice: invalidation,
    invalidationCondition: `Momentum BOS fails on a close back beyond ${formatPrice(invalidation, precision)}.`,
    confirmationExplanation: `A meaningful swing ${bull ? 'high' : 'low'} was broken by a strong displacement candle closing beyond structure with confirmed directional momentum and sufficient room before opposing levels.`,
    bosChochEvidence: [bos.reason],
    supportResistance: [level],
    momentumEvidence: [
      momentum.summary,
      `Body ${(stats.body / atr).toFixed(2)}x ATR with close conviction ${(stats.closePosition * 100).toFixed(0)}%.`,
    ],
    reasons: [
      bos.reason,
      'Strong displacement candle closed beyond structure.',
      'Available room confirmed before opposing support/resistance; weak/late breakouts rejected.',
    ],
    invalidations: [`Close back beyond ${formatPrice(invalidation, precision)} invalidates the momentum break.`],
    scores: {
      structure: 16,
      levelZone: 16,
      entryConfirmation: 24,
      momentum: Math.min(15, 10 + (stats.body >= atr * 1.4 ? 4 : 1)),
      multiTimeframe: 0,
      availableSpace: 0,
    },
  };
}

export const MODEL_DETECTORS: Record<
  EntryModelId,
  (ctx: ModelDetectionContext) => RawDetection | null
> = {
  MODEL_1_TREND_PULLBACK_CONTINUATION: model1TrendPullback,
  MODEL_2_BREAKOUT_AND_RETEST: model2BreakoutRetest,
  MODEL_3_SUPPORT_RESISTANCE_REJECTION: model3SrRejection,
  MODEL_4_SUPPLY_DEMAND_REACTION: model4SupplyDemand,
  MODEL_5_LIQUIDITY_SWEEP_CHOCH: model5LiquiditySweepChoch,
  MODEL_6_TRENDLINE_BREAK_RETEST: model6TrendlineBreakRetest,
  MODEL_7_CHART_PATTERN_BREAKOUT: model7ChartPattern,
  MODEL_8_MOMENTUM_BOS: model8MomentumBos,
};

/** Runs one model detector and finalises it into a scored candidate. */
export function detectModel(
  ctx: ModelDetectionContext,
  model: EntryModelId
): EntryModelCandidate | null {
  // Every detector indexes the last candle, so an empty series must short-circuit here
  // rather than throw a TypeError deep inside a model.
  if (ctx.candles.length === 0) return null;
  const raw = MODEL_DETECTORS[model](ctx);
  if (!raw) return null;
  const entryPrice = ctx.candles[ctx.candles.length - 1].close;
  return finalize(ctx, raw, entryPrice);
}
