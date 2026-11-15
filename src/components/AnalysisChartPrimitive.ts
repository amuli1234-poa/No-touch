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
  MARKUP,
  MARKUP_ALPHA,
  MARKUP_LABEL,
  MARKUP_WIDTH,
  drawAnchorDot,
  drawHLine,
  drawLabel,
  drawZoneBox,
  hexToRgba,
} from './chart/chartMarkupStyle';

/**
 * Price-action overlay for the shared chart: supply/demand zones, trendlines (minor and
 * major), support/resistance, liquidity sweeps, swing labels, patterns, the sideways
 * range bands and the confirmed setup's breakout/retest.
 *
 * Everything is thin, lightly shaded and short-labelled so the candles stay the focus.
 * Only drawings the cleanliness pass kept as current are ever painted.
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

      // 0a. Sideways range bands — barely-there tints for the resistance / no-trade /
      //     support thirds, with a single short code on each.
      if (overlays.range?.valid) {
        const r = overlays.range;
        const bands: { top: number; bottom: number; color: string; code: string }[] = [
          { top: r.resistance, bottom: r.tradingArea.lower, color: MARKUP.bear, code: MARKUP_LABEL.resistance },
          { top: r.tradingArea.lower, bottom: r.noTradeBand.lower, color: MARKUP.neutral, code: 'NT' },
          { top: r.noTradeBand.lower, bottom: r.support, color: MARKUP.bull, code: MARKUP_LABEL.support },
        ];
        for (const band of bands) {
          const yTop = this.series.priceToCoordinate(band.top);
          const yBottom = this.series.priceToCoordinate(band.bottom);
          if (yTop === null || yBottom === null) continue;
          const top = Math.min(yTop, yBottom);
          const h = Math.max(2, Math.abs(yBottom - yTop));
          if (top + h < 0 || top > height) continue;
          drawZoneBox(ctx, {
            x: 0,
            y: top,
            w: width,
            h,
            color: band.color,
            fillAlpha: MARKUP_ALPHA.fillFaint,
            edgesOnly: true,
            edgeAlpha: MARKUP_ALPHA.edge,
          });
          const ly = top + h / 2;
          if (ly >= 8 && ly <= height - 8) drawLabel(ctx, band.code, 6, ly, band.color, { size: 9 });
        }
      }

      // 0. High-probability entry zone — thin dashed band on the right, single code.
      if (overlays.entryZone) {
        const ez = overlays.entryZone;
        const yTop = this.series.priceToCoordinate(ez.high);
        const yBottom = this.series.priceToCoordinate(ez.low);
        if (yTop !== null && yBottom !== null) {
          const top = Math.min(yTop, yBottom);
          const h = Math.max(3, Math.abs(yBottom - yTop));
          if (top + h >= 0 && top <= height) {
            const xStart = Math.max(0, width * 0.62);
            drawZoneBox(ctx, {
              x: xStart,
              y: top,
              w: width - xStart,
              h,
              color: MARKUP.accent,
              fillAlpha: MARKUP_ALPHA.fill,
              dash: [4, 3],
            });
            const ly = Math.max(10, Math.min(height - 10, top - 8));
            drawLabel(ctx, MARKUP_LABEL.entry, xStart + 6, ly, MARKUP.accent, { size: 9, weight: 700 });
          }
        }
      }

      // 1. Supply & demand zones — light fills with a thin boundary and a short DZ/SZ tag.
      for (const zone of overlays.supplyDemand) {
        const yTop = this.series.priceToCoordinate(zone.upperPrice);
        const yBottom = this.series.priceToCoordinate(zone.lowerPrice);
        if (yTop === null || yBottom === null) continue;

        const top = Math.min(yTop, yBottom);
        const h = Math.max(3, Math.abs(yBottom - yTop));
        if (top + h < 0 || top > height) continue;

        const originX = timeScale.timeToCoordinate(zone.originTime as UTCTimestamp);
        const startX = originX === null ? 0 : Math.max(0, Math.min(width - 40, originX));
        const boxW = width - startX;
        if (boxW <= 4) continue;

        const isDemand = zone.type === 'demand';
        const stale = zone.status === 'invalidated';
        const color = stale ? MARKUP.neutral : isDemand ? MARKUP.bull : MARKUP.bear;
        const strong = zone.status === 'fresh';

        drawZoneBox(ctx, {
          x: startX,
          y: top,
          w: boxW,
          h,
          color,
          fillAlpha: strong ? MARKUP_ALPHA.fillStrong : MARKUP_ALPHA.fillFaint,
          edgeAlpha: strong ? MARKUP_ALPHA.edgeStrong : MARKUP_ALPHA.edge,
          dash: strong ? [] : [4, 3],
        });

        const code = isDemand ? MARKUP_LABEL.demand : MARKUP_LABEL.supply;
        const ly = Math.max(10, Math.min(height - 10, top + h / 2));
        drawLabel(ctx, code, Math.max(startX + 6, width - 40), ly, color, { size: 9, weight: 700 });
      }

      // 2. Trendlines (minor) — thin line, short TL tag, tiny anchor dots.
      for (const tl of overlays.trendlines) {
        const x1 = timeScale.timeToCoordinate(tl.startTime as UTCTimestamp);
        const y1 = this.series.priceToCoordinate(tl.startPrice);
        const endT = this.latestTime && this.latestTime > tl.endTime ? this.latestTime : tl.endTime;
        const endYPrice = tl.startPrice + tl.slopePerSec * (endT - tl.startTime);
        const x2 = timeScale.timeToCoordinate(endT as UTCTimestamp);
        const y2 = this.series.priceToCoordinate(endYPrice);
        if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

        const color = tl.direction === 'bullish' ? MARKUP.bull : MARKUP.bear;
        ctx.save();
        ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.line);
        ctx.lineWidth = MARKUP_WIDTH.line;
        if (tl.broken) ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
        drawAnchorDot(ctx, x1, y1, color);

        const lx = Math.max(8, Math.min(width - 24, (x1 + x2) / 2));
        const ly = Math.max(10, Math.min(height - 10, (y1 + y2) / 2 - 9));
        drawLabel(ctx, MARKUP_LABEL.trendline, lx, ly, color, { size: 9 });
      }

      // 2b. Major trendlines — a touch heavier, still thin, with tiny swing anchors.
      for (const tl of overlays.majorTrendlines) {
        const x1 = timeScale.timeToCoordinate(tl.startTime as UTCTimestamp);
        const y1 = this.series.priceToCoordinate(tl.startPrice);
        if (x1 === null || y1 === null) continue;
        const endT = this.latestTime && this.latestTime > tl.endTime ? this.latestTime : tl.endTime;
        const endYPrice = tl.startPrice + tl.slopePerSec * (endT - tl.startTime);
        const x2 = timeScale.timeToCoordinate(endT as UTCTimestamp);
        const y2 = this.series.priceToCoordinate(endYPrice);
        if (x2 === null || y2 === null) continue;

        const color = tl.direction === 'bullish' ? MARKUP.support : MARKUP.resistance;
        ctx.save();
        ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.line);
        ctx.lineWidth = MARKUP_WIDTH.strong;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();

        for (const a of tl.anchors) {
          const ax = timeScale.timeToCoordinate(a.time as UTCTimestamp);
          const ay = this.series.priceToCoordinate(a.price);
          if (ax === null || ay === null) continue;
          drawAnchorDot(ctx, ax, ay, color);
        }

        const lx = Math.max(8, Math.min(width - 30, x2 - 24));
        const ly = Math.max(10, Math.min(height - 10, y2 - 9));
        drawLabel(ctx, `TL${tl.thirdTouchConfirmed ? '★' : ''}`, lx, ly, color, { size: 9, weight: 700 });
      }

      // 2c. Major support / resistance zones — thin boundary, light fill, S/R tag.
      for (const zone of overlays.majorZones) {
        const xStart = timeScale.timeToCoordinate(zone.originTime as UTCTimestamp);
        const yTop = this.series.priceToCoordinate(zone.upperPrice);
        const yBottom = this.series.priceToCoordinate(zone.lowerPrice);
        if (yTop === null || yBottom === null) continue;
        const left = xStart === null ? 0 : Math.max(0, xStart);
        const top = Math.min(yTop, yBottom);
        const h = Math.abs(yBottom - yTop);
        if (h < 1) continue;

        const weakened = zone.freshness === 'WEAKENED' || zone.freshness === 'INVALIDATED';
        const color = weakened
          ? MARKUP.neutral
          : zone.role === 'support'
            ? MARKUP.bull
            : MARKUP.bear;

        drawZoneBox(ctx, {
          x: left,
          y: top,
          w: width - left,
          h,
          color,
          fillAlpha: MARKUP_ALPHA.fillFaint,
          edgeAlpha: weakened ? MARKUP_ALPHA.edge : MARKUP_ALPHA.edgeStrong,
          dash: weakened ? [4, 4] : [],
        });

        const code = zone.role === 'support' ? MARKUP_LABEL.support : MARKUP_LABEL.resistance;
        const ly = Math.max(9, Math.min(height - 9, top + h / 2));
        drawLabel(ctx, code, left + 6, ly, color, { size: 9, weight: 700 });
      }

      // 3a. Liquidity sweep markers — a small cross-hair at the swept wick.
      for (const sweep of overlays.liquiditySweeps) {
        const sx = timeScale.timeToCoordinate(sweep.time as UTCTimestamp);
        const sy = this.series.priceToCoordinate(sweep.sweepPrice);
        if (sx === null || sy === null || sx < -20 || sx > width + 20 || sy < 0 || sy > height) {
          continue;
        }
        const bullish = sweep.type === 'BULLISH_SWEEP';
        const color = MARKUP.sweep;
        ctx.save();
        ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.line);
        ctx.lineWidth = MARKUP_WIDTH.hairline;
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx - 6, sy);
        ctx.lineTo(sx + 6, sy);
        ctx.stroke();
        ctx.restore();

        const ly = bullish ? Math.min(height - 10, sy + 14) : Math.max(10, sy - 14);
        drawLabel(ctx, MARKUP_LABEL.sweep, sx - 16, ly, color, { size: 8, weight: 700 });
      }

      // 3b. Swing labels (HH / HL / LH / LL) — short code above/below the swing.
      for (const sw of overlays.swingPoints) {
        if (!sw.swingLabel) continue;
        const px = timeScale.timeToCoordinate(sw.time as UTCTimestamp);
        const py = this.series.priceToCoordinate(sw.price);
        if (px === null || py === null || px < -20 || px > width + 20) continue;
        const isHigh = sw.type === 'high';
        const bullishLabel = sw.swingLabel === 'HH' || sw.swingLabel === 'HL';
        const color = bullishLabel ? MARKUP.bull : MARKUP.bear;
        const ly = isHigh ? py - 10 : py + 10;
        if (ly < 6 || ly > height - 6) continue;
        drawLabel(ctx, sw.swingLabel, px, ly, color, { size: 8, weight: 700, align: 'center' });
      }

      // 3. Chart patterns — thin outline + short name only.
      for (const pat of overlays.patterns) {
        const color = pat.confirmed
          ? pat.bias === 'bullish'
            ? MARKUP.bull
            : MARKUP.bear
          : MARKUP.neutral;

        let sumX = 0;
        let sumY = 0;
        let segCount = 0;

        for (const seg of pat.lines) {
          const x1 = timeScale.timeToCoordinate(seg.startTime as UTCTimestamp);
          const y1 = this.series.priceToCoordinate(seg.startPrice);
          const x2 = timeScale.timeToCoordinate(seg.endTime as UTCTimestamp);
          const y2 = this.series.priceToCoordinate(seg.endPrice);
          if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

          ctx.save();
          ctx.strokeStyle = hexToRgba(color, MARKUP_ALPHA.line);
          ctx.lineWidth = MARKUP_WIDTH.line;
          if (!pat.confirmed) ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();

          sumX += (x1 + x2) / 2;
          sumY += (y1 + y2) / 2;
          segCount++;
        }

        if (segCount > 0) {
          const centerX = sumX / segCount;
          const centerY = sumY / segCount;
          const ly = Math.max(10, Math.min(height - 10, centerY + 10));
          drawLabel(ctx, pat.confirmed ? `${pat.name} ✓` : pat.name, centerX, ly, color, {
            size: 9,
            align: 'center',
          });
        }
      }

      // 4. Breakout level & retest for the confirmed setup — thin dashed line + small tag.
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
          const color = br.direction === 'RISE' ? MARKUP.support : MARKUP.resistance;

          drawHLine(ctx, yLevel, Math.max(drawStartX + 24, drawEndX), color, {
            dash: [6, 4],
            width: MARKUP_WIDTH.line,
            x: drawStartX,
          });

          const ly = Math.max(10, Math.min(height - 10, yLevel - 9));
          drawLabel(ctx, br.label, drawStartX + 6, ly, color, { size: 9, weight: 700 });
        }

        if (br.retestTime !== null && br.retestPrice !== null) {
          const rx = timeScale.timeToCoordinate(br.retestTime as UTCTimestamp);
          const ry = this.series.priceToCoordinate(br.retestPrice);
          if (rx !== null && ry !== null && rx >= 0 && rx <= width && ry >= 0 && ry <= height) {
            const color = br.direction === 'RISE' ? MARKUP.bull : MARKUP.bear;
            drawAnchorDot(ctx, rx, ry, color, 3);
            const ly = br.direction === 'RISE' ? Math.min(height - 10, ry + 12) : Math.max(10, ry - 12);
            drawLabel(ctx, 'RT', rx, ly, color, { size: 8, weight: 700, align: 'center' });
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
