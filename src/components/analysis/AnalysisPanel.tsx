import React from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  MinusCircle,
  Play,
  Square,
  XCircle
} from 'lucide-react';
import type { ActiveSymbol, Timeframe } from '../../types/scanner';
import type { AnalysisResult, AnalysisStage, AnalysisStageStatus } from '../../features/analysis/types';
import type { AnalysisRunner } from '../../features/analysis/useAnalysisRunner';
import { checkPrerequisites } from '../../features/analysis/types';
import { formatPrice } from '../ui/format';
import { Badge, StatusDot } from '../ui/Badge';
import { Button } from '../ui/Controls';
import type { Tone } from '../ui/format';

/**
 * The right-side analysis panel.
 *
 * Every section reflects real state. There is no invented percentage, no engine
 * shown as "complete" unless it actually completed, and no NEXT ZONE section
 * unless a zone was validated — in which case the panel says so explicitly.
 */

interface AnalysisPanelProps {
  symbol: string;
  displayName: string;
  timeframe: Timeframe;
  activeSymbol?: ActiveSymbol;
  candleCount: number;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  isStale?: boolean;
  runner: AnalysisRunner;
  /** Called when the user wants to clear every drawing. */
  onClearDrawings?: () => void;
  drawingCount: number;
  drawingsVisible: boolean;
  onToggleDrawings?: () => void;
}

const STAGE_ICON: Record<AnalysisStageStatus, React.ReactNode> = {
  PENDING: <MinusCircle className="h-3.5 w-3.5 text-fg-6" />,
  RUNNING: <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-strong" />,
  COMPLETED: <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
  FAILED: <XCircle className="h-3.5 w-3.5 text-danger" />,
  SKIPPED: <MinusCircle className="h-3.5 w-3.5 text-fg-6" />
};

const ENGINE_TONE: Record<string, Tone> = {
  PENDING: 'neutral',
  RUNNING: 'info',
  COMPLETED: 'success',
  FAILED: 'danger',
  UNAVAILABLE: 'neutral'
};

