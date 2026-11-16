import { useMemo, useState } from 'react';
import { Activity, Crosshair, Loader2, Play, RefreshCw } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { AI_TIMEFRAME_KEYS, TIMEFRAME_ROLES } from '../config/deriv';
import { buildWatchZoneExpectation, selectPrimaryWatchZone } from '../analysis/watchZoneExpectation';
import { VolatilitySelector } from './VolatilitySelector';
import { WatchZoneExpectationPanel } from './WatchZoneExpectationPanel';
import { EntryModelPanel } from './EntryModelPanel';
import { AnalyserCyclePanel } from './AnalyserCyclePanel';
import { ModuleChartSlot } from './chart/ModuleChartSlot';
import type { StructureChartOverlay } from './chart/StructureChartPrimitive';
import type { FutureReactionZone } from '../types/structure';

/**
 * CHART ANALYSIS — the dedicated full-screen analysis tab. It uses the ONE shared chart,
 * lets the user pick any supported market (Volatility standard + 1-second, Jump, Step),
 * and runs analysis only on demand. The result is drawn minimally on the chart and
 * explained in a compact watching-zone expectation panel.
 */
export function ChartAnalysisView() {
  const ws = useWorkspace();
  const [selectedZone, setSelectedZone] = useState<FutureReactionZone | null>(null);

  const structureOverlay = useMemo<StructureChartOverlay | null>(() => {
    const s = ws.report?.overlays.structure;
    if (!s || !ws.settings.overlays.structureZones) return null;
    // Fresh watch zones only — never show tested/mitigated zones as fresh opportunities.
    return {
      ...s,
      watchZones: s.watchZones,
      testedZones: [],
      precision: ws.precision,
      showFvg: false,
    };
  }, [ws.report, ws.precision, ws.settings.overlays.structureZones]);

  const expectation = useMemo(() => {
    const structure = ws.report?.overlays.structure ?? null;
    if (!structure) return null;
    const primary = selectPrimaryWatchZone(structure.watchZones);
    if (!primary) return null;
    const opposingLevels = [
      ...structure.srBands.map((b) => (b.upperPrice + b.lowerPrice) / 2),
      ...structure.rejectionZones.map((z) => (z.upperPrice + z.lowerPrice) / 2),
      ...structure.watchZones
        .filter((z) => z.id !== primary.id)
        .map((z) => (z.upperPrice + z.lowerPrice) / 2),
    ];
    return buildWatchZoneExpectation({
      zone: primary,
      overallDirection: ws.report?.overallDirection ?? null,
      atr: ws.report?.intelligence?.atr ?? 0,
      opposingLevels,
    });
  }, [ws.report]);

  const hasRun = ws.runState !== 'READY TO ANALYZE';
  const isRunning = ws.isAnalyzing;
  const origin = ws.chartAnalysisSetup;

  return (
    <>
      <ModuleChartSlot
        structureOverlay={structureOverlay}
        onStructureZoneSelect={setSelectedZone}
      />

      {/* Full-screen chart area: the shared canvas fills the space; this panel is compact. */}
      <div className="flex flex-col h-full min-h-0">
        <div className="shrink-0 px-3 py-2 border-b border-line space-y-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-ink">
              <Crosshair className="w-4 h-4 text-accent" aria-hidden="true" />
              Chart Analysis
            </span>
            <span
              data-testid="chart-analysis-status"
              className={`ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${
                isRunning
                  ? 'bg-accent/10 text-accent border-accent/30'
                  : hasRun
                    ? 'bg-panel text-muted border-line'
                    : 'bg-panel text-faint border-line'
              }`}
            >
              {isRunning && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
              {ws.runState}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <VolatilitySelector
                markets={ws.markets}
                marketsLoading={ws.marketsLoading}
                selectedSymbol={ws.selectedSymbol}
                selectedMarket={ws.selectedMarket}
                onSelect={ws.selectMarket}
              />
            </div>
            <button
              type="button"
              onClick={ws.startAnalysis}
              disabled={!ws.canRunAnalysis || isRunning}
              data-testid="chart-analysis-run"
              className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-accent text-white text-[12px] font-bold hover:bg-accent-soft active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer"
            >
              {isRunning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
              )}
              RUN ANALYSIS
            </button>
          </div>

          <div className="flex items-center gap-1">
            {AI_TIMEFRAME_KEYS.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => ws.selectTimeframe(tf)}
                aria-pressed={ws.timeframe === tf}
                title={TIMEFRAME_ROLES[tf]}
                className={`h-7 px-2.5 rounded-md text-[11px] font-semibold border cursor-pointer ${
                  ws.timeframe === tf
                    ? 'bg-accent text-white border-accent'
                    : 'bg-elevated text-muted border-line hover:text-ink'
                }`}
              >
                {tf}
              </button>
            ))}
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-faint">
              <Activity className="w-3 h-3" aria-hidden="true" />
              {ws.selectedMarket ? ws.marketName : ws.selectedSymbol}
            </span>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          {origin && (
            <div
              data-testid="chart-analysis-origin"
              className="rounded-xl border border-accent/30 bg-accent/8 p-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-accent">
                  Opened from scanner
                </span>
                <button
                  type="button"
                  onClick={ws.clearChartAnalysisSetup}
                  className="ml-auto text-[10px] font-semibold text-faint hover:text-ink cursor-pointer"
                >
                  Clear
                </button>
              </div>
              <p className="mt-1 text-[12px] text-ink leading-snug">
                <span className="font-semibold">{origin.sourceLabel}</span> ·{' '}
                {origin.displayName} {origin.direction} · {origin.modelLabel} ·{' '}
                <span className="tabular-nums">{origin.score}/100</span>
              </p>
              {origin.entryModelLabel && (
                <p className="mt-1 text-[11px] text-muted leading-snug">
                  Entry model selected: <span className="font-semibold text-ink">{origin.entryModelLabel}</span>
                </p>
              )}
            </div>
          )}

          <EntryModelPanel />

          <AnalyserCyclePanel cycle={ws.analyserCycle} />

          <WatchZoneExpectationPanel
            expectation={expectation}
            precision={ws.precision}
            hasRun={hasRun}
          />

          {ws.report?.currentStructureSummary && (
            <div className="rounded-xl border border-line bg-panel p-3">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-ink">
                <RefreshCw className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
                Current market read
              </div>
              <p className="mt-1.5 text-[12px] text-muted leading-snug">
                {ws.report.currentStructureSummary}
              </p>
              {ws.report.conditionExplanation && (
                <p className="mt-1.5 text-[11px] text-faint leading-snug">
                  {ws.report.conditionExplanation}
                </p>
              )}
            </div>
          )}

          {selectedZone && (
            <div className="rounded-xl border border-accent/30 bg-accent/8 p-3">
              <div className="text-[11px] font-bold uppercase tracking-wide text-accent">
                Selected zone
              </div>
              <p className="mt-1 text-[12px] text-muted leading-snug">
                {selectedZone.sourceStructure} · {selectedZone.direction} ·{' '}
                {formatRange(selectedZone.lowerPrice, selectedZone.upperPrice, ws.precision)}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function formatRange(low: number, high: number, precision: number): string {
  const lo = Math.min(low, high).toFixed(precision);
  const hi = Math.max(low, high).toFixed(precision);
  return `${lo} – ${hi}`;
}
