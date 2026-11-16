import type { MarketDirection, SignalQualityTier } from '../types/analysis';
import type { FutureReactionZone, SetupStage, ZoneFreshness } from '../types/structure';

/**
 * WATCHING-ZONE EXPECTATION.
 *
 * Turns one fresh, untested future-reaction zone into a precise, explainable expectation:
 * what the market is likely to do WHEN price reaches the zone, why, what confirmation is
 * required before an entry is valid, and what cancels the idea. It never predicts a
 * reversal by default — a direction is only shown when the zone carries real evidence,
 * otherwise the verdict is WAITING FOR CONFIRMATION.
 */

export type ZoneType =
  | 'Demand'
  | 'Supply'
  | 'Support'
  | 'Resistance'
  | 'Breakout retest';

export type ExpectedReaction = 'RISE' | 'FALL' | 'WAITING_FOR_CONFIRMATION';

export interface WatchZoneExpectation {
  marketDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  zone: {
    id: string;
    low: number;
    high: number;
    type: ZoneType;
    sourceStructure: string;
    freshness: ZoneFreshness;
    stage: SetupStage;
    approachProgress: number;
    distanceAtr: number;
    reactions: number;
  };
  expectedReaction: ExpectedReaction;
  /** Why the reaction is expected — the buyers'/sellers' case. */
  reason: string;
  /** What price must do before the setup becomes valid. */
  confirmationRequired: string;
  invalidation: { level: number; condition: string };
  /** Potential targets, only where justified by structural levels. */
  targets: { tp1: number | null; tp2: number | null; tp3: number | null; justified: boolean };
  quality: { score: number; tier: SignalQualityTier; confidence: string };
  /** Fresh zones only — a stale / tested / failed zone is never a fresh opportunity. */
  isFreshOpportunity: boolean;
}

/** A zone that has already been consumed or failed can never be a fresh opportunity. */
export function isFreshWatchZone(zone: FutureReactionZone): boolean {
  if (zone.stage === 'FAILED' || zone.stage === 'INVALIDATED') return false;
  if (zone.freshness === 'MITIGATED' || zone.freshness === 'INVALIDATED') return false;
  return true;
}

function classifyZoneType(zone: FutureReactionZone): ZoneType {
  const source = zone.sourceStructure.toLowerCase();
  if (source.includes('break') || source.includes('retest')) return 'Breakout retest';
  if (zone.kind === 'support') return zone.direction === 'RISE' ? 'Demand' : 'Support';
  return zone.direction === 'FALL' ? 'Supply' : 'Resistance';
}

function mapMarketDirection(direction: MarketDirection | null, zone: FutureReactionZone): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (direction === 'BULLISH') return 'BULLISH';
  if (direction === 'BEARISH') return 'BEARISH';
  // Fall back to the zone's own expected reaction so the panel is never directionless
  // when the engine already has a read.
  if (zone.direction === 'RISE') return 'BULLISH';
  if (zone.direction === 'FALL') return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * A direction is only asserted when the zone is fresh AND carries evidence. A weak or
 * evidence-free zone yields WAITING FOR CONFIRMATION — the AI never forces a reversal call.
 */
function decideReaction(zone: FutureReactionZone, fresh: boolean): ExpectedReaction {
  if (!fresh) return 'WAITING_FOR_CONFIRMATION';
  const hasEvidence = zone.evidence.length > 0 || zone.reason.trim().length > 0;
  if (!hasEvidence) return 'WAITING_FOR_CONFIRMATION';
  // A merely detected zone (price still far) has no confirmed reaction yet.
  if (zone.stage === 'ZONE_DETECTED') return 'WAITING_FOR_CONFIRMATION';
  return zone.direction;
}

function buildReason(
  zone: FutureReactionZone,
  type: ZoneType,
  reaction: ExpectedReaction
): string {
  const side = reaction === 'FALL' ? 'sellers' : 'buyers';
  const lead = `${type} zone (${zone.sourceStructure}).`;
  if (reaction === 'WAITING_FOR_CONFIRMATION') {
    return `${lead} No confirmed reaction yet — the engine is waiting for price to reach the zone and show a decisive response before choosing a direction.`;
  }
  const evidence = zone.evidence.length > 0 ? ` ${zone.evidence.join('; ')}.` : '';
  const reactionCount = zone.reactions > 0 ? ` The level has produced ${zone.reactions} prior reaction(s).` : '';
  return `${lead} ${side.charAt(0).toUpperCase() + side.slice(1)} are expected to defend it: ${zone.reason}.${evidence}${reactionCount}`;
}

function buildConfirmation(zone: FutureReactionZone, reaction: ExpectedReaction): string {
  if (reaction === 'WAITING_FOR_CONFIRMATION') {
    return 'Wait for price to reach the zone and print a decisive reaction candle (rejection wick plus body close) before considering any entry.';
  }
  const isRise = reaction === 'RISE';
  const boundary = isRise ? 'the upper edge' : 'the lower edge';
  return `Price must reach the zone and close back ${isRise ? 'up' : 'down'} from ${boundary} with a rejection wick or displacement — a confirmed reaction, not a mere touch.`;
}

