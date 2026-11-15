import type { Candle } from '../types/market';
import type {
  TrendlineKind,
  TrendlineLine,
  TrendlineMarketCondition,
  TrendlineTrend,
} from '../types/trendline';
import { formatPrice } from '../utils/derivParser';
import { computeAtrSeries, detectSwings, getCandleStats, type SwingPoint } from './swings';

/** A trendline is defined on confirmed M15 structure only. */
export const TRENDLINE_LOOKBACK_BARS = 120;
/** Minimum swing points that must anchor a valid trendline. */
export const MIN_TRENDLINE_TOUCHES = 2;
/** Minimum bar span between the two anchor swings. */
const MIN_ANCHOR_SPAN_BARS = 5;
/** Maximum bar span so a stale line is not projected forever. */
const MAX_ANCHOR_SPAN_BARS = 90;
/** A close beyond the line by this many ATR counts as a violation / break. */
const BREAK_BUFFER_ATR = 0.2;
/** A bar within this many ATR of the line counts as a touch. */
const TOUCH_TOLERANCE_ATR = 0.3;
/** |slope| below this (per bar, in ATR units) is treated as horizontal. */
const HORIZONTAL_SLOPE_ATR = 0.03;

export function linePriceAtTime(line: { startTime: number; startPrice: number; slopePerSec: number }, time: number): number {
  return line.startPrice + line.slopePerSec * (time - line.startTime);
}

/** Confirmed (closed) candles only — the forming bar never defines structure. */
export function confirmedOnly(candles: readonly Candle[]): Candle[] {
  return candles.length > 2 ? candles.slice(0, -1) : [...candles];
}

export function trendlineAtr(candles: readonly Candle[], period = 14): number {
  const atrs = computeAtrSeries(candles, period);
  return atrs[atrs.length - 1] || 1e-6;
}

interface Candidate {
  line: TrendlineLine;
}

/**
 * Builds every valid trendline from confirmed swing highs/lows, then keeps the best
 * support line and the best resistance line (plus any recently broken ones).
 *
 * A trendline is VALID when it:
 *  - connects >= 2 confirmed swings of the same type with a sensible span,
 *  - is not decisively violated by any intervening close,
 *  - has at least MIN_TRENDLINE_TOUCHES touches within tolerance.
 */
export function detectTrendlines(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  atr: number,
  precision: number
): TrendlineLine[] {
  const confirmed = confirmedOnly(candles);
  if (confirmed.length < 25 || swings.length < 4 || atr <= 0) return [];

  const latestBar = confirmed[confirmed.length - 1];
  const lows = swings.filter((s) => s.type === 'low');
  const highs = swings.filter((s) => s.type === 'high');

  const supportCandidates = buildCandidates(
    confirmed,
    lows,
    'support',
    atr,
    precision,
    latestBar.time
  );
  const resistanceCandidates = buildCandidates(
    confirmed,
    highs,
    'resistance',
    atr,
    precision,
    latestBar.time
  );

  const chosen: TrendlineLine[] = [];
  const bestSupport = pickBest(supportCandidates);
  const bestResistance = pickBest(resistanceCandidates);
  if (bestSupport) chosen.push(bestSupport);
  if (bestResistance) chosen.push(bestResistance);

  // A broken line is still useful for the breakout models even when a newer line
  // is chosen as the active one, so include the most recent broken line of each kind.
  for (const cands of [supportCandidates, resistanceCandidates]) {
    const broken = cands
      .map((c) => c.line)
      .filter((l) => l.broken)
      .sort((a, b) => (b.breakTime ?? 0) - (a.breakTime ?? 0))[0];
    if (broken && !chosen.some((l) => l.id === broken.id)) chosen.push(broken);
  }

  return chosen;
}

