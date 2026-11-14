import React, { useEffect, useMemo, useState } from 'react';
import { CandlestickChart, PanelRightOpen, X } from 'lucide-react';
import type {
  ActiveSymbol,
  Candle,
  OpportunitySignal,
  Timeframe,
  WhatsAppProviderStatus
} from '../../types/scanner';
import { formatPrice } from '../ui/format';
import { ChartStructureEngine } from '../../engines/ChartStructureEngine';
import { TradingChart, type ChartKind, type ChartLevel } from './TradingChart';
import { buildOverlays, type OverlayPreferences, type OverlayShape } from './chartOverlays';
import { OverlayLegend } from './OverlayLegend';
import { ChartToolbar } from '../controls/ChartToolbar';
import { ScannerSummary } from '../views/ScannerSummary';
import { AnalysisPanel } from '../analysis/AnalysisPanel';
import { useOverlayPreferences } from '../../lib/overlayPreferences';
import type { AnalysisRunner } from '../../features/analysis/useAnalysisRunner';
import type { DrawingState } from '../../features/drawing-management/DrawingStore';

/**
 * The institutional workspace: a dominant chart with a fixed right analysis
 * panel.
 *
 * Layout intent (desktop): the chart takes ~72–78% of the workspace width and
 * the analysis panel a fixed ~340–360px, so the chart is always the primary
 * element. Below `xl` the panel becomes a slide-over drawer with a backdrop,
 * keeping the chart full-width and the analysis action one tap away.
 *
 * All market data is owned by `App.tsx`; this component holds only view state.
 */

interface TradingWorkspaceProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  selectedTimeframe: Timeframe;
  onSelectTimeframe: (tf: Timeframe) => void;
  candles: Candle[];
  availableTimeframes: ReadonlySet<Timeframe>;
  activeSymbolInfo?: ActiveSymbol;
  activeOpp?: OpportunitySignal;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  waStatus: WhatsAppProviderStatus;
  alertsAutoSend: boolean;
  onOpenAnalysis: () => void;
  /** Drawing layer. */
  drawings: DrawingState & { shapes: (symbol: string, timeframe?: string) => OverlayShape[] };
  onToggleDrawings: () => void;
  onClearDrawings: () => void;
  /** Analysis runner (owned by App so results outlive route changes). */
  runner: AnalysisRunner;
}

