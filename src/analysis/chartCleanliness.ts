import type {
  ChartOverlayData,
  StructureBreakEvent,
  SwingPoint,
  TrendlineStructure,
} from '../types/analysis';
import type { StructureOverlayData } from '../types/structure';
import type { Candle } from '../types/market';

/**
 * Live-chart cleanliness. The chart must show only CURRENT, relevant price action —
 * never historical BOS/CHOCH, broken support/resistance, expired supply/demand, broken
 * trendlines or completed setups. Historical candles are still analysed internally
 * (structure, swings, backtesting, training); this module only decides what reaches the
 * visible canvas.
 *
 * Every rule here is deterministic and derived from confirmed candles, so a drawing is
 * removed the moment it becomes invalid, mitigated, outdated or irrelevant — and the
 * internal analysis records are never touched.
 */

/** A structure break older than this many confirmed bars is no longer "current". */
export const MAX_BREAK_AGE_BARS = 90;
/** A liquidity-sweep marker older than this many bars is faded off the chart. */
export const MAX_SWEEP_AGE_BARS = 40;
/** Swing labels are only shown for this recent a window. */
export const MAX_SWING_AGE_BARS = 30;
/** A break is invalidated once price closes this far (ATR) back through its level. */
export const BREAK_INVALIDATION_ATR = 0.5;

/** A confirmed structure break stays valid while price has not reversed back through it. */
export function isStructureBreakStillHolding(
  brk: StructureBreakEvent,
  candles: readonly Candle[],
  atr: number
): boolean {
  if (candles.length === 0 || atr <= 0) return true;
  const buffer = atr * BREAK_INVALIDATION_ATR;
  const level = brk.brokenLevel;
  // A bullish break of resistance is invalidated by a decisive close back below it.
  if (brk.direction === 'bullish') {
    const since = candles.slice(brk.index + 1);
    return !since.some((bar) => bar.close < level - buffer);
  }
  const since = candles.slice(brk.index + 1);
  return !since.some((bar) => bar.close > level + buffer);
}

function isTrendlineStillValid(line: TrendlineStructure, candles: readonly Candle[]): boolean {
  if (line.broken) return false;
  if (candles.length === 0) return true;
  // The anchor swing must still be inside the visible window (not scrolled far off).
  const firstTime = candles[0].time;
  return line.endTime >= firstTime;
}

function recentSwings(swings: readonly SwingPoint[], candleCount: number): SwingPoint[] {
  const cutoff = candleCount - MAX_SWING_AGE_BARS;
  return swings.filter((s) => s.index >= cutoff);
}

function pruneStructure(
  structure: StructureOverlayData,
  candles: readonly Candle[],
  atr: number
): StructureOverlayData {
  const candleCount = candles.length;
  const latestIndex = candleCount - 1;

  const breaks = structure.breaks.filter((brk) => {
    if (latestIndex - brk.index > MAX_BREAK_AGE_BARS) return false;
    const event: StructureBreakEvent = {
      id: brk.id,
      kind: brk.kind,
      direction: brk.direction,
      time: brk.time,
      index: brk.index,
      price: brk.closePrice,
      brokenLevel: brk.brokenLevel,
      momentumConfirmed: brk.momentumConfirmed,
      reason: brk.reason,
    };
    return isStructureBreakStillHolding(event, candles, atr);
  });

  // Only live reaction bands survive; mitigated/invalidated bands are dropped.
  const rejectionZones = structure.rejectionZones.filter(
    (z) => z.freshness !== 'MITIGATED' && z.freshness !== 'INVALIDATED'
  );

  const srBands = structure.srBands.filter((b) => b.status === 'active');

  // Watch zones are opportunities, not history: a failed / invalidated / already
  // mitigated zone must leave the chart the moment it stops being tradeable.
  const watchZones = structure.watchZones.filter(
    (z) => z.stage !== 'FAILED' && z.stage !== 'INVALIDATED' && z.freshness !== 'MITIGATED'
  );

  // Only FRESH, unfilled imbalances stay; a probed / tested / filled gap is consumed.
  const fvg = structure.fvg.filter((g) => g.freshness === 'FRESH');

  return { ...structure, breaks, rejectionZones, srBands, watchZones, fvg };
}

/**
 * Prunes a structure overlay on its own (used by the scanner, which has no full
 * {@link ChartOverlayData}). Returns null when nothing valid remains to draw.
 */
export function pruneStructureOverlay(params: {
  structure: StructureOverlayData | null;
  candles: readonly Candle[];
  atr: number;
}): StructureOverlayData | null {
  const { structure, candles, atr } = params;
  if (!structure) return null;
  return pruneStructure(structure, candles, atr);
}

/**
 * Returns a copy of the overlay data containing only drawings that are currently valid.
 * Nothing here mutates the input, and no internal analysis record is affected.
 */
export function pruneOverlaysForLiveChart(params: {
  overlays: ChartOverlayData;
  candles: readonly Candle[];
  atr: number;
}): ChartOverlayData {
  const { overlays, candles, atr } = params;
  const latestIndex = candles.length - 1;

  const structureBreaks = overlays.structureBreaks.filter(
    (brk) =>
      latestIndex - brk.index <= MAX_BREAK_AGE_BARS &&
      isStructureBreakStillHolding(brk, candles, atr)
  );

  const liquiditySweeps = overlays.liquiditySweeps.filter(
    (sweep) => latestIndex - sweep.index <= MAX_SWEEP_AGE_BARS
  );

  return {
    ...overlays,
    // Broken support/resistance is historical — keep only active levels.
    supportResistance: overlays.supportResistance.filter((lvl) => lvl.status === 'active'),
    // Expired (invalidated) supply/demand zones are removed; fresh/tested remain.
    supplyDemand: overlays.supplyDemand.filter((z) => z.status !== 'invalidated'),
    structureBreaks,
    liquiditySweeps,
    // Broken trendlines are history; keep only lines that still hold.
    trendlines: overlays.trendlines.filter((line) => isTrendlineStillValid(line, candles)),
    // A completed (confirmed) pattern is a finished setup — keep only active ones.
    patterns: overlays.patterns.filter((pat) => !pat.confirmed),
    swingPoints: recentSwings(overlays.swingPoints, candles.length),
    // Major drawings are already built from significant structure; enforce the
    // clean-chart rule once more so only valid lines and live zones reach the canvas.
    majorTrendlines: overlays.majorTrendlines.filter((l) => l.valid && !l.broken),
    majorZones: overlays.majorZones.filter((z) => z.freshness !== 'INVALIDATED'),
    structure: overlays.structure
      ? pruneStructure(overlays.structure, candles, atr)
      : null,
  };
}
