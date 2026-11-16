import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { CHART_COLORS } from '../theme/designTokens';
import { MARKUP_COLORS, hexToRgba } from './chart/markupStyle';
import { AlertTriangle, BarChart2, Loader2, RefreshCw } from 'lucide-react';
import type { ChartOverlayPreferences } from '../hooks/useAppSettings';
import type { CandleDataset, LiveCandleTick } from '../hooks/useDerivChartData';
import type { ChartOverlayData, SignalSnapshot } from '../types/analysis';
import type { DsZone } from '../types/demandSupply';
import type { FutureReactionZone } from '../types/structure';
import type { AiZone } from '../types/aiModule';
import type {
  Candle,
  ChartLoadState,
  ConnectionStatus,
} from '../types/market';
import { formatPrice } from '../utils/derivParser';
import { AnalysisChartPrimitive } from './AnalysisChartPrimitive';
import {
  SignalAnnotationPrimitive,
  type SignalLevels,
} from './chart/SignalAnnotationPrimitive';
import {
  TrendlineChartPrimitive,
  type TrendlineChartOverlay,
} from './chart/TrendlineChartPrimitive';
import {
  StructureChartPrimitive,
  type StructureChartOverlay,
} from './chart/StructureChartPrimitive';
import {
  DsChartPrimitive,
  type DsChartOverlay,
} from './chart/DsChartPrimitive';
import {
  AiChartPrimitive,
  type AiChartOverlay,
} from './chart/AiChartPrimitive';
import {
  DRAWING_COLORS,
  UserDrawingsPrimitive,
  type DrawingKind,
  type DrawingPoint,
  type UserDrawing,
} from './UserDrawingsPrimitive';

export interface CandlestickChartHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitContent: () => void;
  scrollToRealTime: () => void;
  /** Enable a drawing tool; the next tap/click sets a point. */
  setDrawingTool: (kind: DrawingKind | null) => void;
  clearDrawings: () => void;
  undoDrawing: () => void;
}

interface CandlestickChartProps {
  dataset: CandleDataset;
  marketName: string;
  timeframeLabel: string;
  /** Candle length in seconds — drives the right-edge countdown. */
  granularitySec: number;
  precision: number;
  liveTick: LiveCandleTick | null;
  loadState: ChartLoadState;
  connectionStatus: ConnectionStatus;
  errorMessage: string | null;
  overlays?: ChartOverlayData | null;
  overlayPrefs?: ChartOverlayPreferences | null;
  /** Scanner evidence to reproduce on the chart (drawn until live analysis supersedes it). */
  snapshot?: SignalSnapshot | null;
  /** Locked entry/SL + dynamic TP annotations drawn directly on the candle canvas. */
  signalLevels?: SignalLevels | null;
  /** Trendline Scanner overlay: M15 trendlines + the module's confirmed signal levels. */
  trendlineOverlay?: TrendlineChartOverlay | null;
  /** AI structure & future-opportunity overlay: fresh watch zones, bands, BOS/CHOCH. */
  structureOverlay?: StructureChartOverlay | null;
  /** Demand & Supply AI overlay: current demand/supply zones + confirmed signal levels. */
  dsOverlay?: DsChartOverlay | null;
  /** Independent AI module overlay (S/R AI, Chart Patterns AI, BOS & CHOCH AI, …). */
  aiOverlay?: AiChartOverlay | null;
  /** Fires when a structure watch zone is tapped so the parent can show its reasoning. */
  onStructureZoneSelect?: (zone: FutureReactionZone) => void;
  /** Fires when a demand/supply zone is tapped so the parent can show its analysis. */
  onDsZoneSelect?: (zone: DsZone) => void;
  /** Fires when an independent-AI zone is tapped so the parent can show its reasoning. */
  onAiZoneSelect?: (zone: AiZone) => void;
  /** Dark theme flag for the chart canvas itself. */
  dark?: boolean;
  /** Fires when an annotation is tapped so the parent can show its reasoning. */
  onAnnotationSelect?: (levels: SignalLevels) => void;
  onReconnect: () => void;
  onCrosshairChange: (candle: Candle | null) => void;
  onNeedOlderCandles: () => void;
  /** Notifies the parent whenever the active drawing tool changes. */
  onDrawingToolChange?: (kind: DrawingKind | null) => void;
}

