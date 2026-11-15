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

const COLORS = {
  rise: '#16a34a',
  riseSoft: 'rgba(22, 163, 74, 0.28)',
  fall: '#dc2626',
  fallSoft: 'rgba(220, 38, 38, 0.28)',
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

/**
 * Draws the mandatory RISE/FALL entry annotations and the locked ENTRY / STOP-LOSS
 * levels plus the dynamic TAKE-PROFIT level directly on the candle canvas.
 *
 * Everything is drawn in media coordinates on every frame, so the annotations stay
 * pinned to their exact candle and price through zoom, pan and resize. Shape plus a
 * text label are used in addition to colour so the markers remain distinguishable
 * without relying on colour alone.
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
      const dirColor = isRise ? COLORS.rise : COLORS.fall;

      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const yEntry = this.series.priceToCoordinate(levels.entry);
      const yStop = this.series.priceToCoordinate(levels.stopLoss);
      const yTarget = this.series.priceToCoordinate(levels.takeProfit);
      const xEntry = timeScale.timeToCoordinate(levels.entryTime as UTCTimestamp);

      // -------------------------------------------------------------------
      // 1. Locked ENTRY level — permanent solid line, blue, labelled.
      // -------------------------------------------------------------------
      if (yEntry !== null) {
        this.drawLevel(ctx, {
          y: yEntry,
          width,
          color: COLORS.entry,
          dash: [],
          label: `ENTRY ${formatLevel(levels.entry)}`,
          badge: 'ENTRY',
          badgeColor: COLORS.entry,
          thickness: 2,
        });
      }

      // -------------------------------------------------------------------
      // 2. Locked STOP-LOSS level — permanent solid red line with lock glyph.
      // -------------------------------------------------------------------
      if (yStop !== null) {
        this.drawLevel(ctx, {
          y: yStop,
          width,
          color: COLORS.stop,
          dash: [],
          label: `STOP-LOSS ${formatLevel(levels.stopLoss)}`,
          badge: 'SL LOCKED',
          badgeColor: COLORS.stop,
          thickness: 2,
        });
      }

      // -------------------------------------------------------------------
      // 3. Dynamic TAKE-PROFIT level — dashed, animates on adjustment.
      // -------------------------------------------------------------------
      if (yTarget !== null) {
        this.drawLevel(ctx, {
          y: yTarget,
          width,
          color: COLORS.target,
          dash: [7, 5],
          label: `TAKE-PROFIT ${formatLevel(levels.takeProfit)}${levels.tpAnimating ? ' ▲' : ''}`,
          badge: levels.tpAnimating ? 'TP MOVING' : 'TP DYNAMIC',
          badgeColor: COLORS.target,
          thickness: levels.tpAnimating ? 3 : 1.6,
          pulse: levels.tpAnimating,
        });
      }

      // -------------------------------------------------------------------
      // 4. Risk / reward ribbon between stop and target (context, not colour-only).
      // -------------------------------------------------------------------
      if (yEntry !== null && yStop !== null && yTarget !== null) {
        const x0 = Math.max(0, width * 0.55);
        const ribbonW = width - x0;
        ctx.fillStyle = hexToRgba(COLORS.stop, 0.07);
        ctx.fillRect(x0, Math.min(yStop, yEntry), ribbonW, Math.abs(yEntry - yStop));
        ctx.fillStyle = hexToRgba(COLORS.target, 0.07);
        ctx.fillRect(x0, Math.min(yTarget, yEntry), ribbonW, Math.abs(yTarget - yEntry));
      }

      // -------------------------------------------------------------------
      // 5. Big RISE / FALL arrow marker pointing at the exact candle + price.
      // -------------------------------------------------------------------
      if (xEntry !== null && yEntry !== null) {
        const arrowSize = 20;
        const arrowY = isRise ? yEntry + 34 : yEntry - 34;

        // Highlight the confirmation candle.
        const barSpacing = timeScale.options().barSpacing ?? 10;
        const halfWidth = Math.max(4, Math.min(12, barSpacing * 0.42));
        ctx.fillStyle = hexToRgba(dirColor, 0.16);
        ctx.strokeStyle = hexToRgba(dirColor, 0.75);
        ctx.lineWidth = 1.5;
        const candleHigh = this.series.priceToCoordinate(
          this.levels.entry + Math.abs(levels.entry - levels.stopLoss) * 0.9
        );
        const candleLow = this.series.priceToCoordinate(
          this.levels.entry - Math.abs(levels.entry - levels.stopLoss) * 0.9
        );
        if (candleHigh !== null && candleLow !== null) {
          ctx.fillRect(xEntry - halfWidth, candleHigh, halfWidth * 2, candleLow - candleHigh);
          ctx.strokeRect(xEntry - halfWidth, candleHigh, halfWidth * 2, candleLow - candleHigh);
        }

        // Stem connecting the arrow to the entry price.
        ctx.strokeStyle = hexToRgba(dirColor, 0.9);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(xEntry, yEntry);
        ctx.lineTo(xEntry, isRise ? arrowY - arrowSize * 0.6 : arrowY + arrowSize * 0.6);
        ctx.stroke();

        // Arrow body (triangle).
        ctx.fillStyle = dirColor;
        ctx.beginPath();
        if (isRise) {
          ctx.moveTo(xEntry, arrowY - arrowSize * 0.6);
          ctx.lineTo(xEntry - arrowSize * 0.55, arrowY + arrowSize * 0.5);
          ctx.lineTo(xEntry + arrowSize * 0.55, arrowY + arrowSize * 0.5);
        } else {
          ctx.moveTo(xEntry, arrowY + arrowSize * 0.6);
          ctx.lineTo(xEntry - arrowSize * 0.55, arrowY - arrowSize * 0.5);
          ctx.lineTo(xEntry + arrowSize * 0.55, arrowY - arrowSize * 0.5);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.lineWidth = 1.25;
        ctx.stroke();

        // Label block: "RISE ENTRY  <price>" plus model + quality.
        const title = isRise ? 'RISE ENTRY' : 'FALL ENTRY';
        const priceText = formatLevel(levels.entry);
        const metaParts: string[] = [];
        if (levels.modelLabel) metaParts.push(levels.modelLabel);
        if (typeof levels.quality === 'number') metaParts.push(`Q${levels.quality}`);
        const metaText = metaParts.join(' · ');

        ctx.font = '800 12px "Plus Jakarta Sans", system-ui, sans-serif';
        const titleW = ctx.measureText(title).width;
        ctx.font = '700 12px "JetBrains Mono", ui-monospace, monospace';
        const priceW = ctx.measureText(priceText).width;
        ctx.font = '600 9.5px "Plus Jakarta Sans", system-ui, sans-serif';
        const metaW = metaText ? ctx.measureText(metaText).width : 0;

        const blockW = Math.max(titleW + priceW + 18, metaW) + 20;
        const blockH = metaText ? 42 : 26;
        const blockX = Math.max(
          6,
          Math.min(width - blockW - 6, xEntry - blockW / 2)
        );
        const blockY = isRise
          ? Math.min(height - blockH - 6, arrowY + 12)
          : Math.max(6, arrowY - blockH - 12);

        ctx.fillStyle = 'rgba(9, 14, 24, 0.92)';
        roundRect(ctx, blockX, blockY, blockW, blockH, 8);
        ctx.fill();
        ctx.strokeStyle = dirColor;
        ctx.lineWidth = 1.6;
        roundRect(ctx, blockX, blockY, blockW, blockH, 8);
        ctx.stroke();

        ctx.textBaseline = 'middle';
        ctx.font = '800 12px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillStyle = dirColor;
        ctx.fillText(title, blockX + 10, blockY + 14);

        ctx.font = '700 12px "JetBrains Mono", ui-monospace, monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(priceText, blockX + 10 + titleW + 8, blockY + 14);

        if (metaText) {
          ctx.font = '600 9.5px "Plus Jakarta Sans", system-ui, sans-serif';
          ctx.fillStyle = 'rgba(226, 232, 240, 0.86)';
          ctx.fillText(metaText, blockX + 10, blockY + 30);
        }

        // Non-colour cue: a letter R / F inside the arrow for colour-blind users.
        ctx.font = '800 10px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(
          isRise ? 'R' : 'F',
          xEntry,
          isRise ? arrowY + 1 : arrowY - 1
        );
        ctx.textAlign = 'left';
      }

      ctx.restore();
    });
  }

  private drawLevel(
    ctx: CanvasRenderingContext2D,
    opts: {
      y: number;
      width: number;
      color: string;
      dash: number[];
      label: string;
      badge: string;
      badgeColor: string;
      thickness: number;
      pulse?: boolean;
    }
  ): void {
    const { y, width, color, dash, label, badge, badgeColor, thickness, pulse } = opts;
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = pulse ? hexToRgba(badgeColor, 0.9) : hexToRgba(color, 0.85);
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Badge on the left edge.
    ctx.font = '700 9px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const badgeW = ctx.measureText(badge).width + 12;
    ctx.fillStyle = badgeColor;
    roundRect(ctx, 4, y - 8, badgeW, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(badge, 10, y);

    // Price label on the right edge.
    ctx.font = '700 9.5px "JetBrains Mono", ui-monospace, monospace';
    const labelW = ctx.measureText(label).width + 14;
    const lx = width - labelW - 4;
    ctx.fillStyle = 'rgba(9, 14, 24, 0.9)';
    roundRect(ctx, lx, y - 9, labelW, 18, 4);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(badgeColor, 0.7);
    ctx.lineWidth = 1;
    roundRect(ctx, lx, y - 9, labelW, 18, 4);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(label, lx + 7, y);
    ctx.restore();
  }
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
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
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
