import type { Candle, TimeframeKey } from '../types/market';
import type { SwingPoint } from '../types/analysis';
import type {
  FairValueGap,
  FutureReactionZone,
  MultiTimeframeStructureResult,
  RejectionZone,
  StructureBias,
  StructureEngineResult,
  SupportResistanceBand,
  ValidStructureBreak,
  WickSweep,
  ZoneFreshness,
} from '../types/structure';
import type { TrendlineLine } from '../types/trendline';
import { formatPrice } from '../utils/derivParser';
import { detectTrendlines as detectValidTrendlines } from './trendlineDetection';
import {
  computeAtrSeries,
  detectSwings,
  getCandleStats,
  getRecentAverageBody,
} from './swings';

/** Only closed candles define structure — the forming bar never counts. */
export function confirmedCandles(candles: readonly Candle[]): Candle[] {
  return candles.length > 2 ? candles.slice(0, -1) : [...candles];
}

/** A close beyond a level by less than this (in ATR) is an insignificant break. */
const MIN_BREAK_DISPLACEMENT_ATR = 0.2;
/** Minimum body/range ratio for a break candle to count as displacement. */
const MIN_BREAK_BODY_RATIO = 0.45;
/** Break body must reach this fraction of the recent average body (follow-through). */
const MIN_BREAK_BODY_VS_AVG = 0.7;
/** Price within this many ATR of a zone counts as "approaching". */
const APPROACH_ATR = 1.6;
/** Price within this many ATR is the outer monitoring band. */
const MONITOR_ATR = 4.5;
/** Half-width of a projected reaction band, in ATR. */
const REACTION_BAND_ATR = 0.3;
/** Cluster tolerance for grouping swing reactions into a zone, in ATR. */
const CLUSTER_TOLERANCE_ATR = 0.45;
/** Maximum fresh watch zones kept on the active chart (clutter guard). */
const MAX_WATCH_ZONES = 5;
/** Maximum fresh fair value gaps kept on the active chart (clutter guard). */
const MAX_FVG = 4;
/** A structure break older than this many bars is no longer "current" on the chart. */
const MAX_BREAK_AGE_BARS = 90;

interface PriceCluster {
  prices: number[];
  times: number[];
  indices: number[];
  highCount: number;
  lowCount: number;
}

function clusterPoints(points: readonly SwingPoint[], tolerance: number): PriceCluster[] {
  const clusters: PriceCluster[] = [];
  for (const p of points) {
    let matched: PriceCluster | null = null;
    let best = Infinity;
    for (const c of clusters) {
      const avg = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
      const d = Math.abs(p.price - avg);
      if (d <= tolerance && d < best) {
        best = d;
        matched = c;
      }
    }
    if (matched) {
      matched.prices.push(p.price);
      matched.times.push(p.time);
      matched.indices.push(p.index);
      if (p.type === 'high') matched.highCount++;
      else matched.lowCount++;
    } else {
      clusters.push({
        prices: [p.price],
        times: [p.time],
        indices: [p.index],
        highCount: p.type === 'high' ? 1 : 0,
        lowCount: p.type === 'low' ? 1 : 0,
      });
    }
  }
  return clusters;
}

/**
 * Detects VALID break of structure (BOS) and change of character (CHOCH) from
 * confirmed swing levels. A break requires a candle BODY CLOSE beyond the protected
 * level plus meaningful displacement; wick-only breaches are returned separately as
 * rejected sweeps so they can never be mistaken for structure.
 */
