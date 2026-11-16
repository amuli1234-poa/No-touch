import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  ITimeScaleApi,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  FairValueGap,
  FutureReactionZone,
  RejectionZone,
  StructureBias,
  StructureOverlayData,
  SupportResistanceBand,
} from '../../types/structure';
import {
  MARKUP_ALPHA,
  MARKUP_COLORS,
  MARKUP_DASH,
  MARKUP_LINE,
  drawTag,
  hexToRgba,
} from './markupStyle';

/**
 * AI Chart Structure overlay: draws only the CURRENT, valid structure on the candle
 * canvas — confirmed BOS/CHOCH, support/resistance and rejection bands, and the fresh
 * future reaction (watch) zones. It draws nothing that has been mitigated or invalidated,
 * so the live chart stays clean.
 *
 * Every drawing follows the minimalist markup style (thin lines, barely-there fills, short
 * S / R / SZ / DZ / BOS / CHoCH / FVG / WATCH labels) so the candles stay the focus.
 */
class StructureRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: StructureChartPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chart;
    const series = this.source.series;
    const overlay = this.source.overlay;
    if (!chart || !series || !overlay) return;

    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width;
      const height = mediaSize.height;
      if (width <= 0) return;
      ctx.save();
      ctx.textBaseline = 'middle';

      // ---- Support / resistance bands (drawn behind everything) ----
      for (const band of overlay.srBands) {
        this.drawBand(ctx, series, width, band);
      }

      // ---- Rejection bands ----
      for (const zone of overlay.rejectionZones) {
        this.drawRejectionBand(ctx, series, width, zone);
      }

      // ---- Fresh fair value gaps (unfilled imbalances) ----
      if (overlay.showFvg !== false) {
        for (const gap of overlay.fvg) {
          this.drawFvg(ctx, series, width, timeScale, gap);
        }
      }

      // ---- Future reaction watch zones (the opportunity layer) ----
      for (const zone of overlay.watchZones) {
        this.drawWatchZone(ctx, series, width, height, timeScale, zone);
      }

      // ---- Confirmed BOS / CHOCH: a small marker at the exact break ----
      for (const brk of overlay.breaks) {
        const y = series.priceToCoordinate(brk.brokenLevel);
        if (y === null) continue;
        const isBull = brk.direction === 'bullish';
        const color = brk.kind === 'CHOCH' ? MARKUP_COLORS.choch : MARKUP_COLORS.bos;
        const x = timeScale.timeToCoordinate(brk.time as UTCTimestamp);
        const xStart = x === null ? width - 70 : Math.max(0, x - 70);

        // Thin level line from the break to the right edge.
        ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edgeSoft);
        ctx.lineWidth = MARKUP_LINE.hair;
        ctx.setLineDash(brk.kind === 'CHOCH' ? MARKUP_DASH.dotted : MARKUP_DASH.subtle);
        ctx.beginPath();
        ctx.moveTo(xStart, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small marker sitting on the broken level, near the actual break.
        const markerX = x === null ? width - 24 : x;
        ctx.fillStyle = color;
        ctx.beginPath();
        if (isBull) {
          ctx.moveTo(markerX, y - 6);
          ctx.lineTo(markerX - 3.5, y - 1);
          ctx.lineTo(markerX + 3.5, y - 1);
        } else {
          ctx.moveTo(markerX, y + 6);
          ctx.lineTo(markerX - 3.5, y + 1);
          ctx.lineTo(markerX + 3.5, y + 1);
        }
        ctx.closePath();
        ctx.fill();

        drawTag(ctx, {
          x: markerX + 5,
          y: isBull ? y - 7 : y + 7,
          text: brk.kind === 'CHOCH' ? 'CHoCH' : 'BOS',
          color,
        });
      }

      ctx.restore();
    });
  }

  private drawBand(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    band: SupportResistanceBand
  ): void {
    const yTop = series.priceToCoordinate(band.upperPrice);
    const yBot = series.priceToCoordinate(band.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const isResistance = band.type === 'resistance';
    const color = isResistance ? MARKUP_COLORS.resistance : MARKUP_COLORS.support;

    ctx.fillStyle = hexToRgba(color, MARKUP_ALPHA.fill);
    ctx.fillRect(0, top, width, h);
    ctx.strokeStyle = hexToRgba(
      color,
      band.importance === 'major' ? MARKUP_ALPHA.edge : MARKUP_ALPHA.edgeSoft
    );
    ctx.lineWidth = MARKUP_LINE.hair;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(width, top);
    ctx.moveTo(0, top + h);
    ctx.lineTo(width, top + h);
    ctx.stroke();

    // Short label: S / R plus touch count. Price lives in the crosshair + legend.
    drawTag(ctx, {
      x: width - 6,
      y: top + h / 2,
      align: 'right',
      text: `${isResistance ? 'R' : 'S'} ${band.touches}x`,
      color,
    });
  }

  private drawRejectionBand(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    zone: RejectionZone
  ): void {
    const yTop = series.priceToCoordinate(zone.upperPrice);
    const yBot = series.priceToCoordinate(zone.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const color = zone.direction === 'RISE' ? MARKUP_COLORS.support : MARKUP_COLORS.resistance;

    ctx.fillStyle = hexToRgba(color, MARKUP_ALPHA.fill);
    ctx.fillRect(0, top, width, h);
    ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edgeSoft);
    ctx.lineWidth = MARKUP_LINE.hair;
    ctx.setLineDash(MARKUP_DASH.subtle);
    ctx.strokeRect(0.5, top + 0.5, width - 1, h - 1);
    ctx.setLineDash([]);

    // Short label: DZ (demand / rise) / SZ (supply / fall).
    drawTag(ctx, {
      x: 6,
      y: top + h / 2,
      text: zone.direction === 'RISE' ? 'DZ' : 'SZ',
      color,
    });
  }

  private drawFvg(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    timeScale: ITimeScaleApi<Time>,
    gap: FairValueGap
  ): void {
    const yTop = series.priceToCoordinate(gap.upperPrice);
    const yBot = series.priceToCoordinate(gap.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const color = MARKUP_COLORS.fvg;

    // Gaps are drawn from their formation time onwards only.
    const xOrigin = timeScale.timeToCoordinate(gap.time as UTCTimestamp);
    const xStart = xOrigin === null ? 0 : Math.max(0, Math.min(width, xOrigin));
    const zoneW = Math.max(0, width - xStart);
    if (zoneW <= 0) return;

    ctx.fillStyle = hexToRgba(color, MARKUP_ALPHA.fill);
    ctx.fillRect(xStart, top, zoneW, h);
    ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edgeSoft);
    ctx.lineWidth = MARKUP_LINE.hair;
    ctx.setLineDash(MARKUP_DASH.dotted);
    ctx.strokeRect(xStart + 0.5, top + 0.5, Math.max(0, zoneW - 1), h - 1);
    ctx.setLineDash([]);

    drawTag(ctx, {
      x: Math.max(6, Math.min(width - 34, xStart + 4)),
      y: Math.max(7, top - 8),
      text: 'FVG',
      color,
    });
  }

  private drawWatchZone(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    height: number,
    timeScale: ITimeScaleApi<Time>,
    zone: FutureReactionZone
  ): void {
    const yTop = series.priceToCoordinate(zone.upperPrice);
    const yBot = series.priceToCoordinate(zone.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const isRise = zone.direction === 'RISE';
    const approaching = zone.stage === 'PRICE_APPROACHING' || zone.stage === 'ENTRY_CONFIRMED';
    const color = isRise ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;

    // Only draw the zone from its formation time onwards.
    const xOrigin = timeScale.timeToCoordinate(zone.originTime as UTCTimestamp);
    const xStart = xOrigin === null ? 0 : Math.max(0, Math.min(width, xOrigin));

    ctx.fillStyle = hexToRgba(color, approaching ? MARKUP_ALPHA.fillActive : MARKUP_ALPHA.fill);
    ctx.fillRect(xStart, top, Math.max(0, width - xStart), h);

    // Active / approaching zones get a marginally firmer edge; distant ones stay faint.
    ctx.strokeStyle = hexToRgba(color, approaching ? MARKUP_ALPHA.edge : MARKUP_ALPHA.edgeSoft);
    ctx.lineWidth = approaching ? MARKUP_LINE.edge : MARKUP_LINE.hair;
    ctx.setLineDash(approaching ? MARKUP_DASH.solid : MARKUP_DASH.subtle);
    ctx.strokeRect(xStart + 0.5, top + 0.5, Math.max(0, width - xStart - 1), h - 1);
    ctx.setLineDash([]);

    // Invalidation level (faint dotted guard line).
    const yInv = series.priceToCoordinate(zone.invalidationLevel);
    if (yInv !== null) {
      ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.guard);
      ctx.lineWidth = MARKUP_LINE.hair;
      ctx.setLineDash(MARKUP_DASH.dotted);
      ctx.beginPath();
      ctx.moveTo(xStart, yInv);
      ctx.lineTo(width, yInv);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // One short label only: WATCH, escalating to APPROACH / ENTRY when price is close.
    const label = zone.stage === 'ENTRY_CONFIRMED' ? 'ENTRY' : approaching ? 'APPROACH' : 'WATCH';
    const tagY = Math.max(7, Math.min(height - 7, top - 8));
    drawTag(ctx, { x: Math.max(6, xStart + 4), y: tagY, text: label, color });
  }
}

class StructurePaneView implements IPrimitivePaneView {
  constructor(private readonly source: StructureChartPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (!this.source.chart || !this.source.series || !this.source.overlay) return null;
    return new StructureRenderer(this.source);
  }
}

export interface StructureChartOverlay extends StructureOverlayData {
  precision: number;
  /** Whether fresh fair value gaps are drawn (settings toggle). */
  showFvg?: boolean;
}

/**
 * Draws the structure & future-opportunity layer on the candle canvas. Zones stay
 * pinned to their exact times/prices through zoom, pan and resize.
 */
export class StructureChartPrimitive implements ISeriesPrimitive<Time> {
  chart: SeriesAttachedParameter<Time, SeriesType>['chart'] | null = null;
  series: SeriesAttachedParameter<Time, SeriesType>['series'] | null = null;
  overlay: StructureChartOverlay | null = null;
  private requestUpdate?: () => void;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor() {
    this._paneViews = [new StructurePaneView(this)];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
    this.requestUpdate();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = undefined;
  }

  setOverlay(overlay: StructureChartOverlay | null): void {
    this.overlay = overlay;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    // Coordinates are resolved on draw from the live timeScale and series.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }
}

/** Bias label helper shared by the chart legend and the panel. */
export function structureBiasLabel(bias: StructureBias | 'neutral'): string {
  if (bias === 'bullish') return 'BULLISH';
  if (bias === 'bearish') return 'BEARISH';
  return 'NEUTRAL';
}
