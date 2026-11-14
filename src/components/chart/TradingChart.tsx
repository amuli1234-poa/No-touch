import React, { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type CandlestickData,
  type LineData,
  type Time,
  type MouseEventParams,
  CrosshairMode,
  LineStyle
} from 'lightweight-charts';
import type { Candle } from '../../types/scanner';
import { toChartBars, toLinePoints, type ChartBar, type ChartPoint } from './chartData';
import { readChartColors, type ChartColors } from './chartTheme';
import { useTheme } from '../../lib/theme';

/**
 * TradingView Lightweight Charts wrapper.
 *
 * Responsibilities are deliberately narrow: render the bars it is given and
 * report the crosshair. It performs **no** data fetching and **no** trading —
 * the caller owns the candles and any order flow, so the chart can never place
 * a trade by itself.
 *
 * Lifecycle rules that matter for live data:
 *  - the chart and its series are created once and reused; a tick must not
 *    recreate them (that would reset pan/zoom on every update);
 *  - the series type (candles vs line) is swapped in place when the user
 *    changes it, without rebuilding the chart;
 *  - `setData` is only called when the *symbol/timeframe* changes; a growing
 *    bar within the same series uses the cheap incremental path;
 *  - everything is disposed on unmount.
 *
 * Lightweight Charts is the renderer only — the indicators and signals shown
 * alongside come from WickSentinel's own engines, and the attribution notice
 * is required by TradingView's licence.
 */

export type ChartKind = 'candles' | 'line';

/**
 * A horizontal reference line drawn on the chart. `tone` maps to a theme token
 * rather than a fixed colour so overlays follow light/dark like everything else.
 * These are *annotations of published signal levels* — the chart never derives
 * or suggests them itself.
 */
export interface ChartLevel {
  price: number;
  tone: 'entry' | 'target' | 'invalidation';
  title: string;
}

interface TradingChartProps {
  candles: Candle[];
  symbol: string;
  timeframe: string;
  kind: ChartKind;
  /** Decimal places for the price scale, derived from the symbol's pip size. */
  priceDigits: number;
  isStale?: boolean;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  height?: number;
  levels?: ChartLevel[];
  onCrosshair?: (price: number | null, epochSeconds: number | null) => void;
}

interface SeriesState {
  api: ISeriesApi<SeriesType, Time>;
  kind: ChartKind;
}

const ATTRIBUTION_HREF = 'https://www.tradingview.com/lightweight-charts/';

