import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  TrendlineAlignment,
  TrendlineSetupZone,
  TrendlineSignal,
} from '../../types/trendline';
import { formatPrice } from '../../utils/derivParser';
import {
  MARKUP_ALPHA,
  MARKUP_COLORS,
  MARKUP_DASH,
  MARKUP_LINE,
  drawTag,
  hexToRgba,
} from './markupStyle';

/**
 * Overlay payload for the Trendline Scanner module. Drawn on the candle canvas so the
 * lines stay pinned to their exact times/prices through zoom, pan and resize.
 *
 * Only the NEAREST valid future setup zones are drawn (blue = bullish continuation below
 * price in an uptrend, red = bearish continuation above price in a downtrend). Historical
 * drawings (touch points, broken lines, old break labels) are intentionally hidden.
 *
 * Minimalist styling: hairline dashed boundaries, transparent fill, short WATCH labels.
 */
export interface TrendlineChartOverlay {
  /** Nearest valid future setup zones (trend-aligned). */
  setupZones: TrendlineSetupZone[];
  /** Trend-alignment verdict, used for the header annotation. */
  alignment?: TrendlineAlignment | null;
  /** The module's best confirmed signal for this instrument (entry/SL/TP + arrow). */
  signal?: TrendlineSignal | null;
  precision: number;
}

class TrendlineRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: TrendlineChartPrimitive) {}

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
      ctx.textAlign = 'left';

      // ---- Future setup zones (nearest only). Historical drawings are never rendered. ----
      for (const zone of overlay.setupZones) {
        const isRise = zone.direction === 'RISE';
        const color = isRise ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;

        const yTop = series.priceToCoordinate(zone.upperPrice);
        const yBottom = series.priceToCoordinate(zone.lowerPrice);
        if (yTop === null || yBottom === null) continue;
        const top = Math.min(yTop, yBottom);
        const zoneH = Math.max(2, Math.abs(yBottom - yTop));

        ctx.fillStyle = hexToRgba(color, MARKUP_ALPHA.fill);
        ctx.fillRect(0, top, width, zoneH);

        ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edgeSoft);
        ctx.lineWidth = MARKUP_LINE.hair;
        ctx.setLineDash(MARKUP_DASH.subtle);
        ctx.beginPath();
        ctx.moveTo(0, top);
        ctx.lineTo(width, top);
        ctx.moveTo(0, top + zoneH);
        ctx.lineTo(width, top + zoneH);
        ctx.stroke();
        ctx.setLineDash([]);

        // One short label: WATCH + direction. Detail lives in the module panel.
        drawTag(ctx, {
          x: width - 6,
          y: Math.max(7, Math.min(height - 7, top + zoneH / 2)),
          align: 'right',
          text: isRise ? 'WATCH RISE' : 'WATCH FALL',
          color,
        });
      }

      // ---- Entry / SL / TP + directional marker for the confirmed signal ----
      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;

        this.drawLevel(ctx, series, width, signal.entryPrice, MARKUP_COLORS.entry, 'ENTRY', MARKUP_DASH.solid);
        this.drawLevel(ctx, series, width, signal.stopLoss, MARKUP_COLORS.stop, 'SL', MARKUP_DASH.solid);
        this.drawLevel(ctx, series, width, signal.takeProfit, MARKUP_COLORS.target, 'TP', MARKUP_DASH.dashed);

        const xEntry = timeScale.timeToCoordinate(signal.confirmedBarTime as UTCTimestamp);
        const yEntry = series.priceToCoordinate(signal.entryPrice);
        if (xEntry !== null && yEntry !== null) {
          const markerY = isRise ? yEntry + 12 : yEntry - 12;
          ctx.fillStyle = dirColor;
          ctx.beginPath();
          if (isRise) {
            ctx.moveTo(xEntry, markerY - 6);
            ctx.lineTo(xEntry - 4, markerY + 3);
            ctx.lineTo(xEntry + 4, markerY + 3);
          } else {
            ctx.moveTo(xEntry, markerY + 6);
            ctx.lineTo(xEntry - 4, markerY - 3);
            ctx.lineTo(xEntry + 4, markerY - 3);
          }
          ctx.closePath();
          ctx.fill();

          drawTag(ctx, { x: xEntry + 6, y: markerY, text: isRise ? 'RISE' : 'FALL', color: dirColor });
        }
      }

      ctx.restore();
    });
  }

  private drawLevel(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    price: number,
    color: string,
    badge: string,
    dash: number[]
  ): void {
    const y = series.priceToCoordinate(price);
    if (y === null) return;
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edge);
    ctx.lineWidth = MARKUP_LINE.hair;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    drawTag(ctx, {
      x: 6,
      y,
      text: `${badge} ${formatPrice(price, this.source.overlay?.precision ?? 2)}`,
      color,
    });
  }
}

class TrendlinePaneView implements IPrimitivePaneView {
  constructor(private readonly source: TrendlineChartPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (!this.source.chart || !this.source.series || !this.source.overlay) return null;
    return new TrendlineRenderer(this.source);
  }
}

/**
 * Renders the Trendline Scanner's nearest valid setup zones and the confirmed signal's
 * entry / stop / target plus a RISE / FALL marker on the candle canvas.
 */
export class TrendlineChartPrimitive implements ISeriesPrimitive<Time> {
  chart: SeriesAttachedParameter<Time, SeriesType>['chart'] | null = null;
  series: SeriesAttachedParameter<Time, SeriesType>['series'] | null = null;
  overlay: TrendlineChartOverlay | null = null;
  private requestUpdate?: () => void;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor() {
    this._paneViews = [new TrendlinePaneView(this)];
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

  setOverlay(overlay: TrendlineChartOverlay | null): void {
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
