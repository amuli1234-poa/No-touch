import type { IndicatorSnapshot } from '../types/engine';
import type { Candle } from '../types/market';

export function ema(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI over `period` closes. */
export function computeRsiSeries(closes: readonly number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD (12/26/9) line, signal and histogram. */
export function computeMacdSeries(
  closes: readonly number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macd: (number | null)[] = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? (emaFast[i] as number) - (emaSlow[i] as number) : null
  );
  const validMacd = macd.filter((v): v is number => v !== null);
  const signalValid = ema(validMacd, signalPeriod);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  let vi = 0;
  for (let i = 0; i < macd.length; i++) {
    if (macd[i] !== null) {
      signal[i] = signalValid[vi] ?? null;
      vi++;
    }
  }
  const histogram: (number | null)[] = closes.map((_, i) =>
    macd[i] !== null && signal[i] !== null ? (macd[i] as number) - (signal[i] as number) : null
  );
  return { macd, signal, histogram };
}

/** Wilder's ADX over `period` — trend strength (direction-agnostic). */
export function computeAdxSeries(candles: readonly Candle[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n <= period * 2) return out;

  const tr: number[] = new Array(n).fill(0);
  const plusDm: number[] = new Array(n).fill(0);
  const minusDm: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }

  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += tr[i];
    plusSum += plusDm[i];
    minusSum += minusDm[i];
  }

  const dx: number[] = [];
  const dxIndex: number[] = [];
  for (let i = period + 1; i < n; i++) {
    trSum = trSum - trSum / period + tr[i];
    plusSum = plusSum - plusSum / period + plusDm[i];
    minusSum = minusSum - minusSum / period + minusDm[i];
    const plusDi = trSum > 0 ? (100 * plusSum) / trSum : 0;
    const minusDi = trSum > 0 ? (100 * minusSum) / trSum : 0;
    const sum = plusDi + minusDi;
    dx.push(sum > 0 ? (100 * Math.abs(plusDi - minusDi)) / sum : 0);
    dxIndex.push(i);
  }

  if (dx.length < period) return out;
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dx[i];
  adx /= period;
  out[dxIndex[period - 1]] = adx;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
    out[dxIndex[i]] = adx;
  }
  return out;
}

/**
 * Builds the optional indicator snapshot. Indicators are used ONLY to confirm
 * price-action evidence — a disagreement downgrades confidence, never creates a signal.
 */
export function buildIndicatorSnapshot(candles: readonly Candle[]): IndicatorSnapshot {
  const empty: IndicatorSnapshot = {
    ema20: null,
    ema50: null,
    rsi14: null,
    macdLine: null,
    macdSignal: null,
    macdHistogram: null,
    adx14: null,
    trendConfirm: 'NEUTRAL',
    momentumConfirm: 'NEUTRAL',
    strengthConfirm: false,
    notes: [],
  };
  if (candles.length < 35) {
    return { ...empty, notes: ['Insufficient history for optional indicators.'] };
  }

  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi = computeRsiSeries(closes, 14);
  const macd = computeMacdSeries(closes);
  const adx = computeAdxSeries(candles, 14);

  const ema20v = ema20[last];
  const ema50v = ema50[last];
  const rsiV = rsi[last];
  const macdLine = macd.macd[last];
  const macdSignal = macd.signal[last];
  const macdHist = macd.histogram[last];
  const adxV = adx[last];

  const notes: string[] = [];
  let trendConfirm: IndicatorSnapshot['trendConfirm'] = 'NEUTRAL';
  if (ema20v !== null && ema50v !== null) {
    if (ema20v > ema50v && closes[last] > ema50v) {
      trendConfirm = 'BULLISH';
      notes.push('EMA20 > EMA50 with price above EMA50 confirms bullish trend.');
    } else if (ema20v < ema50v && closes[last] < ema50v) {
      trendConfirm = 'BEARISH';
      notes.push('EMA20 < EMA50 with price below EMA50 confirms bearish trend.');
    } else {
      notes.push('EMA20/EMA50 not aligned with price — no trend confirmation.');
    }
  }

  let momentumConfirm: IndicatorSnapshot['momentumConfirm'] = 'NEUTRAL';
  if (rsiV !== null && macdHist !== null) {
    if (rsiV >= 52 && macdHist > 0) {
      momentumConfirm = 'BULLISH';
      notes.push(`RSI ${rsiV.toFixed(1)} + positive MACD histogram confirm bullish momentum.`);
    } else if (rsiV <= 48 && macdHist < 0) {
      momentumConfirm = 'BEARISH';
      notes.push(`RSI ${rsiV.toFixed(1)} + negative MACD histogram confirm bearish momentum.`);
    } else {
      notes.push('RSI/MACD mixed — no momentum confirmation.');
    }
  }

  const strengthConfirm = adxV !== null && adxV >= 20;
  if (adxV !== null) {
    notes.push(
      strengthConfirm
        ? `ADX ${adxV.toFixed(1)} confirms a trending (non-choppy) regime.`
        : `ADX ${adxV.toFixed(1)} indicates weak/no trend.`
    );
  }

  return {
    ema20: ema20v ?? null,
    ema50: ema50v ?? null,
    rsi14: rsiV ?? null,
    macdLine: macdLine ?? null,
    macdSignal: macdSignal ?? null,
    macdHistogram: macdHist ?? null,
    adx14: adxV ?? null,
    trendConfirm,
    momentumConfirm,
    strengthConfirm,
    notes,
  };
}