function Section({
  title,
  step,
  children,
  right
}: {
  title: string;
  step?: number;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="border-b border-line-soft px-3.5 py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-6">
          {step !== undefined && (
            <span className="tabular flex h-4 w-4 items-center justify-center rounded-[5px] border border-line bg-surface-raised text-[9px] text-fg-4">
              {step}
            </span>
          )}
          {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({
  symbol,
  displayName,
  timeframe,
  activeSymbol,
  candleCount,
  connectionState,
  isStale,
  runner,
  onClearDrawings,
  drawingCount,
  drawingsVisible,
  onToggleDrawings
}) => {
  const prereq = checkPrerequisites({
    connectionState,
    hasSymbol: Boolean(symbol),
    hasTimeframe: Boolean(timeframe),
    candleCount,
    minCandles: 20,
    isStale
  });

  const digits = (activeSymbol?.pipSize ?? 0.01) < 0.01 ? 3 : 2;
  const result = runner.result;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
      {/* 1. RUN ANALYSIS */}
      <Section
        title="Run analysis"
        step={1}
        right={
          <Badge tone={connectionState === 'CONNECTED' ? 'success' : 'danger'}>
            {connectionState === 'CONNECTED' ? 'Live' : connectionState === 'RECONNECTING' ? 'Reconnecting' : 'Offline'}
          </Badge>
        }
      >
        <div className="mb-2 grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-[8px] border border-line-soft bg-surface-deepest px-2.5 py-1.5">
            <div className="text-[9.5px] uppercase tracking-wide text-fg-6">Instrument</div>
            <div className="truncate font-semibold text-fg-1">{displayName || symbol || '—'}</div>
          </div>
          <div className="rounded-[8px] border border-line-soft bg-surface-deepest px-2.5 py-1.5">
            <div className="text-[9.5px] uppercase tracking-wide text-fg-6">Timeframe</div>
            <div className="tabular font-semibold text-fg-1">{timeframe.toUpperCase()}</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            block
            disabled={!prereq.ok || runner.running}
            onClick={runner.run}
            icon={
              runner.running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )
            }
          >
            {runner.running ? 'Running…' : 'Run analysis'}
          </Button>
          {runner.running && (
            <Button variant="secondary" size="sm" onClick={runner.cancel} icon={<Square className="h-3.5 w-3.5" />}>
              Cancel
            </Button>
          )}
        </div>

        {!prereq.ok && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {prereq.reason}
          </p>
        )}
        <p className="mt-2 text-[10.5px] text-fg-6">
          {candleCount} {timeframe.toUpperCase()} candles buffered · informational only, never authorises a trade.
        </p>
      </Section>

      {/* 2. ANALYSIS PROGRESS */}
      <Section title="Analysis progress" step={2}>
        {runner.stages.length === 0 ? (
          <p className="text-[11px] text-fg-6">No run yet. Press Run analysis to begin.</p>
        ) : (
          <ul className="space-y-1.5">
            {runner.stages.map((s: AnalysisStage) => (
              <li key={s.id} className="flex items-start gap-2">
                <span className="mt-[1px]">{STAGE_ICON[s.status]}</span>
                <span className="min-w-0">
                  <span className="block text-[11.5px] font-medium text-fg-2">{s.label}</span>
                  {s.detail && <span className="block text-[10.5px] leading-snug text-fg-5">{s.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 3. ENGINE STATUS */}
      <Section
        title="Engine status"
        step={3}
        right={
          <span className="text-[10px] text-fg-6">
            {result ? `${result.engines.length} engine(s)` : '—'}
          </span>
        }
      >
        {!result ? (
          <p className="text-[11px] text-fg-6">Engine results appear after a run.</p>
        ) : (
          <ul className="space-y-1.5">
            {result.engines.map((e) => (
              <li
                key={e.engineId}
                className="flex items-start justify-between gap-2 rounded-[8px] border border-line-soft bg-surface-deepest px-2.5 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[11.5px] font-medium text-fg-2">{e.engineName}</span>
                  {e.reason && <span className="block text-[10px] text-fg-6">{e.reason}</span>}
                  {e.summary && !e.reason && (
                    <span className="block line-clamp-2 text-[10px] leading-snug text-fg-6">{e.summary}</span>
                  )}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <Badge tone={ENGINE_TONE[e.status] ?? 'neutral'}>{e.status}</Badge>
                  {e.completedAtMs && (
                    <span className="tabular text-[9.5px] text-fg-6">
                      {new Date(e.completedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 4. ANALYSIS RESULT */}
      <Section
        title="Analysis result"
        step={4}
        right={
          result ? (
            <span className="tabular text-[10px] text-fg-6">
              {new Date(result.completedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          ) : undefined
        }
      >
        {!result ? (
          <p className="text-[11px] text-fg-6">No result yet.</p>
        ) : result.status === 'FAILED' ? (
          <div className="flex items-start gap-2 rounded-[8px] border border-danger/30 bg-danger/10 px-2.5 py-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div>
              <div className="text-[12px] font-semibold text-danger">Analysis failed</div>
              <div className="text-[10.5px] text-fg-5">{result.error ?? 'See notes below.'}</div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div
              className={`flex items-center justify-center gap-2 rounded-[10px] border px-3 py-3 ${
                result.direction === 'RISE'
                  ? 'border-rise/40 bg-rise/10'
                  : result.direction === 'FALL'
                    ? 'border-fall/40 bg-fall/10'
                    : 'border-line bg-surface-deepest'
              }`}
            >
              {result.direction === 'RISE' && <CheckCircle2 className="h-4 w-4 text-rise" />}
              {result.direction === 'FALL' && <CheckCircle2 className="h-4 w-4 text-fall" />}
              {result.direction === 'WAIT' && <Clock className="h-4 w-4 text-neutral-signal" />}
              <span
                className={`text-[14px] font-bold tracking-tight ${
                  result.direction === 'RISE'
                    ? 'text-rise'
                    : result.direction === 'FALL'
                      ? 'text-fall'
                      : 'text-neutral-signal'
                }`}
              >
                {result.direction === 'RISE'
                  ? 'POTENTIAL RISE'
                  : result.direction === 'FALL'
                    ? 'POTENTIAL FALL'
                    : 'WAIT / INSUFFICIENT EVIDENCE'}
              </span>
            </div>
            <ul className="space-y-1">
              {result.notes.map((n, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[10.5px] leading-snug text-fg-5">
                  <Activity className="mt-0.5 h-3 w-3 shrink-0 text-fg-6" />
                  {n}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* 5. NEXT ZONE TO WATCH */}
      <Section
        title="Next zone to watch"
        step={5}
        right={
          result?.zone ? (
            <Badge tone={result.zone.direction === 'RISE' ? 'info' : 'danger'}>{result.zone.direction}</Badge>
          ) : undefined
        }
      >
        {!result || !result.zone ? (
          <p className="text-[11px] text-fg-6">No validated zone identified.</p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] font-semibold text-fg-1">
                {result.zone.direction === 'RISE' ? 'Potential Rise' : 'Potential Fall'} zone
              </span>
              <span className="tabular text-[10px] text-fg-6">{result.zone.timeframe.toUpperCase()}</span>
            </div>
            <div className="rounded-[8px] border border-line-soft bg-surface-deepest px-2.5 py-2">
              <div className="text-[9.5px] uppercase tracking-wide text-fg-6">Price range</div>
              <div className="tabular text-[13px] font-semibold text-fg-1">
                {formatPrice(result.zone.lowerPrice, digits)} – {formatPrice(result.zone.upperPrice, digits)}
              </div>
            </div>
            <div>
              <div className="text-[9.5px] uppercase tracking-wide text-fg-6">Reason</div>
              <p className="text-[11px] leading-snug text-fg-3">{result.zone.reason}</p>
            </div>
            {result.zone.evidence.length > 0 && (
              <div>
                <div className="text-[9.5px] uppercase tracking-wide text-fg-6">Evidence</div>
                <ul className="mt-0.5 space-y-0.5">
                  {result.zone.evidence.map((ev, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[10.5px] leading-snug text-fg-4">
                      <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-fg-6" />
                      {ev}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-[8px] border border-line-soft bg-surface-deepest px-2.5 py-1.5">
                <div className="text-[9.5px] uppercase tracking-wide text-fg-6">Confidence</div>
                <div className="text-[11.5px] font-semibold text-fg-4">
                  {result.zone.confidence !== undefined ? `${Math.round(result.zone.confidence * 100)}%` : 'Not produced'}
                </div>
              </div>
              <div className="rounded-[8px] border border-line-soft bg-surface-deepest px-2.5 py-1.5">
                <div className="text-[9.5px] uppercase tracking-wide text-fg-6">Invalidation</div>
                <div className="truncate text-[11.5px] font-semibold text-fg-4">
                  {result.zone.invalidation ?? 'Not defined'}
                </div>
              </div>
            </div>
            <p className="text-[10px] text-fg-6">
              Blue and red mark zone direction, not a forecast. The zone is an annotation of what the
              engine published — it is never drawn without a validated analysis.
            </p>
          </div>
        )}
      </Section>

      {/* Drawing management (operational controls for the drawing layer). */}
      <Section
        title="Drawings"
        right={
          <span className="tabular text-[10px] text-fg-6">{drawingCount} stored</span>
        }
      >
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onToggleDrawings} disabled={!onToggleDrawings}>
            {drawingsVisible ? 'Hide drawings' : 'Show drawings'}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={onClearDrawings}
            disabled={!onClearDrawings || drawingCount === 0}
          >
            Clear all
          </Button>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[10px] text-fg-6">
          <StatusDot tone={drawingsVisible ? 'success' : 'neutral'} />
          {drawingsVisible ? 'Drawing layer visible' : 'Drawing layer hidden'}
        </p>
      </Section>
    </div>
  );
};
