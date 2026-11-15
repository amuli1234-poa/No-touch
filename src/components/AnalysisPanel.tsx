import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  Layers,
  Play,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type {
  AnalysisControlMode,
  AnalysisRunState,
  FullAnalysisReport,
  MarketDirection,
} from '../types/analysis';
import type { ConnectionStatus, MarketFamily, TimeframeKey } from '../types/market';
import { formatCandleTime, formatPrice } from '../utils/derivParser';

import { CoAnalysisPanel } from './CoAnalysisPanel';
import { AnalysisNarrativePanel } from './AnalysisNarrativePanel';

interface AnalysisPanelProps {
  marketName: string;
  symbol: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  precision: number;
  livePrice: number | null;
  connectionStatus: ConnectionStatus;
  controlMode: AnalysisControlMode;
  runState: AnalysisRunState;
  report: FullAnalysisReport | null;
  isAnalyzing: boolean;
  analysisError: string | null;
  canRunAnalysis: boolean;
  onRunAnalysis: () => void;
  /** Records the confirmed setup into the model-performance ledger. */
  onRecordSignal: (params: { direction: 'RISE' | 'FALL'; entryPrice: number }) => void;
}

const TOP_DOWN_TFS: readonly TimeframeKey[] = ['H4', 'H1', 'M15', 'M5', 'M1'];

function directionColorClass(dir: MarketDirection): string {
  if (dir === 'BULLISH') return 'text-emerald-400';
  if (dir === 'BEARISH') return 'text-bear';
  return 'text-muted';
}

function runStateAccent(state: AnalysisRunState): string {
  switch (state) {
    case 'VALID RISE SETUP':
      return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-400';
    case 'VALID FALL SETUP':
      return 'border-red-500/30 bg-red-500/12 text-bear';
    case 'SETUP INVALIDATED':
      return 'border-amber-500/30 bg-amber-500/10 text-warn';
    case 'ANALYZING MARKET':
      return 'border-accent/30 bg-accent/10 text-accent';
    default:
      return 'border-line bg-panel text-muted';
  }
}

