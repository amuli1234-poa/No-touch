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
  MARKUP,
  MARKUP_ALPHA,
  MARKUP_LABEL,
  MARKUP_WIDTH,
  drawAnchorDot,
  drawHLine,
  drawLabel,
} from './chartMarkupStyle';

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
 * Draws the RISE/FALL entry marker and the locked ENTRY / STOP-LOSS / TAKE-PROFIT levels
 * on the candle canvas.
 *
 * Kept deliberately minimal: thin lines, a small triangle marker at the entry candle and
 * short labels (E, SL, TP). Everything is drawn in media coordinates on every frame, so
 * the annotations stay pinned to their exact candle and price through zoom and pan.
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
      const dirColor = isRise ? MARKUP.bull : MARKUP.bear;

      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const yEntry = this.series.priceToCoordinate(levels.entry);
      const yStop = this.series.priceToCoordinate(levels.stopLoss);
      const yTarget = this.series.priceToCoordinate(levels.takeProfit);
      const xEntry = timeScale.timeToCoordinate(levels.entryTime as UTCTimestamp);

      // Locked ENTRY — solid blue line, thin, short label.
      if (yEntry !== null) {
        this.drawLevel(ctx, yEntry, width, MARKUP.entry, [], `${MARKUP_LABEL.entry} ${formatLevel(levels.entry)}`);
      }
      // Locked STOP-LOSS — solid red line.
      if (yStop !== null) {
        this.drawLevel(ctx, yStop, width, MARKUP.stop, [], `${MARKUP_LABEL.stop} ${formatLevel(levels.stopLoss)}`);
      }
      // Dynamic TAKE-PROFIT — dashed green line.
      if (yTarget !== null) {
        this.drawLevel(
          ctx,
          yTarget,
          width,
          MARKUP.target,
          [7, 5],
          `${MARKUP_LABEL.target} ${formatLevel(levels.takeProfit)}`
        );
      }

      // Risk / reward context between stop and target — very faint, no labels.
      if (yEntry !== null && yStop !== null && yTarget !== null) {
        const x0 = Math.max(0, width * 0.62);
        const ribbonW = width - x0;
        ctx.fillStyle = hexSoft(MARKUP.stop, 0.05);
        ctx.fillRect(x0, Math.min(yStop, yEntry), ribbonW, Math.abs(yEntry - yStop));
        ctx.fillStyle = hexSoft(MARKUP.target, 0.05);
        ctx.fillRect(x0, Math.min(yTarget, yEntry), ribbonW, Math.abs(yTarget - yEntry));
      }

      // Small directional marker at the exact entry candle.
      if (xEntry !== null && yEntry !== null && xEntry >= 0 && xEntry <= width) {
        drawEntryMarker(ctx, xEntry, yEntry, dirColor, isRise);
        drawLabel(ctx, isRise ? 'RISE' : 'FALL', xEntry + 8, yEntry - 10, dirColor, {
          size: 9,
          weight: 700,
        });
      }

      ctx.restore();
    });
  }

  private drawLevel(
    ctx: CanvasRenderingContext2D,
    y: number,
    width: number,
    color: string,
    dash: number[],
    label: string
  ): void {
    drawHLine(ctx, y, width, color, { dash, width: MARKUP_WIDTH.line, alpha: MARKUP_ALPHA.line });
    drawLabel(ctx, label, width - 58, y - 9, color, { size: 9, weight: 700 });
  }
}

function hexSoft(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawEntryMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  bullish: boolean
): void {
  const s = 5;
  ctx.save();
  ctx.strokeStyle = hexSoft(color, 0.9);
  ctx.lineWidth = MARKUP_WIDTH.line;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, bullish ? y + s * 2.4 : y - s * 2.4);
  ctx.stroke();

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
  drawAnchorDot(ctx, x, y, color, 2);
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
