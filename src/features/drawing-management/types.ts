import type { Timeframe } from '../../types/scanner';

/**
 * Chart drawings are *annotations of validated analysis zones*, never
 * predictions the UI invents for itself.
 *
 * Blue and red are drawing semantics (rise / fall), not forecasts. A drawing
 * is only ever created from a zone the analysis produced and validated — the
 * drawing layer never derives a price of its own.
 */

export type DrawingDirection = 'RISE' | 'FALL';

/** Where the drawing came from. Only `ANALYSIS` exists today. */
export type DrawingSource = 'ANALYSIS';

export interface DrawingRecord {
  /** Stable unique id for the drawing. */
  id: string;
  /** Deriv instrument symbol the drawing belongs to (e.g. `R_100`). */
  symbol: string;
  /** Rise (blue) or fall (red). Semantics, not a forecast. */
  direction: DrawingDirection;
  /** Timeframe the zone was identified on. */
  timeframe: Timeframe;
  /** Start of the drawn window, in candle epoch seconds (chart time coordinate). */
  startEpoch: number;
  /** End of the drawn window, in candle epoch seconds. */
  endEpoch: number;
  /** Upper edge of the zone, in instrument price units. */
  upperPrice: number;
  /** Lower edge of the zone, in instrument price units. */
  lowerPrice: number;
  /** Id of the analysis that produced the zone. Drawings cannot exist without one. */
  sourceAnalysisId: string;
  /** Creation time, epoch milliseconds. */
  createdAt: number;
  source: DrawingSource;
  /** Free-text reason carried from the validated zone, for the legend/tooltip. */
  reason?: string;
}

/**
 * The minimal geometry the drawing service needs. Kept separate from
 * `DrawingRecord` so persistence (which owns identity and provenance) stays
 * decoupled from rendering (which only needs coordinates).
 */
export interface DrawingGeometry {
  from: number;
  to: number;
  top: number;
  bottom: number;
}