function qualityTierStyle(tier: string): string {
  if (tier === 'EXCEPTIONAL') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  if (tier === 'HIGH_QUALITY') return 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30';
  if (tier === 'DEVELOPING') return 'bg-amber-500/12 text-warn border-amber-500/30';
  return 'bg-elevated text-muted border-line';
}

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px]">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-ink">
          {value}/{max}
        </span>
      </div>
      <div className="h-1 rounded-full bg-line overflow-hidden">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AnalysisPanel({
  marketName,
  symbol,
  marketFamily,
  timeframe,
  precision,
  livePrice,
  connectionStatus,
  controlMode,
  runState,
  report,
  isAnalyzing,
  analysisError,
  canRunAnalysis,
  onRunAnalysis,
  onRecordSignal,
}: AnalysisPanelProps) {
  const signal = report?.overlays.signal ?? null;

  return (
    <aside
      aria-label="AI Analysis Panel"
      data-testid="ai-analysis-panel"
      className="w-full lg:w-[400px] xl:w-[430px] shrink-0 border-t lg:border-t-0 lg:border-l border-line bg-surface flex flex-col min-h-0 lg:h-full overflow-y-auto"
    >
      <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-2 bg-panel sticky top-0 z-10">
        <div className="min-w-0">
          <h2 className="text-xs font-bold uppercase tracking-wider text-ink">
            Price-Action Setup Analyser
          </h2>
          <p className="text-[11px] text-faint truncate">
            {marketName} ({symbol}) · {marketFamily} · {timeframe}
          </p>
        </div>
        <span
          data-testid="analysis-state-badge"
          className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide rounded border whitespace-nowrap shrink-0 ${runStateAccent(
            runState
          )}`}
        >
          {runState}
        </span>
      </div>

      <div className="p-4 space-y-4 text-xs text-muted">
        <AnalysisNarrativePanel />

        <CoAnalysisPanel />

        {/* Analysis scope strip — describes the chart hierarchy, not a contract horizon */}
        {report && (
          <div className="bg-panel border border-line rounded-lg px-3 py-2 flex flex-col gap-0.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="font-bold text-ink uppercase tracking-wide text-[10px]">
                Chart Hierarchy
              </span>
              <span className="font-mono font-bold text-ink">
                {report.multiTimeframe.macroTf} → {report.multiTimeframe.structuralTf} →{' '}
                {report.multiTimeframe.setupTf} → {report.multiTimeframe.entryTf}
              </span>
            </div>
            <span className="text-faint text-[10px]">{report.multiTimeframe.rationale}</span>
          </div>
        )}

        {analysisError && (
          <div
            role="alert"
            className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-warn"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{analysisError}</span>
          </div>
        )}

        {!report && controlMode === 'idle' && (
          <div
            data-testid="analysis-ready-card"
            className="border border-line rounded-lg p-4 space-y-3 bg-panel"
          >
            <div className="flex items-center gap-2 text-ink font-semibold">
              <Layers className="w-4 h-4 text-muted shrink-0" aria-hidden="true" />
              <span>Ready for Price-Action Setup Analysis</span>
            </div>
            <p className="text-muted leading-relaxed">
              Analyses <span className="font-semibold text-ink">{symbol}</span> ({marketFamily})
              across the chart hierarchy with <strong>8 entry models</strong> and a 100-point
              technical quality score.
            </p>
            <button
              type="button"
              onClick={onRunAnalysis}
              disabled={!canRunAnalysis}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-app bg-accent rounded-md hover:bg-elevated disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              <span>RUN ANALYSIS</span>
            </button>
          </div>
        )}

        {!report && controlMode !== 'idle' && (
          <div className="border border-line rounded-lg p-4 space-y-2 bg-panel">
            <div className="font-semibold text-ink">
              {isAnalyzing ? 'Analysing Price Action...' : runState}
            </div>
            <p className="text-muted">
              Fetching multi-timeframe candles from Deriv for {marketName}…
            </p>
          </div>
        )}

        {report && (
          <>
            {signal ? (
              <section
                data-testid="trade-signal-card"
                aria-label="Confirmed Signal Card"
                className={`rounded-xl border-2 p-3.5 space-y-3 ${
                  signal.direction === 'RISE'
                    ? 'border-emerald-500/30 bg-emerald-500/12'
                    : 'border-red-500/30 bg-red-500/12'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {signal.direction === 'RISE' ? (
                      <ArrowUpRight className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                    ) : (
                      <ArrowDownRight className="w-4 h-4 text-bear shrink-0" aria-hidden="true" />
                    )}
                    <span
                      className={`text-sm font-bold tracking-tight ${
                        signal.direction === 'RISE' ? 'text-emerald-400' : 'text-bear'
                      }`}
                    >
                      {signal.direction === 'RISE' ? 'BUY RISE' : 'BUY FALL'}
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-bold">
                      {signal.state.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <span
                    className={`font-mono tabular-nums text-[11px] font-bold px-2 py-0.5 rounded border ${qualityTierStyle(
                      signal.quality.tier
                    )}`}
                  >
                    {signal.quality.total}/100
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 bg-surface/95 rounded-lg p-2.5 border border-line/90 font-mono tabular-nums">
                  <div>
                    <div className="text-[10px] uppercase text-faint font-sans font-medium">
                      Entry Reference
                    </div>
                    <div className="text-xs font-bold text-accent">
                      {formatPrice(signal.entryPrice, precision)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-faint font-sans font-medium">
                      Structural Level
                    </div>
                    <div className="text-xs font-bold text-ink">
                      {formatPrice(signal.structuralLevelPrice, precision)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-faint font-sans font-medium">
                      Target Reference (TP1 / TP2)
                    </div>
                    <div className="text-xs font-bold text-emerald-400">
                      {formatPrice(signal.takeProfit1, precision)} /{' '}
                      {formatPrice(signal.takeProfit2, precision)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-faint font-sans font-medium">
                      Technical Invalidation
                    </div>
                    <div className="text-xs font-bold text-bear">
                      {formatPrice(signal.invalidationPrice, precision)}
                    </div>
                  </div>
                </div>

                <div className="space-y-1 text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="text-faint font-medium">Entry Model:</span>
                    <span className="font-semibold text-ink text-right">{signal.modelLabel}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-faint font-medium">Market Condition:</span>
                    <span className="font-semibold text-ink text-right">
                      {signal.condition.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {signal.retestPrice !== null && (
                    <div className="flex justify-between gap-2">
                      <span className="text-faint font-medium">Retest / Rejection:</span>
                      <span className="font-mono font-semibold text-ink">
                        {formatPrice(signal.retestPrice, precision)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between gap-2">
                    <span className="text-faint font-medium">Risk : Reward:</span>
                    <span className="font-mono font-semibold text-ink">
                      1:{signal.riskRewardRatio}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-faint font-medium">Available Space:</span>
                    <span className="font-mono font-semibold text-ink">
                      {signal.availableSpaceLabel}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-faint font-medium">Live Feed Status:</span>
                    <span className="font-mono font-semibold text-emerald-400 uppercase">
                      {connectionStatus}
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5 pt-0.5">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-muted">
                    Technical Quality Breakdown
                  </div>
                  <ScoreBar label="Structure" value={signal.quality.structure} max={20} />
                  <ScoreBar label="Level / Zone" value={signal.quality.levelZone} max={20} />
                  <ScoreBar
                    label="Entry Confirmation"
                    value={signal.quality.entryConfirmation}
                    max={25}
                  />
                  <ScoreBar label="Momentum" value={signal.quality.momentum} max={15} />
                  <ScoreBar
                    label="Multi-Timeframe"
                    value={signal.quality.multiTimeframe}
                    max={10}
                  />
                  <ScoreBar
                    label="Available Space"
                    value={signal.quality.availableSpace}
                    max={10}
                  />
                </div>

                <p className="text-[11px] text-ink/90 leading-relaxed">
                  {signal.confirmationExplanation}
                </p>

                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="record-signal-button"
                    onClick={() => {
                      const entry = livePrice ?? signal.entryPrice;
                      onRecordSignal({ direction: signal.direction, entryPrice: entry });
                    }}
                    className="flex-1 py-2 bg-accent hover:bg-accent-soft text-app font-semibold text-xs rounded-lg transition flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    RECORD SETUP TO HISTORY
                  </button>
                </div>

                <div className="bg-surface/85 p-2 rounded border border-line text-[10px] text-muted leading-relaxed">
                  <strong>Execution Disclaimer:</strong> Targets and invalidation are technical
                  price-action references. This scanner identifies where and when price offers a
                  high-quality Rise or Fall entry — it does not prescribe a holding period.
                </div>
              </section>
            ) : (
              <section
                data-testid="wait-signal-card"
                aria-label="Wait Status Card"
                className="rounded-xl border border-line bg-panel p-3.5 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs sm:text-sm font-bold text-ink">
                    {report.runState === 'SETUP INVALIDATED'
                      ? 'SETUP INVALIDATED — WAIT'
                      : 'NO HIGH-QUALITY SETUP — WAITING FOR CONFIRMATION'}
                  </span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-accent text-app font-bold shrink-0">
                    {report.signalStatus}
                  </span>
                </div>
                <p className="text-muted leading-relaxed">{report.entryTriggerText}</p>
                <p className="text-[11px] text-faint">{report.invalidationText}</p>
                {report.developingCandidate && (
                  <div className="mt-1 pt-2 border-t border-line-soft space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-ink">
                        Best developing candidate
                      </span>
                      <span className="font-mono text-[11px] font-bold text-warn">
                        {report.developingCandidate.score}/100
                      </span>
                    </div>
                    <div className="text-[11px] text-muted">
                      {report.developingCandidate.modelLabel} ·{' '}
                      {report.developingCandidate.direction} ·{' '}
                      {report.developingCandidate.condition.replace(/_/g, ' ')}
                    </div>
                    <p className="text-[11px] text-faint">
                      {report.developingCandidate.confirmationExplanation}
                    </p>
                    <p className="text-[10px] text-faint">
                      Below the 85-point publication gate — shown for transparency, not tradeable.
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* Market condition classification */}
            <section className="space-y-1.5 border border-line rounded-lg p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink">
                  Market Condition
                </h3>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-elevated text-ink">
                  {report.marketCondition.replace(/_/g, ' ')}
                </span>
              </div>
              <p className="text-[11px] text-muted">{report.conditionExplanation}</p>
              {report.overlays.range && (
                <div className="mt-1.5 rounded-md border border-line-soft bg-elevated/60 p-2 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-faint">
                      M15 Sideways Range
                    </span>
                    <span
                      className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                        report.overlays.range.valid ? 'text-bull' : 'text-faint'
                      }`}
                    >
                      {report.overlays.range.valid
                        ? `VALID · PRICE IN ${report.overlays.range.zone}`
                        : 'INVALID'}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                    <div>
                      <div className="text-bear">RESISTANCE</div>
                      <div className="text-ink">
                        {formatPrice(report.overlays.range.resistance, report.precision)}
                      </div>
                    </div>
                    <div>
                      <div className="text-faint">EQUILIBRIUM</div>
                      <div className="text-ink">
                        {formatPrice(report.overlays.range.equilibrium, report.precision)}
                      </div>
                    </div>
                    <div>
                      <div className="text-bull">SUPPORT</div>
                      <div className="text-ink">
                        {formatPrice(report.overlays.range.support, report.precision)}
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted">
                    Upper 25% = resistance area (FALL only) · middle 50% = no trade · lower 25%
                    = support area (RISE only).
                  </p>
                  {!report.overlays.range.valid && report.overlays.range.reason && (
                    <p className="text-[10px] text-faint">{report.overlays.range.reason}</p>
                  )}
                </div>
              )}
            </section>

            {/* Model evaluation table — every model assessed for the current condition */}
            <section className="space-y-1.5 border border-line rounded-lg p-3">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink">
                Entry-Model Evaluation
              </h3>
              <div className="divide-y divide-line-soft">
                {report.evaluatedModels.map((m) => (
                  <div key={m.model} className="py-1.5 flex items-center gap-2 text-[11px]">
                    <span className="w-7 shrink-0 font-mono font-bold text-ink text-center">
                      #{m.model.match(/MODEL_(\d+)/)?.[1] ?? '?'}
                    </span>
                    <span className="flex-1 truncate text-muted" title={m.modelLabel}>
                      {m.modelLabel.replace(/^Model \d+ — /, '')}
                    </span>
                    <span
                      className={`font-mono shrink-0 ${
                        m.qualified ? 'text-emerald-400 font-bold' : 'text-faint'
                      }`}
                    >
                      {m.score}/100
                    </span>
                    <span
                      className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${
                        m.qualified
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-elevated text-muted'
                      }`}
                    >
                      {m.qualified ? 'Confirmed' : 'Rejected'}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {report.liquiditySweeps.length > 0 && (
              <section className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-warn font-bold text-[11px]">
                  <Sparkles className="w-3.5 h-3.5 text-warn" />
                  <span>Liquidity Sweep Detected</span>
                </div>
                {report.liquiditySweeps.map((sw) => (
                  <p key={sw.id} className="text-[11px] text-warn">
                    {sw.reason}
                  </p>
                ))}
              </section>
            )}

            <section className="space-y-1.5 border border-line rounded-lg p-3">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink">
                {signal ? 'Qualification Evidence' : 'Why Waiting'}
              </h3>
              <ul className="space-y-1 text-muted list-disc pl-4">
                {report.whyThisSetup.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              {report.htfConflictNote && (
                <div className="mt-2 flex items-start gap-1.5 p-2 rounded bg-amber-500/10 border border-amber-500/30 text-warn text-[11px]">
                  <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{report.htfConflictNote}</span>
                </div>
              )}
            </section>

            {/* Structure, momentum and optional indicators */}
            <section className="space-y-2 border border-line rounded-lg p-3">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink">
                  Structure &amp; Momentum
                </h3>
                <span className="font-mono text-[10px] text-faint whitespace-nowrap">
                  {formatCandleTime(report.confirmedBarTime)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded bg-panel border border-line-soft">
                  <div className="text-[10px] text-faint uppercase">Directional Bias</div>
                  <div
                    className={`font-bold flex items-center gap-1 mt-0.5 ${directionColorClass(
                      report.overallDirection
                    )}`}
                  >
                    {report.overallDirection === 'BULLISH' && (
                      <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    {report.overallDirection === 'BEARISH' && (
                      <TrendingDown className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>{report.overallDirection}</span>
                  </div>
                </div>
                <div className="p-2 rounded bg-panel border border-line-soft">
                  <div className="text-[10px] text-faint uppercase">Setup Quality</div>
                  <div className="font-bold text-ink mt-0.5">{report.setupQuality}</div>
                </div>
              </div>

              <div className="space-y-1 pt-1">
                <div className="flex justify-between gap-2">
                  <span className="text-faint">Current Structure ({timeframe})</span>
                  <span className="font-semibold text-ink text-right">
                    {report.currentStructureSummary}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-faint">Directional Efficiency</span>
                  <span className="font-mono font-semibold text-ink">
                    {report.momentum.directionalEfficiency}
                  </span>
                </div>
                <p className="text-[11px] text-muted pt-0.5">{report.momentum.summary}</p>
              </div>

              {report.indicators.notes.length > 0 && (
                <div className="pt-1 space-y-1">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-muted">
                    Optional Indicator Confirmation
                  </div>
                  {report.indicators.notes.map((n, i) => (
                    <p key={i} className="text-[11px] text-faint">
                      {n}
                    </p>
                  ))}
                </div>
              )}
            </section>

            {/* Top-down hierarchy */}
            <section className="space-y-2 border border-line rounded-lg p-3">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink">
                Top-Down Hierarchy ({report.multiTimeframe.macroTf} →{' '}
                {report.multiTimeframe.structuralTf} → {report.multiTimeframe.setupTf})
              </h3>
              <div className="divide-y divide-line-soft">
                {TOP_DOWN_TFS.map((tf) => {
                  const summary = report.topDownSummaries[tf];
                  return (
                    <div
                      key={tf}
                      className="py-1.5 flex items-center justify-between gap-2 text-[11px]"
                    >
                      <span className="font-mono font-bold text-ink w-9 shrink-0">{tf}</span>
                      <span className="text-muted truncate flex-1">
                        {summary ? summary.structureLabel : 'Awaiting candles'}
                      </span>
                      <span
                        className={`font-bold shrink-0 ${
                          summary ? directionColorClass(summary.direction) : 'text-faint'
                        }`}
                      >
                        {summary ? summary.direction : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Structural + multi-timeframe agreement summary */}
            <section className="space-y-2 border border-line rounded-lg p-3">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-ink flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-muted" aria-hidden="true" />
                <span>Structural Evidence Summary</span>
              </h3>
              <p className="text-[11px] text-muted leading-snug">
                {report.htfAlignmentSummary}
              </p>
              <p className="text-[11px] text-faint leading-snug">
                Confluence factors describe structural and momentum agreement only. A setup stays
                valid while its structure holds and is invalidated when its level breaks.
              </p>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
