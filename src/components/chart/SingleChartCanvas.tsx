import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  Loader2,
  Maximize2,
  Minimize2,
  Navigation,
  Play,
  RotateCw,
  Square,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { TIMEFRAMES } from '../../config/deriv';
import type { Candle } from '../../types/market';
import { buildCrosshairReadout } from '../../utils/derivParser';
import { deriveSignalLevels } from '../../utils/signalLevels';
import { CandlestickChart, type CandlestickChartHandle } from '../CandlestickChart';
import { VolatilitySelector } from '../VolatilitySelector';
import type { ModuleChartOverlay } from '../../types/chartOverlay';

interface SingleChartCanvasProps {
  /** Overlays published by the currently open module (null on non-module views). */
  moduleOverlay?: ModuleChartOverlay | null;
  /** Whether the panel toggle is available on narrow screens. */
  panelToggle?: { open: boolean; onToggle: () => void };
  /** Full-screen Chart tab mode: hide the panel toggle and show a back button. */
  fullScreen?: boolean;
  /** Back navigation shown only in full-screen Chart tab mode. */
  onBack?: () => void;
}

function useCandleCountdown(granularitySec: number, lastCandleTime: number | null): string {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  if (!lastCandleTime || granularitySec <= 0) return '--:--';
  const next = lastCandleTime + granularitySec;
  const remaining = Math.max(0, next - now);
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * THE single shared candlestick chart. It is rendered once by the app shell and is the only
 * chart canvas in the entire application; every module feeds it overlays instead of drawing
 * its own chart. Chart accuracy and live price updates are never delayed by animation.
 */
export function SingleChartCanvas({
  moduleOverlay = null,
  panelToggle,
  fullScreen = false,
  onBack,
}: SingleChartCanvasProps) {
  const ws = useWorkspace();
  const chartRef = useRef<CandlestickChartHandle | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<Candle | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showOverlays, setShowOverlays] = useState(true);
  const [priceDir, setPriceDir] = useState<'up' | 'down' | null>(null);
  const prevPriceRef = useRef<number | null>(null);

  const lastCandleTime = ws.candles.length > 0 ? ws.candles[ws.candles.length - 1].time : null;
  const countdown = useCandleCountdown(ws.granularitySec, lastCandleTime);

  // A brief directional tint on the live price — never a fake move, just a colour hint.
  useEffect(() => {
    const price = ws.livePrice;
    if (price === null) return;
    const prev = prevPriceRef.current;
    prevPriceRef.current = price;
    if (prev === null || price === prev) return;
    setPriceDir(price > prev ? 'up' : 'down');
    const id = setTimeout(() => setPriceDir(null), 320);
    return () => clearTimeout(id);
  }, [ws.livePrice]);

  const levels = useMemo(() => {
    const managed =
      ws.managedSignals.find(
        (m) => m.symbol === ws.selectedSymbol && m.timeframe === ws.timeframe
      ) ?? null;
    // When a setup is open in Chart Analysis, draw the entry model the Entry Model AI chose
    // for it (watching zone / entry / stop / targets) so the chart matches the panel.
    const origin = ws.chartAnalysisSetup;
    const entryModel = origin
      ? ws.entryModelAI.decisions.find(
          (d) => d.symbol === origin.symbol && d.direction === origin.direction
        ) ?? null
      : null;
    return deriveSignalLevels({
      report: ws.report,
      snapshot: ws.pendingSnapshot,
      managed,
      feedItem: null,
      entryModel,
    });
  }, [
    ws.managedSignals,
    ws.report,
    ws.pendingSnapshot,
    ws.selectedSymbol,
    ws.timeframe,
    ws.chartAnalysisSetup,
    ws.entryModelAI.decisions,
  ]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  const readout = useMemo(() => {
    if (hovered) {
      const last = ws.candles[ws.candles.length - 1];
      return buildCrosshairReadout(hovered, Boolean(last && hovered.time === last.time));
    }
    if (ws.candles.length > 0) return buildCrosshairReadout(ws.candles[ws.candles.length - 1], true);
    return null;
  }, [hovered, ws.candles]);

  const overlayPrefs = showOverlays ? ws.settings.overlays : null;
  const priceUp = readout ? readout.change >= 0 : true;
  const priceTone =
    priceDir === 'up' ? 'text-[#089981]' : priceDir === 'down' ? 'text-[#f23645]' : 'text-ink';

  return (
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0 bg-surface">
      {/* Toolbar */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-2 sm:px-3 py-2 border-b border-line bg-nav">
        {fullScreen && onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to overview"
            className="inline-flex items-center gap-1.5 h-9 px-2.5 text-xs font-semibold text-ink bg-surface border border-line rounded-lg hover:border-accent/50 active:scale-[0.98] transition-all duration-150 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Back</span>
          </button>
        )}
        <VolatilitySelector
          markets={ws.markets}
          marketsLoading={ws.marketsLoading}
          selectedSymbol={ws.selectedSymbol}
          selectedMarket={ws.selectedMarket}
          onSelect={ws.selectMarket}
        />

        <div
          className="inline-flex max-w-full flex-wrap items-center gap-0.5 p-0.5 bg-elevated border border-line rounded-lg"
          role="group"
          aria-label="Timeframe"
        >
          {TIMEFRAMES.map((tf) => {
            const active = tf.key === ws.timeframe;
            return (
              <button
                key={tf.key}
                type="button"
                onClick={() => ws.selectTimeframe(tf.key)}
                aria-pressed={active}
                className={`min-h-[30px] min-w-[34px] px-2 text-xs font-semibold rounded-md transition-colors duration-150 cursor-pointer ${
                  active ? 'bg-accent text-white' : 'text-muted hover:text-ink hover:bg-panel'
                }`}
              >
                {tf.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={ws.startAnalysis}
          disabled={!ws.canRunAnalysis || ws.isAnalyzing}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-white bg-accent rounded-lg hover:bg-accent-soft active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 cursor-pointer"
        >
          {ws.isAnalyzing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
          )}
          {ws.isAnalyzing ? 'Analysing' : 'Run analysis'}
        </button>
        <button
          type="button"
          onClick={ws.resumeAnalysis}
          disabled={!ws.canRunAnalysis}
          title="Refresh analysis with fresh candles"
          className="inline-flex items-center gap-1.5 h-9 px-2.5 text-xs font-semibold text-ink bg-surface border border-line rounded-lg hover:border-accent/50 active:scale-[0.98] disabled:opacity-50 transition-all duration-150 cursor-pointer"
        >
          <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Refresh</span>
        </button>
        {ws.controlMode !== 'idle' && (
          <button
            type="button"
            onClick={ws.stopAnalysis}
            className="inline-flex items-center gap-1.5 h-9 px-2.5 text-xs font-semibold text-bear bg-red-500/10 border border-red-500/30 rounded-lg hover:bg-red-500/15 transition-colors duration-150 cursor-pointer"
          >
            <Square className="w-3 h-3 fill-current" aria-hidden="true" />
            <span className="hidden sm:inline">Stop</span>
          </button>
        )}

        <div className="hidden sm:inline-flex items-center gap-0.5 p-0.5 bg-elevated border border-line rounded-lg">
          <button
            type="button"
            onClick={() => chartRef.current?.zoomIn()}
            aria-label="Zoom in"
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted hover:text-ink hover:bg-panel transition-colors cursor-pointer"
          >
            <ZoomIn className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => chartRef.current?.zoomOut()}
            aria-label="Zoom out"
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted hover:text-ink hover:bg-panel transition-colors cursor-pointer"
          >
            <ZoomOut className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => chartRef.current?.scrollToRealTime()}
            aria-label="Jump to latest candle"
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted hover:text-ink hover:bg-panel transition-colors cursor-pointer"
          >
            <Navigation className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowOverlays((v) => !v)}
            aria-pressed={showOverlays}
            title="Toggle AI chart overlays"
            className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
              showOverlays
                ? 'bg-accent/10 text-accent border-accent/30'
                : 'bg-surface text-muted border-line hover:text-ink'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${showOverlays ? 'bg-accent' : 'bg-faint'}`} />
            <span className="hidden sm:inline">AI overlays</span>
          </button>
          {panelToggle && !fullScreen && (
            <button
              type="button"
              onClick={panelToggle.onToggle}
              className="xl:hidden inline-flex items-center gap-1 h-8 px-2.5 text-xs font-semibold text-ink bg-surface border border-line rounded-lg cursor-pointer"
            >
              AI
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform duration-200 ${panelToggle.open ? 'rotate-180' : ''}`}
              />
            </button>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-surface border border-line text-muted hover:text-ink transition-colors cursor-pointer"
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="w-4 h-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Readout strip */}
      <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 sm:px-3 py-1.5 bg-surface border-b border-line text-[13px] tabular-nums">
        <span className="font-semibold text-ink">{ws.marketName}</span>
        <span className="text-faint">{ws.timeframe}</span>
        {ws.livePrice !== null && (
          <span className={`font-bold text-[16px] sm:text-[18px] transition-colors duration-300 ${priceTone}`}>
            {ws.livePrice.toFixed(ws.precision)}
          </span>
        )}
        {readout && (
          <>
            <span className="text-muted">
              O <span className="text-ink">{readout.open.toFixed(ws.precision)}</span>
            </span>
            <span className="text-muted">
              H <span className="text-ink">{readout.high.toFixed(ws.precision)}</span>
            </span>
            <span className="text-muted">
              L <span className="text-ink">{readout.low.toFixed(ws.precision)}</span>
            </span>
            <span className="text-muted">
              C <span className={priceUp ? 'text-[#089981]' : 'text-[#f23645]'}>{readout.close.toFixed(ws.precision)}</span>
            </span>
            <span className={`${priceUp ? 'text-[#089981]' : 'text-[#f23645]'}`}>
              {readout.change >= 0 ? '+' : ''}
              {readout.change.toFixed(ws.precision)} ({readout.changePercent.toFixed(2)}%)
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-3 text-faint">
          <span title="Time until the current candle closes" className="tabular-nums">
            next {countdown}
          </span>
          <span>{ws.candles.length} bars</span>
        </span>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-[280px] relative bg-[#FFFFFF] flex">
        <CandlestickChart
          ref={chartRef}
          dataset={ws.dataset}
          marketName={ws.marketName}
          timeframeLabel={ws.timeframe}
          granularitySec={ws.granularitySec}
          precision={ws.precision}
          liveTick={ws.liveTick}
          loadState={ws.loadState}
          connectionStatus={ws.connectionStatus}
          errorMessage={ws.dataError ?? ws.connectionError?.message ?? null}
          overlays={ws.report?.overlays ?? null}
          overlayPrefs={overlayPrefs}
          snapshot={ws.pendingSnapshot}
          signalLevels={levels}
          aiOverlay={moduleOverlay?.aiOverlay ?? null}
          trendlineOverlay={moduleOverlay?.trendlineOverlay ?? null}
          dsOverlay={moduleOverlay?.dsOverlay ?? null}
          structureOverlay={moduleOverlay?.structureOverlay ?? null}
          onAiZoneSelect={moduleOverlay?.onAiZoneSelect}
          onDsZoneSelect={moduleOverlay?.onDsZoneSelect}
          onStructureZoneSelect={moduleOverlay?.onStructureZoneSelect}
          dark={false}
          onReconnect={ws.reconnect}
          onCrosshairChange={setHovered}
          onNeedOlderCandles={ws.loadOlderCandles}
        />
      </div>
    </div>
  );
}
