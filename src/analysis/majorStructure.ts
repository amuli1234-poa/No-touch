import type { Candle } from '../types/market';
import type { MajorSwing, MajorTrendline, MajorZone } from '../types/intelligence';
import { formatPrice } from '../utils/derivParser';
import { computeAtrSeries, detectSwings, getCandleStats } from './swings';

/**
 * Major-structure detection. This replaces "every local high/low" swing detection with
 * a significance filter: a pivot only becomes a MAJOR swing when it shows real price
 * displacement, rejection strength and structural dominance over its neighbourhood.
 * Major trendlines and major support/resistance ZONES are then built from those swings
 * only — so the chart shows meaningful structure, never minor noise.
 */

/** Minimum bars either side for a pivot to even be considered a candidate. */
const PIVOT_LEFT = 3;
const PIVOT_RIGHT = 3;
/** A major swing must displace at least this many ATR away from the pivot. */
const MIN_DISPLACEMENT_ATR = 0.8;
/** Composite significance below this is a minor swing and is discarded. */
const MIN_SIGNIFICANCE = 0.45;

function atrAt(atrs: readonly number[], index: number): number {
  const a = atrs[Math.min(index, atrs.length - 1)];
  return a && a > 0 ? a : 1e-6;
}

/**
 * Favourable displacement: the largest opposite-direction move within `window` bars
 * after the pivot, measured from the pivot extreme toward the intended reaction.
 */
function favourableDisplacement(
  candles: readonly Candle[],
  index: number,
  type: 'high' | 'low',
  window: number
): number {
  const pivot = candles[index];
  let best = 0;
  const end = Math.min(candles.length - 1, index + window);
  for (let i = index + 1; i <= end; i++) {
    const bar = candles[i];
    const move = type === 'high' ? pivot.high - bar.low : bar.high - pivot.low;
    if (move > best) best = move;
  }
  return best;
}

/** Wick rejection quality: how much of the pivot bar's range was a rejecting wick. */
function rejectionScore(candle: Candle, type: 'high' | 'low'): number {
  const stats = getCandleStats(candle);
  const wick = type === 'high' ? stats.upperWick : stats.lowerWick;
  const wickRatio = wick / stats.range;
  // A pivot that closes back against the extreme (lower close on a high) rejects harder.
  const closeBack = type === 'high' ? 1 - stats.closePosition : stats.closePosition;
  return Math.max(0, Math.min(1, wickRatio * 0.6 + closeBack * 0.4));
}

/**
 * Structural importance: how dominant the pivot is over a wide window either side.
 * 1.0 means no nearby bar exceeds the pivot extreme; lower means several do.
 */
function structuralImportance(
  candles: readonly Candle[],
  index: number,
  type: 'high' | 'low',
  atr: number
): number {
  const pivot = candles[index];
  const left = Math.max(0, index - 25);
  const right = Math.min(candles.length - 1, index + 25);
  let exceeded = 0;
  for (let i = left; i <= right; i++) {
    if (i === index) continue;
    const bar = candles[i];
    const beyond = type === 'high' ? bar.high - pivot.high : pivot.low - bar.low;
    if (beyond > atr * 0.1) exceeded++;
  }
  return Math.max(0, Math.min(1, 1 - exceeded / 6));
}

/**
 * Detects MAJOR swing highs/lows only. Minor internal fluctuations are discarded by a
 * composite significance filter over displacement, rejection and structural dominance.
 */
export function detectMajorSwings(
  candles: readonly Candle[],
  atrs: readonly number[],
  atr: number
): MajorSwing[] {
  if (candles.length < PIVOT_LEFT + PIVOT_RIGHT + 5) return [];

  const candidates = detectSwings(candles, PIVOT_LEFT, PIVOT_RIGHT);
  const majors: MajorSwing[] = [];

  for (const s of candidates) {
    const a = atrAt(atrs, s.index);
    const displacementAtr = favourableDisplacement(candles, s.index, s.type, 10) / a;
    if (displacementAtr < MIN_DISPLACEMENT_ATR) continue;

    const rejection = rejectionScore(candles[s.index], s.type);
    const importance = structuralImportance(candles, s.index, s.type, atr);

    // Displacement dominates, then rejection, then structural dominance.
    const displacementScore = Math.min(1, displacementAtr / 2.2);
    const strength =
      displacementScore * 0.5 + rejection * 0.3 + importance * 0.2;
    if (strength < MIN_SIGNIFICANCE) continue;

    majors.push({
      index: s.index,
      time: s.time,
      price: s.type === 'high' ? candles[s.index].high : candles[s.index].low,
      type: s.type,
      strength: Number(strength.toFixed(3)),
      displacementAtr: Number(displacementAtr.toFixed(2)),
      rejectionScore: Number(rejection.toFixed(3)),
      structuralImportance: Number(importance.toFixed(3)),
      tier: strength >= 0.68 ? 'strong' : 'weak',
      reason: `Major swing ${s.type} at ${formatPrice(
        s.type === 'high' ? candles[s.index].high : candles[s.index].low,
        2
      )} — ${displacementAtr.toFixed(1)}× ATR displacement, ${(rejection * 100).toFixed(
        0
      )}% rejection.`,
    });
  }

  labelMajorSwings(majors);
  return majors;
}

