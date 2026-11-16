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
import {
  MARKUP_ALPHA,
  MARKUP_COLORS,
  MARKUP_DASH,
  MARKUP_LINE,
  drawTag,
  hexToRgba,
} from './markupStyle';

/**
 * DEMAND & SUPPLY AI chart overlay.
 *
 * Draws ONLY the current valid demand (blue) and supply (red) zones with their proximal /
 * distal boundaries and — when a signal is confirmed — TP1 / TP2 and the invalidation
 * level. Fully-mitigated / invalidated / historical zones are never drawn.
 *
 * Minimalist styling: transparent zone fills, hairline boundaries, short DZ / SZ labels.
 */
export interface DsChartOverlay {
  zones: DsZone[];
  /** Future watch zones (untouched, still ahead of price) — drawn dimmer + dashed. */
  watchZones?: DsZone[];
  /** The confirmed signal for this instrument (entry / SL / TP1 / TP2 / TP3). */
  signal?: DsSignal | null;
  precision: number;
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
      const height = mediaSize.height;
      if (width <= 0) return;
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      // ---- Current valid zones: demand = blue, supply = red ----
      const drawZone = (zone: DsZone, isWatch: boolean) => {
        // A zone that is fully mitigated or invalidated is history — unless it has been
        // role-flipped (a broken demand zone now acting as supply is a current level).
        if ((zone.state === 'INVALIDATED' || zone.state === 'FULLY_MITIGATED') && !zone.flipped) {
          return;
        }
        const isDemand = zone.type === 'demand';
        const color = isDemand ? MARKUP_COLORS.support : MARKUP_COLORS.resistance;

        const yUpper = series.priceToCoordinate(zone.upperPrice);
        const yLower = series.priceToCoordinate(zone.lowerPrice);
        if (yUpper === null || yLower === null) return;
        const top = Math.min(yUpper, yLower);
        const zoneH = Math.max(2, Math.abs(yLower - yUpper));

        // Barely-there band fill; watch zones a touch lighter still.
        ctx.fillStyle = hexToRgba(color, isWatch ? MARKUP_ALPHA.fill : MARKUP_ALPHA.fillActive);
        ctx.fillRect(0, top, width, zoneH);

        // Proximal edge (firmer) and distal edge (fainter) boundaries.
        const yProx = series.priceToCoordinate(zone.proximalPrice);
        const yDist = series.priceToCoordinate(zone.distalPrice);
        if (yProx !== null) {
          ctx.strokeStyle = hexToRgba(color, isWatch ? MARKUP_ALPHA.edgeSoft : MARKUP_ALPHA.edge);
          ctx.lineWidth = MARKUP_LINE.hair;
          ctx.setLineDash(isWatch ? MARKUP_DASH.subtle : MARKUP_DASH.solid);
          ctx.beginPath();
          ctx.moveTo(0, yProx);
          ctx.lineTo(width, yProx);
          ctx.stroke();
        }
        if (yDist !== null) {
          ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edgeSoft);
          ctx.lineWidth = MARKUP_LINE.hair;
          ctx.setLineDash(MARKUP_DASH.subtle);
          ctx.beginPath();
          ctx.moveTo(0, yDist);
          ctx.lineTo(width, yDist);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // One short label: DZ (demand) / SZ (supply), + WATCH when ahead of price.
        const token = isDemand ? 'DZ' : 'SZ';
        const text = isWatch ? `${token} · WATCH` : token;
        drawTag(ctx, {
          x: 6,
          y: Math.max(7, Math.min(height - 7, top + zoneH / 2)),
          text,
          color,
        });
      };

      for (const zone of overlay.watchZones ?? []) drawZone(zone, true);
      for (const zone of overlay.zones) drawZone(zone, false);

      // ---- Confirmed signal: entry + TP1 / TP2 + invalidation ----
      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;

        this.drawLevel(ctx, series, width, signal.entryPrice, MARKUP_COLORS.entry, 'ENTRY', MARKUP_DASH.solid);
        this.drawLevel(ctx, series, width, signal.takeProfit1, MARKUP_COLORS.target, 'TP1', MARKUP_DASH.dashed);
        this.drawLevel(ctx, series, width, signal.takeProfit2, MARKUP_COLORS.target, 'TP2', MARKUP_DASH.dashed);
        this.drawLevel(ctx, series, width, signal.stopLoss, MARKUP_COLORS.stop, 'SL', MARKUP_DASH.solid);

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
