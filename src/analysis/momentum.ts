import type {
  MomentumAssessment,
  SupportResistanceLevel,
  SupplyDemandZone,
} from '../types/analysis';
import type { Candle } from '../types/market';
import { getCandleStats, getRecentAverageBody } from './swings';

export interface MomentumInput {
  candles: readonly Candle[];
  atr: number;
  breakoutLevel?: number | null;
  candidateDirection?: 'RISE' | 'FALL' | null;
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
}

export function assessMomentum({
  candles,
  atr,
  breakoutLevel,
  candidateDirection,
  supportResistance,
  supplyDemand,
}: MomentumInput): MomentumAssessment {
  if (candles.length < 15 || atr <= 0) {
    return {
      state: 'NEUTRAL',
      bodyRatio: 0,
      closeConviction: 0.5,
      consecutiveDirectional: 0,
      breakoutAtrDistance: 0,
      isOverextended: false,
      nearOpposingStructure: false,
      directionalEfficiency: 0,
      displacementCandle: false,
      isExhausted: false,
      pullbackQuality: 'CLEAN',
      summary: 'Insufficient candle history to confirm momentum.',
    };
  }

  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const stats = getCandleStats(last);
  const avgBody = getRecentAverageBody(candles, lastIdx, 14);
  const bodyRatio = Number((stats.body / avgBody).toFixed(2));

  // Count consecutive directional closes ending on the latest confirmed candle
  let consecutiveDirectional = 0;
  if (stats.isBullish) {
    for (let i = lastIdx; i >= Math.max(0, lastIdx - 6); i--) {
      if (candles[i].close > candles[i].open) consecutiveDirectional++;
      else break;
    }
  } else if (stats.isBearish) {
    for (let i = lastIdx; i >= Math.max(0, lastIdx - 6); i--) {
      if (candles[i].close < candles[i].open) consecutiveDirectional++;
      else break;
    }
  }

  // Directional Efficiency (net move / sum of ranges over last 10 bars)
  const windowCount = Math.min(10, candles.length);
  const windowStartIdx = lastIdx - windowCount + 1;
  const netMove = Math.abs(last.close - candles[windowStartIdx].open);
  let totalRange = 0;
  for (let i = windowStartIdx; i <= lastIdx; i++) {
    totalRange += Math.max(1e-9, candles[i].high - candles[i].low);
  }
  const directionalEfficiency = Number((netMove / (totalRange || 1)).toFixed(2));

  // Displacement Candle (large body >= 1.35x ATR with strong conviction)
  const displacementCandle = stats.body >= atr * 1.35 && stats.bodyRatio >= 0.58;

  // Distance travelled from breakout level (or recent 8-bar impulse start)
  const impulseLookback = candles.slice(Math.max(0, lastIdx - 7), lastIdx + 1);
  const impulseRange =
    Math.max(...impulseLookback.map((c) => c.high)) -
    Math.min(...impulseLookback.map((c) => c.low));
  const breakoutAtrDistance =
    breakoutLevel !== null && breakoutLevel !== undefined
      ? Number((Math.abs(last.close - breakoutLevel) / atr).toFixed(2))
      : Number((impulseRange / atr).toFixed(2));

  // Reject late / overextended entries (already moved > 2.1 ATR beyond breakout or 3.8 ATR impulse)
  const isOverextended =
    (breakoutLevel !== null &&
      breakoutLevel !== undefined &&
      breakoutAtrDistance > 2.1) ||
    (stats.body > avgBody * 3.4 && impulseRange > atr * 3.8);

  // Check Momentum Exhaustion (4+ consecutive bars followed by a tiny body and large opposing wick)
  const isExhausted =
    consecutiveDirectional >= 4 &&
    (stats.body < avgBody * 0.65 ||
      (stats.isBullish && stats.upperWick >= stats.body * 1.2) ||
      (stats.isBearish && stats.lowerWick >= stats.body * 1.2));

  // Check Pullback Quality (Did counter-trend bars remain controlled vs aggressive opposing spikes?)
  let pullbackQuality: 'CLEAN' | 'CHOPPY' | 'AGGRESSIVE_COUNTER' = 'CLEAN';
  const pullbackLookback = candles.slice(Math.max(0, lastIdx - 4), lastIdx);
  const counterBars = pullbackLookback.filter((c) =>
    candidateDirection === 'RISE'
      ? c.close < c.open
      : candidateDirection === 'FALL'
        ? c.close > c.open
        : true
  );
  const maxCounterBarRange =
    counterBars.length > 0 ? Math.max(...counterBars.map((c) => c.high - c.low)) : 0;
  if (maxCounterBarRange > atr * 1.9) {
    pullbackQuality = 'AGGRESSIVE_COUNTER';
  } else if (directionalEfficiency < 0.25) {
    pullbackQuality = 'CHOPPY';
  } else {
    pullbackQuality = 'CLEAN';
  }

  // Proximity to opposing structure
  let nearOpposingStructure = false;
  const directionToCheck =
    candidateDirection ?? (stats.isBullish ? 'RISE' : stats.isBearish ? 'FALL' : null);

  if (directionToCheck === 'RISE') {
    const blockingResistance = supportResistance.some(
      (lvl) =>
        lvl.status === 'active' &&
        lvl.type === 'resistance' &&
        lvl.price > last.close &&
        lvl.price - last.close <= atr * 0.65
    );
    const blockingSupply = supplyDemand.some(
      (z) =>
        z.type === 'supply' &&
        z.status !== 'invalidated' &&
        z.lowerPrice > last.close - atr * 0.15 &&
        z.lowerPrice - last.close <= atr * 0.65
    );
    nearOpposingStructure = blockingResistance || blockingSupply;
  } else if (directionToCheck === 'FALL') {
    const blockingSupport = supportResistance.some(
      (lvl) =>
        lvl.status === 'active' &&
        lvl.type === 'support' &&
        lvl.price < last.close &&
        last.close - lvl.price <= atr * 0.65
    );
    const blockingDemand = supplyDemand.some(
      (z) =>
        z.type === 'demand' &&
        z.status !== 'invalidated' &&
        z.upperPrice < last.close + atr * 0.15 &&
        last.close - z.upperPrice <= atr * 0.65
    );
    nearOpposingStructure = blockingSupport || blockingDemand;
  }

  const strongBullish =
    stats.isBullish &&
    bodyRatio >= 1.05 &&
    stats.closePosition >= 0.65 &&
    (consecutiveDirectional >= 2 || bodyRatio >= 1.2);

  const strongBearish =
    stats.isBearish &&
    bodyRatio >= 1.05 &&
    stats.closePosition <= 0.35 &&
    (consecutiveDirectional >= 2 || bodyRatio >= 1.2);

  let state: MomentumAssessment['state'] = 'NEUTRAL';
  let summary = 'Neutral candle momentum; awaiting decisive directional expansion.';

  if (isOverextended) {
    state = 'OVEREXTENDED';
    summary = `Price is overextended (${breakoutAtrDistance}x ATR move); avoiding late entry.`;
  } else if (isExhausted) {
    state = 'WEAK';
    summary = `Momentum exhaustion detected after ${consecutiveDirectional} bars; pullback required.`;
  } else if (strongBullish) {
    state = 'STRONG_BULLISH';
    summary = nearOpposingStructure
      ? `Bullish expansion (${bodyRatio}x avg body), but approaching opposing resistance/supply.`
      : `Strong bullish momentum (${bodyRatio}x avg body, ${consecutiveDirectional} consecutive bullish bar${
          consecutiveDirectional > 1 ? 's' : ''
        }, efficiency ${directionalEfficiency}).`;
  } else if (strongBearish) {
    state = 'STRONG_BEARISH';
    summary = nearOpposingStructure
      ? `Bearish expansion (${bodyRatio}x avg body), but approaching opposing support/demand.`
      : `Strong bearish momentum (${bodyRatio}x avg body, ${consecutiveDirectional} consecutive bearish bar${
          consecutiveDirectional > 1 ? 's' : ''
        }, efficiency ${directionalEfficiency}).`;
  } else if (bodyRatio < 0.75) {
    state = 'WEAK';
    summary = `Weak candle momentum (${bodyRatio}x avg body); insufficient conviction for entry.`;
  }

  return {
    state,
    bodyRatio,
    closeConviction: Number(stats.closePosition.toFixed(2)),
    consecutiveDirectional,
    breakoutAtrDistance,
    isOverextended,
    nearOpposingStructure,
    directionalEfficiency,
    displacementCandle,
    isExhausted,
    pullbackQuality,
    summary,
  };
}
