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
  MARKUP,
  MARKUP_ALPHA,
  MARKUP_LABEL,
  MARKUP_WIDTH,
  drawHLine,
  drawLabel,
  drawZoneBox,
} from './chartMarkupStyle';

/**
 * Overlay payload for the Trendline Scanner module. Drawn on the candle canvas so the
 * lines stay pinned to their exact times/prices through zoom, pan and resize.
 *
 * Only the NEAREST valid future setup zones are drawn (blue = bullish continuation below
 * price in an uptrend, red = bearish continuation above price in a downtrend). Historical
 * drawings (touch points, broken lines, old break labels) are intentionally hidden.
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

      // ---- Future setup zones (nearest only): thin dashed edges, light fill, WATCH tag ----
      for (const zone of overlay.setupZones) {
        const isRise = zone.direction === 'RISE';
        const color = isRise ? MARKUP.support : MARKUP.bear;

        const yTop = series.priceToCoordinate(zone.upperPrice);
        const yBottom = series.priceToCoordinate(zone.lowerPrice);
        if (yTop === null || yBottom === null) continue;
        const top = Math.min(yTop, yBottom);
        const h = Math.max(2, Math.abs(yBottom - yTop));

        drawZoneBox(ctx, {
          x: 0,
          y: top,
          w: width,
          h,
          color,
          fillAlpha: MARKUP_ALPHA.fillFaint,
          edgeAlpha: MARKUP_ALPHA.edge,
          edgesOnly: true,
          dash: [6, 4],
        });

        const ly = Math.max(9, Math.min(height - 9, isRise ? top + h + 10 : top - 10));
        drawLabel(ctx, MARKUP_LABEL.watch, Math.max(6, width - 52), ly, color, { size: 9, weight: 700 });
      }

      // ---- Entry / SL / TP + small directional marker for the confirmed signal ----
      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? MARKUP.support : MARKUP.bear;

        this.drawLevel(ctx, series, width, signal.entryPrice, MARKUP.entry, MARKUP_LABEL.entry);
        this.drawLevel(ctx, series, width, signal.stopLoss, MARKUP.stop, MARKUP_LABEL.stop);
        this.drawLevel(ctx, series, width, signal.takeProfit, MARKUP.target, MARKUP_LABEL.target, [7, 5]);

        const xEntry = timeScale.timeToCoordinate(signal.confirmedBarTime as UTCTimestamp);
        const yEntry = series.priceToCoordinate(signal.entryPrice);
        if (xEntry !== null && yEntry !== null && xEntry >= 0 && xEntry <= width) {
          drawBreakMarker(ctx, xEntry, yEntry, dirColor, isRise);
          drawLabel(ctx, isRise ? 'RISE' : 'FALL', xEntry + 7, yEntry - 10, dirColor, {
            size: 9,
            weight: 700,
          });
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
    dash: number[] = []
  ): void {
    const y = series.priceToCoordinate(price);
    if (y === null) return;
    drawHLine(ctx, y, width, color, { dash, width: MARKUP_WIDTH.line, alpha: MARKUP_ALPHA.line });
    const text = `${badge} ${formatPrice(price, this.source.overlay?.precision ?? 2)}`;
    drawLabel(ctx, text, 6, y - 9, color, { size: 9, weight: 700 });
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
 * Renders the Trendline Scanner's valid future setup zones and the confirmed signal's
 * entry / stop / target plus a small RISE / FALL marker on the candle canvas.
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