function buildCandidates(
  candles: readonly Candle[],
  points: readonly SwingPoint[],
  kind: TrendlineKind,
  atr: number,
  precision: number,
  latestTime: number
): Candidate[] {
  const out: Candidate[] = [];
  if (points.length < 2) return out;

  // Consider the most recent handful of anchor pairs (bounded for performance).
  const start = Math.max(0, points.length - 6);
  for (let a = start; a < points.length - 1; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const p1 = points[a];
      const p2 = points[b];
      const spanBars = p2.index - p1.index;
      if (spanBars < MIN_ANCHOR_SPAN_BARS || spanBars > MAX_ANCHOR_SPAN_BARS) continue;
      if (p2.time === p1.time) continue;

      const slope = (p2.price - p1.price) / (p2.time - p1.time);
      const perBarSlope = slope * (candles[1]?.time - candles[0]?.time || 1);

      // Directional consistency for support (ascending/horizontal) vs resistance.
      if (kind === 'support' && p2.price < p1.price - atr * 0.2) continue;
      if (kind === 'resistance' && p2.price > p1.price + atr * 0.2) continue;

      const trend: TrendlineTrend =
        Math.abs(perBarSlope) < atr * HORIZONTAL_SLOPE_ATR
          ? 'horizontal'
          : perBarSlope > 0
            ? 'ascending'
            : 'descending';

      let touchCount = 2;
      const touchPoints: { time: number; price: number }[] = [
        { time: p1.time, price: p1.price },
        { time: p2.time, price: p2.price },
      ];
      let violated = false;
      let breakIndex = -1;

      for (let k = p1.index + 1; k < candles.length; k++) {
        const bar = candles[k];
        const lineY = p1.price + slope * (bar.time - p1.time);
        const stats = getCandleStats(bar);

        if (kind === 'support') {
          if (bar.close < lineY - atr * BREAK_BUFFER_ATR) {
            if (k > p2.index) {
              breakIndex = k;
              break;
            }
            violated = true;
            break;
          }
          if (
            k !== p1.index &&
            k !== p2.index &&
            Math.abs(bar.low - lineY) <= atr * TOUCH_TOLERANCE_ATR &&
            bar.close >= lineY - atr * 0.1
          ) {
            touchCount++;
            touchPoints.push({ time: bar.time, price: bar.low });
          }
        } else {
          if (bar.close > lineY + atr * BREAK_BUFFER_ATR) {
            if (k > p2.index) {
              breakIndex = k;
              break;
            }
            violated = true;
            break;
          }
          if (
            k !== p1.index &&
            k !== p2.index &&
            Math.abs(bar.high - lineY) <= atr * TOUCH_TOLERANCE_ATR &&
            bar.close <= lineY + atr * 0.1
          ) {
            touchCount++;
            touchPoints.push({ time: bar.time, price: bar.high });
          }
        }
      }

      if (violated) continue;

      const currentPrice = linePriceAtTime(
        { startTime: p1.time, startPrice: p1.price, slopePerSec: slope },
        latestTime
      );

      const broken = breakIndex >= 0;
      const breakBar = broken ? candles[breakIndex] : null;

      const valid = !broken && touchCount >= MIN_TRENDLINE_TOUCHES;
      const invalidReason = broken
        ? `Broken by a decisive close beyond the line near ${formatPrice(
            linePriceAtTime(
              { startTime: p1.time, startPrice: p1.price, slopePerSec: slope },
              breakBar ? breakBar.time : latestTime
            ),
            precision
          )}.`
        : touchCount < MIN_TRENDLINE_TOUCHES
          ? `Only ${touchCount} touch(es); need ${MIN_TRENDLINE_TOUCHES}.`
          : '';

      const kindLabel = kind === 'support' ? 'support' : 'resistance';
      const reason = broken
        ? `${
            kind === 'support' ? 'BULLISH' : 'BEARISH'
          } TRENDLINE BREAK — Price closed ${
            kind === 'support' ? 'below ascending support' : 'above descending resistance'
          } after ${touchCount} touches.`
        : `${
            trend === 'ascending' ? 'Ascending' : trend === 'descending' ? 'Descending' : 'Horizontal'
          } ${kindLabel} trendline connecting ${touchCount} confirmed swing ${
            kind === 'support' ? 'lows' : 'highs'
          }.`;

      out.push({
        line: {
          id: `tl-${kind}-${p1.time}-${p2.time}`,
          kind,
          trend,
          startTime: p1.time,
          startPrice: p1.price,
          endTime: latestTime,
          endPrice: currentPrice,
          slopePerSec: slope,
          touches: touchCount,
          touchPoints,
          valid,
          invalidReason,
          broken,
          breakDirection: broken ? (kind === 'support' ? 'bearish' : 'bullish') : undefined,
          breakTime: broken && breakBar ? breakBar.time : undefined,
          breakPrice: broken && breakBar ? breakBar.close : undefined,
          currentPrice,
          reason,
        },
      });
    }
  }

  return out;
}

