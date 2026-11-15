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
import type { AiSignal, AiZone } from '../../types/aiModule';
import { formatPrice } from '../../utils/derivParser';

/**
 * Shared chart overlay for the independent AI strategy modules (Support & Resistance AI,
 * Chart Patterns AI, BOS & CHOCH AI, Technical AI, SMC/ICT & Price Action AI).
 *
 * Draws ONLY the current relevant zones (blue = bullish, red = bearish), the FUTURE watch
 * zones (dimmer + dashed) and, when a signal is confirmed, the entry / stop / TP1-3 levels
 * with a directional arrow. Historical / invalidated / completed markings are never drawn —
 * the modules prune them before the overlay is built, so the chart always reflects the
 * current live market, never a historical analysis.
 */
export interface AiChartOverlay {
  /** Current valid zones in play (nearest first). */
  zones: AiZone[];
  /** Future watch zones — ahead of price, still valid. Drawn dimmer + dashed. */
  watchZones?: AiZone[];
  signal?: AiSignal | null;
  precision: number;
}

const COLORS = {
  bull: '#3b82f6',
  bear: '#ef4444',
  bullBand: 'rgba(59, 130, 246, 0.16)',
  bearBand: 'rgba(239, 68, 68, 0.16)',
  bullEdge: 'rgba(59, 130, 246, 0.9)',
  bearEdge: 'rgba(239, 68, 68, 0.9)',
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

class AiRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: AiChartPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chart;
    const series = this.source.series;
    const overlay = this.source.overlay;
    if (!chart || !series || !overlay) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const mediaSize = scope.mediaSize;
      const width = mediaSize.width;
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const drawZone = (zone: AiZone, isWatch: boolean) => {
        const isBull = zone.direction === 'RISE';
        const color = isBull ? COLORS.bull : COLORS.bear;
        const band = isBull ? COLORS.bullBand : COLORS.bearBand;
        const edge = isBull ? COLORS.bullEdge : COLORS.bearEdge;

        const yUpper = series.priceToCoordinate(zone.upperPrice);
        const yLower = series.priceToCoordinate(zone.lowerPrice);
        if (yUpper === null || yLower === null) return;
        const top = Math.min(yUpper, yLower);
        const height = Math.max(2, Math.abs(yLower - yUpper));

        ctx.globalAlpha = isWatch ? 0.55 : 1;
        ctx.fillStyle = band;
        ctx.fillRect(0, top, width, height);

        ctx.strokeStyle = edge;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(isWatch ? [6, 5] : []);
        ctx.beginPath();
        ctx.moveTo(0, yUpper);
        ctx.lineTo(width, yUpper);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, yLower);
        ctx.lineTo(width, yLower);
        ctx.stroke();
        ctx.setLineDash([]);

        const title = `${zone.label}${isWatch ? ' · WATCH' : ''}`;
        const meta = `Q${Math.round(zone.quality)}/100 · ${isBull ? 'RISE' : 'FALL'}`;
        ctx.font = '800 10px "Plus Jakarta Sans", system-ui, sans-serif';
        const tw = ctx.measureText(title).width;
        ctx.font = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
        const mw = ctx.measureText(meta).width;
        const blockW = Math.max(tw, mw) + 16;
        const blockH = 26;
        const blockX = 6;
        const blockY = Math.max(
          4,
          Math.min(mediaSize.height - blockH - 4, top + height / 2 - blockH / 2)
        );

        ctx.fillStyle = 'rgba(9, 14, 24, 0.9)';
        roundRect(ctx, blockX, blockY, blockW, blockH, 6);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 0.75);
        ctx.lineWidth = 1;
        roundRect(ctx, blockX, blockY, blockW, blockH, 6);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.font = '800 10px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillText(title, blockX + 8, blockY + 10);
        ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
        ctx.font = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillText(meta, blockX + 8, blockY + 20);
        ctx.globalAlpha = 1;
      };

      for (const zone of overlay.watchZones ?? []) drawZone(zone, true);
      for (const zone of overlay.zones) drawZone(zone, false);

      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? COLORS.bull : COLORS.bear;

        const drawLevel = (price: number, color: string, badge: string, dash: number[]) => {
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
          const text = `${badge} ${formatPrice(price, overlay.precision)}`;
          const tw = ctx.measureText(text).width;
          ctx.fillStyle = 'rgba(9, 14, 24, 0.9)';
          roundRect(ctx, width - tw - 16, y - 9, tw + 12, 18, 5);
          ctx.fill();
          ctx.strokeStyle = hexToRgba(color, 0.8);
          ctx.lineWidth = 1;
          roundRect(ctx, width - tw - 16, y - 9, tw + 12, 18, 5);
          ctx.stroke();
          ctx.fillStyle = color;
          ctx.fillText(text, width - tw - 10, y);
          ctx.restore();
        };

        drawLevel(signal.entryPrice, COLORS.entry, 'ENTRY', []);
        drawLevel(signal.takeProfit1, COLORS.target, 'TP1', [7, 5]);
        drawLevel(signal.takeProfit2, COLORS.target, 'TP2', [7, 5]);
        if (signal.takeProfit3 !== null) {
          drawLevel(signal.takeProfit3, COLORS.target, 'TP3', [7, 5]);
        }
        drawLevel(signal.stopLoss, COLORS.stop, 'INVALIDATION', []);

        const xEntry = chart.timeScale().timeToCoordinate(signal.confirmedBarTime as UTCTimestamp);
        const yEntry = series.priceToCoordinate(signal.entryPrice);
        if (xEntry !== null && yEntry !== null) {
          const arrowY = isRise ? yEntry + 26 : yEntry - 26;
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
          const blockY = isRise
            ? Math.min(mediaSize.height - blockH - 6, arrowY + 10)
            : Math.max(6, arrowY - blockH - 10);

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
}

class AiPaneView implements IPrimitivePaneView {
  constructor(private readonly source: AiChartPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (!this.source.chart || !this.source.series || !this.source.overlay) return null;
    return new AiRenderer(this.source);
  }
}

export class AiChartPrimitive implements ISeriesPrimitive<Time> {
  chart: SeriesAttachedParameter<Time, SeriesType>['chart'] | null = null;
  series: SeriesAttachedParameter<Time, SeriesType>['series'] | null = null;
  overlay: AiChartOverlay | null = null;
  private requestUpdate?: () => void;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor() {
    this._paneViews = [new AiPaneView(this)];
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

  setOverlay(overlay: AiChartOverlay | null): void {
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