export const TradingChart: React.FC<TradingChartProps> = ({
  candles,
  symbol,
  timeframe,
  kind,
  priceDigits,
  isStale,
  connectionState,
  height = 420,
  levels,
  onCrosshair
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<SeriesState | null>(null);
  const colorsRef = useRef<ChartColors | null>(null);
  /** Identity of the data currently loaded, to distinguish a new series from an update. */
  const loadedKeyRef = useRef<string>('');
  const crosshairCbRef = useRef(onCrosshair);
  crosshairCbRef.current = onCrosshair;
  const { theme } = useTheme();

  /* ---- create the chart once ------------------------------------------- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const colors = readChartColors(theme);
    colorsRef.current = colors;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { color: colors.background },
        textColor: colors.text,
        fontFamily: "'Inter', system-ui, sans-serif",
        attributionLogo: true
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid }
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshairLabel, style: LineStyle.Dashed },
        horzLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshairLabel, style: LineStyle.Dashed }
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false },
      handleScale: { axisPressedMouseMove: true },
      localization: { priceFormatter: (p: number) => p.toFixed(priceDigits) }
    });

    chartRef.current = chart;

    const onMove = (param: MouseEventParams) => {
      const cb = crosshairCbRef.current;
      if (!cb) return;
      const series = seriesRef.current?.api;
      if (!param.point || !series) {
        cb(null, null);
        return;
      }
      const price = series.coordinateToPrice(param.point.y);
      cb(
        price === null ? null : Number(price),
        typeof param.time === 'number' ? param.time : null
      );
    };
    chart.subscribeCrosshairMove(onMove);

    const observer = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      loadedKeyRef.current = '';
    };
    // Height is a layout input; a change legitimately rebuilds the chart.
  }, [height, priceDigits]);

  /* ---- react to theme changes ------------------------------------------ */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const colors = readChartColors(theme);
    colorsRef.current = colors;
    chart.applyOptions({
      layout: { background: { color: colors.background }, textColor: colors.text },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: {
        vertLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshairLabel },
        horzLine: { color: colors.crosshair, labelBackgroundColor: colors.crosshairLabel }
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border }
    });
    // Re-apply series colours.
    const series = seriesRef.current;
    if (series) applySeriesColors(series, colors);
  }, [theme]);

  /* ---- series type swap ------------------------------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const colors = colorsRef.current ?? readChartColors(theme);
    const existing = seriesRef.current;
    if (existing && existing.kind === kind) return;

    if (existing) chart.removeSeries(existing.api);

    const api =
      kind === 'candles'
        ? chart.addSeries(CandlestickSeries, {
            upColor: colors.up,
            downColor: colors.down,
            borderUpColor: colors.up,
            borderDownColor: colors.down,
            wickUpColor: colors.up,
            wickDownColor: colors.down,
            priceLineVisible: true
          })
        : chart.addSeries(AreaSeries, {
            lineColor: colors.line,
            topColor: colors.area,
            bottomColor: 'rgba(56, 189, 248, 0)',
            lineWidth: 2
          });

    seriesRef.current = { api, kind };
    // Force a full reload into the new series.
    loadedKeyRef.current = '';
  }, [kind, theme]);

  /* ---- data ------------------------------------------------------------- */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const key = `${symbol}|${timeframe}`;

    if (loadedKeyRef.current !== key) {
      // New instrument or timeframe: full replace, then fit the visible range.
      const data = kind === 'candles' ? toChartBars(candles) : toLinePoints(candles);
      series.api.setData(data as (CandlestickData<Time> | LineData<Time>)[]);
      chartRef.current?.timeScale().fitContent();
      loadedKeyRef.current = key;
      return;
    }

    // Same series: apply only the latest bar incrementally so pan/zoom and
    // the scroll position survive every live update.
    if (candles.length === 0) {
      series.api.setData([]);
      return;
    }
    const bars = kind === 'candles' ? toChartBars(candles) : toLinePoints(candles);
    const last = bars[bars.length - 1];
    if (last) series.api.update(last as CandlestickData<Time> | LineData<Time>);
  }, [candles, symbol, timeframe, kind]);

  /* ---- signal level overlays ------------------------------------------- */
  // Price lines live on the series, so they must be rebuilt whenever the series
  // is recreated (kind swap / theme-driven rebuild) as well as when the levels
  // themselves change. Keying on `kind` and `theme` covers both.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const colors = colorsRef.current ?? readChartColors(theme);
    const toneColor: Record<ChartLevel['tone'], string> = {
      entry: colors.levelEntry,
      target: colors.levelTarget,
      invalidation: colors.levelInvalidation
    };
    const created = (levels ?? [])
      .filter((l) => Number.isFinite(l.price))
      .map((l) =>
        series.api.createPriceLine({
          price: l.price,
          color: toneColor[l.tone],
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.title
        })
      );
    return () => {
      created.forEach((line) => {
        try {
          series.api.removePriceLine(line);
        } catch {
          // Series already disposed with the chart; nothing left to detach.
        }
      });
    };
  }, [levels, kind, theme]);

  const disconnected = connectionState !== 'CONNECTED';
  return (
    <div className="relative w-full overflow-hidden rounded-[var(--radius-lg)] border border-line-soft bg-surface">
      <div ref={containerRef} className="w-full" style={{ height }} />

      {/* Overlay states — never hide the chart behind a fake render. */}
      {(candles.length === 0 || disconnected) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-app/60 backdrop-blur-[2px]">
          <div className="rounded-[var(--radius-md)] border border-line-soft bg-surface px-4 py-3 text-center">
            <p className="text-[12.5px] font-semibold text-fg-2">
              {disconnected ? 'Feed disconnected' : 'Waiting for candle history'}
            </p>
            <p className="mt-1 max-w-[280px] text-[11.5px] leading-relaxed text-fg-5">
              {disconnected
                ? 'Reconnecting to the market feed. The chart resumes automatically.'
                : `Streaming ${symbol} ${timeframe.toUpperCase()} bars from the Deriv feed.`}
            </p>
          </div>
        </div>
      )}

      {isStale && !disconnected && candles.length > 0 && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-[var(--radius-sm)] border border-warning/40 bg-warning/15 px-2 py-1 text-[10.5px] font-semibold text-warning">
          Data may be stale
        </div>
      )}

      {/* TradingView attribution, required by the Lightweight Charts licence. */}
      <div className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-fg-6">
        Charting by{' '}
        <a
          href={ATTRIBUTION_HREF}
          target="_blank"
          rel="noopener noreferrer"
          className="pointer-events-auto underline decoration-dotted hover:text-fg-4"
        >
          TradingView Lightweight Charts™
        </a>
      </div>
    </div>
  );
};

function applySeriesColors(series: SeriesState, colors: ChartColors): void {
  if (series.kind === 'candles') {
    series.api.applyOptions({
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down
    } as never);
  } else {
    series.api.applyOptions({
      lineColor: colors.line,
      topColor: colors.area,
      bottomColor: 'rgba(56, 189, 248, 0)'
    } as never);
  }
}