export function detectValidBreaks(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  atrs: readonly number[],
  precision: number
): {
  breaks: ValidStructureBreak[];
  rejectedSweeps: WickSweep[];
  protectedHigh: number | null;
  protectedLow: number | null;
  bias: StructureBias | 'neutral';
} {
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  if (candles.length < 20 || highs.length < 2 || lows.length < 2) {
    return {
      breaks: [],
      rejectedSweeps: [],
      protectedHigh: highs.length ? highs[highs.length - 1].price : null,
      protectedLow: lows.length ? lows[lows.length - 1].price : null,
      bias: 'neutral',
    };
  }

  const breaks: ValidStructureBreak[] = [];
  const rejectedSweeps: WickSweep[] = [];
  const brokenHighs = new Set<number>();
  const brokenLows = new Set<number>();
  const sweptHighs = new Set<number>();
  const sweptLows = new Set<number>();

  let bias: StructureBias | 'neutral' = 'neutral';
  let activeHigh: SwingPoint | null = null;
  let activeLow: SwingPoint | null = null;
  let cursor = 0;

  for (let i = 0; i < candles.length; i++) {
    while (cursor < swings.length && swings[cursor].index <= i - 1) {
      const s = swings[cursor];
      if (s.type === 'high') activeHigh = s;
      else activeLow = s;
      cursor++;
    }

    const bar = candles[i];
    const atr = Math.max(atrs[i] || 1e-6, 1e-9);
    const stats = getCandleStats(bar);
    const avgBody = getRecentAverageBody(candles, i, 14);
    const displacementReady =
      stats.bodyRatio >= MIN_BREAK_BODY_RATIO && stats.body >= avgBody * MIN_BREAK_BODY_VS_AVG;

    // ---- Wick-only sweep above a protected high (rejected as structure) ----
    if (
      activeHigh &&
      !brokenHighs.has(activeHigh.index) &&
      !sweptHighs.has(activeHigh.index) &&
      bar.high > activeHigh.price + atr * 0.02 &&
      bar.close < activeHigh.price &&
      stats.upperWick >= stats.body * 0.75
    ) {
      sweptHighs.add(activeHigh.index);
      rejectedSweeps.push({
        id: `sweep-high-${bar.time}`,
        direction: 'bearish',
        time: bar.time,
        index: i,
        sweepPrice: bar.high,
        sweptLevel: activeHigh.price,
        reversalClose: bar.close,
        reason: `Wick-only breach of ${formatPrice(
          activeHigh.price,
          precision
        )} — closed back inside; a liquidity sweep, NOT a break of structure.`,
      });
    }

    // ---- Wick-only sweep below a protected low ----
    if (
      activeLow &&
      !brokenLows.has(activeLow.index) &&
      !sweptLows.has(activeLow.index) &&
      bar.low < activeLow.price - atr * 0.02 &&
      bar.close > activeLow.price &&
      stats.lowerWick >= stats.body * 0.75
    ) {
      sweptLows.add(activeLow.index);
      rejectedSweeps.push({
        id: `sweep-low-${bar.time}`,
        direction: 'bullish',
        time: bar.time,
        index: i,
        sweepPrice: bar.low,
        sweptLevel: activeLow.price,
        reversalClose: bar.close,
        reason: `Wick-only breach of ${formatPrice(
          activeLow.price,
          precision
        )} — closed back inside; a liquidity sweep, NOT a break of structure.`,
      });
    }

    // ---- Valid bullish break: body close beyond the protected high ----
    const bullDisplacement = activeHigh ? (bar.close - activeHigh.price) / atr : 0;
    if (
      activeHigh &&
      !brokenHighs.has(activeHigh.index) &&
      stats.isBullish &&
      displacementReady &&
      bullDisplacement >= MIN_BREAK_DISPLACEMENT_ATR
    ) {
      brokenHighs.add(activeHigh.index);
      const kind = bias === 'bearish' ? 'CHOCH' : 'BOS';
      const momentumConfirmed = stats.body >= avgBody * 1.1 && stats.closePosition >= 0.68;
      const level = formatPrice(activeHigh.price, precision);
      breaks.push({
        id: `${kind.toLowerCase()}-bull-${bar.time}`,
        kind,
        direction: 'bullish',
        time: bar.time,
        index: i,
        brokenLevel: activeHigh.price,
        levelTime: activeHigh.time,
        levelKind: 'swing-high',
        closePrice: bar.close,
        displacementAtr: Number(bullDisplacement.toFixed(2)),
        bodyRatio: Number(stats.bodyRatio.toFixed(2)),
        momentumConfirmed,
        reason:
          kind === 'CHOCH'
            ? `BULLISH CHOCH — body closed above the lower-high at ${level} (${bullDisplacement.toFixed(
                2
              )}× ATR displacement), shifting control to the upside.`
            : `BULLISH BOS — body closed above the protected high at ${level} (${bullDisplacement.toFixed(
                2
              )}× ATR displacement).`,
      });
      bias = 'bullish';
    } else {
      // ---- Valid bearish break: body close beyond the protected low ----
      const bearDisplacement = activeLow ? (activeLow.price - bar.close) / atr : 0;
      if (
        activeLow &&
        !brokenLows.has(activeLow.index) &&
        stats.isBearish &&
        displacementReady &&
        bearDisplacement >= MIN_BREAK_DISPLACEMENT_ATR
      ) {
        brokenLows.add(activeLow.index);
        const kind = bias === 'bullish' ? 'CHOCH' : 'BOS';
        const momentumConfirmed = stats.body >= avgBody * 1.1 && stats.closePosition <= 0.32;
        const level = formatPrice(activeLow.price, precision);
        breaks.push({
          id: `${kind.toLowerCase()}-bear-${bar.time}`,
          kind,
          direction: 'bearish',
          time: bar.time,
          index: i,
          brokenLevel: activeLow.price,
          levelTime: activeLow.time,
          levelKind: 'swing-low',
          closePrice: bar.close,
          displacementAtr: Number(bearDisplacement.toFixed(2)),
          bodyRatio: Number(stats.bodyRatio.toFixed(2)),
          momentumConfirmed,
          reason:
            kind === 'CHOCH'
              ? `BEARISH CHOCH — body closed below the higher-low at ${level} (${bearDisplacement.toFixed(
                  2
                )}× ATR displacement), shifting control to the downside.`
              : `BEARISH BOS — body closed below the protected low at ${level} (${bearDisplacement.toFixed(
                  2
                )}× ATR displacement).`,
        });
        bias = 'bearish';
      }
    }
  }

  // Protected levels = most recent swing highs/lows that are still intact.
  const protectedHigh =
    [...highs].reverse().find((h) => !brokenHighs.has(h.index))?.price ??
    (highs.length ? highs[highs.length - 1].price : null);
  const protectedLow =
    [...lows].reverse().find((l) => !brokenLows.has(l.index))?.price ??
    (lows.length ? lows[lows.length - 1].price : null);

  return {
    breaks: breaks.slice(-8),
    rejectedSweeps: rejectedSweeps.slice(-5),
    protectedHigh,
    protectedLow,
    bias,
  };
}

