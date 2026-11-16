import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  MARKUP_ALPHA,
  MARKUP_COLORS,
  MARKUP_DASH,
  MARKUP_FONT,
  MARKUP_LINE,
  drawTag,
  hexToRgba,
} from './markupStyle';

export type SignalMarkerDirection = 'RISE' | 'FALL';

export interface SignalLevels {
  direction: SignalMarkerDirection;
  /** Locked entry price. */
  entry: number;
  /** Locked stop-loss price. */
  stopLoss: number;
  /** Dynamic take-profit price. */
  takeProfit: number;
  /** Bar time of the confirmation candle the marker points at. */
  confirmationTime: number;
  /** Bar time of the entry candle (usually the confirmation candle). */
  entryTime: number;
  /** Short label such as the entry model name. */
  modelLabel?: string | null;
  /** Setup quality 0–100. */
  quality?: number | null;
  /** True while a take-profit adjustment is animating. */
  tpAnimating?: boolean;
}

/**
 * Draws the managed RISE/FALL entry annotation and the locked ENTRY / STOP-LOSS levels
 * plus the dynamic TAKE-PROFIT level directly on the candle canvas.
 *
 * Everything is drawn in media coordinates on every frame, so the annotations stay
 * pinned to their exact candle and price through zoom, pan and resize. Minimalist styling
 * is used throughout: hairline level lines, a small R / F marker and tiny price tags, so
 * the candlesticks remain the main focus.
 */
class SignalAnnotationRenderer implements IPrimitivePaneRenderer {
  private readonly chart: IChartApi;
  private readonly series: ISeriesApi<SeriesType>;
  private readonly levels: SignalLevels;

  constructor(chart: IChartApi, series: ISeriesApi<SeriesType>, levels: SignalLevels) {
    this.chart = chart;
    this.series = series;
    this.levels = levels;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const { levels } = this;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width;
      const height = mediaSize.height;
      if (width <= 0 || height <= 0) return;

      const timeScale = this.chart.timeScale();
      const isRise = levels.direction === 'RISE';
      const dirColor = isRise ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;

      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const yEntry = this.series.priceToCoordinate(levels.entry);
      const yStop = this.series.priceToCoordinate(levels.stopLoss);
      const yTarget = this.series.priceToCoordinate(levels.takeProfit);
      const xEntry = timeScale.timeToCoordinate(levels.entryTime as UTCTimestamp);

      // Locked ENTRY level — thin solid line, small tag.
      if (yEntry !== null) {
        this.drawLevel(ctx, width, yEntry, MARKUP_COLORS.entry, 'ENTRY', MARKUP_DASH.solid);
      }
      // Locked STOP-LOSS level — thin solid line, small tag.
      if (yStop !== null) {
        this.drawLevel(ctx, width, yStop, MARKUP_COLORS.stop, 'SL', MARKUP_DASH.solid);
      }
      // Dynamic TAKE-PROFIT level — thin dashed line, small tag.
      if (yTarget !== null) {
        this.drawLevel(
          ctx,
          width,
          yTarget,
          MARKUP_COLORS.target,
          levels.tpAnimating ? 'TP ▶' : 'TP',
          MARKUP_DASH.dashed
        );
      }

      // Small directional marker on the confirmation candle + tiny price tag.
      if (xEntry !== null && yEntry !== null) {
        const markerY = isRise ? yEntry + 12 : yEntry - 12;

        // Faint highlight of the confirmation candle (context, not colour-only).
        const barSpacing = timeScale.options().barSpacing ?? 10;
        const halfWidth = Math.max(3, Math.min(7, barSpacing * 0.3));
        const candleHigh = this.series.priceToCoordinate(
          levels.entry + Math.abs(levels.entry - levels.stopLoss) * 0.9
        );
        const candleLow = this.series.priceToCoordinate(
          levels.entry - Math.abs(levels.entry - levels.stopLoss) * 0.9
        );
        if (candleHigh !== null && candleLow !== null) {
          ctx.fillStyle = hexToRgba(dirColor, 0.06);
          ctx.fillRect(xEntry - halfWidth, candleHigh, halfWidth * 2, candleLow - candleHigh);
        }

        // Small triangle marker pointing at the candle.
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

        // Non-colour cue: a letter R / F inside the marker for colour-blind users.
        ctx.font = MARKUP_FONT.glyph;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(isRise ? 'R' : 'F', xEntry, isRise ? markerY - 1 : markerY + 1);
        ctx.textAlign = 'left';

        // Short label: RISE / FALL + quality. Model detail lives in the panel.
        const meta = typeof levels.quality === 'number' ? ` ${levels.quality}` : '';
        drawTag(ctx, {
          x: xEntry + 6,
          y: markerY,
          text: `${isRise ? 'RISE' : 'FALL'}${meta}`,
          color: dirColor,
        });
      }

      ctx.restore();
    });
  }

  private drawLevel(
    ctx: CanvasRenderingContext2D,
    width: number,
    y: number,
    color: string,
    badge: string,
    dash: number[]
  ): void {
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
      text: `${badge} ${formatLevel(badge === 'SL' ? this.levels.stopLoss : badge.startsWith('TP') ? this.levels.takeProfit : this.levels.entry)}`,
      color,
    });
  }
}

function formatLevel(price: number): string {
  const abs = Math.abs(price);
  const digits = abs >= 1000 ? 2 : abs >= 10 ? 3 : 5;
  return price.toFixed(digits);
}

class SignalAnnotationPaneView implements IPrimitivePaneView {
  private readonly source: SignalAnnotationPrimitive;

  constructor(source: SignalAnnotationPrimitive) {
    this.source = source;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    const chart = this.source.chart;
    const series = this.source.series;
    if (!chart || !series || !this.source.levels) return null;
    return new SignalAnnotationRenderer(chart, series, this.source.levels);
  }
}

export class SignalAnnotationPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  levels: SignalLevels | null = null;
  private requestUpdate?: () => void;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor() {
    this._paneViews = [new SignalAnnotationPaneView(this)];
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

  updateAllViews(): void {
    // Coordinates resolve dynamically on each draw.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setLevels(levels: SignalLevels | null): void {
    this.levels = levels;
    this.requestUpdate?.();
  }
}
