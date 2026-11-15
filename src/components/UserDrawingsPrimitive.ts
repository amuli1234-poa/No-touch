import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export type DrawingKind = 'trendline' | 'horizontal' | 'rectangle';

export interface DrawingPoint {
  time: number;
  price: number;
}

export interface UserDrawing {
  id: string;
  kind: DrawingKind;
  points: DrawingPoint[];
  color: string;
}

export const DRAWING_COLORS: Record<DrawingKind, string> = {
  trendline: '#0ea5e9',
  horizontal: '#f59e0b',
  rectangle: '#8b5cf6',
};

class DrawingsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: UserDrawingsPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chart;
    const series = this.source.series;
    if (!chart || !series) return;
    const drawings = this.source.drawings;
    if (drawings.length === 0) return;

    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();

      for (const drawing of drawings) {
        const coords = drawing.points.map((p) => ({
          x: timeScale.timeToCoordinate(p.time as unknown as Time),
          y: series.priceToCoordinate(p.price),
        }));
        if (coords.some((c) => c.x === null || c.y === null)) continue;
        const pts = coords as Array<{ x: number; y: number }>;

        ctx.strokeStyle = drawing.color;
        ctx.fillStyle = drawing.color;
        ctx.lineWidth = 1.6;

        if (drawing.kind === 'horizontal' && pts.length >= 1) {
          const y = pts[0].y;
          ctx.beginPath();
          ctx.setLineDash([6, 4]);
          ctx.moveTo(0, y);
          ctx.lineTo(mediaSize.width, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(pts[0].x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        } else if (drawing.kind === 'trendline' && pts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          ctx.lineTo(pts[1].x, pts[1].y);
          ctx.stroke();
          for (const p of pts) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (drawing.kind === 'rectangle' && pts.length >= 2) {
          const x = Math.min(pts[0].x, pts[1].x);
          const y = Math.min(pts[0].y, pts[1].y);
          const w = Math.abs(pts[1].x - pts[0].x);
          const h = Math.abs(pts[1].y - pts[0].y);
          ctx.globalAlpha = 0.12;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
          ctx.strokeRect(x, y, w, h);
        }
      }

      ctx.restore();
    });
  }
}

class DrawingsPaneView implements IPrimitivePaneView {
  constructor(private readonly source: UserDrawingsPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (!this.source.chart || !this.source.series) return null;
    return new DrawingsRenderer(this.source);
  }
}

export class UserDrawingsPrimitive implements ISeriesPrimitive<Time> {
  chart: SeriesAttachedParameter<Time, SeriesType>['chart'] | null = null;
  series: SeriesAttachedParameter<Time, SeriesType>['series'] | null = null;
  drawings: readonly UserDrawing[] = [];
  private requestUpdate?: () => void;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor() {
    this._paneViews = [new DrawingsPaneView(this)];
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
    // Coordinates are resolved on draw from the live timeScale and series.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setDrawings(drawings: readonly UserDrawing[]): void {
    this.drawings = drawings;
    this.requestUpdate?.();
  }
}