/**
 * Genuine rejection bands. A long wick alone is NOT enough: a zone needs repeated
 * reactions, wick rejection AND structural significance (>= 2 swing reactions).
 */
export function detectRejectionZones(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  atr: number,
  precision: number
): RejectionZone[] {
  if (candles.length < 25 || swings.length < 3 || atr <= 0) return [];

  const tolerance = Math.max(atr * CLUSTER_TOLERANCE_ATR, 1e-6);
  const clusters = clusterPoints(swings, tolerance);
  const zones: RejectionZone[] = [];

  for (const c of clusters) {
    if (c.prices.length < 2) continue;

    const avg = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
    const isHighCluster = c.highCount >= c.lowCount;
    const direction: 'RISE' | 'FALL' = isHighCluster ? 'FALL' : 'RISE';

    const bandHalf = Math.max(atr * REACTION_BAND_ATR, 1e-6);
    const upperPrice = Math.max(...c.prices) + bandHalf * 0.4;
    const lowerPrice = Math.min(...c.prices) - bandHalf * 0.4;

    // Count rejection closes and body closes that interacted with the band.
    // A rejection = price entered the band then closed back OUT of it (the wick
    // poked the level but the close rejected) — a lone wick that closes inside the
    // band does NOT count.
    const fromIndex = Math.min(...c.indices) + 1;
    let wickRejections = 0;
    let bodyCloses = 0;
    let displacementAtr = 0;

    for (let i = fromIndex; i < candles.length; i++) {
      const bar = candles[i];
      const enteredBand = bar.high >= lowerPrice && bar.low <= upperPrice;
      if (!enteredBand) continue;
      const rejectedOut = isHighCluster ? bar.close < lowerPrice : bar.close > upperPrice;
      if (rejectedOut) {
        wickRejections++;
        const rej = isHighCluster ? bar.high - bar.close : bar.close - bar.low;
        displacementAtr = Math.max(displacementAtr, rej / atr);
      } else {
        bodyCloses++;
      }
    }

    // Structural significance: repeated reactions, at least one wick rejection and
    // a real displacement away from the level.
    if (c.prices.length < 2 || wickRejections < 1 || displacementAtr < 0.4) continue;

    const freshness = evaluateFreshness(
      {
        direction,
        upperPrice,
        lowerPrice,
        fromIndex,
      },
      candles,
      atr
    );

    const invalidationLevel = isHighCluster ? upperPrice + atr * 0.5 : lowerPrice - atr * 0.5;
    const priceLabel = `${formatPrice(lowerPrice, precision)}–${formatPrice(upperPrice, precision)}`;
    const importance = c.prices.length >= 3 && wickRejections >= 2 ? 'major' : 'minor';

    zones.push({
      id: `rej-${direction}-${Math.round(avg * 1e4)}`,
      direction,
      upperPrice,
      lowerPrice,
      originTime: Math.min(...c.times),
      touches: c.prices.length,
      wickRejections,
      bodyCloses,
      displacementAtr: Number(displacementAtr.toFixed(2)),
      structuralSignificance: importance,
      freshness,
      invalidationLevel,
      reason: `${
        isHighCluster ? 'Bearish' : 'Bullish'
      } rejection band ${priceLabel} — ${c.prices.length} swing reactions, ${wickRejections} wick rejection${
        wickRejections === 1 ? '' : 's'
      } and ${displacementAtr.toFixed(1)}× ATR displacement.`,
    });
  }

  return zones
    .sort((a, b) => {
      const scoreA = a.touches * 2 + a.wickRejections + (a.structuralSignificance === 'major' ? 2 : 0);
      const scoreB = b.touches * 2 + b.wickRejections + (b.structuralSignificance === 'major' ? 2 : 0);
      return scoreB - scoreA;
    })
    .slice(0, 4);
}