/** Labels major highs HH/LH and major lows HL/LL in sequence. */
function labelMajorSwings(majors: MajorSwing[]): void {
  const highs = majors.filter((m) => m.type === 'high');
  const lows = majors.filter((m) => m.type === 'low');
  for (let i = 1; i < highs.length; i++) {
    highs[i].label = highs[i].price > highs[i - 1].price ? 'HH' : 'LH';
  }
  for (let i = 1; i < lows.length; i++) {
    lows[i].label = lows[i].price > lows[i - 1].price ? 'HL' : 'LL';
  }
}

// ---------------------------------------------------------------------------
// Major trendlines
// ---------------------------------------------------------------------------

const MIN_ANCHOR_SPAN_BARS = 6;
const MAX_ANCHOR_SPAN_BARS = 120;
const BREAK_BUFFER_ATR = 0.35;
const TOUCH_TOLERANCE_ATR = 0.35;

function linePriceAt(startTime: number, startPrice: number, slope: number, time: number): number {
  return startPrice + slope * (time - startTime);
}

/**
 * Builds trendlines anchored ONLY on major swings. Bullish lines connect major higher
 * lows; bearish lines connect major lower highs. A third independent reaction upgrades
 * the line's validity. Broken lines are omitted (auto-invalidated).
 */
export function detectMajorTrendlines(
  candles: readonly Candle[],
  majors: readonly MajorSwing[],
  atr: number,
  precision: number
): MajorTrendline[] {
  if (candles.length < 25 || atr <= 0) return [];

  const latest = candles[candles.length - 1];
  const lows = majors.filter((m) => m.type === 'low');
  const highs = majors.filter((m) => m.type === 'high');

  const out: MajorTrendline[] = [];
  const bull = bestLine(candles, lows, 'bullish', atr, precision, latest.time);
  const bear = bestLine(candles, highs, 'bearish', atr, precision, latest.time);
  if (bull) out.push(bull);
  if (bear) out.push(bear);
  return out;
}

