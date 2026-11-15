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

      // 0a. Sideways range bands (range extremes only). Shade the upper 25% (resistance
      //     trading area) red, the middle 50% grey (NO TRADE) and the lower 25% (support
      //     trading area) green. Drawn behind everything else.
      if (overlays.range?.valid) {
        const r = overlays.range;
        const bands: { top: number; bottom: number; fill: string; label: string; text: string }[] = [
          { top: r.resistance, bottom: r.tradingArea.lower, fill: 'rgba(220, 38, 38, 0.08)', label: 'RESISTANCE AREA · FALL ONLY', text: '#B91C1C' },
          { top: r.tradingArea.lower, bottom: r.noTradeBand.lower, fill: 'rgba(100, 116, 139, 0.08)', label: 'NO TRADE · MIDDLE 50%', text: '#475569' },
          { top: r.noTradeBand.lower, bottom: r.support, fill: 'rgba(22, 163, 74, 0.08)', label: 'SUPPORT AREA · RISE ONLY', text: '#15803D' },
        ];
        ctx.font = '700 9.5px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        for (const band of bands) {
          const yTop = this.series.priceToCoordinate(band.top);
          const yBottom = this.series.priceToCoordinate(band.bottom);
          if (yTop === null || yBottom === null) continue;
          const top = Math.min(yTop, yBottom);
          const boxHeight = Math.max(2, Math.abs(yBottom - yTop));
          if (top + boxHeight < 0 || top > height) continue;
          ctx.fillStyle = band.fill;
          ctx.fillRect(0, top, width, boxHeight);
          const ly = top + boxHeight / 2;
          if (ly >= 8 && ly <= height - 8) {
            ctx.fillStyle = band.text;
            ctx.fillText(band.label, 8, ly);
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
            ctx.fillStyle = 'rgba(37, 99, 235, 0.10)';
            ctx.fillRect(xStart, top, boxWidth, boxHeight);
            ctx.strokeStyle = 'rgba(37, 99, 235, 0.55)';
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 3]);
            ctx.strokeRect(xStart, top, boxWidth, boxHeight);
            ctx.setLineDash([]);

            const tag = ez.label;
            ctx.font = '700 9.5px "Plus Jakarta Sans", system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            const tw = ctx.measureText(tag).width;
            const lx = Math.max(8, Math.min(width - tw - 20, xStart + 6));
            const ly = Math.max(12, Math.min(height - 12, top - 10));
            ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
            ctx.fillRect(lx - 4, ly - 7, tw + 8, 14);
            ctx.strokeStyle = 'rgba(37, 99, 235, 0.7)';
            ctx.lineWidth = 0.85;
            ctx.strokeRect(lx - 4, ly - 7, tw + 8, 14);
            ctx.fillStyle = '#1D4ED8';
            ctx.fillText(tag, lx, ly);
          }
        }
      }

      // 1. Supply & Demand Zones (light shaded rectangles with clean border & status label)
      for (const zone of overlays.supplyDemand) {
        const yTop = this.series.priceToCoordinate(zone.upperPrice);
        const yBottom = this.series.priceToCoordinate(zone.lowerPrice);
        if (yTop === null || yBottom === null) continue;

        const top = Math.min(yTop, yBottom);
        const rawHeight = Math.abs(yBottom - yTop);
        const boxHeight = Math.max(4, rawHeight);
        if (top + boxHeight < 0 || top > height) continue;

        const originX = timeScale.timeToCoordinate(zone.originTime as UTCTimestamp);
        const startX = originX === null ? 0 : Math.max(0, Math.min(width - 40, originX));
        const endX = width;
        const boxWidth = endX - startX;
        if (boxWidth <= 4) continue;

        const isDemand = zone.type === 'demand';
        let fillColor: string;
        let strokeColor: string;
        let textColor: string;

        if (zone.status === 'invalidated') {
          fillColor = 'rgba(100, 116, 139, 0.06)';
          strokeColor = 'rgba(100, 116, 139, 0.45)';
          textColor = '#475569';
        } else if (isDemand) {
          fillColor =
            zone.status === 'fresh'
              ? 'rgba(22, 163, 74, 0.14)'
              : 'rgba(22, 163, 74, 0.07)';
          strokeColor =
            zone.status === 'fresh'
              ? 'rgba(22, 163, 74, 0.65)'
              : 'rgba(22, 163, 74, 0.35)';
          textColor = '#15803D';
        } else {
          fillColor =
            zone.status === 'fresh'
              ? 'rgba(220, 38, 38, 0.14)'
              : 'rgba(220, 38, 38, 0.07)';
          strokeColor =
            zone.status === 'fresh'
              ? 'rgba(220, 38, 38, 0.65)'
              : 'rgba(220, 38, 38, 0.35)';
          textColor = '#B91C1C';
        }

        ctx.fillStyle = fillColor;
        ctx.fillRect(startX, top, boxWidth, boxHeight);

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = zone.status === 'fresh' ? 1.25 : 1;
        ctx.setLineDash(zone.status === 'fresh' ? [] : [4, 3]);
        ctx.strokeRect(startX, top, boxWidth, boxHeight);
        ctx.setLineDash([]);

        const statusLabel =
          zone.status === 'fresh'
            ? 'Fresh'
            : zone.status === 'tested'
              ? `Tested ${zone.touches}x`
              : 'Invalidated';
        const tagText = `${isDemand ? 'DEMAND' : 'SUPPLY'} · ${statusLabel}`;

        ctx.font = '600 10px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const textWidth = ctx.measureText(tagText).width;
        const padX = 5;
        const pillH = 14;
        const labelX = Math.max(startX + 8, width - textWidth - padX * 2 - 14);
        const preferredY = top + boxHeight / 2;
        const labelY = Math.max(pillH / 2 + 4, Math.min(height - pillH / 2 - 4, preferredY));

        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.fillRect(labelX - padX, labelY - pillH / 2, textWidth + padX * 2, pillH);
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 0.75;
        ctx.strokeRect(labelX - padX, labelY - pillH / 2, textWidth + padX * 2, pillH);
        ctx.fillStyle = textColor;
        ctx.fillText(tagText, labelX, labelY);
      }

      // 2. Trendlines (Bullish green / Bearish red)
      for (const tl of overlays.trendlines) {
        const x1 = timeScale.timeToCoordinate(tl.startTime as UTCTimestamp);
        const y1 = this.series.priceToCoordinate(tl.startPrice);
        const endT = this.latestTime && this.latestTime > tl.endTime ? this.latestTime : tl.endTime;
        const endYPrice = tl.startPrice + tl.slopePerSec * (endT - tl.startTime);
        const x2 = timeScale.timeToCoordinate(endT as UTCTimestamp);
        const y2 = this.series.priceToCoordinate(endYPrice);

        if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

        ctx.strokeStyle = tl.direction === 'bullish' ? '#16A34A' : '#DC2626';
        ctx.lineWidth = tl.broken ? 1.5 : 2;
        ctx.setLineDash(tl.broken ? [5, 4] : []);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);

        const label = tl.broken
          ? `${tl.direction === 'bullish' ? 'BULL' : 'BEAR'} TL BREAK`
          : `${tl.direction === 'bullish' ? 'BULL' : 'BEAR'} TL (${tl.touches})`;
        ctx.font = '600 9.5px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        const lx = Math.max(8, Math.min(width - tw - 16, midX - tw / 2));
        const ly = Math.max(12, Math.min(height - 12, midY - 12));
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.fillRect(lx - 4, ly - 7, tw + 8, 14);
        ctx.fillStyle = tl.direction === 'bullish' ? '#15803D' : '#B91C1C';
        ctx.fillText(label, lx, ly);
      }

      // 2b. MAJOR trendlines (built from significant swings only). Drawn heavier than
      //     the minor trendlines so the clean-chart major structure reads first.
      for (const tl of overlays.majorTrendlines) {
        const x1 = timeScale.timeToCoordinate(tl.startTime as UTCTimestamp);
        const y1 = this.series.priceToCoordinate(tl.startPrice);
        if (x1 === null || y1 === null) continue;
        const endT = this.latestTime && this.latestTime > tl.endTime ? this.latestTime : tl.endTime;
        const endYPrice = tl.startPrice + tl.slopePerSec * (endT - tl.startTime);
        const x2 = timeScale.timeToCoordinate(endT as UTCTimestamp);
        const y2 = this.series.priceToCoordinate(endYPrice);
        if (x2 === null || y2 === null) continue;

        const color = tl.direction === 'bullish' ? '#0EA5E9' : '#F59E0B';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Anchor dots at the major swing touches.
        ctx.fillStyle = color;
        for (const a of tl.anchors) {
          const ax = timeScale.timeToCoordinate(a.time as UTCTimestamp);
          const ay = this.series.priceToCoordinate(a.price);
          if (ax === null || ay === null) continue;
          ctx.beginPath();
          ctx.arc(ax, ay, 3, 0, Math.PI * 2);
          ctx.fill();
        }

        const label = `MAJOR ${tl.direction === 'bullish' ? 'BULL' : 'BEAR'} TL${
          tl.thirdTouchConfirmed ? ' ★' : ''
        } (${tl.touches})`;
        ctx.font = '700 9.5px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        const lx = Math.max(8, Math.min(width - tw - 16, x2 - tw - 6));
        const ly = Math.max(12, Math.min(height - 12, y2));
        ctx.fillStyle = 'rgba(9, 14, 24, 0.86)';
        ctx.fillRect(lx - 4, ly - 8, tw + 8, 16);
        ctx.fillStyle = color;
        ctx.fillText(label, lx, ly);
      }

      // 2c. MAJOR support / resistance ZONES as rectangles covering the reaction area.
      //     BLUE = potential RISE (support/demand), RED = potential FALL
      //     (resistance/supply), GREY = weakened.
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
          ? '#94A3B8'
          : zone.role === 'support'
            ? '#16A34A'
            : '#DC2626';
        const alpha = weakened ? 0.05 : 0.1;

        ctx.fillStyle =
          color === '#16A34A'
            ? `rgba(22, 163, 74, ${alpha})`
            : color === '#DC2626'
              ? `rgba(220, 38, 38, ${alpha})`
              : `rgba(148, 163, 184, ${alpha})`;
        ctx.fillRect(left, top, width - left, boxH);

        ctx.strokeStyle = color;
        ctx.lineWidth = weakened ? 1 : 1.4;
        ctx.setLineDash(weakened ? [4, 4] : []);
        ctx.strokeRect(left, top, width - left, boxH);
        ctx.setLineDash([]);

        const roleTag = zone.roleReversed ? `${zone.role.toUpperCase()} (FLIP)` : zone.role.toUpperCase();
        const label = `${roleTag} ZONE · ${zone.strength}`;
        ctx.font = '700 8.5px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        const lx = Math.max(8, Math.min(width - tw - 14, left + 6));
        const ly = Math.max(9, Math.min(height - 9, top + boxH / 2));
        ctx.fillStyle = 'rgba(9, 14, 24, 0.86)';
        ctx.fillRect(lx - 4, ly - 7, tw + 8, 14);
        ctx.fillStyle = color;
        ctx.fillText(label, lx, ly);
      }

      // 3a. Liquidity sweep markers (sweep wick + reversal)
      for (const sweep of overlays.liquiditySweeps) {
        const sx = timeScale.timeToCoordinate(sweep.time as UTCTimestamp);
        const sy = this.series.priceToCoordinate(sweep.sweepPrice);
        if (sx === null || sy === null || sx < -20 || sx > width + 20 || sy < 0 || sy > height) {
          continue;
        }
        const bullish = sweep.type === 'BULLISH_SWEEP';
        const color = bullish ? '#0EA5E9' : '#F59E0B';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx - 7, sy);
        ctx.lineTo(sx + 7, sy);
        ctx.stroke();

        const tag = 'LIQ SWEEP';
        ctx.font = '700 8.5px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(tag).width;
        const lx = Math.max(8, Math.min(width - tw - 14, sx - tw / 2));
        const ly = bullish ? Math.min(height - 10, sy + 16) : Math.max(10, sy - 16);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
        ctx.fillRect(lx - 3, ly - 6, tw + 6, 12);
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.75;
        ctx.strokeRect(lx - 3, ly - 6, tw + 6, 12);
        ctx.fillStyle = color;
        ctx.fillText(tag, lx, ly);
      }

      // 3b. Swing labels (HH / HL / LH / LL)
      for (const sw of overlays.swingPoints) {
        if (!sw.swingLabel) continue;
        const px = timeScale.timeToCoordinate(sw.time as UTCTimestamp);
        const py = this.series.priceToCoordinate(sw.price);
        if (px === null || py === null || px < -20 || px > width + 20) continue;
        const isHigh = sw.type === 'high';
        const bullishLabel = sw.swingLabel === 'HH' || sw.swingLabel === 'HL';
        const color = bullishLabel ? '#15803D' : '#B91C1C';
        const ly = isHigh ? py - 12 : py + 12;
        if (ly < 6 || ly > height - 6) continue;
        ctx.font = '700 9px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(sw.swingLabel).width;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
        ctx.fillRect(px - tw / 2 - 2.5, ly - 6, tw + 5, 12);
        ctx.fillStyle = color;
        ctx.fillText(sw.swingLabel, px, ly);
        ctx.textAlign = 'left';
      }

      // 3. Confirmed & Forming Chart Patterns
      for (const pat of overlays.patterns) {
        const patColor = pat.confirmed
          ? pat.bias === 'bullish'
            ? '#047857'
            : '#B91C1C'
          : '#6366F1';

        let sumX = 0;
        let sumY = 0;
        let segCount = 0;

        for (const seg of pat.lines) {
          const x1 = timeScale.timeToCoordinate(seg.startTime as UTCTimestamp);
          const y1 = this.series.priceToCoordinate(seg.startPrice);
          const x2 = timeScale.timeToCoordinate(seg.endTime as UTCTimestamp);
          const y2 = this.series.priceToCoordinate(seg.endPrice);
          if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

          ctx.strokeStyle = patColor;
          ctx.lineWidth = pat.confirmed ? 2 : 1.35;
          ctx.setLineDash(pat.confirmed ? [] : [4, 4]);
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
          const label = pat.confirmed ? `${pat.name} ✓` : `${pat.name} (Forming)`;
          ctx.font = '600 9.5px "Plus Jakarta Sans", system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          const tw = ctx.measureText(label).width;
          const lx = Math.max(8, Math.min(width - tw - 16, centerX - tw / 2));
          const ly = Math.max(12, Math.min(height - 12, centerY + 12));
          ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
          ctx.fillRect(lx - 4, ly - 7, tw + 8, 14);
          ctx.strokeStyle = patColor;
          ctx.lineWidth = 0.75;
          ctx.strokeRect(lx - 4, ly - 7, tw + 8, 14);
          ctx.fillStyle = patColor;
          ctx.fillText(label, lx, ly);
        }
      }

      // 4. Breakout level & retest markings for the confirmed setup
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
          const accent = br.direction === 'RISE' ? '#0284C7' : '#D97706';

          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.75;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(drawStartX, yLevel);
          ctx.lineTo(Math.max(drawStartX + 24, drawEndX), yLevel);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.font = '700 9.5px "Plus Jakarta Sans", system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          const lvlLabel = br.label;
          const tw = ctx.measureText(lvlLabel).width;
          const lx = Math.max(8, Math.min(width - tw - 20, drawStartX + 6));
          const ly = Math.max(12, Math.min(height - 12, yLevel - 11));
          ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
          ctx.fillRect(lx - 4, ly - 7, tw + 8, 14);
          ctx.strokeStyle = accent;
          ctx.lineWidth = 0.85;
          ctx.strokeRect(lx - 4, ly - 7, tw + 8, 14);
          ctx.fillStyle = accent;
          ctx.fillText(lvlLabel, lx, ly);
        }

        if (br.retestTime !== null && br.retestPrice !== null) {
          const rx = timeScale.timeToCoordinate(br.retestTime as UTCTimestamp);
          const ry = this.series.priceToCoordinate(br.retestPrice);
          if (rx !== null && ry !== null && rx >= 0 && rx <= width && ry >= 0 && ry <= height) {
            const retestColor = br.direction === 'RISE' ? '#059669' : '#E11D48';
            ctx.fillStyle = retestColor;
            ctx.beginPath();
            ctx.arc(rx, ry, 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            const tag = 'RETEST';
            ctx.font = '700 9px "Plus Jakarta Sans", system-ui, sans-serif';
            const rtw = ctx.measureText(tag).width;
            const rlx = Math.max(8, Math.min(width - rtw - 14, rx - rtw / 2));
            const rly =
              br.direction === 'RISE'
                ? Math.min(height - 12, ry + 14)
                : Math.max(12, ry - 14);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.fillRect(rlx - 4, rly - 6, rtw + 8, 12);
            ctx.strokeStyle = retestColor;
            ctx.lineWidth = 0.75;
            ctx.strokeRect(rlx - 4, rly - 6, rtw + 8, 12);
            ctx.fillStyle = retestColor;
            ctx.fillText(tag, rlx, rly);
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