/** Most-touched, then most-recent, then longest line wins for each side. */
function pickBest(candidates: readonly Candidate[]): TrendlineLine | null {
  const valid = candidates.map((c) => c.line).filter((l) => l.valid);
  if (valid.length === 0) return null;
  return valid.sort((a, b) => {
    if (b.touches !== a.touches) return b.touches - a.touches;
    if (b.endTime !== a.endTime) return b.endTime - a.endTime;
    return b.touchPoints.length - a.touchPoints.length;
  })[0];
}

/**
 * Classifies the market condition from confirmed M15 structure and validated
 * trendlines. RANGE_EXTREME is returned when price is in the outer band of a
 * validated sideways range (so the trendline module knows a range boundary is in play).
 */
export function classifyTrendlineCondition(params: {
  candles: readonly Candle[];
  trendlines: readonly TrendlineLine[];
  structureDirection: 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL';
  structureSequence: { hh: boolean; hl: boolean; lh: boolean; ll: boolean };
  overlapRatio: number;
  rangeZone: 'UPPER' | 'MIDDLE' | 'LOWER' | 'ABOVE_RANGE' | 'BELOW_RANGE' | null;
  rangeValid: boolean;
}): { condition: TrendlineMarketCondition; explanation: string } {
  const {
    trendlines,
    structureDirection,
    structureSequence,
    overlapRatio,
    rangeZone,
    rangeValid,
  } = params;

  if (rangeValid && (rangeZone === 'UPPER' || rangeZone === 'LOWER')) {
    return {
      condition: 'RANGE_EXTREME',
      explanation:
        'Price is at a validated M15 sideways-range extreme — trendline rejection at the range boundary is in play.',
    };
  }

  const ascending = trendlines.find((l) => l.valid && l.trend === 'ascending');
  const descending = trendlines.find((l) => l.valid && l.trend === 'descending');
  const strongTrendStructure =
    (structureSequence.hh && structureSequence.hl) || (structureSequence.lh && structureSequence.ll);

  if (structureDirection === 'BULLISH' && (ascending || strongTrendStructure)) {
    return {
      condition: 'UPTREND',
      explanation:
        'Confirmed M15 uptrend (higher highs & higher lows) with ascending trendline support.',
    };
  }
  if (structureDirection === 'BEARISH' && (descending || strongTrendStructure)) {
    return {
      condition: 'DOWNTREND',
      explanation:
        'Confirmed M15 downtrend (lower highs & lower lows) with descending trendline resistance.',
    };
  }

  if (rangeValid) {
    return {
      condition: 'SIDEWAYS',
      explanation:
        'Validated M15 sideways range — trade only the extremes; the middle 50% is a no-trade band.',
    };
  }

  if (trendlines.some((l) => l.valid) || structureDirection === 'RANGING') {
    return {
      condition: 'SIDEWAYS',
      explanation:
        'Range-bound / sideways M15 structure with a valid trendline defining the boundary.',
    };
  }

  if (overlapRatio < 0.3 && structureDirection === 'NEUTRAL') {
    return {
      condition: 'CHOPPY',
      explanation: 'Heavy candle overlap with no valid trendline structure — low-quality condition.',
    };
  }

  return {
    condition: 'CHOPPY',
    explanation: 'No valid trendline structure or directional M15 control — low-quality condition.',
  };
}
