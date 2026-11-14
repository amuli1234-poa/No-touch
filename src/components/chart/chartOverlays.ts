import type { OpportunitySignal, ProtectedSwing, SupportResistanceZone } from '../../types/scanner';
import type { ChartStructure } from '../../engines/ChartStructureEngine';

/**
 * Turns derived chart structure into a flat list of drawable shapes.
 *
 * Keeping this pure (no canvas, no chart) means the geometry can be unit-tested
 * without a DOM, and the renderer only has to know how to paint a shape — it
 * never decides what should be on the chart.
 */

export type OverlayTone =
  | 'support'
  | 'resistance'
  | 'flipSupport'
  | 'flipResistance'
  | 'supply'
  | 'demand'
  | 'trendBull'
  | 'trendBear'
  | 'trendNeutral'
  | 'protectedHigh'
  | 'protectedLow'
  | 'patternNeckline'
  | 'patternBoundary'
  | 'patternPole'
  | 'breakout'
  | 'rise'
  | 'fall';

export interface OverlayPreferences {
  showTrendlines: boolean;
  showSupportResistance: boolean;
  showSupplyDemand: boolean;
  showBreakoutLevels: boolean;
  showProtectedSwings: boolean;
  showChartPatterns: boolean;
}

export const DEFAULT_OVERLAY_PREFERENCES: OverlayPreferences = {
  showTrendlines: true,
  showSupportResistance: true,
  showSupplyDemand: true,
  showBreakoutLevels: true,
  showProtectedSwings: true,
  showChartPatterns: true
};

export type OverlayShape =
  | {
      kind: 'zone';
      from: number;
      to: number;
      top: number;
      bottom: number;
      tone: OverlayTone;
      label?: string;
      /** Flip zones draw a dashed mid-line as well as the band. */
      midline?: boolean;
    }
  | {
      kind: 'segment';
      fromEpoch: number;
      fromPrice: number;
      toEpoch: number;
      toPrice: number;
      tone: OverlayTone;
      dashed?: boolean;
      width?: number;
    }
  | {
      kind: 'level';
      from: number;
      to: number;
      price: number;
      tone: OverlayTone;
      dashed?: boolean;
      label?: string;
      /** Draw a dot at the level's origin, e.g. a protected swing. */
      dotEpoch?: number;
    };

interface BuildArgs {
  structure: ChartStructure;
  opportunity?: OpportunitySignal;
  preferences: OverlayPreferences;
  /** Visible epoch bounds, used to extend zones/lines to the right edge. */
  lastEpoch: number;
}

/** Zones extend to the right edge of the visible data, like the old chart. */
function zoneShapes(
  zones: SupportResistanceZone[],
  isSupport: boolean,
  lastEpoch: number,
  prefs: OverlayPreferences
): OverlayShape[] {
  const out: OverlayShape[] = [];
  for (const zone of zones) {
    const isFlip = Boolean(zone.isFlip);
    const isSd = Boolean(zone.hasBaseFormation || (zone.causedDisplacement && !zone.isFlip));

    // A zone belongs to exactly one toggle; flip zones are their own category
    // and are always shown with S/R, matching the original behaviour.
    if (isFlip && !prefs.showSupportResistance) continue;
    if (!isFlip && isSd && !prefs.showSupplyDemand) continue;
    if (!isFlip && !isSd && !prefs.showSupportResistance) continue;

    const from = zone.originEpoch;
    const to = Math.max(lastEpoch, from);
    const mid = (zone.upperPrice + zone.lowerPrice) / 2;

    if (isFlip) {
      out.push({
        kind: 'zone',
        from,
        to,
        top: zone.upperPrice,
        bottom: zone.lowerPrice,
        tone: isSupport ? 'flipSupport' : 'flipResistance',
        midline: true,
        label: `${isSupport ? 'R→S FLIP' : 'S→R FLIP'}`
      });
      continue;
    }

    out.push({
      kind: 'zone',
      from,
      to,
      top: zone.upperPrice,
      bottom: zone.lowerPrice,
      tone: isSd ? (isSupport ? 'demand' : 'supply') : isSupport ? 'support' : 'resistance',
      label: isSd
        ? `${zone.fresh ? 'Fresh ' : ''}${isSupport ? 'Demand' : 'Supply'}`
        : `${zone.tier === 'MAJOR' ? 'Major ' : ''}${isSupport ? 'Support' : 'Resistance'}`
    });
    void mid;
  }
  return out;
}

function swingShape(swing: ProtectedSwing | null, tone: OverlayTone, lastEpoch: number): OverlayShape[] {
  if (!swing) return [];
  return [
    {
      kind: 'level',
      from: swing.epoch,
      to: Math.max(lastEpoch, swing.epoch),
      price: swing.price,
      tone,
      dashed: true,
      dotEpoch: swing.epoch,
      label: `${swing.type === 'HIGH' ? 'Prot High' : 'Prot Low'}`
    }
  ];
}

export function buildOverlays({ structure, opportunity, preferences, lastEpoch }: BuildArgs): OverlayShape[] {
  const shapes: OverlayShape[] = [];

  shapes.push(
    ...zoneShapes(structure.supportZones, true, lastEpoch, preferences),
    ...zoneShapes(structure.resistanceZones, false, lastEpoch, preferences)
  );

  if (
    preferences.showBreakoutLevels &&
    opportunity?.tradingRange.isValid &&
    opportunity.tradingRange.breakoutState !== 'INSIDE_RANGE'
  ) {
    const isBull = opportunity.tradingRange.breakoutState === 'BULLISH_BREAKOUT_RETEST';
    const price = isBull ? opportunity.tradingRange.rangeHigh : opportunity.tradingRange.rangeLow;
    shapes.push({
      kind: 'level',
      from: structure.trendlines.length > 0 ? structure.trendlines[0].startEpoch : lastEpoch,
      to: lastEpoch,
      price,
      tone: 'breakout',
      dashed: true,
      label: 'Breakout/Retest'
    });
  }

  if (preferences.showTrendlines) {
    for (const tl of structure.trendlines) {
      shapes.push({
        kind: 'segment',
        fromEpoch: tl.startEpoch,
        fromPrice: tl.startPrice,
        toEpoch: tl.endEpoch,
        toPrice: tl.endPrice,
        tone: tl.direction === 'BULLISH' ? 'trendBull' : tl.direction === 'BEARISH' ? 'trendBear' : 'trendNeutral',
        dashed: tl.event === 'BREAKOUT' || tl.event === 'RETEST',
        width: tl.event === 'BREAKOUT' || tl.event === 'RETEST' ? 1.5 : 1.2
      });
    }
  }

  if (preferences.showProtectedSwings) {
    shapes.push(
      ...swingShape(structure.protectedHigh, 'protectedHigh', lastEpoch),
      ...swingShape(structure.protectedLow, 'protectedLow', lastEpoch)
    );
  }

  const pattern = structure.confirmedPattern;
  if (preferences.showChartPatterns && pattern) {
    for (const line of pattern.lines) {
      shapes.push({
        kind: 'segment',
        fromEpoch: line.startEpoch,
        fromPrice: line.startPrice,
        toEpoch: line.endEpoch,
        toPrice: line.endPrice,
        tone:
          line.kind === 'NECKLINE'
            ? 'patternNeckline'
            : line.kind === 'POLE'
              ? 'patternPole'
              : 'patternBoundary',
        dashed: line.kind === 'NECKLINE',
        width: line.kind === 'NECKLINE' ? 1.5 : 1.35
      });
    }
  }

  return shapes;
}
