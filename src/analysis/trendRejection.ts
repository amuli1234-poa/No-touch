import type { SupportResistanceLevel, SupplyDemandZone } from '../types/analysis';
import type {
  TrendlineAlignment,
  TrendlineLine,
  TrendlineSetupZone,
  TrendlineZoneFreshness,
  TrendlineZoneSource,
} from '../types/trendline';
import { formatPrice } from '../utils/derivParser';
import { linePriceAtTime } from './trendlineDetection';

/**
 * TREND-ALIGNED FUTURE SETUP ZONES.
 *
 * Builds the zones price would need to PULL BACK into (uptrend) or RETRACE into
 * (downtrend) for a trend-continuation rejection:
 *  - uptrend → zones BELOW price (blue): support, demand, previous resistance turned
 *    support, rising trendlines;
 *  - downtrend → zones ABOVE price (red): resistance, supply, previous support turned
 *    resistance, falling trendlines.
 *
 * Only the nearest valid, trend-side zones are returned (fresh/untested first). These are
 * locations to WATCH — never an entry on their own.
 */

/** Maximum number of future zones surfaced per instrument (nearest first). */
export const MAX_SETUP_ZONES = 3;
/** A trendline boundary is drawn as a thin band around the projected price. */
const TRENDLINE_BAND_ATR = 0.3;
/** A horizontal level / S-R zone band half-width, in ATR. */
const LEVEL_BAND_ATR = 0.28;
/** A zone must sit on the trend side of price, within this ATR slack. */
const SIDE_SLACK_ATR = 0.2;
/** Beyond this many ATR away a zone is no longer a "future setup" worth showing. */
const MAX_DISTANCE_ATR = 12;
/** Touches at or above this mark a zone as well-worn (weakened). */
const WORN_TOUCHES = 4;

export interface SetupZoneInput {
  price: number;
  atr: number;
  precision: number;
  alignment: TrendlineAlignment;
  trendlines: readonly TrendlineLine[];
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
  /** Latest confirmed bar time — used to project sloping trendlines. */
  lastTime: number;
}

function freshnessFromTouches(touches: number): TrendlineZoneFreshness {
  if (touches <= 2) return 'FRESH';
  if (touches < WORN_TOUCHES) return 'TESTED';
  return 'WEAKENED';
}

function band(center: number, halfWidth: number): { upperPrice: number; lowerPrice: number } {
  return { upperPrice: center + halfWidth, lowerPrice: center - halfWidth };
}

/**
 * Builds the trend-aligned future setup zones and returns the nearest valid ones,
 * freshest first. Returns [] when the market has no tradable trend (WAIT).
 */
