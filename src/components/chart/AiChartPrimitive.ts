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
  MARKUP,
  MARKUP_ALPHA,
  MARKUP_LABEL,
  MARKUP_WIDTH,
  drawHLine,
  drawLabel,
  drawZoneBox,
} from './chartMarkupStyle';

/**
 * Shared chart overlay for the independent AI strategy modules (Support & Resistance AI,
 * Chart Patterns AI, BOS & CHOCH AI, Technical AI, SMC/ICT & Price Action AI).
 *
 * Draws only the current relevant zones (blue = bullish, red = bearish), the FUTURE watch
 * zones (dimmer + dashed) and, when a signal is confirmed, the entry / stop / TP levels
 * with a small directional marker. Zones are lightly shaded with thin edges and short
 * labels; historical / invalidated / completed markings are never drawn.
 */
export interface AiChartOverlay {
  /** Current valid zones in play (nearest first). */
  zones: AiZone[];
  /** Future watch zones — ahead of price, still valid. Drawn dimmer + dashed. */
  watchZones?: AiZone[];
  signal?: AiSignal | null;
  precision: number;
}

/**
 * Compresses a module zone label ("SUPPORT", "BULLISH OB", "DEMAND ZONE", …) to a short
 * on-chart code. Unknown labels fall back to their first word so the chart never shows a
 * sentence.
 */
export function shortZoneLabel(label: string): string {
  const key = label.trim().toUpperCase();
  if (key.includes('SUPPORT')) return MARKUP_LABEL.support;
  if (key.includes('RESIST')) return MARKUP_LABEL.resistance;
  if (key.includes('DEMAND')) return MARKUP_LABEL.demand;
  if (key.includes('SUPPLY')) return MARKUP_LABEL.supply;
  if (key.includes('CHOCH')) return MARKUP_LABEL.choch;
  if (key.includes('BOS')) return MARKUP_LABEL.bos;
  if (key.includes('FVG')) return MARKUP_LABEL.fvg;
  if (key.includes('OB')) return 'OB';
  return key.split(/\s+/)[0]?.slice(0, 6) || 'Z';
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
      if (width <= 0) return;
      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const drawZone = (zone: AiZone, isWatch: boolean) => {
        const isBull = zone.direction === 'RISE';
        const color = isBull ? MARKUP.support : MARKUP.bear;

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

        const code = shortZoneLabel(zone.label);
        const ly = Math.max(9, Math.min(height - 9, top + h / 2));
        drawLabel(ctx, `${code}${isWatch ? ` ${MARKUP_LABEL.watch}` : ''}`, 6, ly, color, {
          size: 9,
          weight: 700,
        });
      };

      for (const zone of overlay.watchZones ?? []) drawZone(zone, true);
      for (const zone of overlay.zones) drawZone(zone, false);

      const signal = overlay.signal;
      if (signal) {
        const isRise = signal.direction === 'RISE';
        const dirColor = isRise ? MARKUP.support : MARKUP.bear;

        const drawLevel = (price: number, color: string, badge: string, dash: number[]) => {
          const y = series.priceToCoordinate(price);
          if (y === null) return;
          drawHLine(ctx, y, width, color, { dash, width: MARKUP_WIDTH.line, alpha: MARKUP_ALPHA.line });
          const text = `${badge} ${formatPrice(price, overlay.precision)}`;
          drawLabel(ctx, text, width - 70, y - 9, color, { size: 9, weight: 700 });
        };

        drawLevel(signal.entryPrice, MARKUP.entry, MARKUP_LABEL.entry, []);
        drawLevel(signal.takeProfit1, MARKUP.target, MARKUP_LABEL.target, [7, 5]);
        drawLevel(signal.takeProfit2, MARKUP.target, MARKUP_LABEL.target, [7, 5]);
        if (signal.takeProfit3 !== null) {
          drawLevel(signal.takeProfit3, MARKUP.target, MARKUP_LABEL.target, [7, 5]);
        }
        drawLevel(signal.stopLoss, MARKUP.stop, MARKUP_LABEL.stop, []);

        const xEntry = chart.timeScale().timeToCoordinate(signal.confirmedBarTime as UTCTimestamp);
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