/**
 * Current support/resistance as PRICE BANDS (not arbitrary single lines). Requires
 * multiple confirmed swing reactions; minor highs/lows are ignored.
 */
export function detectSupportResistanceBands(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  atr: number,
  precision: number
): SupportResistanceBand[] {
  if (candles.length < 20 || swings.length < 2 || atr <= 0) return [];

  const tolerance = Math.max(atr * CLUSTER_TOLERANCE_ATR, 1e-6);
  const clusters = clusterPoints(swings, tolerance);
  const latestClose = candles[candles.length - 1].close;
  const bands: SupportResistanceBand[] = [];

  for (const c of clusters) {
    if (c.prices.length < 2) continue;

    const avg = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
    const pad = Math.max(atr * REACTION_BAND_ATR, 1e-6);
    const upperPrice = Math.max(...c.prices) + pad;
    const lowerPrice = Math.min(...c.prices) - pad;
    const type: 'support' | 'resistance' = latestClose >= avg ? 'support' : 'resistance';

    const recent = candles.slice(-3);
    const broken =
      type === 'support'
        ? recent.every((b) => b.close < lowerPrice - atr * 0.15)
        : recent.every((b) => b.close > upperPrice + atr * 0.15);

    const importance: 'major' | 'minor' = c.prices.length >= 3 ? 'major' : 'minor';
    const priceLabel = `${formatPrice(lowerPrice, precision)}–${formatPrice(upperPrice, precision)}`;
    bands.push({
      id: `srb-${type}-${Math.round(avg * 1e4)}`,
      type,
      upperPrice,
      lowerPrice,
      touches: c.prices.length,
      firstTouchTime: Math.min(...c.times),
      lastTouchTime: Math.max(...c.times),
      status: broken ? 'broken' : 'active',
      importance,
      reason:
        type === 'support'
          ? `${importance.toUpperCase()} SUPPORT band ${priceLabel} — ${c.prices.length} confirmed reactions.`
          : `${importance.toUpperCase()} RESISTANCE band ${priceLabel} — ${c.prices.length} confirmed reactions.`,
    });
  }

  // Keep the two most relevant active bands per side (no minor clutter).
  const pick = (t: 'support' | 'resistance') =>
    bands
      .filter((b) => b.status === 'active' && b.type === t)
      .sort((a, b) => {
        const sa = a.touches * 2 - Math.abs(latestClose - (a.upperPrice + a.lowerPrice) / 2) / atr;
        const sb = b.touches * 2 - Math.abs(latestClose - (b.upperPrice + b.lowerPrice) / 2) / atr;
        return sb - sa;
      })
      .slice(0, 2);

  return [...pick('resistance'), ...pick('support')].sort((a, b) => b.upperPrice - a.upperPrice);
}

interface FreshnessProbe {
  direction: 'RISE' | 'FALL';
  upperPrice: number;
  lowerPrice: number;
  fromIndex: number;
}

/**
 * Consistent mitigation definition based on how price interacts with the ENTIRE zone:
 *  - wick touch only           → PROBED
 *  - body close inside the band → PARTIALLY_TESTED
 *  - body close through the far boundary → MITIGATED
 *  - decisive close beyond invalidation → INVALIDATED
 */
export function evaluateFreshness(
  probe: FreshnessProbe,
  candles: readonly Candle[],
  atr: number
): ZoneFreshness {
  const { direction, upperPrice, lowerPrice } = probe;
  // A decisive close this far beyond the far boundary invalidates the zone.
  const invalidateBuffer = atr * 0.5;
  let freshness: ZoneFreshness = 'FRESH';

  for (let i = probe.fromIndex; i < candles.length; i++) {
    const bar = candles[i];
    const bodyTop = Math.max(bar.open, bar.close);
    const bodyBottom = Math.min(bar.open, bar.close);

    // Invalidation: a decisive close well beyond the far boundary.
    if (direction === 'RISE' && bar.close < lowerPrice - invalidateBuffer) return 'INVALIDATED';
    if (direction === 'FALL' && bar.close > upperPrice + invalidateBuffer) return 'INVALIDATED';

    // Full mitigation: the candle body closed entirely through the far boundary.
    const farBoundaryCrossed =
      direction === 'RISE' ? bodyTop < lowerPrice : bodyBottom > upperPrice;
    if (farBoundaryCrossed) {
      freshness = 'MITIGATED';
      continue;
    }

    // Partial penetration: the body closed inside the band but not through it.
    const bodyInside = bodyTop >= lowerPrice && bodyBottom <= upperPrice;
    if (bodyInside) {
      if (freshness !== 'MITIGATED') freshness = 'PARTIALLY_TESTED';
      continue;
    }

    // Wick touch only: the range entered the band but the body stayed outside.
    const rangeTouches = bar.high >= lowerPrice && bar.low <= upperPrice;
    if (rangeTouches && freshness === 'FRESH') freshness = 'PROBED';
  }

  return freshness;
}

