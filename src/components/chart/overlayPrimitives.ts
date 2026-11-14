import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time
} from 'lightweight-charts';
import type { OverlayShape, OverlayTone } from './chartOverlays';
import type { ChartColors } from './chartTheme';

/**
 * Paints the chart-structure overlays onto the chart's own canvas layer.
 *
 * Lightweight Charts has no zone/segment primitives, so this implements
 * `ISeriesPrimitive`: it receives a pane view, converts each shape's
 * time/price into pixels via the series and time-scale APIs, and draws with a
 * plain 2D context. Nothing here decides *what* to draw — that is the pure
 * model in `chartOverlays.ts`; this file only paints.
 */

export interface OverlayToneColors {
  line: string;
  fill?: string;
  label?: string;
}

function toneColors(colors: ChartColors): Record<OverlayTone, OverlayToneColors> {
  return {
    support: { line: colors.zoneSupport, fill: colors.zoneSupportFill, label: colors.zoneSupport },
    resistance: { line: colors.zoneResistance, fill: colors.zoneResistanceFill, label: colors.zoneResistance },
    flipSupport: { line: colors.flipSupport, fill: colors.flipSupportFill, label: colors.flipSupport },
    flipResistance: { line: colors.flipResistance, fill: colors.flipResistanceFill, label: colors.flipResistance },
    supply: { line: colors.zoneResistance, fill: colors.zoneResistanceFill, label: colors.zoneResistance },
    demand: { line: colors.zoneSupport, fill: colors.zoneSupportFill, label: colors.zoneSupport },
    trendBull: { line: colors.trendBull },
    trendBear: { line: colors.trendBear },
    trendNeutral: { line: colors.trendNeutral },
    protectedHigh: { line: colors.protectedHigh, label: colors.protectedHigh },
    protectedLow: { line: colors.protectedLow, label: colors.protectedLow },
    patternNeckline: { line: colors.patternNeckline, label: colors.patternNeckline },
    patternBoundary: { line: colors.patternBoundary },
    patternPole: { line: colors.patternPole },
    breakout: { line: colors.breakout, label: colors.breakout },
    rise: { line: colors.rise, fill: colors.riseFill, label: colors.rise },
    fall: { line: colors.fall, fill: colors.fallFill, label: colors.fall }
  };
}

class OverlayRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly shapes: readonly OverlayShape[],
    private readonly colors: ChartColors,
    private readonly priceFormatter: (p: number) => string
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => {
      const tones = toneColors(this.colors);
      // Labels are collected and drawn last so a later band can never cover one.
      const labels: { x: number; y: number; text: string; color: string; align: CanvasTextAlign }[] = [];

      for (const shape of this.shapes) {
        if (shape.kind === 'zone') this.drawZone(ctx, shape, tones, mediaSize.width, labels);
        else if (shape.kind === 'segment') this.drawSegment(ctx, shape, tones);
        else this.drawLevel(ctx, shape, tones, mediaSize.width, labels);
      }

      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      for (const l of labels) {
        ctx.textAlign = l.align;
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, l.x, l.y);
      }
      ctx.textAlign = 'left';
    });
  }

  private drawZone(
    ctx: CanvasRenderingContext2D,
    shape: Extract<OverlayShape, { kind: 'zone' }>,
    tones: Record<OverlayTone, OverlayToneColors>,
    width: number,
    labels: { x: number; y: number; text: string; color: string; align: CanvasTextAlign }[]
  ): void {
    const { x, y } = this.project(shape.from, shape.top);
    const end = this.project(shape.to, shape.bottom);
    const xStart = Math.max(0, x);
    const xEnd = Math.min(width, end.x);
    if (xEnd <= xStart) return;

    const yTop = Math.min(y, end.y);
    const yBottom = Math.max(y, end.y);
    const tone = tones[shape.tone];
    const height = Math.max(2, yBottom - yTop);

    if (tone.fill) {
      ctx.fillStyle = tone.fill;
      ctx.fillRect(xStart, yTop, xEnd - xStart, height);
    }

    ctx.strokeStyle = tone.line;
    ctx.lineWidth = shape.midline ? 1.65 : 1;
    if (shape.midline) {
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(xStart, yTop + height / 2);
      ctx.lineTo(xEnd, yTop + height / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.beginPath();
      ctx.moveTo(xStart, yTop);
      ctx.lineTo(xEnd, yTop);
      ctx.stroke();
    }

    if (shape.label && tone.label) {
      labels.push({
        x: xEnd - 6,
        y: Math.max(12, yTop + 10),
        text: `${shape.label} ${this.priceFormatter(shape.top)}`,
        color: tone.label,
        align: 'right'
      });
    }
  }

  private drawSegment(
    ctx: CanvasRenderingContext2D,
    shape: Extract<OverlayShape, { kind: 'segment' }>,
    tones: Record<OverlayTone, OverlayToneColors>
  ): void {
    const a = this.project(shape.fromEpoch, shape.fromPrice);
    const b = this.project(shape.toEpoch, shape.toPrice);
    ctx.strokeStyle = tones[shape.tone].line;
    ctx.lineWidth = shape.width ?? 1.2;
    if (shape.dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawLevel(
    ctx: CanvasRenderingContext2D,
    shape: Extract<OverlayShape, { kind: 'level' }>,
    tones: Record<OverlayTone, OverlayToneColors>,
    width: number,
    labels: { x: number; y: number; text: string; color: string; align: CanvasTextAlign }[]
  ): void {
    const start = this.project(shape.from, shape.price);
    const end = this.project(shape.to, shape.price);
    const xStart = Math.max(0, start.x);
    const xEnd = Math.min(width, end.x);
    if (xEnd <= xStart) return;

    const tone = tones[shape.tone];
    ctx.strokeStyle = tone.line;
    ctx.lineWidth = 1.15;
    if (shape.dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(xStart, start.y);
    ctx.lineTo(xEnd, start.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (shape.dotEpoch !== undefined) {
      const dot = this.project(shape.dotEpoch, shape.price);
      if (dot.x >= xStart && dot.x <= xEnd) {
        ctx.fillStyle = tone.line;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (shape.label && tone.label) {
      labels.push({
        x: xEnd - 6,
        y: Math.max(12, start.y - 5),
        text: `${shape.label} ${this.priceFormatter(shape.price)}`,
        color: tone.label,
        align: 'right'
      });
    }
  }

  /**
   * Time and price to media (CSS pixel) coordinates. The series and time scale
   * are supplied by the primitive wrapper before each draw.
   */
  private project(time: number, price: number): { x: number; y: number } {
    const x = this.timeToCoordinate ? (this.timeToCoordinate(time as Time) ?? -1e6) : -1e6;
    const y = this.priceToCoordinate ? (this.priceToCoordinate(price) ?? -1e6) : -1e6;
    return { x, y };
  }

  // Injected by OverlayPrimitive when the chart attaches/detaches.
  timeToCoordinate: ((time: Time) => number | null) | null = null;
  priceToCoordinate: ((price: number) => number | null) | null = null;
}

class OverlayPaneView implements IPrimitivePaneView {
  private readonly renderer_: OverlayRenderer;

  constructor(shapes: readonly OverlayShape[], colors: ChartColors, priceFormatter: (p: number) => string) {
    this.renderer_ = new OverlayRenderer(shapes, colors, priceFormatter);
  }

  zOrder(): PrimitivePaneViewZOrder {
    // Draw above the candles so zones read as annotations, not background.
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this.renderer_;
  }

  get rendererInstance(): OverlayRenderer {
    return this.renderer_;
  }
}

export class OverlayPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<'Candlestick' | 'Area', Time> | null = null;
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private view: OverlayPaneView;

  constructor(
    shapes: readonly OverlayShape[],
    colors: ChartColors,
    private readonly priceFormatter: (p: number) => string
  ) {
    this.view = new OverlayPaneView(shapes, colors, priceFormatter);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series as ISeriesApi<'Candlestick' | 'Area', Time>;
    this.chart = param.chart;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.chart = null;
    this.requestUpdate = null;
  }

  update(shapes: readonly OverlayShape[], colors: ChartColors): void {
    this.view = new OverlayPaneView(shapes, colors, this.priceFormatter);
    // Overlays can change without a new bar, so ask for a repaint explicitly.
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const series = this.series;
    const chart = this.chart;
    if (series && chart) {
      const renderer = this.view.rendererInstance;
      renderer.priceToCoordinate = (price: number) => series.priceToCoordinate(price);
      renderer.timeToCoordinate = (time: Time) => chart.timeScale().timeToCoordinate(time);
    }
    return [this.view];
  }
}
