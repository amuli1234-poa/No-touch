import React, { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  LineStyle,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  Time,
  SeriesMarker,
  IPriceLine
} from 'lightweight-charts';
import { Activity, Maximize2, ZoomIn, ZoomOut, Expand } from 'lucide-react';
import {
  Candle,
  FVG,
  TradeableRange,
  BarrierProposal,
  StructuralShift,
  LiquidityPool,
  SupportResistanceZone
} from '../types/scanner';
import { IconButton } from './ui';

interface ChartProps {
  candles: Candle[];
  symbol: string;
  displayName?: string;
  timeframe: string;
  fvg?: FVG;
  tradeableRange?: TradeableRange;
  barrier?: BarrierProposal;
  structuralShift?: StructuralShift;
  sweptPool?: LiquidityPool;
  zones?: SupportResistanceZone[];
  heightClass?: string;
}

const CHART_BG = '#080D18';
const GRID = '#131B2E';
const BORDER = '#1E293B';

export const InteractiveLightweightChart: React.FC<ChartProps> = ({
  candles,
  symbol,
  displayName,
  timeframe,
  fvg,
  tradeableRange,
  barrier,
  structuralShift,
  sweptPool,
  zones = [],
  heightClass = 'h-[300px] sm:h-[360px] xl:h-[440px]'
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersPluginRef = useRef<any>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight || 380,
      layout: {
        background: { color: CHART_BG },
        textColor: '#94A3B8',
        fontFamily: "'JetBrains Mono', monospace",
        attributionLogo: false
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID }
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: '#38BDF8',
          width: 1,
          style: LineStyle.LargeDashed,
          labelBackgroundColor: '#0369A1'
        },
        horzLine: {
          color: '#38BDF8',
          width: 1,
          style: LineStyle.LargeDashed,
          labelBackgroundColor: '#0369A1'
        }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: BORDER
      },
      rightPriceScale: {
        borderColor: BORDER,
        autoScale: true,
        scaleMargins: { top: 0.12, bottom: 0.12 }
      }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#F43F5E',
      borderVisible: false,
      wickUpColor: '#10B981',
      wickDownColor: '#F43F5E'
    });

    chartRef.current = chart;
    seriesRef.current = series;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData || !seriesRef.current) {
        setHoveredCandle(null);
        return;
      }
      const data = param.seriesData.get(seriesRef.current) as CandlestickData<Time> | undefined;
      if (data) {
        setHoveredCandle({
          epoch: Number(data.time),
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close
        });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight || 380
        });
      }
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersPluginRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;

    priceLinesRef.current.forEach((line) => {
      try {
        seriesRef.current?.removePriceLine(line);
      } catch {
        /* line already detached */
      }
    });
    priceLinesRef.current = [];

    const map = new Map<number, Candle>();
    candles.forEach((c) => map.set(c.epoch, c));
    const sortedCandles = Array.from(map.values()).sort((a, b) => a.epoch - b.epoch);

    const chartData: CandlestickData<Time>[] = sortedCandles.map((c) => ({
      time: c.epoch as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));

    seriesRef.current.setData(chartData);

    if (sortedCandles.length > 0) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: sortedCandles[sortedCandles.length - 1].close,
          color: '#38BDF8',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'SPOT'
        })
      );
    }

    const markers: SeriesMarker<Time>[] = [];

    if (sweptPool && sweptPool.sweptEpoch) {
      markers.push({
        time: sweptPool.sweptEpoch as Time,
        position: sweptPool.type === 'SELLSIDE' ? 'belowBar' : 'aboveBar',
        color: '#F59E0B',
        shape: sweptPool.type === 'SELLSIDE' ? 'arrowUp' : 'arrowDown',
        text: 'LIQ SWEEP'
      });
    }

    if (structuralShift) {
      markers.push({
        time: structuralShift.breakEpoch as Time,
        position: structuralShift.direction === 'BULLISH' ? 'aboveBar' : 'belowBar',
        color: '#A855F7',
        shape: 'circle',
        text: `${structuralShift.type} ${structuralShift.direction.slice(0, 4)}`
      });
    }

    if (!markersPluginRef.current) {
      markersPluginRef.current = createSeriesMarkers(seriesRef.current, markers);
    } else {
      markersPluginRef.current.setMarkers(markers);
    }

    // 1. No Touch Barrier
    if (barrier) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: barrier.barrierLevel,
          color: '#F43F5E',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `NO TOUCH (${barrier.barrier})`
        })
      );
    }

    // 2 & 3. Protected Swing + Adaptive Retracement Target
    if (tradeableRange) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: tradeableRange.newlyProtectedSwing,
          color: '#EAB308',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'PROTECTED SWING'
        })
      );
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: tradeableRange.adaptiveFillTarget,
          color: '#06B6D4',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `ADAPTIVE (${tradeableRange.fillDepthType})`
        })
      );
    }

    // 4. Fair Value Gap boundaries + midpoint
    if (fvg) {
      priceLinesRef.current.push(
        seriesRef.current.createPriceLine({
          price: fvg.upperBoundary,
          color: '#818CF8',
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: false,
          title: 'FVG HIGH'
        }),
        seriesRef.current.createPriceLine({
          price: fvg.lowerBoundary,
          color: '#818CF8',
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: false,
          title: 'FVG LOW'
        }),
        seriesRef.current.createPriceLine({
          price: fvg.midpoint,
          color: '#A5B4FC',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: 'FVG 50%'
        })
      );
    }

    // 5. Active support / resistance zones
    zones.slice(0, 3).forEach((z) => {
      priceLinesRef.current.push(
        seriesRef.current!.createPriceLine({
          price: (z.upperPrice + z.lowerPrice) / 2,
          color: z.type === 'SUPPORT' ? '#059669' : '#DC2626',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: `${z.type} (${z.testCount} tests)`
        })
      );
    });
  }, [candles, fvg, tradeableRange, barrier, structuralShift, sweptPool, zones]);

  const latestCandle = hoveredCandle || candles[candles.length - 1];

  const zoomBy = (factor: number) => {
    const scale = chartRef.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();
    if (!scale || !range) return;
    const center = (range.from + range.to) / 2;
    const halfRange = ((range.to - range.from) * factor) / 2;
    scale.setVisibleLogicalRange({ from: center - halfRange, to: center + halfRange });
  };

  const requestFullscreen = () => {
    const el = wrapperRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      el.requestFullscreen?.();
    }
  };

  const ohlc = latestCandle;

  return (
    <div
      ref={wrapperRef}
      className="relative flex w-full min-w-0 flex-col overflow-hidden rounded-[14px] border border-[#273449] bg-[#080D18] shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
    >
      {/* Chart toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#273449] bg-[#0F1728] px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className="truncate text-[13px] font-bold tracking-tight text-white">
            {displayName || symbol}
          </span>
          <span className="rounded border border-[#635BFF]/30 bg-[#635BFF]/10 px-1.5 py-px text-[10px] font-bold text-[#A5A0FF]">
            {timeframe}
          </span>
          {candles.length > 0 && (
            <span className="tabular text-[10.5px] text-slate-500">{candles.length} bars</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <IconButton label="Zoom out" onClick={() => zoomBy(1.25)}>
            <ZoomOut className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Zoom in" onClick={() => zoomBy(0.8)}>
            <ZoomIn className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Fit content" onClick={() => chartRef.current?.timeScale().fitContent()}>
            <Expand className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Toggle fullscreen" onClick={requestFullscreen}>
            <Maximize2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {/* OHLC strip */}
      {ohlc && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#1E293B] bg-[#0B1120] px-3 py-1.5 text-[11px]">
          {(
            [
              ['O', ohlc.open, 'text-slate-200'],
              ['H', ohlc.high, 'text-emerald-400'],
              ['L', ohlc.low, 'text-rose-400'],
              ['C', ohlc.close, ohlc.close >= ohlc.open ? 'text-emerald-400' : 'text-rose-400']
            ] as const
          ).map(([label, value, cls]) => (
            <span key={label} className="tabular inline-flex items-center gap-1">
              <span className="text-slate-500">{label}</span>
              <span className={cls}>{value.toFixed(2)}</span>
            </span>
          ))}
          {hoveredCandle && (
            <span className="ml-auto text-[10px] text-slate-500">
              {new Date(hoveredCandle.epoch * 1000).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Chart canvas — always fills its container */}
      <div className="relative">
        <div ref={chartContainerRef} className={`w-full ${heightClass}`} />
        {candles.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#080D18] text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-[#273449] bg-[#172238] text-slate-400">
              <Activity className="h-5 w-5" />
            </span>
            <div className="text-[13px] font-semibold text-slate-200">Waiting for market candles</div>
            <div className="text-[11.5px] text-slate-500">
              Chart data appears once the {symbol} feed streams.
            </div>
          </div>
        )}
      </div>

      {/* Overlay legend */}
      <div className="flex flex-wrap items-center justify-between gap-y-1.5 border-t border-[#273449] bg-[#0B1120] px-3 py-2 text-[10.5px] text-slate-500">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
          {(
            [
              ['#F43F5E', 'No Touch Barrier'],
              ['#EAB308', 'Protected Swing'],
              ['#06B6D4', 'Adaptive Retracement'],
              ['#818CF8', 'Fair Value Gap'],
              ['#38BDF8', 'Spot']
            ] as const
          ).map(([color, label]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <span className="h-[3px] w-3 rounded-sm" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
        <span className="hidden sm:inline">Scroll to zoom · drag to pan · hover for OHLC</span>
      </div>
    </div>
  );
};