/**
 * Detects fresh fair value gaps (three-candle imbalances). A bullish FVG exists when
 * the high of candle i-1 sits below the low of candle i+1 (the displacement candle i
 * left an unfilled gap); a bearish FVG is the mirror. Only gaps that price has NOT yet
 * fully traded back through are returned, so filled imbalances are removed from the
 * live chart automatically. Gaps far beyond the monitoring band are dropped.
 */
export function detectFairValueGaps(
  candles: readonly Candle[],
  atr: number,
  precision: number
): FairValueGap[] {
  if (candles.length < 20 || atr <= 0) return [];

  const latestClose = candles[candles.length - 1].close;
  const gaps: FairValueGap[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const mid = candles[i];
    const next = candles[i + 1];

    // Bullish gap: the current candle's low leaves an imbalance above the prior high.
    const bullLower = prev.high;
    const bullUpper = next.low;
    const bearUpper = prev.low;
    const bearLower = next.high;

    const isBull = bullUpper > bullLower;
    const isBear = bearLower < bearUpper;
    if (!isBull && !isBear) continue;

    // The displacement candle must show real imbalance, not a 1-tick sliver.
    const bullish = isBull && !isBear;
    const lowerPrice = bullish ? bullLower : bearLower;
    const upperPrice = bullish ? bullUpper : bearUpper;
    const size = upperPrice - lowerPrice;
    if (size < atr * 0.12) continue;
    if (getCandleStats(mid).body < atr * 0.25) continue;

    // Freshness: filled once price trades back through the far edge of the gap.
    let freshness: ZoneFreshness = 'FRESH';
    for (let j = i + 2; j < candles.length; j++) {
      const bar = candles[j];
      if (bullish) {
        if (bar.low <= lowerPrice) {
          freshness = 'MITIGATED';
          break;
        }
      } else if (bar.high >= upperPrice) {
        freshness = 'MITIGATED';
        break;
      }
    }
    if (freshness === 'MITIGATED') continue;

    const mid0 = (lowerPrice + upperPrice) / 2;
    const distance = Math.abs(latestClose - mid0);
    const distanceAtr = Number((distance / Math.max(atr, 1e-9)).toFixed(2));
    if (distanceAtr > MONITOR_ATR) continue;

    const reaction: 'RISE' | 'FALL' = bullish ? 'RISE' : 'FALL';
    gaps.push({
      id: `fvg-${bullish ? 'bull' : 'bear'}-${mid.time}`,
      direction: bullish ? 'bullish' : 'bearish',
      reaction,
      upperPrice,
      lowerPrice,
      time: mid.time,
      index: i,
      sizeAtr: Number((size / Math.max(atr, 1e-9)).toFixed(2)),
      freshness,
      distanceAtr,
      approachProgress: Number(
        Math.max(0, Math.min(1, 1 - distance / Math.max(atr * MONITOR_ATR, 1e-9))).toFixed(2)
      ),
      reason: `${
        bullish ? 'Bullish' : 'Bearish'
      } fair value gap ${formatPrice(lowerPrice, precision)}–${formatPrice(
        upperPrice,
        precision
      )} — unfilled ${(size / Math.max(atr, 1e-9)).toFixed(1)}× ATR imbalance; expect a ${
        bullish ? 'RISE' : 'FALL'
      } reaction if price returns into it.`,
    });
  }

  // Keep the nearest fresh gaps, most recently formed first (no stale clutter).
  return gaps
    .sort((a, b) => a.distanceAtr - b.distanceAtr)
    .slice(0, MAX_FVG);
}

/**
 * Projects fresh FUTURE reaction zones from valid breaks and existing structure.
 * A broken resistance is reclassified as potential support (WATCH RISE); a broken
 * support becomes potential resistance (WATCH FALL). Opposing fresh zones on the far
 * side of price are added as the next likely reaction. Levels are only ever taken
 * from real structure — never invented.
 */
