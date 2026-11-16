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
import {
  MARKUP_ALPHA,
  MARKUP_COLORS,
  MARKUP_DASH,
  MARKUP_LINE,
  drawTag,
  hexToRgba,
  shortZoneLabel,
} from './markupStyle';

/**
 * Shared chart overlay for the independent AI strategy modules (Support & Resistance AI,
 * Chart Patterns AI, BOS & CHOCH AI, Technical AI, SMC/ICT & Price Action AI).
 *
 * Draws ONLY the current relevant zones (blue = bullish, red = bearish), the FUTURE watch
 * zones (dimmer + dashed) and, when a signal is confirmed, the entry / stop / TP1-3 levels.
 * Historical / invalidated / completed markings are never drawn — the modules prune them
 * before the overlay is built, so the chart always reflects the current live market.
 *
 * All drawings use the minimalist markup style: thin lines, transparent fills and short
 * labels (S, R, SZ, DZ, BOS, CHoCH, WATCH) so the candles stay the focus.
 */
export interface AiChartOverlay {
  /** Current valid zones in play (nearest first). */
  zones: AiZone[];
  /** Future watch zones — ahead of price, still valid. Drawn dimmer + dashed. */
  watchZones?: AiZone[];
  signal?: AiSignal | null;
  precision: number;
}

class AiRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: AiChartPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chart;
    const series = this.source.series;
    const overlay = this.source.overlay;
    if (!chart || !series || !overlay) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width;
      const height = mediaSize.height;
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const drawZone = (zone: AiZone, isWatch: boolean) => {
        const isBull = zone.direction === 'RISE';
        const color = isBull ? MARKUP_COLORS.support : MARKUP_COLORS.resistance;

        const yUpper = series.priceToCoordinate(zone.upperPrice);
        const yLower = series.priceToCoordinate(zone.lowerPrice);
        if (yUpper === null || yLower === null) return;
        const top = Math.min(yUpper, yLower);
        const zoneH = Math.max(2, Math.abs(yLower - yUpper));

        // Barely-there band fill; watch zones a touch lighter still.
        ctx.fillStyle = hexToRgba(color, isWatch ? MARKUP_ALPHA.fill : MARKUP_ALPHA.fillActive);
        ctx.fillRect(0, top, width, zoneH);

        // Thin upper / lower boundaries (dashed for a future watch zone).
        ctx.strokeStyle = hexToRgba(color, isWatch ? MARKUP_ALPHA.edgeSoft : MARKUP_ALPHA.edge);
        ctx.lineWidth = MARKUP_LINE.hair;
        ctx.setLineDash(isWatch ? MARKUP_DASH.subtle : MARKUP_DASH.solid);
        ctx.beginPath();
        ctx.moveTo(0, top);
        ctx.lineTo(width, top);
        ctx.moveTo(0, top + zoneH);
        ctx.lineTo(width, top + zoneH);
        ctx.stroke();
        ctx.setLineDash([]);

        // One short label: token + WATCH for a future zone.
        const token = shortZoneLabel(zone.label);
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

      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;

        const drawLevel = (price: number, color: string, badge: string, dash: number[]) => {
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
            x: width - 6,
            y,
            align: 'right',
            text: `${badge} ${formatPrice(price, overlay.precision)}`,
            color,
          });
        };

        drawLevel(signal.entryPrice, MARKUP_COLORS.entry, 'ENTRY', MARKUP_DASH.solid);
        drawLevel(signal.takeProfit1, MARKUP_COLORS.target, 'TP1', MARKUP_DASH.dashed);
        drawLevel(signal.takeProfit2, MARKUP_COLORS.target, 'TP2', MARKUP_DASH.dashed);
        if (signal.takeProfit3 !== null) {
          drawLevel(signal.takeProfit3, MARKUP_COLORS.target, 'TP3', MARKUP_DASH.dashed);
        }
        drawLevel(signal.stopLoss, MARKUP_COLORS.stop, 'SL', MARKUP_DASH.solid);

        // Small directional marker on the confirmation candle.
        const xEntry = chart.timeScale().timeToCoordinate(signal.confirmedBarTime as UTCTimestamp);
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

          drawTag(ctx, {
            x: xEntry + 6,
            y: markerY,
            text: isRise ? 'RISE' : 'FALL',
            color: dirColor,
          });
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
