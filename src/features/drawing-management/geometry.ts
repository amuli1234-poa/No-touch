import type { OverlayShape } from '../../components/chart/chartOverlays';
import type { DrawingRecord } from './types';

/**
 * Projects drawing metadata onto chart geometry.
 *
 * This is the *only* place a drawing becomes something the chart can paint, and
 * it is a pure function: it copies the stored coordinates verbatim. It never
 * re-derives a price from candles and never snaps a level, which is what keeps
 * a drawing from being silently moved to an incorrect price when the chart is
 * resized or the timeframe changes.
 *
 * Time is passed through in candle epoch seconds — the same coordinate space
 * Lightweight Charts uses — so the band stays anchored to the bars it was
 * identified against.
 */
export function drawingsToOverlayShapes(
  records: readonly DrawingRecord[],
  options: { visible: boolean; symbol: string; timeframe?: string }
): OverlayShape[] {
  if (!options.visible) return [];
  return records
    .filter((r) => r.symbol === options.symbol)
    .filter((r) => options.timeframe === undefined || r.timeframe === options.timeframe)
    .map((r) => ({
      kind: 'zone' as const,
      from: r.startEpoch,
      to: r.endEpoch,
      top: r.upperPrice,
      bottom: r.lowerPrice,
      tone: r.direction === 'RISE' ? ('rise' as const) : ('fall' as const),
      label: r.direction === 'RISE' ? 'Potential Rise' : 'Potential Fall'
    }));
}
