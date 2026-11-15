import type { Candle } from '../types/market';
import type { RangeAnalysis, RangeZone } from '../types/engine';
import { computeAtrSeries, detectSwings, getCandleStats } from './swings';

/**
 * Sideways-market range configuration ("range extremes only").
 *
 * A range is defined on CONFIRMED M15 candles from real swing highs/lows:
 *  - resistance = range high, support = range low, equilibrium = midpoint.
 *  - the upper 25% is the resistance (FALL) trading area.
 *  - the lower 25% is the support (RISE) trading area.
 *  - the middle 50% is a hard NO-TRADE band.
 * Only a valid range (enough confirmed touches on both boundaries, sensible height,
 * price still contained) may produce a range-extreme signal. Breakouts invalidate the
 * range and are handled by the breakout-and-retest entry model instead.
 */

/** How many recent confirmed M15 bars define the candidate range window. */
export const RANGE_LOOKBACK_BARS = 60;
/** Minimum confirmed swing touches required on each boundary for a valid range. */
export const MIN_BOUNDARY_TOUCHES = 2;
/** Fraction of the range taken by each extreme trading area (upper / lower 25%). */
export const EXTREME_FRACTION = 0.25;
/** Tolerance (ATR multiples) for a swing to count as a touch of a boundary. */
const TOUCH_TOLERANCE_ATR = 0.6;
/** Minimum range height (ATR multiples) for the range to be tradeable. */
const MIN_HEIGHT_ATR = 2.5;
/** Maximum range height (ATR multiples) — beyond this it is a trend, not a range. */
const MAX_HEIGHT_ATR = 12;
/** A close beyond a boundary by this many ATR invalidates (breaks) the range. */
const BREAKOUT_BUFFER_ATR = 0.5;

/** Which band of the range a price sits in. Extremes trade; the middle never does. */
export function classifyRangeZone(price: number, range: RangeAnalysis): RangeZone {
  if (price > range.resistance) return 'ABOVE_RANGE';
  if (price < range.support) return 'BELOW_RANGE';
  if (price >= range.tradingArea.lower) return 'UPPER';
  if (price <= range.noTradeBand.lower) return 'LOWER';
  return 'MIDDLE';
}

/**
 * Builds the sideways range from confirmed M15 candles. Returns null when there is not
 * enough structure to even form a candidate range. `valid` is false when the candidate
 * exists but fails the quality/containment checks (reason explains why).
 */
export function detectRangeAnalysis(
  candles: readonly Candle[],
  price: number
): RangeAnalysis | null {
  if (candles.length < 30) return null;

  // Only confirmed (closed) M15 candles may define the range.
  const confirmed = candles.length > 2 ? candles.slice(0, -1) : candles;
  const window = confirmed.slice(-RANGE_LOOKBACK_BARS);
  if (window.length < 20) return null;

  const atrs = computeAtrSeries(window, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const swings = detectSwings(window, 3, 3);
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');
  if (highs.length < 2 || lows.length < 2) return null;

  const resistance = Math.max(...highs.map((s) => s.price));
  const support = Math.min(...lows.map((s) => s.price));
  const height = resistance - support;
  if (height <= 0) return null;

  const tol = Math.max(atr * TOUCH_TOLERANCE_ATR, height * 0.06);
  const resistanceTouches = highs.filter((s) => resistance - s.price <= tol).length;
  const supportTouches = lows.filter((s) => s.price - support <= tol).length;

  const equilibrium = support + height / 2;
  const upperStart = resistance - height * EXTREME_FRACTION; // lower edge of the upper 25%
  const lowerEnd = support + height * EXTREME_FRACTION; // upper edge of the lower 25%

  const base: RangeAnalysis = {
    resistance,
    support,
    equilibrium,
    height,
    resistanceTouches,
    supportTouches,
    asOfTime: window[window.length - 1].time,
    valid: false,
    reason: '',
    zone: 'MIDDLE',
    tradingArea: { lower: upperStart, upper: resistance },
    noTradeBand: { lower: lowerEnd, upper: upperStart },
  };

  const heightAtr = height / atr;
  if (heightAtr < MIN_HEIGHT_ATR) {
    return {
      ...base,
      reason: `Range too narrow (${heightAtr.toFixed(1)}x ATR) — insufficient structure for range-extreme entries.`,
    };
  }
  if (heightAtr > MAX_HEIGHT_ATR) {
    return {
      ...base,
      reason: `Range too wide (${heightAtr.toFixed(1)}x ATR) — price is trending, not ranging.`,
    };
  }
  if (resistanceTouches < MIN_BOUNDARY_TOUCHES || supportTouches < MIN_BOUNDARY_TOUCHES) {
    return {
      ...base,
      reason: `Range boundaries not confirmed enough (resistance ${resistanceTouches}, support ${supportTouches} touches; need ${MIN_BOUNDARY_TOUCHES} each).`,
    };
  }

  const buffer = atr * BREAKOUT_BUFFER_ATR;
  if (price > resistance + buffer) {
    return {
      ...base,
      zone: 'ABOVE_RANGE',
      reason: 'Range invalidated — price broke above resistance (handled by breakout & retest).',
    };
  }
  if (price < support - buffer) {
    return {
      ...base,
      zone: 'BELOW_RANGE',
      reason: 'Range invalidated — price broke below support (handled by breakout & retest).',
    };
  }

  const valid: RangeAnalysis = { ...base, valid: true, reason: '' };
  return { ...valid, zone: classifyRangeZone(price, valid) };
}

export interface BoundaryRejection {
  confirmed: boolean;
  reason: string;
}

/**
 * Confirms a boundary rejection on the entry timeframe (M5). RISE requires a bullish
 * rejection at the range low; FALL requires a bearish rejection at the range high.
 * Uses only confirmed (closed) entry-timeframe candles.
 */
export function detectBoundaryRejection(params: {
  candles: readonly Candle[];
  boundary: number;
  direction: 'RISE' | 'FALL';
  atr: number;
  toleranceAtr?: number;
}): BoundaryRejection {
  const { candles, boundary, direction, atr } = params;
  if (candles.length < 3) {
    return { confirmed: false, reason: 'Insufficient M5 candles to confirm a boundary rejection.' };
  }
  const confirmed = candles.length > 2 ? candles.slice(0, -1) : candles;
  const last = confirmed[confirmed.length - 1];
  const stats = getCandleStats(last);
  const tol = Math.max(atr * (params.toleranceAtr ?? 0.6), 1e-6);

  if (direction === 'RISE') {
    const touched = last.low <= boundary + tol;
    const reclaimed = last.close > boundary && stats.isBullish;
    const wick = stats.lowerWick >= stats.body * 0.4 || stats.closePosition >= 0.6;
    if (touched && reclaimed && wick) {
      return {
        confirmed: true,
        reason: 'Confirmed M5 bullish rejection at range support (wick below, bullish close back above).',
      };
    }
    return { confirmed: false, reason: 'No confirmed M5 bullish rejection at range support yet.' };
  }

  const touched = last.high >= boundary - tol;
  const reclaimed = last.close < boundary && stats.isBearish;
  const wick = stats.upperWick >= stats.body * 0.4 || stats.closePosition <= 0.4;
  if (touched && reclaimed && wick) {
    return {
      confirmed: true,
      reason: 'Confirmed M5 bearish rejection at range resistance (wick above, bearish close back below).',
    };
  }
  return { confirmed: false, reason: 'No confirmed M5 bearish rejection at range resistance yet.' };
}
