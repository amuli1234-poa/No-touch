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
import type { ChartOverlayData } from '../types/analysis';
import {
  MARKUP_ALPHA,
  MARKUP_COLORS,
  MARKUP_DASH,
  MARKUP_FONT,
  MARKUP_LINE,
  drawTag,
  hexToRgba,
} from './chart/markupStyle';

/**
 * The analyser overlay. Every drawing uses the minimalist markup style (thin lines,
 * transparent fills, short S / R / SZ / DZ / BOS / CHoCH / FVG / WATCH labels) so the
 * candlesticks stay the main focus. Only the CURRENT, valid markings are drawn — the
 * overlay is pruned before it reaches this renderer.
 */
class AnalysisOverlayRenderer implements IPrimitivePaneRenderer {
  private readonly chart: IChartApi;
  private readonly series: ISeriesApi<SeriesType>;
  private readonly overlays: ChartOverlayData | null;
  private readonly latestTime: number | null;

  constructor(
    chart: IChartApi,
    series: ISeriesApi<SeriesType>,
    overlays: ChartOverlayData | null,
    latestTime: number | null
  ) {
    this.chart = chart;
    this.series = series;
    this.overlays = overlays;
    this.latestTime = latestTime;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this.overlays) return;

    const overlays = this.overlays;
    const timeScale = this.chart.timeScale();

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const width = mediaSize.width;
      const height = mediaSize.height;
      if (width <= 0 || height <= 0) return;

      ctx.save();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      // 0a. Sideways range bands (range extremes only). Upper 25% red, middle 50% grey,
      //     lower 25% green. Drawn behind everything else, very faint.
      if (overlays.range?.valid) {
        const r = overlays.range;
        const bands: { top: number; bottom: number; color: string; label: string }[] = [
          { top: r.resistance, bottom: r.tradingArea.lower, color: MARKUP_COLORS.fall, label: 'R AREA' },
          { top: r.tradingArea.lower, bottom: r.noTradeBand.lower, color: MARKUP_COLORS.neutral, label: 'NT' },
          { top: r.noTradeBand.lower, bottom: r.support, color: MARKUP_COLORS.rise, label: 'S AREA' },
        ];
        for (const band of bands) {
          const yTop = this.series.priceToCoordinate(band.top);
          const yBottom = this.series.priceToCoordinate(band.bottom);
          if (yTop === null || yBottom === null) continue;
          const top = Math.min(yTop, yBottom);
          const boxHeight = Math.max(2, Math.abs(yBottom - yTop));
          if (top + boxHeight < 0 || top > height) continue;
          ctx.fillStyle = hexToRgba(band.color, MARKUP_ALPHA.fill);
          ctx.fillRect(0, top, width, boxHeight);
          const ly = top + boxHeight / 2;
          if (ly >= 8 && ly <= height - 8) {
            drawTag(ctx, { x: 6, y: ly, text: band.label, color: band.color });
          }
        }
      }

      // 0. High-probability entry zone (band between the structural level and the
      //    confirmation close). Drawn first so it sits behind the annotations.
      if (overlays.entryZone) {
        const ez = overlays.entryZone;
        const yTop = this.series.priceToCoordinate(ez.high);
        const yBottom = this.series.priceToCoordinate(ez.low);
        if (yTop !== null && yBottom !== null) {
          const top = Math.min(yTop, yBottom);
          const boxHeight = Math.max(3, Math.abs(yBottom - yTop));
          if (top + boxHeight >= 0 && top <= height) {
            const xStart = Math.max(0, width * 0.62);
            const boxWidth = width - xStart;
            ctx.fillStyle = hexToRgba(MARKUP_COLORS.entry, MARKUP_ALPHA.fillActive);
            ctx.fillRect(xStart, top, boxWidth, boxHeight);
            ctx.strokeStyle = hexToRgba(MARKUP_COLORS.entry, MARKUP_ALPHA.edgeSoft);
            ctx.lineWidth = MARKUP_LINE.hair;
            ctx.setLineDash(MARKUP_DASH.subtle);
            ctx.strokeRect(xStart, top, boxWidth, boxHeight);
            ctx.setLineDash([]);

            const ly = Math.max(12, Math.min(height - 12, top - 10));
            drawTag(ctx, { x: xStart + 6, y: ly, text: ez.label, color: MARKUP_COLORS.entry });
          }
        }
      }