export function buildTrendSetupZones(input: SetupZoneInput): TrendlineSetupZone[] {
  const { price, atr, alignment, trendlines, supportResistance, supplyDemand, lastTime, precision } =
    input;
  const allowed = alignment.tradableDirection;
  if (!allowed || atr <= 0) return [];

  const isRise = allowed === 'RISE';
  const zones: TrendlineSetupZone[] = [];

  // A zone qualifies only when it sits on the trend side of price: the whole band must be
  // at/below price for a RISE continuation (and at/above for FALL), within a small slack.
  const sideOk = (zone: TrendlineSetupZone): boolean =>
    isRise
      ? zone.upperPrice <= price + atr * SIDE_SLACK_ATR
      : zone.lowerPrice >= price - atr * SIDE_SLACK_ATR;

  const push = (zone: TrendlineSetupZone): void => {
    if (!sideOk(zone)) return;
    if (zone.distanceAtr > MAX_DISTANCE_ATR) return;
    zones.push(zone);
  };

  // ---- 1. Trendlines: rising support below price (RISE) / falling resistance above (FALL) ----
  for (const line of trendlines) {
    const projected = linePriceAtTime(line, lastTime);
    if (isRise) {
      // A valid support line below price, or a broken resistance now acting as support.
      const isFlippedSupport = line.broken && line.kind === 'resistance';
      const isLiveSupport = !line.broken && line.valid && line.kind === 'support';
      if (!isFlippedSupport && !isLiveSupport) continue;
      const source: TrendlineZoneSource = isFlippedSupport ? 'flipped-support' : 'trendline';
      // A trendline is "fresh" while it still has only its anchor reactions; once price
      // has leaned on it repeatedly it is a well-worn (TESTED) boundary.
      const freshness: TrendlineZoneFreshness = isFlippedSupport
        ? 'FRESH'
        : line.touches <= 3
          ? 'FRESH'
          : 'TESTED';
      const b = band(projected, atr * TRENDLINE_BAND_ATR);
      push({
        id: `zone-${source}-${line.id}`,
        direction: 'RISE',
        source,
        label: isFlippedSupport
          ? 'Previous resistance turned support'
          : `${line.touches}-touch rising support trendline`,
        ...b,
        projectedPrice: projected,
        distanceAtr: Number((Math.abs(price - projected) / atr).toFixed(2)),
        freshness,
        touches: line.touches,
        untested: line.touches <= 2,
        valid: true,
        invalidReason: '',
        trendline: line,
        reason: isFlippedSupport
          ? `Broken resistance at ${formatPrice(projected, precision)} now acts as support — watch for a bullish rejection on the pullback.`
          : `${line.reason} Watch for a bullish rejection on the pullback into it.`,
      });
    } else {
      const isFlippedResistance = line.broken && line.kind === 'support';
      const isLiveResistance = !line.broken && line.valid && line.kind === 'resistance';
      if (!isFlippedResistance && !isLiveResistance) continue;
      const source: TrendlineZoneSource = isFlippedResistance ? 'flipped-resistance' : 'trendline';
      const freshness: TrendlineZoneFreshness = isFlippedResistance
        ? 'FRESH'
        : line.touches <= 3
          ? 'FRESH'
          : 'TESTED';
      const b = band(projected, atr * TRENDLINE_BAND_ATR);
      push({
        id: `zone-${source}-${line.id}`,
        direction: 'FALL',
        source,
        label: isFlippedResistance
          ? 'Previous support turned resistance'
          : `${line.touches}-touch falling resistance trendline`,
        ...b,
        projectedPrice: projected,
        distanceAtr: Number((Math.abs(price - projected) / atr).toFixed(2)),
        freshness,
        touches: line.touches,
        untested: line.touches <= 2,
        valid: true,
        invalidReason: '',
        trendline: line,
        reason: isFlippedResistance
          ? `Broken support at ${formatPrice(projected, precision)} now acts as resistance — watch for a bearish rejection on the retrace.`
          : `${line.reason} Watch for a bearish rejection on the retrace into it.`,
      });
    }
  }

  // ---- 2. Support / resistance levels (and role-reversed flips) ----
  for (const level of supportResistance) {
    const isRiseLevel = level.type === 'support';
    if (isRise && !isRiseLevel) continue;
    if (!isRise && isRiseLevel) continue;
    // A broken support is now resistance (FALL); a broken resistance is now support (RISE).
    const flipped = level.status === 'broken';
    const source: TrendlineZoneSource = flipped
      ? isRise
        ? 'flipped-support'
        : 'flipped-resistance'
      : isRise
        ? 'support'
        : 'resistance';
    const freshness: TrendlineZoneFreshness = flipped ? 'FRESH' : freshnessFromTouches(level.touches);
    const b = band(level.price, atr * LEVEL_BAND_ATR);
    push({
      id: `zone-${source}-${level.id}`,
      direction: allowed,
      source,
      label: flipped
        ? `Broken ${isRise ? 'resistance' : 'support'} (flip) · ${level.touches}x`
        : `${level.importance} ${isRise ? 'support' : 'resistance'} · ${level.touches}x`,
      ...b,
      projectedPrice: level.price,
      distanceAtr: Number((Math.abs(price - level.price) / atr).toFixed(2)),
      freshness,
      touches: level.touches,
      untested: level.touches <= 2,
      valid: true,
      invalidReason: '',
      trendline: null,
      reason: flipped
        ? `Broken ${isRise ? 'resistance' : 'support'} at ${formatPrice(
            level.price,
            precision
          )} flipped role — watch for a ${isRise ? 'bullish' : 'bearish'} rejection.`
        : level.reason,
    });
  }

  // ---- 3. Supply / demand zones ----
  for (const zone of supplyDemand) {
    if (zone.status === 'invalidated') continue;
    const isDemand = zone.type === 'demand';
    if (isRise && !isDemand) continue;
    if (!isRise && isDemand) continue;
    const center = (zone.upperPrice + zone.lowerPrice) / 2;
    const freshness: TrendlineZoneFreshness =
      zone.status === 'fresh'
        ? 'FRESH'
        : zone.status === 'tested'
          ? 'TESTED'
          : 'WEAKENED';
    push({
      id: `zone-${isDemand ? 'demand' : 'supply'}-${zone.id}`,
      direction: allowed,
      source: isDemand ? 'demand' : 'supply',
      label: `${zone.status === 'fresh' ? 'Fresh' : 'Tested'} ${isDemand ? 'demand' : 'supply'} zone`,
      upperPrice: zone.upperPrice,
      lowerPrice: zone.lowerPrice,
      projectedPrice: center,
      distanceAtr: Number((Math.abs(price - center) / atr).toFixed(2)),
      freshness,
      touches: zone.touches,
      untested: zone.status === 'fresh',
      valid: true,
      invalidReason: '',
      trendline: null,
      reason: zone.reason,
    });
  }

  // Nearest, freshest first: rank = distance (ATR) + a freshness penalty, so distance
  // dominates but a fresh zone edges out a well-worn one at a similar distance.
  const freshnessPenalty: Record<TrendlineZoneFreshness, number> = {
    FRESH: 0,
    TESTED: 0.5,
    WEAKENED: 1.5,
  };
  return zones
    .sort(
      (a, b) =>
        a.distanceAtr + freshnessPenalty[a.freshness] -
        (b.distanceAtr + freshnessPenalty[b.freshness])
    )
    .slice(0, MAX_SETUP_ZONES);
}

/**
 * Picks the nearest trend-side setup zone that price is currently interacting with, so
 * the candidate detection only considers genuine, trend-aligned boundaries.
 */
export function nearestZoneInPlay(
  zones: readonly TrendlineSetupZone[],
  price: number,
  atr: number
): TrendlineSetupZone | null {
  const tol = atr * 1.8;
  const inPlay = zones.filter((z) => Math.abs(price - z.projectedPrice) <= tol);
  if (inPlay.length === 0) return null;
  return inPlay.sort((a, b) => a.distanceAtr - b.distanceAtr)[0];
}