export function projectFutureReactionZones(params: {
  candles: readonly Candle[];
  breaks: readonly ValidStructureBreak[];
  srBands: readonly SupportResistanceBand[];
  rejectionZones: readonly RejectionZone[];
  timeframe: TimeframeKey;
  atr: number;
  precision: number;
}): FutureReactionZone[] {
  const { candles, breaks, srBands, rejectionZones, timeframe, atr, precision } = params;
  if (candles.length === 0 || atr <= 0) return [];

  const latestIndex = candles.length - 1;
  const latestClose = candles[candles.length - 1].close;
  const bandHalf = Math.max(atr * REACTION_BAND_ATR, 1e-6);
  const zones: FutureReactionZone[] = [];
  const seen = new Set<string>();

  const push = (z: FutureReactionZone) => {
    const key = `${z.direction}-${Math.round((z.upperPrice + z.lowerPrice) * 0.5 * 1e4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    zones.push(z);
  };

  // 1. Reclassified broken levels → their retest area is a fresh watch zone.
  for (const brk of breaks) {
    if (latestIndex - brk.index > 60) continue;
    const isBull = brk.direction === 'bullish';
    const level = brk.brokenLevel;
    const zone: FutureReactionZone = {
      id: `fz-${isBull ? 'rise' : 'fall'}-${brk.id}`,
      direction: isBull ? 'RISE' : 'FALL',
      kind: isBull ? 'support' : 'resistance',
      upperPrice: level + bandHalf,
      lowerPrice: level - bandHalf,
      originTime: brk.time,
      originTimeframe: timeframe,
      sourceStructure: isBull
        ? `Broken resistance ${formatPrice(level, precision)} → potential support (bullish ${brk.kind})`
        : `Broken support ${formatPrice(level, precision)} → potential resistance (bearish ${brk.kind})`,
      freshness: 'FRESH',
      stage: 'ZONE_DETECTED',
      invalidationLevel: isBull ? level - atr * 1.0 : level + atr * 1.0,
      invalidationCondition: isBull
        ? `Invalidated if price closes decisively below ${formatPrice(level - atr, precision)}.`
        : `Invalidated if price closes decisively above ${formatPrice(level + atr, precision)}.`,
      reactions: 0,
      distanceAtr: 0,
      approachProgress: 0,
      reason: isBull
        ? `The broken resistance at ${formatPrice(
            level,
            precision
          )} is now potential support — watch for a RISE reaction on the retest.`
        : `The broken support at ${formatPrice(
            level,
            precision
          )} is now potential resistance — watch for a FALL reaction on the retest.`,
      evidence: [brk.reason],
    };
    push(zone);
  }

  // 2. Fresh rejection zones near price become watch zones in their reaction direction.
  for (const rz of rejectionZones) {
    if (rz.freshness === 'MITIGATED' || rz.freshness === 'INVALIDATED') continue;
    const mid = (rz.upperPrice + rz.lowerPrice) / 2;
    if (Math.abs(mid - latestClose) / atr > MONITOR_ATR) continue;
    push({
      id: `fz-${rz.direction.toLowerCase()}-${rz.id}`,
      direction: rz.direction,
      kind: rz.direction === 'RISE' ? 'support' : 'resistance',
      upperPrice: rz.upperPrice,
      lowerPrice: rz.lowerPrice,
      originTime: rz.originTime,
      originTimeframe: timeframe,
      sourceStructure: `Rejection band (${rz.touches} reactions)`,
      freshness: rz.freshness,
      stage: 'ZONE_DETECTED',
      invalidationLevel: rz.invalidationLevel,
      invalidationCondition:
        rz.direction === 'RISE'
          ? `Invalidated if price closes below ${formatPrice(rz.invalidationLevel, precision)}.`
          : `Invalidated if price closes above ${formatPrice(rz.invalidationLevel, precision)}.`,
      reactions: rz.touches,
      distanceAtr: 0,
      approachProgress: 0,
      reason: rz.reason,
      evidence: [],
    });
  }

  // 3. Fresh opposing zones on the far side of price (next likely reaction).
  const activeBands = srBands.filter((b) => b.status === 'active');
  for (const band of activeBands) {
    const mid = (band.upperPrice + band.lowerPrice) / 2;
    const above = mid > latestClose;
    // A resistance above price → potential FALL reaction; support below → potential RISE.
    const direction: 'RISE' | 'FALL' = above ? 'FALL' : 'RISE';
    push({
      id: `fz-opp-${band.id}`,
      direction,
      kind: band.type,
      upperPrice: band.upperPrice,
      lowerPrice: band.lowerPrice,
      originTime: band.firstTouchTime,
      originTimeframe: timeframe,
      sourceStructure: `Fresh ${band.type} band (${band.touches} reactions)`,
      freshness: 'FRESH',
      stage: 'ZONE_DETECTED',
      invalidationLevel: above ? band.upperPrice + atr * 1.0 : band.lowerPrice - atr * 1.0,
      invalidationCondition: above
        ? `Invalidated if price closes above ${formatPrice(band.upperPrice + atr, precision)}.`
        : `Invalidated if price closes below ${formatPrice(band.lowerPrice - atr, precision)}.`,
      reactions: band.touches,
      distanceAtr: 0,
      approachProgress: 0,
      reason:
        direction === 'FALL'
          ? `Fresh resistance band ${formatPrice(band.lowerPrice, precision)}–${formatPrice(
              band.upperPrice,
              precision
            )} above price — watch for a FALL reaction.`
          : `Fresh support band ${formatPrice(band.lowerPrice, precision)}–${formatPrice(
              band.upperPrice,
              precision
            )} below price — watch for a RISE reaction.`,
      evidence: [],
    });
  }

  // Evaluate freshness + three-stage status for every candidate zone.
  return zones
    .map((z) => evaluateZoneState(z, candles, atr))
    .filter((z) => z.stage !== 'INVALIDATED')
    .sort((a, b) => a.distanceAtr - b.distanceAtr);
}

/**
 * Evaluates a zone's freshness and advances the three-stage progression from live
 * candles. Stage 3 (ENTRY_CONFIRMED) is only ever set by the integration layer when a
 * published, quality-gated signal corresponds to the zone — never here.
 */
export function evaluateZoneState(
  zone: FutureReactionZone,
  candles: readonly Candle[],
  atr: number
): FutureReactionZone {
  const latestClose = candles[candles.length - 1].close;
  const originIndex = Math.max(
    0,
    candles.findIndex((c) => c.time >= zone.originTime)
  );
  const freshness = evaluateFreshness(
    {
      direction: zone.direction,
      upperPrice: zone.upperPrice,
      lowerPrice: zone.lowerPrice,
      fromIndex: originIndex + 1,
    },
    candles,
    atr
  );

  const mid = (zone.upperPrice + zone.lowerPrice) / 2;
  const nearBoundary =
    zone.direction === 'RISE' ? zone.upperPrice : zone.lowerPrice;
  const distance = Math.abs(latestClose - nearBoundary);
  const distanceAtr = Number((distance / Math.max(atr, 1e-9)).toFixed(2));

  const inZone = latestClose >= zone.lowerPrice && latestClose <= zone.upperPrice;
  const invalidated =
    zone.direction === 'RISE'
      ? latestClose < zone.invalidationLevel
      : latestClose > zone.invalidationLevel;

  let stage = zone.stage;
  if (freshness === 'INVALIDATED' || invalidated) {
    stage = 'INVALIDATED';
  } else if (freshness === 'MITIGATED') {
    stage = 'FAILED';
  } else if (inZone || distance <= atr * APPROACH_ATR) {
    stage = 'PRICE_APPROACHING';
  } else {
    stage = 'ZONE_DETECTED';
  }

  const approachProgress = Number(
    Math.max(0, Math.min(1, 1 - distance / Math.max(atr * MONITOR_ATR, 1e-9))).toFixed(2)
  );

  void mid;
  return {
    ...zone,
    freshness,
    stage,
    distanceAtr,
    approachProgress,
  };
}

/**
 * Advances a watch zone to stage 3 (ENTRY_CONFIRMED) when a published, quality-gated
 * signal corresponds to it (same direction and the entry sits inside/near the zone).
 * This is the ONLY place stage 3 is set — the detection layer never fabricates it.
 */
export function markZoneEntryConfirmed(
  zones: readonly FutureReactionZone[],
  params: {
    direction: 'RISE' | 'FALL';
    entryPrice: number;
    atr: number;
  }
): FutureReactionZone[] {
  const { direction, entryPrice, atr } = params;
  return zones.map((zone) => {
    if (zone.direction !== direction) return zone;
    if (zone.stage === 'FAILED' || zone.stage === 'INVALIDATED') return zone;
    const pad = Math.max(atr * 0.5, 1e-6);
    const inZone = entryPrice >= zone.lowerPrice - pad && entryPrice <= zone.upperPrice + pad;
    if (!inZone) return zone;
    return { ...zone, stage: 'ENTRY_CONFIRMED' };
  });
}

/**
 * The structure layer entry point. Runs on confirmed candles only and returns the
 * current valid structure, fresh zones and forward-looking watch zones. Invalidated
 * trendlines and mitigated/invalidated zones are excluded from the active output.
 */
export function analyzeStructure(params: {
  candles: readonly Candle[];
  timeframe: TimeframeKey;
  precision: number;
  /** Higher-timeframe bias used to label CHOCH/BOS context. */
  htfBias?: StructureBias | 'neutral';
}): StructureEngineResult {
  const { timeframe, precision } = params;
  const confirmed = confirmedCandles(params.candles);

  const empty: StructureEngineResult = {
    breaks: [],
    rejectedSweeps: [],
    protectedHigh: null,
    protectedLow: null,
    bias: 'neutral',
    trendlines: [],
    rejectionZones: [],
    srBands: [],
    fvg: [],
    watchZones: [],
    activeWatch: [],
    testedWatch: [],
    summary: 'Insufficient confirmed candles for structural analysis.',
  };
  if (confirmed.length < 30) return empty;

  const atrs = computeAtrSeries(confirmed, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const swings = detectSwings(confirmed, 3, 3);

  const { breaks, rejectedSweeps, protectedHigh, protectedLow, bias } = detectValidBreaks(
    confirmed,
    swings,
    atrs,
    precision
  );

  // Valid swing-anchored trendlines; keep only those still valid on the active chart.
  const allTrendlines: TrendlineLine[] = detectValidTrendlines(confirmed, swings, atr, precision);
  const trendlines = allTrendlines.filter((l) => l.valid);

  const rejectionZones = detectRejectionZones(confirmed, swings, atr, precision);
  const srBands = detectSupportResistanceBands(confirmed, swings, atr, precision);
  const fvg = detectFairValueGaps(confirmed, atr, precision);

  const watchZones = projectFutureReactionZones({
    candles: confirmed,
    breaks,
    srBands,
    rejectionZones,
    timeframe,
    atr,
    precision,
  });

  const activeWatch = watchZones
    .filter((z) => z.freshness !== 'MITIGATED' && z.freshness !== 'INVALIDATED' && z.stage !== 'FAILED')
    .slice(0, MAX_WATCH_ZONES);
  const testedWatch = watchZones
    .filter((z) => z.freshness === 'MITIGATED' || z.freshness === 'INVALIDATED' || z.stage === 'FAILED')
    .slice(0, MAX_WATCH_ZONES);

  const biasLabel = bias === 'bullish' ? 'Bullish' : bias === 'bearish' ? 'Bearish' : 'Neutral';
  const latestBreak = breaks[breaks.length - 1] ?? null;
  const summary = latestBreak
    ? `${biasLabel} structure — ${latestBreak.reason}`
    : `${biasLabel} structure — no decisive break of structure in the recent window.`;

  return {
    breaks,
    rejectedSweeps,
    protectedHigh,
    protectedLow,
    bias,
    trendlines,
    rejectionZones,
    srBands,
    fvg,
    watchZones,
    activeWatch,
    testedWatch,
    summary,
  };
}

/**
 * Multi-timeframe wrapper: the higher timeframe establishes major direction, while the
 * active timeframe refines structure and zones. Watch zones are deduped across
 * timeframes and each preserves the timeframe it originated on.
 */
export function analyzeMultiTimeframeStructure(params: {
  activeTimeframe: TimeframeKey;
  candlesByTimeframe: Partial<Record<TimeframeKey, readonly Candle[]>>;
  htfTimeframe: TimeframeKey | null;
  precision: number;
}): MultiTimeframeStructureResult {
  const { activeTimeframe, candlesByTimeframe, htfTimeframe, precision } = params;

  const activeCandles = candlesByTimeframe[activeTimeframe] ?? [];
  const result = analyzeStructure({ candles: activeCandles, timeframe: activeTimeframe, precision });

  let htfBias: StructureBias | 'neutral' = 'neutral';
  if (htfTimeframe) {
    const htfCandles = candlesByTimeframe[htfTimeframe] ?? [];
    if (htfCandles.length >= 30) {
      const htf = analyzeStructure({ candles: htfCandles, timeframe: htfTimeframe, precision });
      htfBias = htf.bias;
    }
  }

  // Dedupe watch zones across the active timeframe's candidates (origin preserved).
  const merged: FutureReactionZone[] = [];
  for (const z of result.activeWatch) {
    const duplicate = merged.some(
      (m) =>
        m.direction === z.direction &&
        Math.abs((m.upperPrice + m.lowerPrice) / 2 - (z.upperPrice + z.lowerPrice) / 2) <
          (m.upperPrice - m.lowerPrice) / 2 + (z.upperPrice - z.lowerPrice) / 2
    );
    if (!duplicate) merged.push(z);
  }

  return {
    activeTimeframe,
    htfBias,
    htfTimeframe,
    result,
    mergedWatchZones: merged,
  };
}
