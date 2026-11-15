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
import type { DsSignal, DsZone } from '../../types/demandSupply';
import { formatPrice } from '../../utils/derivParser';

/**
 * DEMAND & SUPPLY AI chart overlay.
 *
 * Draws ONLY the current valid demand (blue) and supply (red) zones with accurate
 * proximal / distal boundaries, zone labels + quality scores, the potential entry area,
 * and — when a signal is confirmed — TP1 / TP2 and the invalidation level.
 *
 * Fully-mitigated / invalidated / historical zones are never drawn.
 */
export interface DsChartOverlay {
  zones: DsZone[];
  /** Future watch zones (untouched, still ahead of price) — drawn dimmer + dashed. */
  watchZones?: DsZone[];
  /** The confirmed signal for this instrument (entry / SL / TP1 / TP2 / TP3). */
  signal?: DsSignal | null;
  precision: number;
}

const COLORS = {
  demand: '#3b82f6',
  supply: '#ef4444',
  demandBand: 'rgba(59, 130, 246, 0.16)',
  supplyBand: 'rgba(239, 68, 68, 0.16)',
  demandEdge: 'rgba(59, 130, 246, 0.9)',
  supplyEdge: 'rgba(239, 68, 68, 0.9)',
  entry: '#2563eb',
  stop: '#dc2626',
  target: '#16a34a',
  ink: 'rgba(226, 232, 240, 0.92)',
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

class DsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: DsChartPrimitive) {}

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

      // ---- Current valid zones: demand = blue, supply = red ----
      const drawZone = (zone: DsZone, isWatch: boolean) => {
        const isDemand = zone.type === 'demand';
        const color = isDemand ? COLORS.demand : COLORS.supply;
        const band = isDemand ? COLORS.demandBand : COLORS.supplyBand;
        const edge = isDemand ? COLORS.demandEdge : COLORS.supplyEdge;

        const yUpper = series.priceToCoordinate(zone.upperPrice);
        const yLower = series.priceToCoordinate(zone.lowerPrice);
        if (yUpper === null || yLower === null) return;
        const top = Math.min(yUpper, yLower);
        const height = Math.max(2, Math.abs(yLower - yUpper));

        // Shade the zone band. Watch zones are drawn dimmer so they read as "potential".
        ctx.globalAlpha = isWatch ? 0.55 : 1;
        ctx.fillStyle = band;
        ctx.fillRect(0, top, width, height);

        // Proximal edge (solid) and distal edge (dashed) boundaries.
        const yProx = series.priceToCoordinate(zone.proximalPrice);
        const yDist = series.priceToCoordinate(zone.distalPrice);
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1.6;
        ctx.setLineDash(isWatch ? [6, 5] : []);
        if (yProx !== null) {
          ctx.beginPath();
          ctx.moveTo(0, yProx);
          ctx.lineTo(width, yProx);
          ctx.stroke();
        }
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.2;
        if (yDist !== null) {
          ctx.beginPath();
          ctx.moveTo(0, yDist);
          ctx.lineTo(width, yDist);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // Left label: type + formation + state + quality + proximal/distal.
        const title = `${isDemand ? 'DEMAND' : 'SUPPLY'} · ${zone.formationLabel}${
          zone.flipped ? ' (flip)' : ''
        }${isWatch ? ' · WATCH' : ''}`;
        const meta = `${zone.state.replace(/_/g, ' ')} · Q${zone.score.total}/100`;
        const bounds = `P ${formatPrice(zone.proximalPrice, overlay.precision)} · D ${formatPrice(
          zone.distalPrice,
          overlay.precision
        )}`;
        ctx.font = '800 10px "Plus Jakarta Sans", system-ui, sans-serif';
        const tw = Math.max(
          ctx.measureText(title).width,
          ctx.measureText(bounds).width
        );
        ctx.font = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
        const mw = ctx.measureText(meta).width;
        const blockW = Math.max(tw, mw) + 16;
        const blockH = 38;
        const blockX = 6;
        const blockY = Math.max(4, Math.min(mediaSize.height - blockH - 4, top + height / 2 - blockH / 2));

        ctx.fillStyle = 'rgba(9, 14, 24, 0.9)';
        roundRect(ctx, blockX, blockY, blockW, blockH, 6);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 0.75);
        ctx.lineWidth = 1;
        roundRect(ctx, blockX, blockY, blockW, blockH, 6);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.font = '800 10px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillText(title, blockX + 8, blockY + 11);
        ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
        ctx.font = '600 9px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillText(meta, blockX + 8, blockY + 23);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.95)';
        ctx.fillText(bounds, blockX + 8, blockY + 33);
        ctx.globalAlpha = 1;
      };

      for (const zone of overlay.watchZones ?? []) drawZone(zone, true);
      for (const zone of overlay.zones) drawZone(zone, false);

      // ---- Confirmed signal: entry area + TP1 / TP2 + invalidation ----
      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? COLORS.demand : COLORS.supply;

        this.drawLevel(ctx, series, width, signal.entryPrice, COLORS.entry, 'ENTRY', []);
        this.drawLevel(ctx, series, width, signal.takeProfit1, COLORS.target, 'TP1', [7, 5]);
        this.drawLevel(ctx, series, width, signal.takeProfit2, COLORS.target, 'TP2', [7, 5]);
        this.drawLevel(ctx, series, width, signal.stopLoss, COLORS.stop, 'INVALIDATION', []);

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

class DsPaneView implements IPrimitivePaneView {
  constructor(private readonly source: DsChartPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (!this.source.chart || !this.source.series || !this.source.overlay) return null;
    return new DsRenderer(this.source);
  }
}

/**
 * Renders the Demand & Supply AI's current zones and the confirmed signal's entry /
 * TP1 / TP2 / invalidation on the candle canvas.
 */
export class DsChartPrimitive implements ISeriesPrimitive<Time> {
  chart: SeriesAttachedParameter<Time, SeriesType>['chart'] | null = null;
  series: SeriesAttachedParameter<Time, SeriesType>['series'] | null = null;
  overlay: DsChartOverlay | null = null;
  private requestUpdate?: () => void;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor() {
    this._paneViews = [new DsPaneView(this)];
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

  setOverlay(overlay: DsChartOverlay | null): void {
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