function toChartCandle(c: Candle): CandlestickData<UTCTimestamp> {
  return {
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

/**
 * Right-edge live candle countdown, anchored to the chart's price coordinate system
 * (native Deriv behaviour). It is positioned with the same pixel coordinate as the live
 * candle's close, converted via the series' priceToCoordinate, and pinned just left of
 * the right price axis. It recomputes on every tick, zoom, scroll, resize and second.
 */
function LiveCandleCountdown({
  chart,
  series,
  container,
  liveCandle,
  granularitySec,
  connectionStatus,
}: {
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  container: HTMLDivElement | null;
  liveCandle: Candle | null;
  granularitySec: number;
  connectionStatus: ConnectionStatus;
}) {
  const [remainingSec, setRemainingSec] = useState<number>(0);
  const [top, setTop] = useState<number | null>(null);
  const [right, setRight] = useState<number>(12);
  const [placed, setPlaced] = useState<boolean>(false);

  const anchorPrice = liveCandle ? liveCandle.close : null;
  const candleTime = liveCandle ? liveCandle.time : null;

  // Recompute the vertical anchor from the chart's own price coordinate system. Runs on
  // every tick, and on zoom/scroll/resize via the subscriptions below.
  const reposition = useCallback(() => {
    if (!series || !chart || !container || anchorPrice === null) {
      setPlaced(false);
      return;
    }
    const y = series.priceToCoordinate(anchorPrice);
    if (y === null) {
      setPlaced(false);
      return;
    }
    const height = container.clientHeight;
    const scaleWidth = chart.priceScale('right').width();
    const clampedTop = Math.max(10, Math.min(height - 10, y));
    setTop(clampedTop);
    setRight(scaleWidth > 0 ? scaleWidth + 10 : 12);
    setPlaced(true);
  }, [series, chart, container, anchorPrice]);

  // Keep the latest reposition in a ref so the chart/resize subscriptions below are
  // attached once, not re-created on every tick.
  const repositionRef = useRef(reposition);
  repositionRef.current = reposition;

  useEffect(() => {
    reposition();
  }, [reposition]);

  // Keep the anchor pinned to the candle while the user zooms, scrolls or resizes.
  useEffect(() => {
    if (!chart) return;
    const onRangeChange = () => repositionRef.current();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    chart.timeScale().subscribeVisibleTimeRangeChange(onRangeChange);
    chart.subscribeCrosshairMove(onRangeChange);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onRangeChange);
      chart.unsubscribeCrosshairMove(onRangeChange);
    };
  }, [chart]);

  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver(() => repositionRef.current());
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  // Single synchronized 1s countdown, driven by the candle timestamp (not browser time).
  useEffect(() => {
    if (connectionStatus !== 'connected' || candleTime === null) {
      setRemainingSec(0);
      return;
    }
    const update = () => {
      const left = Math.round(candleTime + granularitySec - Date.now() / 1000);
      setRemainingSec(left > 0 ? left : 0);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [candleTime, granularitySec, connectionStatus]);

  if (!placed || top === null || connectionStatus !== 'connected') return null;

  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const label = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const closing = remainingSec <= 10;

  return (
    <div
      data-testid="right-candle-countdown"
      aria-label="Time until the live candle closes"
      className="absolute z-20 pointer-events-none -translate-y-1/2"
      style={{ top: `${top}px`, right: `${right}px` }}
    >
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[11px] font-bold tabular-nums shadow-sm border ${
          closing
            ? 'bg-rose-500/95 border-rose-400 text-white'
            : 'bg-elevated/95 border-line text-ink'
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function ChartLegendOverlay({
  overlays,
  precision,
}: {
  overlays: ChartOverlayData | null;
  precision: number;
}) {
  if (!overlays || overlays.supportResistance.length === 0) return null;
  const activeLevels = overlays.supportResistance.filter((l) => l.status === 'active').slice(0, 4);
  if (activeLevels.length === 0) return null;

  return (
    <div className="absolute top-2 left-2 sm:top-3 sm:left-3 z-25 pointer-events-none bg-elevated/92 backdrop-blur-sm border border-line shadow-sm rounded-lg px-2 py-1 flex flex-col gap-0.5 max-w-[150px] text-[9px] font-mono">
      <span className="font-bold text-muted uppercase tracking-wider">S / R</span>
      <div className="flex flex-col gap-0.5">
        {activeLevels.map((lvl) => (
          <div key={lvl.id} className="flex items-center justify-between gap-1.5 text-muted">
            <span className={`font-semibold ${lvl.type === 'support' ? 'text-emerald-400' : 'text-bear'}`}>
              {lvl.type === 'support' ? 'S' : 'R'} {lvl.touches}x
            </span>
            <span className="font-mono text-ink">{formatPrice(lvl.price, precision)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const CandlestickChart = forwardRef<CandlestickChartHandle, CandlestickChartProps>(
  function CandlestickChart(
    {
      dataset,
      marketName,
      timeframeLabel,
      granularitySec,
      precision,
      liveTick,
      loadState,
      connectionStatus,
      errorMessage,
      overlays = null,
      overlayPrefs = null,
      snapshot = null,
      signalLevels = null,
      trendlineOverlay = null,
      structureOverlay = null,
      dsOverlay = null,
      aiOverlay = null,
      dark = true,
      onAnnotationSelect,
      onStructureZoneSelect,
      onDsZoneSelect,
      onAiZoneSelect,
      onReconnect,
      onCrosshairChange,
      onNeedOlderCandles,
      onDrawingToolChange,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
    const primitiveRef = useRef<AnalysisChartPrimitive | null>(null);
    const signalPrimitiveRef = useRef<SignalAnnotationPrimitive | null>(null);
    const trendlinePrimitiveRef = useRef<TrendlineChartPrimitive | null>(null);
    const structurePrimitiveRef = useRef<StructureChartPrimitive | null>(null);
    const dsPrimitiveRef = useRef<DsChartPrimitive | null>(null);
    const aiPrimitiveRef = useRef<AiChartPrimitive | null>(null);
    const priceLinesRef = useRef<IPriceLine[]>([]);
    const drawingsPrimitiveRef = useRef<UserDrawingsPrimitive | null>(null);
    const drawingsRef = useRef<UserDrawing[]>([]);
    const drawingToolRef = useRef<DrawingKind | null>(null);
    const pendingPointRef = useRef<DrawingPoint | null>(null);

    const onCrosshairRef = useRef(onCrosshairChange);
    const onNeedOlderRef = useRef(onNeedOlderCandles);
    const onDrawingToolChangeRef = useRef(onDrawingToolChange);
    const onAnnotationSelectRef = useRef(onAnnotationSelect);
    const onStructureZoneSelectRef = useRef(onStructureZoneSelect);
    const onDsZoneSelectRef = useRef(onDsZoneSelect);
    const onAiZoneSelectRef = useRef(onAiZoneSelect);
    onCrosshairRef.current = onCrosshairChange;
    onNeedOlderRef.current = onNeedOlderCandles;
    onDrawingToolChangeRef.current = onDrawingToolChange;
    onAnnotationSelectRef.current = onAnnotationSelect;
    onStructureZoneSelectRef.current = onStructureZoneSelect;
    onDsZoneSelectRef.current = onDsZoneSelect;
    onAiZoneSelectRef.current = onAiZoneSelect;
    const signalLevelsRef = useRef<SignalLevels | null>(signalLevels);
    signalLevelsRef.current = signalLevels;
    const structureOverlayRef = useRef<StructureChartOverlay | null>(structureOverlay);
    structureOverlayRef.current = structureOverlay;
    const dsOverlayRef = useRef<DsChartOverlay | null>(dsOverlay);
    dsOverlayRef.current = dsOverlay;
    const aiOverlayRef = useRef<AiChartOverlay | null>(aiOverlay);
    aiOverlayRef.current = aiOverlay;

    const appliedDatasetIdRef = useRef<number>(-1);
    const appliedCandlesLengthRef = useRef<number>(0);
    const appliedEarliestTimeRef = useRef<number | null>(null);
    const lastSeriesBarTimeRef = useRef<number | null>(null);
    const lastAppliedTickSeqRef = useRef<number>(0);
    const lastLiveCandleRef = useRef<Candle | null>(null);

    // Chart/series handles mirrored into state so the price-anchored countdown can
    // recompute its coordinate on every render (the refs alone do not re-render).
    const [chartApi, setChartApi] = useState<IChartApi | null>(null);
    const [seriesApi, setSeriesApi] = useState<ISeriesApi<'Candlestick'> | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        zoomIn() {
          const chart = chartRef.current;
          if (!chart) return;
          const ts = chart.timeScale();
          const range = ts.getVisibleLogicalRange();
          if (!range) return;
          const span = range.to - range.from;
          if (span <= 10) return;
          const delta = span * 0.2;
          ts.setVisibleLogicalRange({
            from: range.from + delta,
            to: range.to - delta * 0.35,
          });
        },
        zoomOut() {
          const chart = chartRef.current;
          if (!chart) return;
          const ts = chart.timeScale();
          const range = ts.getVisibleLogicalRange();
          if (!range) return;
          const span = range.to - range.from;
          const delta = span * 0.25;
          ts.setVisibleLogicalRange({
            from: range.from - delta,
            to: range.to + delta * 0.35,
          });
        },
        fitContent() {
          chartRef.current?.timeScale().fitContent();
        },
        scrollToRealTime() {
          chartRef.current?.timeScale().scrollToRealTime();
        },
        setDrawingTool(kind) {
          drawingToolRef.current = kind;
          pendingPointRef.current = null;
          onDrawingToolChangeRef.current?.(kind);
        },
        clearDrawings() {
          drawingsRef.current = [];
          pendingPointRef.current = null;
          drawingsPrimitiveRef.current?.setDrawings([]);
        },
        undoDrawing() {
          drawingsRef.current = drawingsRef.current.slice(0, -1);
          pendingPointRef.current = null;
          drawingsPrimitiveRef.current?.setDrawings(drawingsRef.current);
        },
      }),
      []
    );

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const chart = createChart(container, {
        width: container.clientWidth || 800,
        height: container.clientHeight || 500,
        layout: {
          // The chart canvas stays pure white in every theme (design system rule).
          background: { type: ColorType.Solid, color: CHART_COLORS.background },
          textColor: CHART_COLORS.priceScale,
          fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: CHART_COLORS.grid },
          horzLines: { color: CHART_COLORS.grid },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: CHART_COLORS.priceLine,
            width: 1,
            labelBackgroundColor: CHART_COLORS.crosshairLabel,
          },
          horzLine: {
            color: CHART_COLORS.priceLine,
            width: 1,
            labelBackgroundColor: CHART_COLORS.crosshairLabel,
          },
        },
        rightPriceScale: {
          borderColor: CHART_COLORS.axisBorder,
          scaleMargins: {
            top: 0.08,
            bottom: 0.08,
          },
        },
        timeScale: {
          borderColor: CHART_COLORS.axisBorder,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 12,
          barSpacing: 10,
          minBarSpacing: 3,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
        handleScale: {
          axisPressedMouseMove: true,
          mouseWheel: true,
          pinch: true,
        },
      });

      chartRef.current = chart;
      setChartApi(chart);

      const series = chart.addSeries(CandlestickSeries, {
        upColor: CHART_COLORS.bullish,
        downColor: CHART_COLORS.bearish,
        borderVisible: false,
        wickUpColor: CHART_COLORS.bullish,
        wickDownColor: CHART_COLORS.bearish,
      });
      seriesRef.current = series;
      setSeriesApi(series);

      const markersPlugin = createSeriesMarkers(series);
      markersPluginRef.current = markersPlugin;

      const primitive = new AnalysisChartPrimitive();
      primitiveRef.current = primitive;
      series.attachPrimitive(primitive);

      const signalPrimitive = new SignalAnnotationPrimitive();
      signalPrimitiveRef.current = signalPrimitive;
      series.attachPrimitive(signalPrimitive);

      const trendlinePrimitive = new TrendlineChartPrimitive();
      trendlinePrimitiveRef.current = trendlinePrimitive;
      series.attachPrimitive(trendlinePrimitive);

      const structurePrimitive = new StructureChartPrimitive();
      structurePrimitiveRef.current = structurePrimitive;
      series.attachPrimitive(structurePrimitive);

      const dsPrimitive = new DsChartPrimitive();
      dsPrimitiveRef.current = dsPrimitive;
      series.attachPrimitive(dsPrimitive);

      const aiPrimitive = new AiChartPrimitive();
      aiPrimitiveRef.current = aiPrimitive;
      series.attachPrimitive(aiPrimitive);

      const drawingsPrimitive = new UserDrawingsPrimitive();
      drawingsPrimitiveRef.current = drawingsPrimitive;
      series.attachPrimitive(drawingsPrimitive);

      // Drawing tools: each tap/click records a point in data coordinates.
      chart.subscribeClick((param) => {
        const tool = drawingToolRef.current;
        if (!tool || !param.point || param.time === undefined) return;
        const price = series.coordinateToPrice(param.point.y);
        if (price === null) return;
        const point: DrawingPoint = { time: Number(param.time), price: Number(price) };

        if (tool === 'horizontal') {
          drawingsRef.current = [
            ...drawingsRef.current,
            { id: `d${Date.now()}`, kind: tool, points: [point], color: DRAWING_COLORS[tool] },
          ];
          drawingsPrimitive.setDrawings(drawingsRef.current);
          return;
        }

        const pending = pendingPointRef.current;
        if (!pending) {
          pendingPointRef.current = point;
          return;
        }
        drawingsRef.current = [
          ...drawingsRef.current,
          {
            id: `d${Date.now()}`,
            kind: tool,
            points: [pending, point],
            color: DRAWING_COLORS[tool],
          },
        ];
        pendingPointRef.current = null;
        drawingsPrimitive.setDrawings(drawingsRef.current);
      });

      chart.subscribeCrosshairMove((param) => {
        const time = param.time;
        if (!time || !param.seriesData) {
          onCrosshairRef.current(null);
          return;
        }
        const data = param.seriesData.get(series);
        if (!data || typeof data !== 'object') {
          onCrosshairRef.current(null);
          return;
        }
        const ohlc = data as { open: number; high: number; low: number; close: number };
        const unixTime = Number(time);
        onCrosshairRef.current({
          time: unixTime,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
        });
      });

      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!range) return;
        if (range.from < 5) {
          onNeedOlderRef.current();
        }
      });

      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            chart.resize(Math.floor(width), Math.floor(height));
          }
        }
      });
      resizeObserver.observe(container);

      return () => {
        resizeObserver.disconnect();
        priceLinesRef.current = [];
        markersPlugin.detach();
        series.detachPrimitive(primitive);
        series.detachPrimitive(signalPrimitive);
        series.detachPrimitive(trendlinePrimitive);
        series.detachPrimitive(structurePrimitive);
        series.detachPrimitive(dsPrimitive);
        series.detachPrimitive(drawingsPrimitive);
        primitiveRef.current = null;
        signalPrimitiveRef.current = null;
        trendlinePrimitiveRef.current = null;
        structurePrimitiveRef.current = null;
        dsPrimitiveRef.current = null;
        drawingsPrimitiveRef.current = null;
        drawingsRef.current = [];
        pendingPointRef.current = null;
        drawingToolRef.current = null;
        markersPluginRef.current = null;
        chart.remove();
        chartRef.current = null;
        seriesRef.current = null;
        setChartApi(null);
        setSeriesApi(null);
      };
    }, []);

    useEffect(() => {
      const series = seriesRef.current;
      if (!series) return;
      const clampedPrecision = Math.min(8, Math.max(0, precision));
      series.applyOptions({
        priceFormat: {
          type: 'price',
          precision: clampedPrecision,
          minMove: Math.pow(10, -clampedPrecision),
        },
      });
    }, [precision]);

    // Re-skin the canvas when the light/dark theme changes.
    useEffect(() => {
      const chart = chartRef.current;
      if (!chart) return;
      chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: CHART_COLORS.background },
          textColor: CHART_COLORS.priceScale,
        },
        grid: {
          vertLines: { color: CHART_COLORS.grid },
          horzLines: { color: CHART_COLORS.grid },
        },
        rightPriceScale: { borderColor: CHART_COLORS.axisBorder },
        timeScale: { borderColor: CHART_COLORS.axisBorder },
      });
    }, [dark]);

    // Sync the locked entry/SL + dynamic TP annotations onto the candle canvas.
    useEffect(() => {
      signalPrimitiveRef.current?.setLevels(signalLevels);
    }, [signalLevels]);

    // Sync the Trendline Scanner overlay (trendlines + confirmed signal levels).
    useEffect(() => {
      trendlinePrimitiveRef.current?.setOverlay(trendlineOverlay);
    }, [trendlineOverlay]);

    // Sync the AI structure & future-opportunity overlay (fresh watch zones only).
    useEffect(() => {
      structurePrimitiveRef.current?.setOverlay(structureOverlay);
    }, [structureOverlay]);

    // Sync the Demand & Supply AI overlay (current zones + confirmed signal levels).
    useEffect(() => {
      dsPrimitiveRef.current?.setOverlay(dsOverlay);
    }, [dsOverlay]);

    // Sync the independent AI module overlay (current zones + confirmed signal levels).
    useEffect(() => {
      aiPrimitiveRef.current?.setOverlay(aiOverlay);
    }, [aiOverlay]);

    // Tapping near an annotation surfaces its technical reasoning.
    useEffect(() => {
      const chart = chartRef.current;
      const series = seriesRef.current;
      if (!chart || !series) return;
      const onClick = (param: { point?: { x: number; y: number } }) => {
        if (!param.point) return;
        if (drawingToolRef.current) return;

        // Demand & Supply zones: tapping inside a zone's band surfaces its analysis.
        const ds = dsOverlayRef.current;
        if (ds) {
          const hit = ds.zones.find((z) => {
            const yTop = series.priceToCoordinate(z.upperPrice);
            const yBot = series.priceToCoordinate(z.lowerPrice);
            if (yTop === null || yBot === null) return false;
            const top = Math.min(yTop, yBot) - 4;
            const bottom = Math.max(yTop, yBot) + 4;
            return param.point!.y >= top && param.point!.y <= bottom;
          });
          if (hit) {
            onDsZoneSelectRef.current?.(hit);
            return;
          }
        }

        // Structure watch zones: tapping inside a zone's band surfaces its reasoning.
        const structure = structureOverlayRef.current;
        if (structure) {
          const hit = structure.watchZones.find((z) => {
            const yTop = series.priceToCoordinate(z.upperPrice);
            const yBot = series.priceToCoordinate(z.lowerPrice);
            if (yTop === null || yBot === null) return false;
            const top = Math.min(yTop, yBot) - 4;
            const bottom = Math.max(yTop, yBot) + 4;
            return param.point!.y >= top && param.point!.y <= bottom;
          });
          if (hit) {
            onStructureZoneSelectRef.current?.(hit);
            return;
          }
        }

        // Independent AI module zones (S/R, patterns, BOS/CHOCH, …): tap a band to inspect.
        const ai = aiOverlayRef.current;
        if (ai) {
          const all = [...ai.zones, ...(ai.watchZones ?? [])];
          const hit = all.find((z) => {
            const yTop = series.priceToCoordinate(z.upperPrice);
            const yBot = series.priceToCoordinate(z.lowerPrice);
            if (yTop === null || yBot === null) return false;
            const top = Math.min(yTop, yBot) - 4;
            const bottom = Math.max(yTop, yBot) + 4;
            return param.point!.y >= top && param.point!.y <= bottom;
          });
          if (hit) {
            onAiZoneSelectRef.current?.(hit);
            return;
          }
        }

        const levels = signalLevelsRef.current;
        if (!levels) return;
        const yEntry = series.priceToCoordinate(levels.entry);
        const yStop = series.priceToCoordinate(levels.stopLoss);
        const yTarget = series.priceToCoordinate(levels.takeProfit);
        const tolerance = 22;
        const near = (y: number | null) => y !== null && Math.abs(y - param.point!.y) <= tolerance;
        if (near(yEntry) || near(yStop) || near(yTarget)) {
          onAnnotationSelectRef.current?.(levels);
        }
      };
      chart.subscribeClick(onClick);
      return () => chart.unsubscribeClick(onClick);
    }, []);

    useEffect(() => {
      const series = seriesRef.current;
      const chart = chartRef.current;
      if (!series || !chart) return;

      const { datasetId, candles } = dataset;
      const isNewDataset = appliedDatasetIdRef.current !== datasetId;
      const currentEarliest = candles.length > 0 ? candles[0].time : null;
      const currentLatest = candles.length > 0 ? candles[candles.length - 1].time : null;

      if (isNewDataset) {
        appliedDatasetIdRef.current = datasetId;
        lastAppliedTickSeqRef.current = 0;
        lastLiveCandleRef.current = null;
        series.setData(candles.map(toChartCandle));
        appliedCandlesLengthRef.current = candles.length;
        appliedEarliestTimeRef.current = currentEarliest;
        lastSeriesBarTimeRef.current = currentLatest;

        if (candles.length > 0) {
          const total = candles.length;
          const visibleBars = Math.min(total, 110);
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, total - visibleBars),
            to: total + 4,
          });
        }
        return;
      }

      const prependedCount =
        currentEarliest !== null &&
        appliedEarliestTimeRef.current !== null &&
        currentEarliest < appliedEarliestTimeRef.current
          ? candles.length - appliedCandlesLengthRef.current
          : 0;

      if (appliedCandlesLengthRef.current === 0 && candles.length > 0) {
        series.setData(candles.map(toChartCandle));
        appliedCandlesLengthRef.current = candles.length;
        appliedEarliestTimeRef.current = currentEarliest;
        lastSeriesBarTimeRef.current = currentLatest;

        const total = candles.length;
        const visibleBars = Math.min(total, 110);
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, total - visibleBars),
          to: total + 4,
        });
      } else if (prependedCount > 0) {
        const previousRange = chart.timeScale().getVisibleLogicalRange();
        series.setData(candles.map(toChartCandle));
        appliedCandlesLengthRef.current = candles.length;
        appliedEarliestTimeRef.current = currentEarliest;
        if (currentLatest !== null) {
          lastSeriesBarTimeRef.current = currentLatest;
        }
        if (previousRange) {
          chart.timeScale().setVisibleLogicalRange({
            from: previousRange.from + prependedCount,
            to: previousRange.to + prependedCount,
          });
        }
      }
    }, [dataset]);

    useEffect(() => {
      const series = seriesRef.current;
      if (!series || !liveTick) return;
      if (liveTick.datasetId !== appliedDatasetIdRef.current) return;
      if (liveTick.seq === lastAppliedTickSeqRef.current) return;
      if (
        lastSeriesBarTimeRef.current !== null &&
        liveTick.candle.time < lastSeriesBarTimeRef.current
      ) {
        return;
      }

      const last = lastLiveCandleRef.current;
      if (
        last !== null &&
        last.time === liveTick.candle.time &&
        last.open === liveTick.candle.open &&
        last.high === liveTick.candle.high &&
        last.low === liveTick.candle.low &&
        last.close === liveTick.candle.close
      ) {
        // Identical frame — nothing to repaint (avoids the flicker loop).
        return;
      }

      lastAppliedTickSeqRef.current = liveTick.seq;
      lastSeriesBarTimeRef.current = liveTick.candle.time;
      lastLiveCandleRef.current = liveTick.candle;
      series.update(toChartCandle(liveTick.candle));
    }, [liveTick]);

    // Sync AI Analysis Overlays
    useEffect(() => {
      const series = seriesRef.current;
      const primitive = primitiveRef.current;
      const markersPlugin = markersPluginRef.current;
      if (!series || !primitive || !markersPlugin) return;

      for (const line of priceLinesRef.current) {
        try {
          series.removePriceLine(line);
        } catch {
          // ignore stale line removal
        }
      }
      priceLinesRef.current = [];

      const latestTime =
        dataset.candles.length > 0
          ? dataset.candles[dataset.candles.length - 1].time
          : null;

      if (!overlays) {
        primitive.setOverlays(null, latestTime);
        markersPlugin.setMarkers([]);
        return;
      }

      const prefs = overlayPrefs ?? {
        supportResistance: true,
        supplyDemand: true,
        trendlines: true,
        patterns: true,
        structureBreaks: true,
        liquiditySweeps: true,
        swingLabels: true,
        entryLevels: true,
        entryZone: true,
        rangeZones: true,
        targets: true,
        legends: true,
      };

      const filteredOverlays: ChartOverlayData = {
        ...overlays,
        supportResistance: prefs.supportResistance ? overlays.supportResistance : [],
        supplyDemand: prefs.supplyDemand ? overlays.supplyDemand : [],
        trendlines: prefs.trendlines ? overlays.trendlines : [],
        patterns: prefs.patterns ? overlays.patterns : [],
        structureBreaks: prefs.structureBreaks ? overlays.structureBreaks : [],
        liquiditySweeps: prefs.liquiditySweeps ? overlays.liquiditySweeps : [],
        swingPoints: prefs.swingLabels ? overlays.swingPoints : [],
        range: prefs.rangeZones ? overlays.range : null,
        entryZone: prefs.entryZone ? overlays.entryZone : null,
        breakoutRetest: prefs.entryLevels ? overlays.breakoutRetest : null,
        signal: prefs.entryLevels ? overlays.signal : null,
      };

      primitive.setOverlays(filteredOverlays, latestTime);

      // 1. Support & Resistance lines — fine horizontal lines, short S / R labels only.
      if (prefs.supportResistance) {
        for (const lvl of overlays.supportResistance) {
          const line = series.createPriceLine({
            price: lvl.price,
            color: hexToRgba(
              lvl.type === 'support' ? MARKUP_COLORS.support : MARKUP_COLORS.resistance,
              lvl.status === 'active' ? 0.7 : 0.4
            ),
            lineWidth: 1,
            lineStyle: lvl.status === 'active' ? LineStyle.Dashed : LineStyle.Dotted,
            axisLabelVisible: true,
            title: `${lvl.type === 'support' ? 'S' : 'R'} ${lvl.touches}x`,
          });
          priceLinesRef.current.push(line);
        }
      }

      // 1b. Sideways range lines: resistance (range high), support (range low) and
      //     equilibrium (midpoint). Only drawn when a validated range is present.
      if (prefs.rangeZones && overlays.range?.valid) {
        const r = overlays.range;
        const rangeLines = [
          { price: r.resistance, color: MARKUP_COLORS.resistance, title: 'R' },
          { price: r.support, color: MARKUP_COLORS.support, title: 'S' },
          { price: r.equilibrium, color: MARKUP_COLORS.neutral, title: 'EQ' },
        ];
        for (const rl of rangeLines) {
          const line = series.createPriceLine({
            price: rl.price,
            color: hexToRgba(rl.color, 0.6),
            lineWidth: 1,
            lineStyle: rl.title === 'EQ' ? LineStyle.Dotted : LineStyle.Solid,
            axisLabelVisible: true,
            title: rl.title,
          });
          priceLinesRef.current.push(line);
        }
      }

      // 2. Active signal entry, TP1, TP2 and stop-loss price lines — thin, short labels.
      if (prefs.entryLevels && overlays.signal) {
        const entryLine = series.createPriceLine({
          price: overlays.signal.entryPrice,
          color: hexToRgba(MARKUP_COLORS.entry, 0.75),
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'ENTRY',
        });
        const tp1Line = series.createPriceLine({
          price: overlays.signal.takeProfit1,
          color: hexToRgba(MARKUP_COLORS.target, 0.6),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'TP1',
        });
        const tp2Line = series.createPriceLine({
          price: overlays.signal.takeProfit2,
          color: hexToRgba(MARKUP_COLORS.target, 0.5),
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'TP2',
        });
        const slLine = series.createPriceLine({
          price: overlays.signal.stopLoss,
          color: hexToRgba(MARKUP_COLORS.stop, 0.75),
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'SL',
        });
        priceLinesRef.current.push(entryLine, tp1Line, tp2Line, slLine);
      }

      // 3. Reproduce the original scanner signal evidence when live analysis has not
      //    (yet) produced its own signal for this chart. Never draws imaginary candles.
      if (prefs.entryLevels && snapshot && !overlays.signal) {
        const snapEntry = series.createPriceLine({
          price: snapshot.entryPrice,
          color: hexToRgba(MARKUP_COLORS.entry, 0.75),
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'ENTRY',
        });
        const snapInvalidation = series.createPriceLine({
          price: snapshot.invalidationPrice,
          color: hexToRgba(MARKUP_COLORS.stop, 0.7),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'INVAL',
        });
        priceLinesRef.current.push(snapEntry, snapInvalidation);
        if (prefs.targets && snapshot.target1 !== null) {
          const t1 = series.createPriceLine({
            price: snapshot.target1,
            color: hexToRgba(MARKUP_COLORS.target, 0.55),
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'T1',
          });
          priceLinesRef.current.push(t1);
        }
        if (prefs.targets && snapshot.target2 !== null) {
          const t2 = series.createPriceLine({
            price: snapshot.target2,
            color: hexToRgba(MARKUP_COLORS.target, 0.45),
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'T2',
          });
          priceLinesRef.current.push(t2);
        }
      }

      const markers: SeriesMarker<Time>[] = [];
      if (prefs.structureBreaks) {
        for (const brk of overlays.structureBreaks) {
          const isBullish = brk.direction === 'bullish';
          markers.push({
            time: brk.time as UTCTimestamp,
            position: isBullish ? 'belowBar' : 'aboveBar',
            shape: isBullish ? 'arrowUp' : 'arrowDown',
            color: isBullish ? CHART_COLORS.bullish : CHART_COLORS.bearish,
            text: `${brk.kind}`,
            size: 1,
          });
        }
      }

      if (prefs.entryLevels && overlays.signal) {
        const isRise = overlays.signal.direction === 'RISE';
        markers.push({
          time: overlays.signal.entryCandleTime as UTCTimestamp,
          position: isRise ? 'belowBar' : 'aboveBar',
          shape: isRise ? 'arrowUp' : 'arrowDown',
          color: isRise ? MARKUP_COLORS.rise : MARKUP_COLORS.fall,
          text: isRise ? 'RISE' : 'FALL',
          size: 1,
        });
      }

      // Confirmation candle marker for a reproduced scanner signal.
      if (prefs.entryLevels && snapshot && !overlays.signal) {
        const isRise = snapshot.direction === 'RISE';
        markers.push({
          time: snapshot.confirmedBarTime as UTCTimestamp,
          position: isRise ? 'belowBar' : 'aboveBar',
          shape: isRise ? 'arrowUp' : 'arrowDown',
          color: isRise ? MARKUP_COLORS.rise : MARKUP_COLORS.fall,
          text: isRise ? 'RISE' : 'FALL',
          size: 1,
        });
      }

      markers.sort((a, b) => Number(a.time) - Number(b.time));
      markersPlugin.setMarkers(markers);
    }, [
      // Depend on the last bar's *time* (changes once per candle) rather than the
      // candles array (new identity every tick) so overlays are not rebuilt per tick.
      dataset.datasetId,
      dataset.candles.length,
      dataset.candles.length > 0 ? dataset.candles[dataset.candles.length - 1].time : null,
      overlays,
      overlayPrefs,
      snapshot,
      precision,
    ]);

    const candles = dataset.candles;

    const showBlockingError =
      (loadState === 'error' || connectionStatus === 'error') &&
      candles.length === 0;
    const showTopDisconnectNotice =
      (connectionStatus === 'reconnecting' ||
        connectionStatus === 'disconnected' ||
        connectionStatus === 'error') &&
      candles.length > 0;

    return (
      <div
        className="relative flex-1 min-h-0 w-full bg-surface"
        data-testid="chart-workspace"
        data-load-state={loadState}
        data-connection-status={connectionStatus}
        data-live-candle={
          candles.length > 0
            ? `${candles[candles.length - 1].time}:${candles[candles.length - 1].open}:${candles[candles.length - 1].high}:${candles[candles.length - 1].low}:${candles[candles.length - 1].close}`
            : ''
        }
      >
        <div
          ref={containerRef}
          className="w-full h-full"
          data-testid="lightweight-chart-container"
        />

        {/* Price-anchored live candle countdown at the right edge (native Deriv style) */}
        <LiveCandleCountdown
          chart={chartApi}
          series={seriesApi}
          container={containerRef.current}
          liveCandle={candles.length > 0 ? candles[candles.length - 1] : null}
          granularitySec={granularitySec}
          connectionStatus={connectionStatus}
        />

        {/* Organized S/R Legend (top-left) */}
        {overlayPrefs?.legends !== false && (
          <ChartLegendOverlay overlays={overlays} precision={precision} />
        )}

        {showTopDisconnectNotice && (
          <div
            role="alert"
            className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 bg-elevated/95 border border-amber-500/40 rounded-lg shadow-sm text-xs text-ink max-w-[92%]"
          >
            <AlertTriangle
              className="w-4 h-4 text-amber-600 shrink-0"
              aria-hidden="true"
            />
            <span className="truncate">
              {connectionStatus === 'reconnecting'
                ? 'Live stream interrupted. Reconnecting to Deriv...'
                : errorMessage || 'Disconnected from live Deriv feed.'}
            </span>
            {connectionStatus !== 'reconnecting' && (
              <button
                type="button"
                onClick={onReconnect}
                className="font-semibold text-ink underline underline-offset-2 hover:text-accent whitespace-nowrap shrink-0 cursor-pointer"
              >
                Reconnect
              </button>
            )}
          </div>
        )}

        {loadState === 'loading' && (
          <div
            role="status"
            aria-live="polite"
            className={`absolute inset-0 z-10 flex items-center justify-center pointer-events-none ${
              candles.length === 0 ? 'bg-surface' : 'bg-surface/60'
            }`}
          >
            <div className="flex items-center gap-2.5 px-4 py-2.5 bg-elevated border border-line rounded-lg shadow-xs text-sm text-muted">
              <Loader2
                className="w-4 h-4 text-accent animate-spin shrink-0"
                aria-hidden="true"
              />
              <span>
                Loading {marketName} ({timeframeLabel}) candles...
              </span>
            </div>
          </div>
        )}

        {loadState === 'empty' && candles.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface p-6">
            <div className="max-w-sm text-center space-y-3">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-panel text-muted">
                <BarChart2 className="w-5 h-5" aria-hidden="true" />
              </div>
              <h2 className="text-base font-semibold text-ink">
                No historical candles returned
              </h2>
              <p className="text-sm text-muted">
                Deriv did not return candle data for {marketName} on {timeframeLabel}.
              </p>
              <button
                type="button"
                onClick={onReconnect}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-app bg-accent rounded-md hover:bg-accent-soft cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Retry Fetch</span>
              </button>
            </div>
          </div>
        )}

        {showBlockingError && (
          <div
            role="alert"
            className="absolute inset-0 z-20 flex items-center justify-center bg-surface p-6"
          >
            <div className="max-w-md text-center space-y-4 border border-line rounded-xl p-6 bg-elevated">
              <div className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-red-500/12 text-bear">
                <AlertTriangle className="w-5 h-5" aria-hidden="true" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-base font-semibold text-ink">
                  Unable to connect to Deriv market feed
                </h2>
                <p className="text-sm text-muted">
                  {errorMessage ||
                    'The WebSocket connection to wss://ws.derivws.com could not be established. Check your network connection and retry.'}
                </p>
              </div>
              <button
                type="button"
                onClick={onReconnect}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Reconnect to Deriv</span>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
);
