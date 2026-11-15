import type { StructureBreakEvent } from '../types/analysis';
import type { Candle } from '../types/market';
import type { DsZoneFormation, DsZoneOrigin, DsZoneType } from '../types/demandSupply';
import { DS_FORMATION_LABELS } from '../types/demandSupply';
import type { FairValueGap } from '../types/structure';
import { formatPrice } from '../utils/derivParser';
import { getCandleStats, getRecentAverageBody, type SwingPoint } from './swings';

/**
 * DEMAND & SUPPLY DETECTION — finds the raw base/leg formations that leave a genuine
 * imbalance, and refuses anything that is merely a swing point or ordinary consolidation.
 *
 * Only four formations qualify:
 *   - Drop-Base-Rally (DBR) → demand
 *   - Rally-Base-Rally (RBR) → demand
 *   - Rally-Base-Drop (RBD) → supply
 *   - Drop-Base-Drop  (DBD) → supply
 *
 * A formation is only valid when a COMPACT base is followed by a strong displacement leg
 * (>= MIN_DISPLACEMENT_ATR). Weak bases, thin impulses and random consolidations are
 * rejected outright.
 */

/** Minimum displacement leaving the zone for it to count as a real imbalance. */
export const MIN_DISPLACEMENT_ATR = 1.2;
/** The base candle body must be no larger than this multiple of the recent average body. */
const MAX_BASE_BODY_VS_AVG = 1.1;
/** The base candle range must be no larger than this multiple of ATR. */
const MAX_BASE_RANGE_ATR = 1.2;
/** Displacement candle body vs the recent average body (follow-through). */
const MIN_DISPLACEMENT_BODY_VS_AVG = 1.5;
/** A zone taller than this many ATR is not a clean level — reject it. */
const MAX_ZONE_HEIGHT_ATR = 2.6;
/** Minimum zone height in ATR so a sliver is not treated as a zone. */
const MIN_ZONE_HEIGHT_ATR = 0.08;

/** A raw zone before lifecycle tracking. */
export interface RawDsZone {
  id: string;
  type: DsZoneType;
  formation: DsZoneFormation;
  formationLabel: string;
  upperPrice: number;
  lowerPrice: number;
  originTime: number;
  originIndex: number;
  displacementAtr: number;
  /** Index of the last candle of the displacement leg (zone is established after it). */
  establishedIndex: number;
  /** Whether the displacement move broke structure (BOS) in the zone's direction. */
  causedBos: boolean;
  /** The structural evidence that originated this zone. */
  origins?: DsZoneOrigin[];
  hasFvgConfluence: boolean;
  fvg: { upperPrice: number; lowerPrice: number } | null;
  /** Base tightness 0..1 (tighter base = higher). */
  baseTightness: number;
}

export interface DetectDsZonesParams {
  /** Confirmed M15 candles (primary supply/demand identification). */
  structureCandles: readonly Candle[];
  /** Confirmed M5 candles (zone refinement). */
  refinementCandles: readonly Candle[];
  structureAtr: number;
  precision: number;
  swings: readonly SwingPoint[];
  breaks: readonly StructureBreakEvent[];
  fvgs: readonly FairValueGap[];
}

function fvgOverlapsZone(
  fvg: FairValueGap,
  lower: number,
  upper: number,
  originIndex: number
): boolean {
  // A confluence FVG must sit inside / adjacent to the zone AND originate near it.
  if (fvg.index < originIndex - 1 || fvg.index > originIndex + 2) return false;
  return fvg.lowerPrice < upper && fvg.upperPrice > lower;
}

/**
 * Refines a zone's bounds with the entry-timeframe (M5) candles that overlap the M15
 * base window. The refined body can only ever tighten toward the true base — it is
 * clamped so a zone cannot collapse to a sliver or balloon past MAX_ZONE_HEIGHT_ATR.
 */
function refineBounds(
  raw: { upperPrice: number; lowerPrice: number; originTime: number },
  refinementCandles: readonly Candle[],
  structureAtr: number
): { upperPrice: number; lowerPrice: number } {
  const windowStart = raw.originTime;
  const windowEnd = raw.originTime + 900; // one M15 bar
  const window = refinementCandles.filter((c) => c.time >= windowStart && c.time < windowEnd);
  if (window.length === 0) return { upperPrice: raw.upperPrice, lowerPrice: raw.lowerPrice };

  const low = Math.min(...window.map((c) => c.low));
  const high = Math.max(...window.map((c) => c.high));
  // Intersect the M15 base with the M5 extremes so refinement only tightens.
  let upperPrice = Math.min(raw.upperPrice, high);
  let lowerPrice = Math.max(raw.lowerPrice, low);
  if (upperPrice <= lowerPrice) return { upperPrice: raw.upperPrice, lowerPrice: raw.lowerPrice };

  const height = upperPrice - lowerPrice;
  if (height < structureAtr * MIN_ZONE_HEIGHT_ATR) {
    const mid = (upperPrice + lowerPrice) / 2;
    const half = (structureAtr * MIN_ZONE_HEIGHT_ATR) / 2;
    upperPrice = mid + half;
    lowerPrice = mid - half;
  } else if (height > structureAtr * MAX_ZONE_HEIGHT_ATR) {
    // Keep the proximal half (the entry edge) and clamp the distal side.
    return { upperPrice: raw.upperPrice, lowerPrice: raw.lowerPrice };
  }
  return { upperPrice, lowerPrice };
}

