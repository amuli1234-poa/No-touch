import type { Candle } from '../types/market';

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'high' | 'low';
}

export interface CandleStats {
  range: number;
  body: number;
  upperWick: number;
  lowerWick: number;
  isBullish: boolean;
  isBearish: boolean;
  bodyRatio: number; // body / range
  closePosition: number; // 0 = low, 1 = high
}

export function getCandleStats(candle: Candle): CandleStats {
  const range = Math.max(1e-9, candle.high - candle.low);
  const body = Math.abs(candle.close - candle.open);
  const top = Math.max(candle.open, candle.close);
  const bottom = Math.min(candle.open, candle.close);
  const upperWick = Math.max(0, candle.high - top);
  const lowerWick = Math.max(0, bottom - candle.low);
  const isBullish = candle.close > candle.open;
  const isBearish = candle.close < candle.open;

  return {
    range,
    body,
    upperWick,
    lowerWick,
    isBullish,
    isBearish,
    bodyRatio: body / range,
    closePosition: (candle.close - candle.low) / range,
  };
}

export function computeAtrSeries(candles: readonly Candle[], period = 14): number[] {
  if (candles.length === 0) return [];
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      trs.push(c.high - c.low);
    } else {
      const prevClose = candles[i - 1].close;
      trs.push(
        Math.max(
          c.high - c.low,
          Math.abs(c.high - prevClose),
          Math.abs(c.low - prevClose)
        )
      );
    }
  }

  const atrs: number[] = [];
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) {
      sum += trs[i];
      atrs.push(sum / (i + 1));
    } else {
      const prevAtr = atrs[i - 1];
      atrs.push((prevAtr * (period - 1) + trs[i]) / period);
    }
  }
  return atrs;
}

export function getRecentAverageBody(
  candles: readonly Candle[],
  endIndex: number,
  lookback = 14
): number {
  const start = Math.max(0, endIndex - lookback);
  let sum = 0;
  let count = 0;
  for (let i = start; i < endIndex; i++) {
    sum += Math.abs(candles[i].close - candles[i].open);
    count++;
  }
  if (count === 0) {
    return Math.abs(candles[endIndex]?.close - candles[endIndex]?.open) || 1e-6;
  }
  return Math.max(1e-9, sum / count);
}

export function detectSwings(
  candles: readonly Candle[],
  leftBars = 3,
  rightBars = 3
): SwingPoint[] {
  const swings: SwingPoint[] = [];
  if (candles.length < leftBars + rightBars + 1) {
    return swings;
  }

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const c = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (j < i) {
        if (candles[j].high > c.high) isSwingHigh = false;
        if (candles[j].low < c.low) isSwingLow = false;
      } else {
        if (candles[j].high >= c.high) isSwingHigh = false;
        if (candles[j].low <= c.low) isSwingLow = false;
      }
      if (!isSwingHigh && !isSwingLow) break;
    }

    if (isSwingHigh) {
      swings.push({
        index: i,
        time: c.time,
        price: c.high,
        type: 'high',
      });
    }
    if (isSwingLow) {
      swings.push({
        index: i,
        time: c.time,
        price: c.low,
        type: 'low',
      });
    }
  }

  return swings.sort((a, b) => a.index - b.index);
}