function bestLine(
  candles: readonly Candle[],
  points: readonly MajorSwing[],
  direction: 'bullish' | 'bearish',
  atr: number,
  precision: number,
  latestTime: number
): MajorTrendline | null {
  if (points.length < 2) return null;

  let best: MajorTrendline | null = null;
  let bestScore = -Infinity;

  for (let a = 0; a < points.length - 1; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const p1 = points[a];
      const p2 = points[b];
      const spanBars = p2.index - p1.index;
      if (spanBars < MIN_ANCHOR_SPAN_BARS || spanBars > MAX_ANCHOR_SPAN_BARS) continue;
      if (p2.time === p1.time) continue;

      // Bullish lines require higher lows; bearish lines require lower highs.
      if (direction === 'bullish' && p2.price <= p1.price) continue;
      if (direction === 'bearish' && p2.price >= p1.price) continue;

      const slope = (p2.price - p1.price) / (p2.time - p1.time);

      let touches = 2;
      let broken = false;
      let breakIndex = -1;

      for (let k = p1.index + 1; k < candles.length; k++) {
        const bar = candles[k];
        const y = linePriceAt(p1.time, p1.price, slope, bar.time);
        if (direction === 'bullish') {
          if (bar.close < y - atr * BREAK_BUFFER_ATR) {
            if (k > p2.index) breakIndex = k;
            broken = true;
            break;
          }
          if (k !== p1.index && k !== p2.index && Math.abs(bar.low - y) <= atr * TOUCH_TOLERANCE_ATR) {
            touches++;
          }
        } else {
          if (bar.close > y + atr * BREAK_BUFFER_ATR) {
            if (k > p2.index) breakIndex = k;
            broken = true;
            break;
          }
          if (
            k !== p1.index &&
            k !== p2.index &&
            Math.abs(bar.high - y) <= atr * TOUCH_TOLERANCE_ATR
          ) {
            touches++;
          }
        }
      }

      // Auto-invalidate broken or outdated lines.
      if (broken) continue;

      const thirdTouch = touches >= 3;
      const currentPrice = linePriceAt(p1.time, p1.price, slope, latestTime);
      const score = touches * 2 + (thirdTouch ? 3 : 0) + spanBars / 20;
      if (score <= bestScore) continue;

      bestScore = score;
      best = {
        id: `mtl-${direction}-${p1.time}-${p2.time}`,
        direction,
        startTime: p1.time,
        startPrice: p1.price,
        endTime: latestTime,
        endPrice: currentPrice,
        slopePerSec: slope,
        anchors: [
          { time: p1.time, price: p1.price },
          { time: p2.time, price: p2.price },
        ],
        touches,
        thirdTouchConfirmed: thirdTouch,
        valid: true,
        broken: false,
        currentPrice,
        reason: `${
          direction === 'bullish' ? 'Ascending support' : 'Descending resistance'
        } trendline on major swings — ${touches} reactions${
          thirdTouch ? ' (third touch confirms)' : ''
        }, projected to ${formatPrice(currentPrice, precision)}.`,
      };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Major support / resistance ZONES
// ---------------------------------------------------------------------------

/** Cluster tolerance: swings within this many ATR form one zone. */
const ZONE_CLUSTER_ATR = 0.6;
/** Maximum zone height (ATR) — avoids excessively wide bands. */
const MAX_ZONE_HEIGHT_ATR = 1.4;
/** Minimum zone height (ATR) so the rectangle covers the real reaction area. */
const MIN_ZONE_HEIGHT_ATR = 0.2;
const MAX_ZONES = 6;

/**
 * Builds major support/resistance ZONES as rectangles around clusters of major swings.
 * A single major reaction followed by strong displacement qualifies as an originating
 * zone. Zones are de-duplicated, non-overlapping and never excessively wide.
 */
export function detectMajorZones(
  candles: readonly Candle[],
  majors: readonly MajorSwing[],
  atr: number,
  precision: number
): MajorZone[] {
  if (candles.length < 25 || majors.length < 1 || atr <= 0) return [];

  const latestClose = candles[candles.length - 1].close;
  const tol = Math.max(atr * ZONE_CLUSTER_ATR, 1e-6);

  interface Cluster {
    swings: MajorSwing[];
    center: number;
  }
  const clusters: Cluster[] = [];

  for (const m of majors) {
    let target: Cluster | null = null;
    let bestDist = Infinity;
    for (const c of clusters) {
      const d = Math.abs(m.price - c.center);
      if (d <= tol && d < bestDist) {
        bestDist = d;
        target = c;
      }
    }
    if (target) {
      target.swings.push(m);
      target.center =
        target.swings.reduce((sum, s) => sum + s.price, 0) / target.swings.length;
    } else {
      clusters.push({ swings: [m], center: m.price });
    }
  }

  const zones: MajorZone[] = [];

  for (const c of clusters) {
    // A zone needs either multiple major reactions, OR a single STRONG major swing
    // backed by meaningful displacement (an originating zone).
    const totalReactions = c.swings.length;
    const hasStrongOrigin = c.swings.some(
      (s) => s.tier === 'strong' && s.displacementAtr >= MIN_DISPLACEMENT_ATR
    );
    if (totalReactions < 2 && !hasStrongOrigin) continue;

    const prices = c.swings.map((s) => s.price);
    const center = prices.reduce((a, b) => a + b, 0) / prices.length;
    const maxDisp = Math.max(...c.swings.map((s) => s.displacementAtr));

    // Zone height covers the reaction area but stays bounded.
    const spread = Math.max(...prices) - Math.min(...prices);
    const height = Math.min(
      Math.max(spread, atr * MIN_ZONE_HEIGHT_ATR),
      atr * MAX_ZONE_HEIGHT_ATR
    );
    const upperPrice = center + height / 2;
    const lowerPrice = center - height / 2;

    // Type follows where the reactions came from: high clusters reject (resistance),
    // low clusters support. A mixed cluster leans on the latest swing type.
    const highCount = c.swings.filter((s) => s.type === 'high').length;
    const lowCount = c.swings.filter((s) => s.type === 'low').length;
    const type: 'support' | 'resistance' = highCount > lowCount ? 'resistance' : 'support';

    const origin = c.swings.reduce((a, b) => (b.time < a.time ? b : a));
    const strengthScore =
      c.swings.reduce((sum, s) => sum + s.strength, 0) / c.swings.length;
    const strength: MajorZone['strength'] =
      strengthScore >= 0.68 ? 'strong' : strengthScore >= 0.55 ? 'moderate' : 'weak';

    const { freshness, broken } = zoneState(
      candles,
      lowerPrice,
      upperPrice,
      type,
      origin.index,
      atr,
      latestClose
    );
    if (freshness === 'INVALIDATED') continue;

    // A broken level can flip roles: broken support → resistance and vice versa.
    const role: 'support' | 'resistance' = broken
      ? type === 'support'
        ? 'resistance'
        : 'support'
      : type;

    zones.push({
      id: `mz-${type}-${Math.round(center * 1e4)}`,
      type,
      role,
      upperPrice,
      lowerPrice,
      originTime: origin.time,
      originIndex: origin.index,
      reactions: totalReactions,
      displacementAtr: Number(maxDisp.toFixed(2)),
      freshness,
      strength,
      roleReversed: broken,
      retestZone: broken
        ? { upperPrice, lowerPrice }
        : null,
      reason: `${
        broken ? `Broken ${type} now acting as ${role}` : `Major ${type} zone`
      } around ${formatPrice(center, precision)} — ${totalReactions} reaction${
        totalReactions === 1 ? '' : 's'
      }, ${maxDisp.toFixed(1)}× ATR displacement.`,
      evidence: c.swings.map((s) => s.reason),
    });
  }

  return dedupeZones(zones, atr, latestClose).slice(0, MAX_ZONES);
}

/**
 * Zone freshness + break state.
 *
 *  - TESTED    : price reacted back into the zone (a retest) but no break occurred.
 *  - INVALIDATED: price closed decisively through the zone in the losing direction and
 *                 then left it far behind (no longer a live reaction area).
 *  - broken    : price closed decisively through the zone and is now sitting on the
 *                 other side — the classic role-reversal (broken support → resistance).
 */
function zoneState(
  candles: readonly Candle[],
  lowerPrice: number,
  upperPrice: number,
  type: 'support' | 'resistance',
  originIndex: number,
  atr: number,
  price: number
): { freshness: MajorZone['freshness']; broken: boolean } {
  let bodyInside = 0;
  let breaches = 0;
  for (let i = originIndex + 1; i < candles.length; i++) {
    const bar = candles[i];
    if (bar.close >= lowerPrice && bar.close <= upperPrice) bodyInside++;
    if (type === 'support') {
      if (bar.close < lowerPrice - atr * 0.2) breaches++;
    } else if (bar.close > upperPrice + atr * 0.2) {
      breaches++;
    }
  }

  const broken =
    type === 'support' ? price < lowerPrice : price > upperPrice;

  // Abandoned: many decisive closes through the zone AND price far beyond it.
  const farBeyond =
    type === 'support' ? price < lowerPrice - atr * 2 : price > upperPrice + atr * 2;
  if (breaches >= 3 && farBeyond) {
    return { freshness: 'INVALIDATED', broken: false };
  }

  let freshness: MajorZone['freshness'];
  if (broken) freshness = 'WEAKENED';
  else if (breaches >= 2) freshness = 'WEAKENED';
  else if (bodyInside === 0) freshness = 'FRESH';
  else if (bodyInside >= 2) freshness = 'TESTED';
  else freshness = 'TESTED';

  return { freshness, broken };
}

/** Removes overlapping/duplicate zones, keeping the strongest of each cluster. */
function dedupeZones(zones: MajorZone[], atr: number, price: number): MajorZone[] {
  const strengthRank: Record<MajorZone['strength'], number> = {
    strong: 3,
    moderate: 2,
    weak: 1,
  };
  const sorted = [...zones].sort((a, b) => {
    const s = strengthRank[b.strength] - strengthRank[a.strength];
    if (s !== 0) return s;
    return b.reactions - a.reactions;
  });

  const kept: MajorZone[] = [];
  for (const z of sorted) {
    const overlaps = kept.some((k) => {
      const overlap =
        Math.min(z.upperPrice, k.upperPrice) - Math.max(z.lowerPrice, k.lowerPrice);
      return overlap > atr * 0.25;
    });
    if (!overlaps) kept.push(z);
  }

  // Prefer the zones nearest current price, then by strength.
  return kept.sort((a, b) => {
    const da = Math.abs(price - (a.upperPrice + a.lowerPrice) / 2);
    const db = Math.abs(price - (b.upperPrice + b.lowerPrice) / 2);
    return da - db;
  });
}