function buildTargets(
  zone: FutureReactionZone,
  reaction: ExpectedReaction,
  opposingLevels: readonly number[],
  atr: number
): { tp1: number | null; tp2: number | null; tp3: number | null; justified: boolean } {
  if (reaction === 'WAITING_FOR_CONFIRMATION') {
    return { tp1: null, tp2: null, tp3: null, justified: false };
  }
  const isRise = reaction === 'RISE';
  // Only structural levels ahead of price justify a target — never an invented number.
  const ahead = opposingLevels
    .filter((level) => (isRise ? level > zone.upperPrice : level < zone.lowerPrice))
    .sort((a, b) => (isRise ? a - b : b - a));
  const targets = ahead.slice(0, 3);
  // When structure gives no reachable level, a single ATR-projected target is used only
  // if the zone distance is meaningful; otherwise no target is claimed.
  if (targets.length === 0 && atr > 0) {
    const edge = isRise ? zone.upperPrice : zone.lowerPrice;
    const projected = isRise ? edge + atr * 2 : edge - atr * 2;
    return { tp1: projected, tp2: null, tp3: null, justified: false };
  }
  return {
    tp1: targets[0] ?? null,
    tp2: targets[1] ?? null,
    tp3: targets[2] ?? null,
    justified: targets.length > 0,
  };
}

function scoreQuality(
  zone: FutureReactionZone,
  reaction: ExpectedReaction,
  targetCount: number
): { score: number; tier: SignalQualityTier; confidence: string } {
  let score = 40;
  if (zone.freshness === 'FRESH') score += 20;
  else if (zone.freshness === 'PROBED') score += 12;
  else if (zone.freshness === 'PARTIALLY_TESTED') score += 6;
  if (zone.stage === 'PRICE_APPROACHING') score += 12;
  else if (zone.stage === 'ENTRY_CONFIRMED') score += 20;
  score += Math.min(zone.reactions, 3) * 4;
  score += Math.min(zone.evidence.length, 4) * 3;
  if (reaction === 'WAITING_FOR_CONFIRMATION') score = Math.min(score, 55);
  score += Math.min(targetCount, 3) * 3;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const tier: SignalQualityTier =
    score >= 90 ? 'EXCEPTIONAL' : score >= 80 ? 'HIGH QUALITY' : score >= 60 ? 'DEVELOPING' : 'INVALID SETUP';
  const confidence =
    reaction === 'WAITING_FOR_CONFIRMATION'
      ? 'Low — awaiting a confirmed reaction'
      : score >= 90
        ? 'Very high'
        : score >= 80
          ? 'High'
          : score >= 60
            ? 'Moderate'
            : 'Low';
  return { score, tier, confidence };
}

export interface BuildWatchZoneExpectationParams {
  zone: FutureReactionZone;
  /** Current market direction read from the analysis report. */
  overallDirection: MarketDirection | null;
  /** ATR of the analysed timeframe, used only for a fallback target projection. */
  atr: number;
  /** Structural levels (S/R, opposing zones) used to justify targets. */
  opposingLevels: readonly number[];
}

/** Builds the full expectation for one watching zone. Pure — no side effects. */
export function buildWatchZoneExpectation({
  zone,
  overallDirection,
  atr,
  opposingLevels,
}: BuildWatchZoneExpectationParams): WatchZoneExpectation {
  const fresh = isFreshWatchZone(zone);
  const type = classifyZoneType(zone);
  const reaction = decideReaction(zone, fresh);
  const targets = buildTargets(zone, reaction, opposingLevels, atr);
  const targetCount = [targets.tp1, targets.tp2, targets.tp3].filter((t) => t !== null).length;
  const quality = scoreQuality(zone, reaction, targetCount);

  return {
    marketDirection: mapMarketDirection(overallDirection, zone),
    zone: {
      id: zone.id,
      low: Math.min(zone.lowerPrice, zone.upperPrice),
      high: Math.max(zone.lowerPrice, zone.upperPrice),
      type,
      sourceStructure: zone.sourceStructure,
      freshness: zone.freshness,
      stage: zone.stage,
      approachProgress: zone.approachProgress,
      distanceAtr: zone.distanceAtr,
      reactions: zone.reactions,
    },
    expectedReaction: reaction,
    reason: buildReason(zone, type, reaction),
    confirmationRequired: buildConfirmation(zone, reaction),
    invalidation: { level: zone.invalidationLevel, condition: zone.invalidationCondition },
    targets,
    quality,
    isFreshOpportunity: fresh,
  };
}

/**
 * Picks the single best watching zone to explain: fresh, untested zones only, preferring
 * the one closest to price (highest approach progress). Tested/mitigated zones are never
 * returned as fresh opportunities.
 */
export function selectPrimaryWatchZone(
  zones: readonly FutureReactionZone[]
): FutureReactionZone | null {
  const fresh = zones.filter(isFreshWatchZone);
  if (fresh.length === 0) return null;
  return [...fresh].sort((a, b) => {
    if (b.approachProgress !== a.approachProgress) return b.approachProgress - a.approachProgress;
    return a.distanceAtr - b.distanceAtr;
  })[0];
}