export const TradingWorkspace: React.FC<TradingWorkspaceProps> = ({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  selectedTimeframe,
  onSelectTimeframe,
  candles,
  availableTimeframes,
  activeSymbolInfo,
  activeOpp,
  connectionState,
  onOpenAnalysis,
  drawings,
  onToggleDrawings,
  onClearDrawings,
  runner
}) => {
  const [chartKind, setChartKind] = useState<ChartKind>('candles');
  const [overlayPrefs, setOverlayPrefs] = useOverlayPreferences();
  const [overlaysVisible, setOverlaysVisible] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [chartHeight, setChartHeight] = useState(460);

  // The chart is the dominant element, so give it more height on wider screens.
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w < 640) setChartHeight(Math.max(280, Math.round(h * 0.42)));
      else if (w < 1280) setChartHeight(420);
      else setChartHeight(Math.max(420, Math.min(620, Math.round(h * 0.62))));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const digits = (activeSymbolInfo?.pipSize ?? 0.01) < 0.01 ? 3 : 2;

  const structure = useMemo(
    () => ChartStructureEngine.derive(candles, selectedTimeframe),
    [candles, selectedTimeframe]
  );

  const overlayAvailability = useMemo<Record<keyof OverlayPreferences, boolean>>(
    () => ({
      showSupportResistance: structure.supportZones.length + structure.resistanceZones.length > 0,
      showSupplyDemand: [...structure.supportZones, ...structure.resistanceZones].some(
        (z) => !z.isFlip && (z.hasBaseFormation || z.causedDisplacement)
      ),
      showTrendlines: structure.trendlines.length > 0,
      showProtectedSwings: Boolean(structure.protectedHigh || structure.protectedLow),
      showChartPatterns: Boolean(structure.confirmedPattern),
      showBreakoutLevels:
        Boolean(activeOpp?.tradingRange.isValid) &&
        activeOpp?.tradingRange.breakoutState !== 'INSIDE_RANGE'
    }),
    [structure, activeOpp]
  );

  // Structure overlays (engine-derived) + drawings (analysis-derived). Drawings
  // are projected straight from the store, never re-derived from candles.
  const overlays = useMemo<OverlayShape[]>(() => {
    const lastEpoch = candles.length > 0 ? candles[candles.length - 1].epoch : 0;
    const structureShapes = overlaysVisible
      ? buildOverlays({ structure, opportunity: activeOpp, preferences: overlayPrefs, lastEpoch })
      : [];
    const drawingShapes = drawings.shapes(selectedSymbol, selectedTimeframe);
    return [...structureShapes, ...drawingShapes];
  }, [structure, activeOpp, overlayPrefs, candles, overlaysVisible, drawings, selectedSymbol, selectedTimeframe]);

  const levels = useMemo<ChartLevel[]>(() => {
    const tp = activeOpp?.entryAndTp;
    if (!tp) return [];
    const out: ChartLevel[] = [];
    if (tp.entryPrice !== undefined) out.push({ price: tp.entryPrice, tone: 'entry', title: 'Entry' });
    if (tp.takeProfit !== undefined) out.push({ price: tp.takeProfit, tone: 'target', title: 'TP1' });
    if (tp.takeProfit2 !== undefined) out.push({ price: tp.takeProfit2, tone: 'target', title: 'TP2' });
    if (tp.invalidationLevel !== undefined)
      out.push({ price: tp.invalidationLevel, tone: 'invalidation', title: 'SL' });
    return out;
  }, [activeOpp]);

  const analysisPanel = (
    <AnalysisPanel
      symbol={selectedSymbol}
      displayName={activeSymbolInfo?.displayName ?? selectedSymbol}
      timeframe={selectedTimeframe}
      activeSymbol={activeSymbolInfo}
      candleCount={candles.length}
      connectionState={connectionState}
      isStale={activeSymbolInfo?.isStale}
      runner={runner}
      drawingCount={drawings.records.length}
      drawingsVisible={drawings.visible}
      onToggleDrawings={onToggleDrawings}
      onClearDrawings={onClearDrawings}
    />
  );

  return (
    <div className="flex items-start gap-3">
      {/* Chart column — dominant region. */}
      <div className="min-w-0 flex-1 space-y-3">
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
          {/* Instrument strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <label className="sr-only" htmlFor="market-select">
                Select market
              </label>
              <select
                id="market-select"
                value={selectedSymbol}
                onChange={(e) => onSelectSymbol(e.target.value)}
                className="h-8 max-w-[220px] rounded-[9px] border border-line bg-surface-deepest px-2 text-[12px] font-semibold text-fg-1 focus:border-accent focus:outline-none"
              >
                {symbols.map((s) => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.displayName}
                    {s.isOpen ? '' : ' (closed)'}
                  </option>
                ))}
              </select>
              <div className="flex items-baseline gap-2">
                <span className="tabular text-[16px] font-bold leading-none text-fg-1">
                  {activeSymbolInfo?.lastQuote ? formatPrice(activeSymbolInfo.lastQuote, digits) : '—'}
                </span>
                <span
                  className={`tabular text-[10.5px] font-semibold ${
                    connectionState === 'CONNECTED' ? 'text-live' : 'text-danger'
                  }`}
                >
                  ● {connectionState === 'CONNECTED' ? 'LIVE' : connectionState}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPanelOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-[9px] border border-line bg-surface-raised px-2.5 py-1.5 text-[11.5px] font-semibold text-fg-2 transition-colors hover:border-line-strong xl:hidden"
              >
                <PanelRightOpen className="h-3.5 w-3.5" />
                Analysis
              </button>
              <button
                onClick={onOpenAnalysis}
                className="hidden items-center gap-1.5 rounded-[9px] border border-line bg-surface-raised px-2.5 py-1.5 text-[11.5px] font-semibold text-fg-2 transition-colors hover:border-line-strong xl:inline-flex"
              >
                <CandlestickChart className="h-3.5 w-3.5" />
                Full breakdown
              </button>
            </div>
          </div>

          <ChartToolbar
            selectedTimeframe={selectedTimeframe}
            onSelectTimeframe={onSelectTimeframe}
            availableTimeframes={availableTimeframes}
            chartKind={chartKind}
            onSelectChartKind={setChartKind}
            onResetChart={() => setResetKey((k) => k + 1)}
            drawingsVisible={drawings.visible}
            onToggleDrawings={onToggleDrawings}
            onClearDrawings={onClearDrawings}
            drawingCount={drawings.records.length}
            overlaysVisible={overlaysVisible}
            onToggleOverlays={() => setOverlaysVisible((v) => !v)}
          />

          <div className="p-2">
            <TradingChart
              candles={candles}
              symbol={selectedSymbol}
              timeframe={selectedTimeframe}
              kind={chartKind}
              priceDigits={digits}
              isStale={activeSymbolInfo?.isStale}
              connectionState={connectionState}
              levels={levels}
              overlays={overlays}
              height={chartHeight}
              resetKey={resetKey}
            />
          </div>

          <div className="border-t border-line-soft px-3 py-1.5">
            <OverlayLegend
              preferences={overlayPrefs}
              onToggle={setOverlayPrefs}
              availability={overlayAvailability}
            />
          </div>
        </div>

        <ScannerSummary
          opportunity={activeOpp}
          lastTickAt={activeSymbolInfo?.lastTickEpoch ? activeSymbolInfo.lastTickEpoch * 1000 : null}
          isStale={activeSymbolInfo?.isStale}
          connectionState={connectionState}
          onOpenAnalysis={onOpenAnalysis}
        />
      </div>

      {/* Right analysis panel — fixed width on desktop, drawer below xl. */}
      <aside className="hidden shrink-0 xl:block xl:w-[340px] 2xl:w-[360px]">
        <div className="sticky top-[64px]">{analysisPanel}</div>
      </aside>

      {/* Mobile slide-over drawer */}
      {panelOpen && (
        <div className="fixed inset-0 z-50 xl:hidden">
          <button
            aria-label="Close analysis panel"
            className="absolute inset-0 bg-app/70 backdrop-blur-[2px]"
            onClick={() => setPanelOpen(false)}
          />
          <div className="absolute right-0 top-0 flex h-full w-full max-w-[380px] flex-col bg-app shadow-[var(--shadow-modal)]">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="text-[12px] font-semibold text-fg-1">Analysis</span>
              <button
                aria-label="Close"
                onClick={() => setPanelOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-line bg-surface-raised text-fg-4 hover:text-fg-1"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">{analysisPanel}</div>
          </div>
        </div>
      )}
    </div>
  );
};
