import { Link2, ShieldCheck, ShieldAlert, GitMerge, Info, Save } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import type { CoAnalysisVerdict } from '../types/signals';

const VERDICT_STYLE: Record<
  CoAnalysisVerdict,
  { label: string; cls: string; icon: typeof ShieldCheck }
> = {
  ALIGNED: {
    label: 'Dual-engine aligned',
    cls: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
    icon: ShieldCheck,
  },
  PARTIAL: {
    label: 'Engines partially aligned',
    cls: 'bg-amber-500/12 text-warn border-amber-500/30',
    icon: GitMerge,
  },
  CONFLICT: {
    label: 'Engine conflict — wait',
    cls: 'bg-red-500/12 text-bear border-red-500/30',
    icon: ShieldAlert,
  },
  SCANNER_ONLY: {
    label: 'Scanner only — unconfirmed',
    cls: 'bg-sky-500/12 text-accent border-sky-500/30',
    icon: Link2,
  },
  ANALYSER_ONLY: {
    label: 'Analyser only — unconfirmed',
    cls: 'bg-sky-500/12 text-accent border-sky-500/30',
    icon: Link2,
  },
  NO_SIGNAL: {
    label: 'No confirmed setup',
    cls: 'bg-panel text-muted border-line',
    icon: Info,
  },
};

function EngineColumn({
  name,
  direction,
  modelLabel,
  confidence,
  highlight,
}: {
  name: string;
  direction: string | null;
  modelLabel: string | null;
  confidence: number | null;
  highlight: boolean;
}) {
  return (
    <div
      className={`flex-1 min-w-[140px] rounded-lg border px-3 py-2 ${
        highlight ? 'border-accent/40 bg-accent/8' : 'border-line-soft bg-panel'
      }`}
    >
      <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{name}</div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span
          className={`text-sm font-bold ${
            direction === 'RISE'
              ? 'text-emerald-400'
              : direction === 'FALL'
                ? 'text-bear'
                : 'text-muted'
          }`}
        >
          {direction ?? 'WAIT'}
        </span>
        {confidence !== null && (
          <span className="text-[10px] font-mono text-faint">{Math.round(confidence)}/100</span>
        )}
      </div>
      <div className="text-[10px] text-muted truncate" title={modelLabel ?? ''}>
        {modelLabel ?? 'No model selected'}
      </div>
    </div>
  );
}

/**
 * Dual-engine co-analysis panel. Shows how the breadth (scanner) and depth
 * (analyser) engines reconcile for the selected instrument, and whether the
 * resulting signal passes shared validation.
 */
export function CoAnalysisPanel() {
  const ws = useWorkspace();
  const co = ws.coAnalysis;
  if (!co) return null;

  const style = VERDICT_STYLE[co.verdict];
  const Icon = style.icon;
  const sDir = co.scannerDirection;
  const aDir = co.analyserDirection;
  const validatedItem = ws.signalFeed.find(
    (i) => i.validated && i.symbol === co.symbol && i.timeframe === co.timeframe
  );

  return (
    <div
      data-testid="co-analysis-panel"
      data-verdict={co.verdict}
      className="bg-surface border border-line rounded-xl overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-line-soft">
        <div className="flex items-center gap-2">
          <GitMerge className="w-4 h-4 text-accent" aria-hidden="true" />
          <h3 className="text-[13px] font-bold text-ink">Dual-engine co-analysis</h3>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-bold uppercase tracking-wide ${style.cls}`}
        >
          <Icon className="w-3 h-3" aria-hidden="true" />
          {style.label}
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="flex flex-wrap gap-2.5">
          <EngineColumn
            name="Scanner · breadth"
            direction={sDir}
            modelLabel={co.scannerModelLabel}
            confidence={co.scannerConfidence}
            highlight={co.validated}
          />
          <EngineColumn
            name="Analyser · depth"
            direction={aDir}
            modelLabel={co.analyserModelLabel}
            confidence={co.analyserConfidence}
            highlight={co.validated}
          />
        </div>

        {co.validated && co.combinedConfidence !== null && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span className="text-xs font-bold text-emerald-400 uppercase tracking-wide">
                Shared validation passed
              </span>
              <span className="text-xs text-muted">
                · combined confidence {co.combinedConfidence}/100
                {co.modelAgreement ? ' · model agreement' : ''}
              </span>
              {ws.playSignalSound && (
                <button
                  type="button"
                  onClick={() => ws.playSignalSound('validated')}
                  className="ml-auto text-[11px] font-semibold text-emerald-400 hover:underline cursor-pointer"
                >
                  Test chime
                </button>
              )}
            </div>
            {validatedItem && (
              <button
                type="button"
                data-testid="record-validated-signal-btn"
                onClick={() => ws.recordValidatedSignal(validatedItem)}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-bold text-app bg-emerald-500 rounded-md hover:bg-emerald-400 transition-colors cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
                RECORD VALIDATED SIGNAL
              </button>
            )}
          </div>
        )}

        {co.notes.length > 0 && (
          <ul className="space-y-1">
            {co.notes.map((n, i) => (
              <li key={i} className="text-[11px] text-muted leading-relaxed flex gap-1.5">
                <span className="text-faint">•</span>
                <span>{n}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
