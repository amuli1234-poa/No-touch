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
import { formatPrice } from '../../utils/derivParser';
import {
  MARKUP,
  MARKUP_ALPHA,
  MARKUP_LABEL,
  MARKUP_WIDTH,
  drawHLine,
  drawLabel,
  drawZoneBox,
} from './chartMarkupStyle';

/**
 * AI Chart Structure overlay: draws only the CURRENT, valid structure on the candle
 * canvas — confirmed BOS/CHoCH, support/resistance bands, rejection bands, fresh fair
 * value gaps and the fresh future reaction (watch) zones.
 *
 * Markup is deliberately minimal: thin boundary lines, subtle fills and short labels
 * (S, R, BOS, CHoCH, WATCH, FVG). Nothing mitigated or invalidated is ever drawn.
 */
export interface StructureChartOverlay extends StructureOverlayData {
  precision: number;
  /** Whether fresh fair value gaps are drawn (settings toggle). */
  showFvg?: boolean;
}

/** A tiny triangle marker placed at the exact break, pointing with the break direction. */
function drawBreakMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  bullish: boolean
): void {
  const s = 4;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  if (bullish) {
    ctx.moveTo(x, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.lineTo(x + s, y + s);
  } else {
    ctx.moveTo(x, y + s);
    ctx.lineTo(x - s, y - s);
    ctx.lineTo(x + s, y - s);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

class StructureRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: StructureChartPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chart;
    const series = this.source.series;
    const overlay = this.source.overlay;
    if (!chart || !series || !overlay) return;

    const timeScale = chart.timeScale();
    const precision = overlay.precision;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width;
      const height = mediaSize.height;
      if (width <= 0) return;
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      // ---- Support / resistance bands (thin edges, subtle fill) ----
      for (const band of overlay.srBands) {
        this.drawBand(ctx, series, width, height, band, precision);
      }

      // ---- Rejection bands ----
      for (const zone of overlay.rejectionZones) {
        this.drawRejectionBand(ctx, series, width, height, zone, precision);
      }

      // ---- Fresh fair value gaps (unfilled imbalances) ----
      if (overlay.showFvg !== false) {
        for (const gap of overlay.fvg) {
          this.drawFvg(ctx, series, width, height, timeScale, gap);
        }
      }

      // ---- Future reaction watch zones ----
      for (const zone of overlay.watchZones) {
        this.drawWatchZone(ctx, series, width, height, timeScale, zone);
      }

      // ---- Confirmed BOS / CHoCH: small marker at the exact break ----
      for (const brk of overlay.breaks) {
        const y = series.priceToCoordinate(brk.brokenLevel);
        if (y === null) continue;
        const x = timeScale.timeToCoordinate(brk.time as UTCTimestamp);
        if (x === null || x < -20 || x > width + 20) continue;
        const isBull = brk.direction === 'bullish';
        const color = brk.kind === 'CHOCH' ? MARKUP.choch : isBull ? MARKUP.bull : MARKUP.bear;

        // Thin tick from the break candle out to the level.
        drawHLine(ctx, y, Math.min(width, x + 26), color, {
          dash: [3, 3],
          width: MARKUP_WIDTH.hairline,
          alpha: MARKUP_ALPHA.edge,
          x,
        });
        drawBreakMarker(ctx, x, y, color, isBull);
        drawLabel(ctx, brk.kind === 'CHOCH' ? MARKUP_LABEL.choch : MARKUP_LABEL.bos, x + 8, y - 9, color, {
          size: 9,
          weight: 700,
        });
      }

      ctx.restore();
    });
  }

  private drawBand(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    height: number,
    band: SupportResistanceBand,
    precision: number
  ): void {
    const yTop = series.priceToCoordinate(band.upperPrice);
    const yBot = series.priceToCoordinate(band.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const isResistance = band.type === 'resistance';
    const color = isResistance ? MARKUP.resistance : MARKUP.support;

    drawZoneBox(ctx, {
      x: 0,
      y: top,
      w: width,
      h,
      color,
      fillAlpha: MARKUP_ALPHA.fillFaint,
      edgesOnly: true,
      edgeAlpha: band.importance === 'major' ? MARKUP_ALPHA.edgeStrong : MARKUP_ALPHA.edge,
    });

    const code = isResistance ? MARKUP_LABEL.resistance : MARKUP_LABEL.support;
    const ly = Math.max(9, Math.min(height - 9, top + h / 2));
    drawLabel(ctx, `${code} ${formatPrice((band.upperPrice + band.lowerPrice) / 2, precision)}`, width - 78, ly, color, {
      size: 9,
      weight: 700,
    });
  }

  private drawRejectionBand(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    height: number,
    zone: RejectionZone,
    precision: number
  ): void {
    const yTop = series.priceToCoordinate(zone.upperPrice);
    const yBot = series.priceToCoordinate(zone.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const color = zone.direction === 'RISE' ? MARKUP.bull : MARKUP.bear;

    drawZoneBox(ctx, {
      x: 0,
      y: top,
      w: width,
      h,
      color,
      fillAlpha: MARKUP_ALPHA.fillFaint,
      edgeAlpha: zone.structuralSignificance === 'major' ? MARKUP_ALPHA.edgeStrong : MARKUP_ALPHA.edge,
      dash: [6, 4],
    });

    const ly = Math.max(9, Math.min(height - 9, top - 8));
    drawLabel(ctx, `RZ ${formatPrice((zone.upperPrice + zone.lowerPrice) / 2, precision)}`, 6, ly, color, {
      size: 9,
      weight: 700,
    });
  }

  private drawFvg(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    height: number,
    timeScale: ITimeScaleApi<Time>,
    gap: FairValueGap
  ): void {
    const yTop = series.priceToCoordinate(gap.upperPrice);
    const yBot = series.priceToCoordinate(gap.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const color = gap.reaction === 'RISE' ? MARKUP.support : MARKUP.resistance;

    const xOrigin = timeScale.timeToCoordinate(gap.time as UTCTimestamp);
    const xStart = xOrigin === null ? 0 : Math.max(0, Math.min(width, xOrigin));
    const zoneW = Math.max(0, width - xStart);
    if (zoneW <= 0) return;

    drawZoneBox(ctx, {
      x: xStart,
      y: top,
      w: zoneW,
      h,
      color,
      fillAlpha: MARKUP_ALPHA.fillFaint,
      edgeAlpha: MARKUP_ALPHA.edge,
      dash: [3, 3],
    });

    const ly = Math.max(9, Math.min(height - 9, top - 8));
    drawLabel(ctx, MARKUP_LABEL.fvg, Math.max(6, Math.min(width - 30, xStart + 4)), ly, color, {
      size: 8,
      weight: 700,
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
    const color = zone.direction === 'RISE' ? MARKUP.bull : MARKUP.bear;

    const xOrigin = timeScale.timeToCoordinate(zone.originTime as UTCTimestamp);
    const xStart = xOrigin === null ? 0 : Math.max(0, Math.min(width, xOrigin));
    const zoneW = Math.max(0, width - xStart);
    if (zoneW <= 0) return;

    const approaching = zone.stage === 'PRICE_APPROACHING';
    drawZoneBox(ctx, {
      x: xStart,
      y: top,
      w: zoneW,
      h,
      color,
      fillAlpha: MARKUP_ALPHA.fill,
      edgeAlpha: approaching ? MARKUP_ALPHA.edgeStrong : MARKUP_ALPHA.edge,
      dash: approaching ? [] : [5, 4],
    });

    // Invalidation guard line — thin dotted.
    const yInv = series.priceToCoordinate(zone.invalidationLevel);
    if (yInv !== null) {
      drawHLine(ctx, yInv, width, color, {
        dash: [2, 4],
        width: MARKUP_WIDTH.hairline,
        alpha: 0.35,
        x: xStart,
      });
    }

    const ly = Math.max(9, Math.min(height - 9, top - 8));
    drawLabel(ctx, MARKUP_LABEL.watch, Math.max(6, Math.min(width - 46, xStart + 4)), ly, color, {
      size: 9,
      weight: 700,
    });
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
