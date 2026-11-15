import type { Candle } from '../types/market';
import type { DsZone, DsZoneLifecycle, DsZoneOrigin, DsZoneScore, DsZoneState } from '../types/demandSupply';
import { formatPrice } from '../utils/derivParser';
import { type RawDsZone, describeFormation } from './demandSupplyDetection';

/**
 * DEMAND & SUPPLY ZONE INTELLIGENCE — tracks each zone's lifecycle and scores it 0–100.
 *
 * Lifecycle (never deleted while current):
 *   FRESH → TESTED → PARTIALLY_MITIGATED → FULLY_MITIGATED / INVALIDATED
 *
 * A zone is INVALIDATED only by a decisive close beyond the distal edge; merely reaching
 * the distal edge fully mitigates it. Weak formations never make it this far — the
 * detector already refused them.
 */

/** Minimum quality score for a zone to be considered valid / tradable. */
export const DS_MIN_ZONE_SCORE = 55;
/** Maximum current zones kept per instrument (nearest first, clutter guard). */
export const MAX_ACTIVE_ZONES = 6;
/** A close beyond the distal edge by this many ATR is a decisive invalidation. */
const INVALIDATION_BUFFER_ATR = 0.15;
/** Price further than this many ATR from the proximal edge is a "future watch" zone. */
const FUTURE_WATCH_MIN_DISTANCE_ATR = 0.8;

export interface TrackDsZonesParams {
  raw: readonly RawDsZone[];
  candles: readonly Candle[];
  atr: number;
  precision: number;
  /** M15 directional context — a zone aligned with it scores the full HTF marks. */
  htfDirection?: 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL';
  /** All tracked zones (both sides) — used to measure room to the opposing level. */
  opposingZones?: readonly DsZone[];
}

interface TrackerState {
  state: DsZoneState;
  touches: number;
  firstTestTime: number | null;
  distalReachedTime: number | null;
  invalidatedTime: number | null;
  /** Deepest penetration into the zone as a fraction of zone height (0 proximal → 1 distal). */
  maxPenetration: number;
}

function trackZone(zone: RawDsZone, candles: readonly Candle[], atr: number): TrackerState {
  const state: TrackerState = {
    state: 'FRESH',
    touches: 0,
    firstTestTime: null,
    distalReachedTime: null,
    invalidatedTime: null,
    maxPenetration: 0,
  };
  const height = Math.max(zone.upperPrice - zone.lowerPrice, 1e-9);
  const isDemand = zone.type === 'demand';

  for (let j = zone.establishedIndex + 1; j < candles.length; j++) {
    const bar = candles[j];

    // Decisive invalidation: a body close beyond the distal edge.
    if (isDemand && bar.close < zone.lowerPrice - atr * INVALIDATION_BUFFER_ATR) {
      state.state = 'INVALIDATED';
      state.invalidatedTime = bar.time;
      break;
    }
    if (!isDemand && bar.close > zone.upperPrice + atr * INVALIDATION_BUFFER_ATR) {
      state.state = 'INVALIDATED';
      state.invalidatedTime = bar.time;
      break;
    }

    const overlaps = bar.high >= zone.lowerPrice && bar.low <= zone.upperPrice;
    if (!overlaps) continue;

    state.touches++;
    if (state.firstTestTime === null) state.firstTestTime = bar.time;

    // How deep did price travel into the zone? (0 = proximal, 1 = distal)
    const penetration = isDemand
      ? (zone.upperPrice - bar.low) / height
      : (bar.high - zone.lowerPrice) / height;
    state.maxPenetration = Math.max(state.maxPenetration, Math.max(0, Math.min(1, penetration)));

    if (state.maxPenetration >= 1) state.distalReachedTime = state.distalReachedTime ?? bar.time;
  }

  if (state.state !== 'INVALIDATED') {
    if (state.maxPenetration >= 1) state.state = 'FULLY_MITIGATED';
    else if (state.maxPenetration >= 0.5) state.state = 'PARTIALLY_MITIGATED';
    else if (state.touches > 0) state.state = 'TESTED';
    else state.state = 'FRESH';
  }

  return state;
}