      // 1. Supply & Demand zones — transparent rectangles, hairline boundary, short label.
      for (const zone of overlays.supplyDemand) {
        const yTop = this.series.priceToCoordinate(zone.upperPrice);
        const yBottom = this.series.priceToCoordinate(zone.lowerPrice);
        if (yTop === null || yBottom === null) continue;

        const top = Math.min(yTop, yBottom);
        const boxHeight = Math.max(2, Math.abs(yBottom - yTop));
        if (top + boxHeight < 0 || top > height) continue;

        const originX = timeScale.timeToCoordinate(zone.originTime as UTCTimestamp);
        const startX = originX === null ? 0 : Math.max(0, Math.min(width - 40, originX));
        const boxWidth = width - startX;
        if (boxWidth <= 4) continue;

        const isDemand = zone.type === 'demand';
        const color = isDemand ? MARKUP_COLORS.support : MARKUP_COLORS.resistance;
        const fresh = zone.status === 'fresh';

        ctx.fillStyle = hexToRgba(color, fresh ? MARKUP_ALPHA.fillActive : MARKUP_ALPHA.fill);
        ctx.fillRect(startX, top, boxWidth, boxHeight);

        ctx.strokeStyle = hexToRgba(color, fresh ? MARKUP_ALPHA.edge : MARKUP_ALPHA.edgeSoft);
        ctx.lineWidth = MARKUP_LINE.hair;
        ctx.setLineDash(fresh ? MARKUP_DASH.solid : MARKUP_DASH.subtle);
        ctx.strokeRect(startX, top, boxWidth, boxHeight);
        ctx.setLineDash([]);

        const labelY = Math.max(9, Math.min(height - 9, top + boxHeight / 2));
        drawTag(ctx, {
          x: startX + 6,
          y: labelY,
          text: isDemand ? 'DZ' : 'SZ',
          color,
        });
      }

