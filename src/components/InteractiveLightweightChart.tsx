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

interface ChartProps {
  candles: Candle[];
  symbol: string;
  timeframe: string;
  fvg?: FVG;
  tradeableRange?: TradeableRange;
  barrier?: BarrierProposal;
  structuralShift?: StructuralShift;
  sweptPool?: LiquidityPool;
  zones?: SupportResistanceZone[];
}

export const InteractiveLightweightChart: React.FC<ChartProps> = ({
  candles,
  symbol,
  timeframe,
  fvg,
  tradeableRange,
  barrier,
  structuralShift,
  sweptPool,
  zones = []
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersPluginRef = useRef<any>(null);

  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);

  // Initialize Lightweight Chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight || 380,
      layout: {
        background: { color: '#080c14' },
        textColor: '#94a3b8',
        fontFamily: "'JetBrains Mono', monospace"
      },
      grid: {
        vertLines: { color: '#131b2e' },
        horzLines: { color: '#131b2e' }
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: '#38bdf8',
          width: 1,
          style: LineStyle.LargeDashed,
          labelBackgroundColor: '#0284c7'
        },
        horzLine: {
          color: '#38bdf8',
          width: 1,
          style: LineStyle.LargeDashed,
          labelBackgroundColor: '#0284c7'
        }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#1e293b'
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        autoScale: true,
        scaleMargins: {
          top: 0.12,
          bottom: 0.12
        }
      }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e'
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Crosshair move listener
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

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries[0] && chartRef.current && chartContainerRef.current) {
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

  // Update candlestick data and structural overlays
  useEffect(() => {
    if (!seriesRef.current) return;

    // Remove previous price lines
    priceLinesRef.current.forEach((line) => {
      try {
        seriesRef.current?.removePriceLine(line);
      } catch {
        // ignore if already removed
      }
    });
    priceLinesRef.current = [];

    // Map unique sorted candles
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
      const spotLine = seriesRef.current.createPriceLine({ price: sortedCandles[sortedCandles.length - 1].close, color: '#38BDF8', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SPOT' });
      priceLinesRef.current.push(spotLine);
    }

    // Structural Markers (Liquidity Sweeps, CHoCH / BOS)
    const markers: SeriesMarker<Time>[] = [];

    if (sweptPool && sweptPool.sweptEpoch) {
      markers.push({
        time: sweptPool.sweptEpoch as Time,
        position: sweptPool.type === 'SELLSIDE' ? 'belowBar' : 'aboveBar',
        color: '#f59e0b',
        shape: sweptPool.type === 'SELLSIDE' ? 'arrowUp' : 'arrowDown',
        text: `LIQUIDITY SWEEP (${sweptPool.type})`
      });
    }

    if (structuralShift) {
      markers.push({
        time: structuralShift.breakEpoch as Time,
        position: structuralShift.direction === 'BULLISH' ? 'aboveBar' : 'belowBar',
        color: '#a855f7',
        shape: 'circle',
        text: `${structuralShift.type} (${structuralShift.direction})`
      });
    }

    if (!markersPluginRef.current) {
      markersPluginRef.current = createSeriesMarkers(seriesRef.current, markers);
    } else {
      markersPluginRef.current.setMarkers(markers);
    }

    // Draw Price Overlays:
    // 1. NO TOUCH BARRIER (Bright Red Solid Line)
    if (barrier && seriesRef.current) {
      const bLine = seriesRef.current.createPriceLine({
        price: barrier.barrierLevel,
        color: '#f43f5e',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `NO TOUCH BARRIER (${barrier.barrier})`
      });
      priceLinesRef.current.push(bLine);
    }

    // 2. PROTECTED SWING (Amber Dashed Line)
    if (tradeableRange && seriesRef.current) {
      const pLine = seriesRef.current.createPriceLine({
        price: tradeableRange.newlyProtectedSwing,
        color: '#eab308',
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'PROTECTED SWING'
      });
      priceLinesRef.current.push(pLine);

      // 3. ADAPTIVE RETRACEMENT TARGET (Cyan Dotted Line)
      const aLine = seriesRef.current.createPriceLine({
        price: tradeableRange.adaptiveFillTarget,
        color: '#06b6d4',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: `ADAPTIVE TARGET (${tradeableRange.fillDepthType})`
      });
      priceLinesRef.current.push(aLine);
    }

    // 4. FAIR VALUE GAP (Violet Boundaries & Midpoint)
    if (fvg && seriesRef.current) {
      const topFvg = seriesRef.current.createPriceLine({
        price: fvg.upperBoundary,
        color: '#818cf8',
        lineWidth: 1,
        lineStyle: LineStyle.LargeDashed,
        axisLabelVisible: false,
        title: 'FVG HIGH'
      });
      const botFvg = seriesRef.current.createPriceLine({
        price: fvg.lowerBoundary,
        color: '#818cf8',
        lineWidth: 1,
        lineStyle: LineStyle.LargeDashed,
        axisLabelVisible: false,
        title: 'FVG LOW'
      });
      const midFvg = seriesRef.current.createPriceLine({
        price: fvg.midpoint,
        color: '#a5b4fc',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: 'FVG 50% MID'
      });
      priceLinesRef.current.push(topFvg, botFvg, midFvg);
    }

    // 5. Active Support & Resistance Zones
    zones.slice(0, 3).forEach((z) => {
      if (seriesRef.current) {
        const srLine = seriesRef.current.createPriceLine({
          price: (z.upperPrice + z.lowerPrice) / 2,
          color: z.type === 'SUPPORT' ? '#059669' : '#dc2626',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: `${z.type} (${z.testCount} tests)`
        });
        priceLinesRef.current.push(srLine);
      }
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

  return (
    <div className="relative w-full rounded-xl overflow-hidden border border-slate-800/80 bg-[#080c14] shadow-2xl">
      {/* Top Header Overlay with Market Info & Live OHLC */}
      <div className="px-4 py-2.5 bg-slate-900/80 border-b border-slate-800/80 flex flex-wrap items-center justify-between text-xs backdrop-blur-sm gap-2">
        <div className="flex items-center space-x-3">
          <span className="font-bold text-white tracking-wide">{symbol}</span>
          <span className="px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 font-mono text-[10px] border border-indigo-800/50">
            {timeframe}
          </span>
          {candles.length > 0 && (
            <span className="text-[11px] text-slate-400 font-mono">
              {candles.length} bars
            </span>
          )}
        </div>

        {latestCandle && (
          <div className="flex items-center space-x-3 font-mono text-[11px]">
            <div>
              <span className="text-slate-500 mr-1">O</span>
              <span className="text-slate-200">{latestCandle.open.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-slate-500 mr-1">H</span>
              <span className="text-emerald-400">{latestCandle.high.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-slate-500 mr-1">L</span>
              <span className="text-rose-400">{latestCandle.low.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-slate-500 mr-1">C</span>
              <span
                className={`font-semibold ${
                  latestCandle.close >= latestCandle.open ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {latestCandle.close.toFixed(2)}
              </span>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1">
          <button onClick={() => zoomBy(1.25)} aria-label="Zoom out" className="rounded-md border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"><ZoomOut className="h-3.5 w-3.5" /></button>
          <button onClick={() => zoomBy(0.8)} aria-label="Zoom in" className="rounded-md border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"><ZoomIn className="h-3.5 w-3.5" /></button>
          <button onClick={() => chartRef.current?.timeScale().fitContent()} aria-label="Fit chart" className="rounded-md border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"><Expand className="h-3.5 w-3.5" /></button>
          <button onClick={() => chartContainerRef.current?.parentElement?.requestFullscreen?.()} aria-label="Fullscreen chart" className="rounded-md border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"><Maximize2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {/* Lightweight Chart Container */}
      <div className="relative">
        <div ref={chartContainerRef} className="w-full h-[320px] sm:h-[380px] xl:h-[440px]" />
        {candles.length === 0 && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#080D18] text-center"><div className="rounded-full border border-slate-700 bg-slate-900 p-3 text-slate-400"><Activity className="h-5 w-5" /></div><div className="text-sm font-semibold text-slate-200">Waiting for market candles</div><div className="text-xs text-slate-500">Chart data appears when the feed is connected.</div></div>}
      </div>

      {/* Bottom Chart Legend */}
      <div className="px-4 py-2 bg-slate-950/90 border-t border-slate-800/80 flex flex-wrap items-center justify-between text-[10px] text-slate-400 font-mono gap-y-1">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-1 bg-[#f43f5e] rounded-sm" />
            <span>No Touch Barrier</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-1 bg-[#eab308] rounded-sm" />
            <span>Protected Swing</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-1 bg-[#06b6d4] rounded-sm" />
            <span>Adaptive Retracement Target</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-1 bg-[#818cf8] rounded-sm" />
            <span>Fair Value Gap</span>
          </div>
        </div>
        <div className="text-slate-500">
          Scroll to zoom • Drag to pan • Hover for OHLC
        </div>
      </div>
    </div>
  );
};