/** 100-point zone-quality score: origin (25) + displacement (15) + freshness (15) +
 *  BOS origin (10) + FVG (10) + HTF alignment (15) + room to target (10). */
export function scoreDsZone(
  zone: RawDsZone,
  tracker: TrackerState,
  atr: number,
  htfDirection: 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL' = 'NEUTRAL',
  roomAtr: number | null = null
): DsZoneScore {
  // Origin quality: a clean, tight base with a decisive impulse scores highest. A
  // BOS-originating zone is the highest-conviction origin of all.
  const tightness = zone.baseTightness; // 0..1
  const bosBonus = zone.causedBos ? 3 : 0;
  const formationQuality = Math.min(25, 11 + tightness * 8 + bosBonus);

  // Displacement magnitude (in ATR), saturating around 4× ATR.
  const displacement = Math.min(15, Math.round((zone.displacementAtr / 4) * 15));

  // Freshness: an untouched zone is worth the most; each state down costs value.
  const freshnessBase: Record<DsZoneState, number> = {
    FRESH: 15,
    TESTED: 11,
    PARTIALLY_MITIGATED: 6,
    FULLY_MITIGATED: 2,
    INVALIDATED: 0,
  };
  const touchPenalty = Math.min(5, Math.max(0, tracker.touches - 1) * 1.5);
  const freshness = Math.max(0, freshnessBase[tracker.state] - touchPenalty);

  const bosOrigin = zone.causedBos ? 10 : 4;
  const fvgConfluence = zone.hasFvgConfluence ? 10 : 3;

  // HTF alignment: a demand zone in a bullish M15 context (or supply in bearish) earns
  // the full marks; a zone fighting the higher timeframe earns none.
  const alignedWithHtf =
    (zone.type === 'demand' && htfDirection === 'BULLISH') ||
    (zone.type === 'supply' && htfDirection === 'BEARISH');
  const htfAlignment = alignedWithHtf ? 15 : htfDirection === 'RANGING' || htfDirection === 'NEUTRAL' ? 8 : 2;

  // Room to target: enough space to the opposing level for a realistic reaction.
  const roomToTarget =
    roomAtr === null ? 6 : roomAtr >= 3 ? 10 : roomAtr >= 2 ? 8 : roomAtr >= 1.2 ? 5 : 2;

  const total = Math.round(
    formationQuality + displacement + freshness + bosOrigin + fvgConfluence + htfAlignment + roomToTarget
  );
  return {
    formationQuality: Math.round(formationQuality),
    displacement,
    freshness,
    bosOrigin,
    fvgConfluence,
    htfAlignment,
    roomToTarget,
    total,
  };
}

function lifecycleOf(zone: RawDsZone, tracker: TrackerState): DsZoneLifecycle {
  return {
    formedTime: zone.originTime,
    formedIndex: zone.originIndex,
    firstTestTime: tracker.firstTestTime,
    distalReachedTime: tracker.distalReachedTime,
    invalidatedTime: tracker.invalidatedTime,
  };
}

/**
 * Tracks, scores and filters the raw zones. Returns the current zones (nearest first),
 * dropping fully-mitigated / invalidated zones from the active set but keeping the most
 * recently invalidated demand/supply for context.
 */