      // 2. Trendlines (thin; broken lines dashed).
      for (const tl of overlays.trendlines) {
        const x1 = timeScale.timeToCoordinate(tl.startTime as UTCTimestamp);
        const y1 = this.series.priceToCoordinate(tl.startPrice);
        const endT = this.latestTime && this.latestTime > tl.endTime ? this.latestTime : tl.endTime;
        const endYPrice = tl.startPrice + tl.slopePerSec * (endT - tl.startTime);
        const x2 = timeScale.timeToCoordinate(endT as UTCTimestamp);
        const y2 = this.series.priceToCoordinate(endYPrice);
        if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

        const color = tl.direction === 'bullish' ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;
        ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edge);
        ctx.lineWidth = MARKUP_LINE.hair;
        ctx.setLineDash(tl.broken ? MARKUP_DASH.subtle : MARKUP_DASH.solid);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);

        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        const ly = Math.max(12, Math.min(height - 12, midY - 11));
        drawTag(ctx, {
          x: midX,
          y: ly,
          align: 'center',
          text: tl.broken ? 'TL ×' : 'TL',
          color,
        });
      }

      // 2b. MAJOR trendlines (significant swings only) — a touch firmer than minor ones.
      for (const tl of overlays.majorTrendlines) {
        const x1 = timeScale.timeToCoordinate(tl.startTime as UTCTimestamp);
        const y1 = this.series.priceToCoordinate(tl.startPrice);
        if (x1 === null || y1 === null) continue;
        const endT = this.latestTime && this.latestTime > tl.endTime ? this.latestTime : tl.endTime;
        const endYPrice = tl.startPrice + tl.slopePerSec * (endT - tl.startTime);
        const x2 = timeScale.timeToCoordinate(endT as UTCTimestamp);
        const y2 = this.series.priceToCoordinate(endYPrice);
        if (x2 === null || y2 === null) continue;

        const color = tl.direction === 'bullish' ? MARKUP_COLORS.support : MARKUP_COLORS.resistance;
        ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edgeStrong);
        ctx.lineWidth = MARKUP_LINE.edge;
        ctx.setLineDash(MARKUP_DASH.solid);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Small anchor dots at the major swing touches.
        ctx.fillStyle = color;
        for (const a of tl.anchors) {
          const ax = timeScale.timeToCoordinate(a.time as UTCTimestamp);
          const ay = this.series.priceToCoordinate(a.price);
          if (ax === null || ay === null) continue;
          ctx.beginPath();
          ctx.arc(ax, ay, 2, 0, Math.PI * 2);
          ctx.fill();
        }

        const ly = Math.max(12, Math.min(height - 12, y2));
        drawTag(ctx, {
          x: Math.max(8, Math.min(width - 40, x2 - 34)),
          y: ly,
          text: tl.thirdTouchConfirmed ? 'TL ★' : 'TL',
          color,
        });
      }

      // 2c. MAJOR support / resistance zones — faint rectangle covering the reaction area.
      for (const zone of overlays.majorZones) {
        const xStart = timeScale.timeToCoordinate(zone.originTime as UTCTimestamp);
        const yTop = this.series.priceToCoordinate(zone.upperPrice);
        const yBottom = this.series.priceToCoordinate(zone.lowerPrice);
        if (yTop === null || yBottom === null) continue;
        const left = xStart === null ? 0 : Math.max(0, xStart);
        const top = Math.min(yTop, yBottom);
        const boxH = Math.abs(yBottom - yTop);
        if (boxH < 1) continue;

        const weakened = zone.freshness === 'WEAKENED' || zone.freshness === 'INVALIDATED';
        const color = weakened
          ? MARKUP_COLORS.neutral
          : zone.role === 'support'
            ? MARKUP_COLORS.support
            : MARKUP_COLORS.resistance;

        ctx.fillStyle = hexToRgba(color, MARKUP_ALPHA.fill);
        ctx.fillRect(left, top, width - left, boxH);
        ctx.strokeStyle = hexToRgba(color, weakened ? MARKUP_ALPHA.edgeSoft : MARKUP_ALPHA.edge);
        ctx.lineWidth = MARKUP_LINE.hair;
        ctx.setLineDash(weakened ? MARKUP_DASH.subtle : MARKUP_DASH.solid);
        ctx.strokeRect(left, top, width - left, boxH);
        ctx.setLineDash([]);

        const ly = Math.max(9, Math.min(height - 9, top + boxH / 2));
        drawTag(ctx, {
          x: left + 6,
          y: ly,
          text: zone.role === 'support' ? (zone.roleReversed ? 'S ↺' : 'S') : zone.roleReversed ? 'R ↺' : 'R',
          color,
        });
      }

      // 3a. Liquidity sweep markers (small circle + crosshair).
      for (const sweep of overlays.liquiditySweeps) {
        const sx = timeScale.timeToCoordinate(sweep.time as UTCTimestamp);
        const sy = this.series.priceToCoordinate(sweep.sweepPrice);
        if (sx === null || sy === null || sx < -20 || sx > width + 20 || sy < 0 || sy > height) {
          continue;
        }
        const bullish = sweep.type === 'BULLISH_SWEEP';
        const color = bullish ? MARKUP_COLORS.support : MARKUP_COLORS.resistance;
        ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.edge);
        ctx.lineWidth = MARKUP_LINE.hair;
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx - 4, sy);
        ctx.lineTo(sx + 4, sy);
        ctx.stroke();

        const ly = bullish ? Math.min(height - 9, sy + 13) : Math.max(9, sy - 13);
        drawTag(ctx, { x: sx, y: ly, align: 'center', text: 'SWEEP', color });
      }

      // 3b. Swing labels (HH / HL / LH / LL) — tiny, no background box.
      for (const sw of overlays.swingPoints) {
        if (!sw.swingLabel) continue;
        const px = timeScale.timeToCoordinate(sw.time as UTCTimestamp);
        const py = this.series.priceToCoordinate(sw.price);
        if (px === null || py === null || px < -20 || px > width + 20) continue;
        const isHigh = sw.type === 'high';
        const bullishLabel = sw.swingLabel === 'HH' || sw.swingLabel === 'HL';
        const color = bullishLabel ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;
        const ly = isHigh ? py - 9 : py + 9;
        if (ly < 6 || ly > height - 6) continue;
        ctx.font = MARKUP_FONT.microBold;
        ctx.textAlign = 'center';
        ctx.fillStyle = hexToRgba(color, 0.95);
        ctx.fillText(sw.swingLabel, px, ly);
        ctx.textAlign = 'left';
      }

      // 3. Chart patterns (thin; forming patterns dashed).
      for (const pat of overlays.patterns) {
        const patColor = pat.confirmed
          ? pat.bias === 'bullish'
            ? MARKUP_COLORS.rise
            : MARKUP_COLORS.fall
          : MARKUP_COLORS.neutral;

        let sumX = 0;
        let sumY = 0;
        let segCount = 0;

        for (const seg of pat.lines) {
          const x1 = timeScale.timeToCoordinate(seg.startTime as UTCTimestamp);
          const y1 = this.series.priceToCoordinate(seg.startPrice);
          const x2 = timeScale.timeToCoordinate(seg.endTime as UTCTimestamp);
          const y2 = this.series.priceToCoordinate(seg.endPrice);
          if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

          ctx.strokeStyle = hexToRgba(patColor, MARKUP_ALPHA.edge);
          ctx.lineWidth = MARKUP_LINE.hair;
          ctx.setLineDash(pat.confirmed ? MARKUP_DASH.solid : MARKUP_DASH.subtle);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.setLineDash([]);

          sumX += (x1 + x2) / 2;
          sumY += (y1 + y2) / 2;
          segCount++;
        }

        if (segCount > 0) {
          const centerX = sumX / segCount;
          const centerY = sumY / segCount;
          const ly = Math.max(12, Math.min(height - 12, centerY + 11));
          drawTag(ctx, {
            x: centerX,
            y: ly,
            align: 'center',
            text: pat.confirmed ? pat.name : `${pat.name} …`,
            color: patColor,
          });
        }
      }

      // 4. Breakout level & retest markings for the confirmed setup.
      if (overlays.breakoutRetest) {
        const br = overlays.breakoutRetest;
        const yLevel = this.series.priceToCoordinate(br.breakoutLevel);
        const xStart = timeScale.timeToCoordinate(br.breakoutTime as UTCTimestamp);
        const xEnd =
          this.latestTime !== null
            ? timeScale.timeToCoordinate(this.latestTime as UTCTimestamp)
            : width - 16;

        if (yLevel !== null && yLevel >= 0 && yLevel <= height) {
          const drawStartX = xStart === null ? Math.max(0, width * 0.45) : Math.max(0, xStart);
          const drawEndX = xEnd === null ? width - 12 : Math.min(width - 4, xEnd + 24);
          const accent = br.direction === 'RISE' ? MARKUP_COLORS.support : MARKUP_COLORS.resistance;

          ctx.strokeStyle = hexToRgba(accent, MARKUP_ALPHA.edge);
          ctx.lineWidth = MARKUP_LINE.hair;
          ctx.setLineDash(MARKUP_DASH.subtle);
          ctx.beginPath();
          ctx.moveTo(drawStartX, yLevel);
          ctx.lineTo(Math.max(drawStartX + 24, drawEndX), yLevel);
          ctx.stroke();
          ctx.setLineDash([]);

          const ly = Math.max(12, Math.min(height - 12, yLevel - 11));
          drawTag(ctx, { x: drawStartX + 6, y: ly, text: br.label, color: accent });
        }

        if (br.retestTime !== null && br.retestPrice !== null) {
          const rx = timeScale.timeToCoordinate(br.retestTime as UTCTimestamp);
          const ry = this.series.priceToCoordinate(br.retestPrice);
          if (rx !== null && ry !== null && rx >= 0 && rx <= width && ry >= 0 && ry <= height) {
            const retestColor = br.direction === 'RISE' ? MARKUP_COLORS.rise : MARKUP_COLORS.fall;
            ctx.fillStyle = retestColor;
            ctx.beginPath();
            ctx.arc(rx, ry, 2.5, 0, Math.PI * 2);
            ctx.fill();

            const rly = br.direction === 'RISE' ? Math.min(height - 9, ry + 12) : Math.max(9, ry - 12);
            drawTag(ctx, { x: rx, y: rly, align: 'center', text: 'RETEST', color: retestColor });
          }
        }
      }

      ctx.restore();
    });
  }
}

class AnalysisOverlayPaneView implements IPrimitivePaneView {
  private readonly source: AnalysisChartPrimitive;

  constructor(source: AnalysisChartPrimitive) {
    this.source = source;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }

  renderer(): IPrimitivePaneRenderer | null {
    const chart = this.source.chart;
    const series = this.source.series;
    if (!chart || !series || !this.source.overlays) {
      return null;
    }
    return new AnalysisOverlayRenderer(
      chart,
      series,
      this.source.overlays,
      this.source.latestTime
    );
  }
}

export class AnalysisChartPrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  overlays: ChartOverlayData | null = null;
  latestTime: number | null = null;
  private requestUpdate?: () => void;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor() {
    this._paneViews = [new AnalysisOverlayPaneView(this)];
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
    // Renderer resolves coordinates dynamically from current timeScale and series on draw
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  setOverlays(overlays: ChartOverlayData | null, latestTime: number | null): void {
    this.overlays = overlays;
    this.latestTime = latestTime;
    this.requestUpdate?.();
  }
}
