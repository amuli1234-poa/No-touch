import { useMemo, useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import {
  ANALYSIS_STAGE_TONE,
  deriveAnalysisStage,
  stageIndex,
} from '../utils/analysisStages';
import { AnalysisPanel } from './AnalysisPanel';
import { AnalyserCyclePanel } from './AnalyserCyclePanel';
import { MarketIntelligencePanel } from './MarketIntelligencePanel';
import { EngineFindingsPanel } from './EngineFindingsPanel';
import { StructureOpportunitiesPanel } from './StructureOpportunitiesPanel';
import { ModuleChartSlot } from './chart/ModuleChartSlot';
import type { StructureChartOverlay } from './chart/StructureChartPrimitive';
import type { FutureReactionZone } from '../types/structure';

const PIPELINE_STAGES = [
  'CONNECTING',
  'LOADING MARKET DATA',
  'ANALYSING STRUCTURE',
  'CHECKING MOMENTUM',
  'VALIDATING SETUP',
] as const;

function AnalysisStatusPipeline() {
  const ws = useWorkspace();
  const info = deriveAnalysisStage({
    connectionStatus: ws.connectionStatus,
    loadState: ws.loadState,
    isAnalyzing: ws.isAnalyzing,
    report: ws.report,
    hasCandles: ws.candles.length > 0,
    hasRanAnalysis: ws.runState !== 'READY TO ANALYZE',
  });
  const tone = ANALYSIS_STAGE_TONE[info.tone];
  const currentIdx = stageIndex(info.stage);

  return (
    <div data-testid="analysis-pipeline" data-stage={info.stage} className="flex flex-wrap items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold ${tone.bg} ${tone.border} ${tone.text}`}
      >
        {ws.isAnalyzing && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
        <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
        {info.stage}
      </span>
      <div className="flex items-center gap-1" aria-hidden="true">
        {PIPELINE_STAGES.map((stage, idx) => {
          const done = currentIdx > idx || info.stage === 'CONFIRMED' || info.stage === 'WAIT';
          const active = info.stage === stage;
          return (
            <span
              key={stage}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                active ? 'w-6 bg-accent' : done ? 'w-3 bg-accent/50' : 'w-3 bg-line'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * CHART ANALYSER — the right-hand intelligence panel for the ONE shared chart. It publishes
 * its structure overlay into the shared canvas and renders every existing analyser panel. It
 * never creates a second chart.
 */
export function ChartAnalyserView() {
  const ws = useWorkspace();
  const [selectedZone, setSelectedZone] = useState<FutureReactionZone | null>(null);

  const structureOverlay = useMemo<StructureChartOverlay | null>(() => {
    const s = ws.report?.overlays.structure;
    if (!s || !ws.settings.overlays.structureZones) return null;
    const watchZones = ws.settings.overlays.showTestedZones
      ? [...s.watchZones, ...s.testedZones]
      : s.watchZones;
    return {
      ...s,
      watchZones,
      precision: ws.precision,
      showFvg: ws.settings.overlays.fvgZones,
    };
  }, [
    ws.report,
    ws.precision,
    ws.settings.overlays.structureZones,
    ws.settings.overlays.fvgZones,
    ws.settings.overlays.showTestedZones,
  ]);

  return (
    <>
      <ModuleChartSlot structureOverlay={structureOverlay} onStructureZoneSelect={setSelectedZone} />
      <div className="flex flex-col h-full min-h-0">
        <div className="shrink-0 px-3 py-2 border-b border-line space-y-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent">
            <Activity className="w-3.5 h-3.5" aria-hidden="true" />
            Chart Analyser
          </span>
          <AnalysisStatusPipeline />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-3 space-y-3 border-b border-line">
            <AnalyserCyclePanel cycle={ws.analyserCycle} />
            <MarketIntelligencePanel
              intelligence={ws.report?.intelligence ?? null}
              precision={ws.precision}
            />
            <EngineFindingsPanel
              findings={ws.report?.findings ?? null}
              reachability={ws.report?.reachability ?? null}
              falseSignal={ws.report?.falseSignal ?? null}
            />
            <StructureOpportunitiesPanel
              structure={ws.report?.overlays.structure ?? null}
              precision={ws.precision}
              selectedZoneId={selectedZone?.id ?? null}
              onSelectZone={setSelectedZone}
            />
          </div>
          <AnalysisPanelBridge />
        </div>
      </div>
    </>
  );
}

function AnalysisPanelBridge() {
  const ws = useWorkspace();
  return (
    <AnalysisPanel
      marketName={ws.marketName}
      symbol={ws.selectedSymbol}
      marketFamily={ws.marketFamily}
      timeframe={ws.timeframe}
      precision={ws.precision}
      livePrice={ws.livePrice}
      connectionStatus={ws.connectionStatus}
      controlMode={ws.controlMode}
      runState={ws.runState}
      report={ws.report}
      isAnalyzing={ws.isAnalyzing}
      analysisError={ws.analysisError}
      canRunAnalysis={ws.canRunAnalysis}
      onRunAnalysis={ws.startAnalysis}
      onRecordSignal={ws.recordAnalyserSignal}
    />
  );
}