export function trackDsZones(params: TrackDsZonesParams): DsZone[] {
  const { raw, candles, atr, precision, htfDirection = 'NEUTRAL', opposingZones = [] } = params;
  if (candles.length === 0) return [];
  const price = candles[candles.length - 1].close;

  const tracked: DsZone[] = [];
  for (const zone of raw) {
    const tracker = trackZone(zone, candles, atr);
    const isDemand = zone.type === 'demand';
    const proximalPrice = isDemand ? zone.upperPrice : zone.lowerPrice;
    const distalPrice = isDemand ? zone.lowerPrice : zone.upperPrice;
    const distanceAtr = Number((Math.abs(price - proximalPrice) / Math.max(atr, 1e-9)).toFixed(2));

    // Room to the nearest opposing level (realistic reaction space), in ATR.
    const opposingEdges = opposingZones
      .filter((z) => (isDemand ? z.type === 'supply' : z.type === 'demand'))
      .map((z) => (isDemand ? z.lowerPrice : z.upperPrice))
      .filter((edge) => (isDemand ? edge > proximalPrice : edge < proximalPrice));
    const roomAtr =
      opposingEdges.length === 0
        ? null
        : Number(
            (Math.min(...opposingEdges.map((e) => Math.abs(e - proximalPrice))) / Math.max(atr, 1e-9)).toFixed(2)
          );

    const score = scoreDsZone(zone, tracker, atr, htfDirection, roomAtr);
    const origins: DsZoneOrigin[] = zone.origins ?? ['DISPLACEMENT'];

    const stateTag: Record<DsZoneState, string> = {
      FRESH: 'Fresh (untested)',
      TESTED: `Tested (${tracker.touches}×)`,
      PARTIALLY_MITIGATED: 'Partially mitigated',
      FULLY_MITIGATED: 'Fully mitigated',
      INVALIDATED: 'Invalidated',
    };
    const extras: string[] = [];
    if (zone.causedBos) extras.push('caused BOS');
    if (zone.hasFvgConfluence) extras.push('FVG confluence');
    const extraText = extras.length > 0 ? ` · ${extras.join(' · ')}` : '';

    tracked.push({
      id: zone.id,
      type: zone.type,
      formation: zone.formation,
      formationLabel: zone.formationLabel,
      state: tracker.state,
      proximalPrice,
      distalPrice,
      upperPrice: zone.upperPrice,
      lowerPrice: zone.lowerPrice,
      originTime: zone.originTime,
      originIndex: zone.originIndex,
      displacementAtr: zone.displacementAtr,
      touches: tracker.touches,
      untested: tracker.touches === 0,
      causedBos: zone.causedBos,
      origins,
      hasFvgConfluence: zone.hasFvgConfluence,
      fvg: zone.fvg,
      flipped: false,
      distanceAtr,
      // A future watch zone is still ahead of price (untouched) — where price may react NEXT.
      isFutureWatch: tracker.touches === 0 && distanceAtr >= FUTURE_WATCH_MIN_DISTANCE_ATR,
      lifecycle: lifecycleOf(zone, tracker),
      score,
      reason: `${describeFormation(zone, precision)} [${stateTag[tracker.state]}${extraText}]`,
    });
  }

  const current = tracked
    .filter((z) => z.state !== 'INVALIDATED' && z.state !== 'FULLY_MITIGATED')
    .filter((z) => z.score.total >= DS_MIN_ZONE_SCORE)
    .sort((a, b) => a.distanceAtr - b.distanceAtr)
    .slice(0, MAX_ACTIVE_ZONES);

  return current;
}

/**
 * Marks a zone as a flipped (role-reversed) level — a broken demand zone now acting as
 * supply, or a broken supply zone now acting as demand. Flipped zones are always shown
 * as current because price is now using them from the other side.
 */
export function applyFlips(zones: readonly DsZone[]): DsZone[] {
  return zones.map((z) => {
    const flippedToDemand = z.type === 'supply' && z.state === 'INVALIDATED';
    const flippedToSupply = z.type === 'demand' && z.state === 'INVALIDATED';
    if (!flippedToDemand && !flippedToSupply) return z;
    return { ...z, flipped: true };
  });
}

export function zoneStateLabel(state: DsZoneState): string {
  switch (state) {
    case 'FRESH':
      return 'FRESH';
    case 'TESTED':
      return 'TESTED';
    case 'PARTIALLY_MITIGATED':
      return 'PARTIAL';
    case 'FULLY_MITIGATED':
      return 'MITIGATED';
    default:
      return 'INVALIDATED';
  }
}

/** True when price is inside or within one ATR of the zone's proximal edge. */
export function zoneInPlay(zone: DsZone, price: number, atr: number): boolean {
  const tol = atr * 1.4;
  return price <= zone.upperPrice + tol && price >= zone.lowerPrice - tol;
}

export function zoneContains(zone: DsZone, price: number): boolean {
  return price <= zone.upperPrice && price >= zone.lowerPrice;
}

export function describeZoneBounds(zone: DsZone, precision: number): string {
  return `${formatPrice(zone.lowerPrice, precision)}–${formatPrice(zone.upperPrice, precision)}`;
}
