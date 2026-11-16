import { Brain, Compass, Pin, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { buildAnalysisNarrative, summariseDirection, type NarrativeSection } from '../utils/narrative';

const TONE_STYLE: Record<NarrativeSection['tone'], string> = {
  info: 'border-line-soft bg-panel',
  positive: 'border-emerald-500/25 bg-emerald-500/8',
  caution: 'border-amber-500/25 bg-amber-500/8',
};

function DirectionBadge() {
  const ws = useWorkspace();
  const dir = summariseDirection(ws.report);
  if (!dir) return null;
  const Icon = dir.tone === 'bullish' ? TrendingUp : dir.tone === 'bearish' ? TrendingDown : Minus;
  const cls =
    dir.tone === 'bullish'
      ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
      : dir.tone === 'bearish'
        ? 'bg-red-500/12 text-bear border-red-500/30'
        : 'bg-panel text-muted border-line';

  return (
    <div
      data-testid="market-direction"
      data-tone={dir.tone}
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${cls}`}
    >
      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-xs font-bold uppercase tracking-wide">{dir.label}</div>
        <div className="text-[11px] font-mono text-faint truncate" title={dir.ladder}>
          {dir.ladder}
        </div>
      </div>
    </div>
  );
}

function SnapshotBanner() {
  const ws = useWorkspace();
  const snap = ws.pendingSnapshot;
  if (!snap) return null;
  const isRise = snap.direction === 'RISE';
  return (
    <div
      data-testid="snapshot-banner"
      className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/8 px-3 py-2"
    >
      <Pin className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-bold text-accent uppercase tracking-wide">
          Reproducing scanner signal
        </div>
        <div className="text-[12px] text-muted leading-snug">
          {snap.source === 'CO-ANALYSIS' ? 'Co-analysis' : 'Scanner'} · {snap.displayName}{' '}
          {isRise ? 'RISE' : 'FALL'} · {snap.modelLabel} · {snap.qualityTotal}/100. Chart levels
          show the exact evidence recorded at scan time.
        </div>
      </div>
      <button
        type="button"
        onClick={ws.clearPendingSnapshot}
        className="shrink-0 text-[11px] font-semibold text-faint hover:text-ink cursor-pointer"
      >
        Clear
      </button>
    </div>
  );
}

/**
 * Human-readable analysis narrative: the market direction, the top-down read and
 * the dual-engine reconciliation, all derived strictly from engine output.
 */
export function AnalysisNarrativePanel() {
  const ws = useWorkspace();
  const sections = buildAnalysisNarrative(ws.report, ws.coAnalysis);

  return (
    <div
      data-testid="analysis-narrative"
      className="bg-surface border border-line rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line-soft">
        <Brain className="w-4 h-4 text-accent" aria-hidden="true" />
        <h3 className="text-[13px] font-bold text-ink">AI chart analysis</h3>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-faint">
          <Compass className="w-3 h-3" aria-hidden="true" />
          Top-down
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <SnapshotBanner />
        <DirectionBadge />

        {sections.length === 0 ? (
          <p className="text-xs text-muted leading-relaxed">
            Run the analysis to generate a top-down read of the market direction, structure and
            setup.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {sections.map((section) => (
              <div
                key={section.heading}
                className={`rounded-lg border px-3 py-2 ${TONE_STYLE[section.tone]}`}
              >
                <div className="text-[12px] font-bold text-ink uppercase tracking-wide">
                  {section.heading}
                </div>
                <p className="text-[12px] text-muted leading-relaxed mt-0.5">{section.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
