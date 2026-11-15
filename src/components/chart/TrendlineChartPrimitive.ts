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

const COLORS = {
  rise: '#3b82f6',
  fall: '#ef4444',
  riseBand: 'rgba(59, 130, 246, 0.14)',
  fallBand: 'rgba(239, 68, 68, 0.14)',
  entry: '#2563eb',
  stop: '#dc2626',
  target: '#16a34a',
};

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
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
      if (width <= 0) return;
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      // ---- Future setup zones (nearest only): blue below price in an uptrend,
      // red above price in a downtrend. Historical drawings are never rendered. ----
      for (const zone of overlay.setupZones) {
        const isRise = zone.direction === 'RISE';
        const color = isRise ? COLORS.rise : COLORS.fall;
        const bandColor = isRise ? COLORS.riseBand : COLORS.fallBand;

        const yTop = series.priceToCoordinate(zone.upperPrice);
        const yBottom = series.priceToCoordinate(zone.lowerPrice);
        if (yTop === null || yBottom === null) continue;
        const top = Math.min(yTop, yBottom);
        const height = Math.max(2, Math.abs(yBottom - yTop));

        // Shade the zone band across the pane.
        ctx.fillStyle = bandColor;
        ctx.fillRect(0, top, width, height);

        // Dashed boundary lines at the band edges.
        ctx.strokeStyle = hexToRgba(color, 0.85);
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, top);
        ctx.lineTo(width, top);
        ctx.moveTo(0, top + height);
        ctx.lineTo(width, top + height);
        ctx.stroke();
        ctx.setLineDash([]);

        // Right-edge label: direction + source + freshness + distance.
        const labelY = isRise ? top + height + 9 : top - 9;
        const text = `${isRise ? 'WATCH RISE' : 'WATCH FALL'} · ${zone.label}`;
        const meta = `${zone.freshness} · ${zone.distanceAtr.toFixed(1)}× ATR away`;
        ctx.font = '800 10px "Plus Jakarta Sans", system-ui, sans-serif';
        const tw = Math.max(ctx.measureText(text).width, ctx.measureText(meta).width);
        const blockW = tw + 14;
        const blockX = Math.max(4, width - blockW - 4);
        const blockY = Math.max(4, Math.min(mediaSize.height - 34, labelY - 9));
        ctx.fillStyle = 'rgba(9, 14, 24, 0.9)';
        roundRect(ctx, blockX, blockY, blockW, 30, 6);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 0.75);
        ctx.lineWidth = 1;
        roundRect(ctx, blockX, blockY, blockW, 30, 6);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(text, blockX + 7, blockY + 9);
        ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
        ctx.font = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillText(meta, blockX + 7, blockY + 21);
      }

      // ---- Entry / SL / TP + rejection arrow for the confirmed signal ----
      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? COLORS.rise : COLORS.fall;

        this.drawLevel(ctx, series, width, signal.entryPrice, COLORS.entry, 'ENTRY');
        this.drawLevel(ctx, series, width, signal.stopLoss, COLORS.stop, 'STOP-LOSS');
        this.drawLevel(ctx, series, width, signal.takeProfit, COLORS.target, 'TAKE-PROFIT', [
          7,
          5,
        ]);

        const xEntry = timeScale.timeToCoordinate(signal.confirmedBarTime as UTCTimestamp);
        const yEntry = series.priceToCoordinate(signal.entryPrice);
        if (xEntry !== null && yEntry !== null) {
          const arrowY = isRise ? yEntry + 30 : yEntry - 30;
          ctx.strokeStyle = hexToRgba(dirColor, 0.9);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(xEntry, yEntry);
          ctx.lineTo(xEntry, isRise ? arrowY - 10 : arrowY + 10);
          ctx.stroke();

          ctx.fillStyle = dirColor;
          ctx.beginPath();
          if (isRise) {
            ctx.moveTo(xEntry, arrowY - 12);
            ctx.lineTo(xEntry - 7, arrowY + 4);
            ctx.lineTo(xEntry + 7, arrowY + 4);
          } else {
            ctx.moveTo(xEntry, arrowY + 12);
            ctx.lineTo(xEntry - 7, arrowY - 4);
            ctx.lineTo(xEntry + 7, arrowY - 4);
          }
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.lineWidth = 1.2;
          ctx.stroke();

          const title = isRise ? 'RISE' : 'FALL';
          const meta = `${signal.modelLabel} · ${signal.score}/100`;
          ctx.font = '800 11px "Plus Jakarta Sans", system-ui, sans-serif';
          const tw = ctx.measureText(title).width;
          ctx.font = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
          const mw = ctx.measureText(meta).width;
          const blockW = Math.max(tw + 12, mw) + 18;
          const blockH = 32;
          const blockX = Math.max(6, Math.min(width - blockW - 6, xEntry - blockW / 2));
          const blockY = isRise ? Math.min(mediaSize.height - blockH - 6, arrowY + 10) : Math.max(6, arrowY - blockH - 10);

          ctx.fillStyle = 'rgba(9, 14, 24, 0.92)';
          roundRect(ctx, blockX, blockY, blockW, blockH, 7);
          ctx.fill();
          ctx.strokeStyle = dirColor;
          ctx.lineWidth = 1.5;
          roundRect(ctx, blockX, blockY, blockW, blockH, 7);
          ctx.stroke();

          ctx.fillStyle = dirColor;
          ctx.font = '800 11px "Plus Jakarta Sans", system-ui, sans-serif';
          ctx.fillText(title, blockX + 9, blockY + 11);
          ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
          ctx.font = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
          ctx.fillText(meta, blockX + 9, blockY + 24);
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
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = hexToRgba(color, 0.85);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '700 9px "Plus Jakarta Sans", system-ui, sans-serif';
    const text = `${badge} ${formatPrice(price, this.source.overlay?.precision ?? 2)}`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(9, 14, 24, 0.9)';
    roundRect(ctx, 4, y - 9, tw + 12, 18, 5);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(color, 0.8);
    ctx.lineWidth = 1;
    roundRect(ctx, 4, y - 9, tw + 12, 18, 5);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, 10, y);
    ctx.restore();
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
 * Renders the Trendline Scanner's M15 trendlines, touches, breaks and the confirmed
 * signal's entry / stop / target plus a RISE / FALL arrow on the candle canvas.
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