export function detectDsZones(params: DetectDsZonesParams): RawDsZone[] {
  const { structureCandles, refinementCandles, structureAtr, precision, breaks, fvgs } = params;
  const candles = structureCandles;
  if (candles.length < 30 || structureAtr <= 0) return [];

  const out: RawDsZone[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < candles.length - 2; i++) {
    const base = candles[i];
    const prev = candles[i - 1];
    const out1 = candles[i + 1];
    const out2 = candles[i + 2];

    const avgBody = getRecentAverageBody(candles, i, 14);
    const baseStats = getCandleStats(base);
    const prevStats = getCandleStats(prev);
    const out1Stats = getCandleStats(out1);
    const out2Stats = getCandleStats(out2);

    // The base must be compact relative to recent activity — ordinary consolidation with
    // a wide body is not a base, it is noise.
    const compact =
      baseStats.body <= avgBody * MAX_BASE_BODY_VS_AVG &&
      baseStats.range <= structureAtr * MAX_BASE_RANGE_ATR;
    if (!compact) continue;

    const bullishOut =
      out1Stats.isBullish &&
      out1Stats.body >= avgBody * MIN_DISPLACEMENT_BODY_VS_AVG &&
      out1Stats.closePosition >= 0.6 &&
      (out2.close > out1.high || out2Stats.isBullish) &&
      out2.close - base.low >= structureAtr * MIN_DISPLACEMENT_ATR;

    const bearishOut =
      out1Stats.isBearish &&
      out1Stats.body >= avgBody * MIN_DISPLACEMENT_BODY_VS_AVG &&
      out1Stats.closePosition <= 0.4 &&
      (out2.close < out1.low || out2Stats.isBearish) &&
      base.high - out2.close >= structureAtr * MIN_DISPLACEMENT_ATR;

    if (!bullishOut && !bearishOut) continue;

    const type: DsZoneType = bullishOut ? 'demand' : 'supply';
    const formation: DsZoneFormation = bullishOut
      ? prevStats.isBearish
        ? 'DBR'
        : 'RBR'
      : prevStats.isBullish
        ? 'RBD'
        : 'DBD';

    const id = `${type}-${formation}-${base.time}`;
    if (seen.has(id)) continue;

    const rawBounds = { upperPrice: base.high, lowerPrice: base.low, originTime: base.time };
    const refined = refineBounds(rawBounds, refinementCandles, structureAtr);
    const height = refined.upperPrice - refined.lowerPrice;
    if (height <= 0 || height > structureAtr * MAX_ZONE_HEIGHT_ATR) continue;

    const displacementAtr = Number(
      ((bullishOut ? out2.close - base.low : base.high - out2.close) / structureAtr).toFixed(2)
    );

    const establishedIndex = i + 2;
    const causedBos = breaks.some(
      (b) =>
        b.index >= i &&
        b.index <= establishedIndex &&
        ((bullishOut && b.direction === 'bullish') || (bearishOut && b.direction === 'bearish'))
    );
    const overlappingFvg =
      fvgs.find((f) =>
        fvgOverlapsZone(f, refined.lowerPrice, refined.upperPrice, i)
      ) ?? null;

    // Classify the evidence that ORIGINATED this zone. A genuine zone is left by a
    // departure — displacement is mandatory (already enforced above); engulfing, a
    // liquidity sweep ahead of the departure, an imbalance and a BOS are recorded when
    // present so downstream scoring can weight the strongest origins.
    const origins: DsZoneOrigin[] = ['DISPLACEMENT'];
    const engulfingDeparture = bullishOut
      ? out1Stats.isBullish && out1.open <= base.close && out1.close >= base.open
      : out1Stats.isBearish && out1.open >= base.close && out1.close <= base.open;
    if (engulfingDeparture) origins.push('ENGULFING');
    if (causedBos) origins.push('BOS');
    if (overlappingFvg) origins.push('IMBALANCE');
    // A liquidity sweep: the base (or the bar before it) wicked beyond the prior extreme
    // in the opposite direction of the departure, then price displaced away.
    const sweepBar = candles[i];
    const sweepBarPrev = candles[i - 1];
    const swept = bullishOut
      ? sweepBar.low < sweepBarPrev.low && sweepBar.close > sweepBarPrev.low
      : sweepBar.high > sweepBarPrev.high && sweepBar.close < sweepBarPrev.high;
    if (swept) origins.push('LIQUIDITY_SWEEP');

    seen.add(id);
    out.push({
      id,
      type,
      formation,
      formationLabel: DS_FORMATION_LABELS[formation],
      upperPrice: refined.upperPrice,
      lowerPrice: refined.lowerPrice,
      originTime: base.time,
      originIndex: i,
      displacementAtr,
      establishedIndex,
      causedBos,
      origins,
      hasFvgConfluence: overlappingFvg !== null,
      fvg: overlappingFvg
        ? { upperPrice: overlappingFvg.upperPrice, lowerPrice: overlappingFvg.lowerPrice }
        : null,
      baseTightness: Number(
        Math.max(0, Math.min(1, 1 - baseStats.body / Math.max(avgBody, 1e-9))).toFixed(2)
      ),
    });
  }

  void precision;
  return out;
}

/** Formation-descriptive text used in zone reasons. */
export function describeFormation(zone: RawDsZone, precision: number): string {
  const side = zone.type === 'demand' ? 'DEMAND' : 'SUPPLY';
  const leg =
    zone.type === 'demand'
      ? zone.formation === 'DBR'
        ? 'Drop-Base-Rally'
        : 'Rally-Base-Rally'
      : zone.formation === 'RBD'
        ? 'Rally-Base-Drop'
        : 'Drop-Base-Drop';
  return `${leg} ${side} ZONE (${formatPrice(zone.lowerPrice, precision)}–${formatPrice(
    zone.upperPrice,
    precision
  )}) — ${zone.displacementAtr.toFixed(1)}× ATR displacement left the base.`;
}
