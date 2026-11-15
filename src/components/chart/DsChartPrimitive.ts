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
  MARKUP,
  MARKUP_ALPHA,
  MARKUP_LABEL,
  MARKUP_WIDTH,
  drawHLine,
  drawLabel,
  drawZoneBox,
} from './chartMarkupStyle';

/**
 * DEMAND & SUPPLY AI chart overlay.
 *
 * Draws only the current valid demand (blue) and supply (red) zones with their proximal /
 * distal boundaries and, when a signal is confirmed, the entry / TP / invalidation levels.
 * Everything is lightly shaded with thin edges and short labels (DZ, SZ, E, TP, SL) so the
 * candles stay the focus. Fully-mitigated / invalidated / historical zones are never drawn.
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

      const drawZone = (zone: DsZone, isWatch: boolean) => {
        // A zone that is fully mitigated or invalidated is history — unless it has been
        // role-flipped (a broken demand zone now acting as supply is a current level).
        if ((zone.state === 'INVALIDATED' || zone.state === 'FULLY_MITIGATED') && !zone.flipped) return;
        const isDemand = zone.type === 'demand';
        const color = isDemand ? MARKUP.support : MARKUP.bear;

        const yUpper = series.priceToCoordinate(zone.upperPrice);
        const yLower = series.priceToCoordinate(zone.lowerPrice);
        if (yUpper === null || yLower === null) return;
        const top = Math.min(yUpper, yLower);
        const h = Math.max(2, Math.abs(yLower - yUpper));

        drawZoneBox(ctx, {
          x: 0,
          y: top,
          w: width,
          h,
          color,
          fillAlpha: isWatch ? MARKUP_ALPHA.fillFaint : MARKUP_ALPHA.fill,
          edgeAlpha: MARKUP_ALPHA.edge,
          edgesOnly: true,
          dash: isWatch ? [6, 5] : [],
        });

        // Proximal (solid) / distal (dashed) edges — thin.
        const yProx = series.priceToCoordinate(zone.proximalPrice);
        const yDist = series.priceToCoordinate(zone.distalPrice);
        if (yProx !== null) {
          drawHLine(ctx, yProx, width, color, {
            width: MARKUP_WIDTH.line,
            alpha: MARKUP_ALPHA.edgeStrong,
            dash: isWatch ? [6, 5] : [],
          });
        }
        if (yDist !== null) {
          drawHLine(ctx, yDist, width, color, {
            width: MARKUP_WIDTH.hairline,
            alpha: MARKUP_ALPHA.edge,
            dash: [5, 4],
          });
        }

        const code = isDemand ? MARKUP_LABEL.demand : MARKUP_LABEL.supply;
        const ly = Math.max(9, Math.min(height - 9, top + h / 2));
        drawLabel(ctx, `${code}${isWatch ? ` ${MARKUP_LABEL.watch}` : ''}`, 6, ly, color, {
          size: 9,
          weight: 700,
        });
      };

      for (const zone of overlay.watchZones ?? []) drawZone(zone, true);
      for (const zone of overlay.zones) drawZone(zone, false);

      // ---- Confirmed signal: entry / TP / invalidation + a small directional marker ----
      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? MARKUP.support : MARKUP.bear;

        this.drawLevel(ctx, series, width, signal.entryPrice, MARKUP.entry, MARKUP_LABEL.entry, []);
        this.drawLevel(ctx, series, width, signal.takeProfit1, MARKUP.target, MARKUP_LABEL.target, [7, 5]);
        this.drawLevel(ctx, series, width, signal.takeProfit2, MARKUP.target, MARKUP_LABEL.target, [7, 5]);
        this.drawLevel(ctx, series, width, signal.stopLoss, MARKUP.stop, MARKUP_LABEL.stop, []);

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
    dash: number[]
  ): void {
    const y = series.priceToCoordinate(price);
    if (y === null) return;
    drawHLine(ctx, y, width, color, { dash, width: MARKUP_WIDTH.line, alpha: MARKUP_ALPHA.line });
    const text = `${badge} ${formatPrice(price, this.source.overlay?.precision ?? 2)}`;
    drawLabel(ctx, text, 6, y - 9, color, { size: 9, weight: 700 });
  }
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
 * TP / invalidation on the candle canvas.
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
