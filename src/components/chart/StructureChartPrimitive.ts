import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  ITimeScaleApi,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  FairValueGap,
  FutureReactionZone,
  RejectionZone,
  StructureBias,
  StructureOverlayData,
  SupportResistanceBand,
} from '../../types/structure';
import { formatPrice } from '../../utils/derivParser';

/**
 * AI Chart Structure overlay: draws only the CURRENT, valid structure on the candle
 * canvas — confirmed BOS/CHOCH, support/resistance and rejection bands, and the fresh
 * future reaction (watch) zones with their three-stage status. It draws nothing that
 * has been mitigated or invalidated, so the live chart stays clean.
 */
const COLORS = {
  rise: '#16a34a',
  fall: '#dc2626',
  riseSoft: 'rgba(22, 163, 74, 0.14)',
  fallSoft: 'rgba(220, 38, 38, 0.14)',
  resistance: '#f59e0b',
  support: '#0ea5e9',
  resistanceSoft: 'rgba(245, 158, 11, 0.12)',
  supportSoft: 'rgba(14, 165, 233, 0.12)',
  choch: '#a855f7',
  bos: '#64748b',
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

function stageLabel(zone: FutureReactionZone): string {
  switch (zone.stage) {
    case 'ZONE_DETECTED':
      return 'ZONE DETECTED';
    case 'PRICE_APPROACHING':
      return 'PRICE APPROACHING';
    case 'ENTRY_CONFIRMED':
      return 'ENTRY CONFIRMED';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'INVALIDATED';
  }
}

function freshnessLabel(zone: FutureReactionZone): string {
  switch (zone.freshness) {
    case 'FRESH':
      return 'fresh';
    case 'PROBED':
      return 'probed';
    case 'PARTIALLY_TESTED':
      return 'partial';
    case 'MITIGATED':
      return 'mitigated';
    default:
      return 'invalidated';
  }
}

class StructureRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: StructureChartPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chart;
    const series = this.source.series;
    const overlay = this.source.overlay;
    if (!chart || !series || !overlay) return;

    const timeScale = chart.timeScale();
    const precision = overlay.precision;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width;
      const height = mediaSize.height;
      if (width <= 0) return;
      ctx.save();
      ctx.textBaseline = 'middle';

      // ---- Support / resistance bands (drawn behind everything) ----
      for (const band of overlay.srBands) {
        this.drawBand(ctx, series, width, band, precision);
      }

      // ---- Rejection bands ----
      for (const zone of overlay.rejectionZones) {
        this.drawRejectionBand(ctx, series, width, zone, precision);
      }

      // ---- Fresh fair value gaps (unfilled imbalances) ----
      if (overlay.showFvg !== false) {
        for (const gap of overlay.fvg) {
          this.drawFvg(ctx, series, width, timeScale, gap, precision);
        }
      }

      // ---- Future reaction watch zones (the opportunity layer) ----
      for (const zone of overlay.watchZones) {
        this.drawWatchZone(ctx, series, width, height, timeScale, zone, precision);
      }

      // ---- Confirmed BOS / CHOCH levels ----
      for (const brk of overlay.breaks) {
        const y = series.priceToCoordinate(brk.brokenLevel);
        if (y === null) continue;
        const isBull = brk.direction === 'bullish';
        const color = brk.kind === 'CHOCH' ? COLORS.choch : isBull ? COLORS.rise : COLORS.fall;
        const x = timeScale.timeToCoordinate(brk.time as UTCTimestamp);
        const xStart = x === null ? width - 90 : Math.max(0, x - 80);

        ctx.strokeStyle = hexToRgba(color, 0.9);
        ctx.lineWidth = 1.6;
        ctx.setLineDash(brk.kind === 'CHOCH' ? [2, 4] : [8, 4]);
        ctx.beginPath();
        ctx.moveTo(xStart, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.setLineDash([]);

        const text = `${brk.kind} ${isBull ? '▲' : '▼'} ${formatPrice(brk.brokenLevel, precision)}`;
        ctx.font = '800 9px "Plus Jakarta Sans", system-ui, sans-serif';
        const tw = ctx.measureText(text).width;
        const bx = Math.min(width - tw - 14, Math.max(6, xStart + 4));
        ctx.fillStyle = 'rgba(9, 14, 24, 0.9)';
        roundRect(ctx, bx, y - 9, tw + 10, 18, 5);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(color, 0.75);
        ctx.lineWidth = 1;
        roundRect(ctx, bx, y - 9, tw + 10, 18, 5);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillText(text, bx + 5, y);
      }

      ctx.restore();
    });
  }

  private drawBand(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    band: SupportResistanceBand,
    precision: number
  ): void {
    const yTop = series.priceToCoordinate(band.upperPrice);
    const yBot = series.priceToCoordinate(band.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const isResistance = band.type === 'resistance';
    const fill = isResistance ? COLORS.resistanceSoft : COLORS.supportSoft;
    const line = isResistance ? COLORS.resistance : COLORS.support;

    ctx.fillStyle = fill;
    ctx.fillRect(0, top, width, h);
    ctx.strokeStyle = hexToRgba(line, band.importance === 'major' ? 0.7 : 0.4);
    ctx.lineWidth = band.importance === 'major' ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(width, top);
    ctx.moveTo(0, top + h);
    ctx.lineTo(width, top + h);
    ctx.stroke();

    const label = `${band.type === 'resistance' ? 'R' : 'S'} ${band.touches}× ${formatPrice(
      (band.upperPrice + band.lowerPrice) / 2,
      precision
    )}`;
    ctx.font = '700 9px "Plus Jakarta Sans", system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(9, 14, 24, 0.82)';
    roundRect(ctx, width - tw - 12, top + h / 2 - 8, tw + 8, 16, 4);
    ctx.fill();
    ctx.fillStyle = line;
    ctx.fillText(label, width - tw - 8, top + h / 2);
  }

  private drawRejectionBand(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    zone: RejectionZone,
    precision: number
  ): void {
    const yTop = series.priceToCoordinate(zone.upperPrice);
    const yBot = series.priceToCoordinate(zone.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const color = zone.direction === 'RISE' ? COLORS.rise : COLORS.fall;

    ctx.fillStyle = zone.direction === 'RISE' ? COLORS.riseSoft : COLORS.fallSoft;
    ctx.fillRect(0, top, width, h);
    ctx.strokeStyle = hexToRgba(color, zone.structuralSignificance === 'major' ? 0.85 : 0.5);
    ctx.lineWidth = 1.3;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(0.5, top + 0.5, width - 1, h - 1);
    ctx.setLineDash([]);

    const label = `REJECTION · ${zone.direction === 'RISE' ? 'buy' : 'sell'} · ${formatPrice(
      (zone.upperPrice + zone.lowerPrice) / 2,
      precision
    )}`;
    ctx.font = '700 9px "Plus Jakarta Sans", system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(9, 14, 24, 0.82)';
    roundRect(ctx, 6, top - 9, tw + 12, 17, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(label, 12, top);
  }

  private drawFvg(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    timeScale: ITimeScaleApi<Time>,
    gap: FairValueGap,
    precision: number
  ): void {
    const yTop = series.priceToCoordinate(gap.upperPrice);
    const yBot = series.priceToCoordinate(gap.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const isRise = gap.reaction === 'RISE';
    const color = isRise ? COLORS.support : COLORS.resistance;

    // Gaps are drawn from their formation time onwards only.
    const xOrigin = timeScale.timeToCoordinate(gap.time as UTCTimestamp);
    const xStart = xOrigin === null ? 0 : Math.max(0, Math.min(width, xOrigin));
    const zoneW = Math.max(0, width - xStart);
    if (zoneW <= 0) return;

    ctx.fillStyle = hexToRgba(color, 0.14);
    ctx.fillRect(xStart, top, zoneW, h);
    ctx.strokeStyle = hexToRgba(color, 0.55);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(xStart + 0.5, top + 0.5, Math.max(0, zoneW - 1), h - 1);
    ctx.setLineDash([]);

    const label = `FVG ${isRise ? '▲' : '▼'} ${formatPrice(
      (gap.upperPrice + gap.lowerPrice) / 2,
      precision
    )} · ${gap.sizeAtr.toFixed(1)}×`;
    ctx.font = '700 8.5px "Plus Jakarta Sans", system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const bx = Math.max(6, Math.min(width - tw - 12, xStart + 5));
    const by = Math.max(6, top - 15);
    ctx.fillStyle = 'rgba(9, 14, 24, 0.82)';
    roundRect(ctx, bx, by, tw + 10, 15, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(label, bx + 5, by + 8);
  }

  private drawWatchZone(
    ctx: CanvasRenderingContext2D,
    series: SeriesAttachedParameter<Time, SeriesType>['series'],
    width: number,
    height: number,
    timeScale: ITimeScaleApi<Time>,
    zone: FutureReactionZone,
    precision: number
  ): void {
    const yTop = series.priceToCoordinate(zone.upperPrice);
    const yBot = series.priceToCoordinate(zone.lowerPrice);
    if (yTop === null || yBot === null) return;
    const top = Math.min(yTop, yBot);
    const h = Math.max(2, Math.abs(yBot - yTop));
    const isRise = zone.direction === 'RISE';
    const color = isRise ? COLORS.rise : COLORS.fall;

    // Only draw the zone from its formation time onwards.
    const xOrigin = timeScale.timeToCoordinate(zone.originTime as UTCTimestamp);
    const xStart = xOrigin === null ? 0 : Math.max(0, Math.min(width, xOrigin));

    ctx.fillStyle = isRise ? COLORS.riseSoft : COLORS.fallSoft;
    ctx.fillRect(xStart, top, Math.max(0, width - xStart), h);

    // Active / approaching zones get a solid border; distant ones are dashed.
    ctx.strokeStyle = hexToRgba(color, zone.stage === 'PRICE_APPROACHING' ? 0.95 : 0.7);
    ctx.lineWidth = zone.stage === 'PRICE_APPROACHING' ? 2 : 1.3;
    ctx.setLineDash(zone.stage === 'PRICE_APPROACHING' ? [] : [5, 4]);
    ctx.strokeRect(xStart + 0.5, top + 0.5, Math.max(0, width - xStart - 1), h - 1);
    ctx.setLineDash([]);

    // Invalidation level (dotted red/green guard line).
    const yInv = series.priceToCoordinate(zone.invalidationLevel);
    if (yInv !== null) {
      ctx.strokeStyle = hexToRgba(color, 0.4);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(xStart, yInv);
      ctx.lineTo(width, yInv);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Label block: direction + stage + freshness.
    const title = isRise ? 'WATCH RISE' : 'WATCH FALL';
    const meta = `${stageLabel(zone)} · ${freshnessLabel(zone)}`;
    ctx.font = '800 10px "Plus Jakarta Sans", system-ui, sans-serif';
    const tw = ctx.measureText(title).width;
    ctx.font = '600 8px "Plus Jakarta Sans", system-ui, sans-serif';
    const mw = ctx.measureText(meta).width;
    const blockW = Math.max(tw, mw) + 16;
    const blockH = 28;
    const blockX = Math.max(6, Math.min(width - blockW - 6, xStart + 6));
    const blockY = top - blockH - 4 < 6 ? top + h + 4 : top - blockH - 4;
    const clampedY = Math.max(6, Math.min(height - blockH - 6, blockY));

    ctx.fillStyle = 'rgba(9, 14, 24, 0.94)';
    roundRect(ctx, blockX, clampedY, blockW, blockH, 6);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    roundRect(ctx, blockX, clampedY, blockW, blockH, 6);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = '800 10px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillText(title, blockX + 8, clampedY + 10);
    ctx.fillStyle = COLORS.ink;
    ctx.font = '600 8px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillText(meta, blockX + 8, clampedY + 21);
  }
}

class StructurePaneView implements IPrimitivePaneView {
  constructor(private readonly source: StructureChartPrimitive) {}

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (!this.source.chart || !this.source.series || !this.source.overlay) return null;
    return new StructureRenderer(this.source);
  }
}

export interface StructureChartOverlay extends StructureOverlayData {
  precision: number;
  /** Whether fresh fair value gaps are drawn (settings toggle). */
  showFvg?: boolean;
}

/**
 * Draws the structure & future-opportunity layer on the candle canvas. Zones stay
 * pinned to their exact times/prices through zoom, pan and resize.
 */
export class StructureChartPrimitive implements ISeriesPrimitive<Time> {
  chart: SeriesAttachedParameter<Time, SeriesType>['chart'] | null = null;
  series: SeriesAttachedParameter<Time, SeriesType>['series'] | null = null;
  overlay: StructureChartOverlay | null = null;
  private requestUpdate?: () => void;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor() {
    this._paneViews = [new StructurePaneView(this)];
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

  setOverlay(overlay: StructureChartOverlay | null): void {
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

/** Bias label helper shared by the chart legend and the panel. */
export function structureBiasLabel(bias: StructureBias | 'neutral'): string {
  if (bias === 'bullish') return 'BULLISH';
  if (bias === 'bearish') return 'BEARISH';
  return 'NEUTRAL';
}
