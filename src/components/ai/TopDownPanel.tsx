import { ArrowDown, ArrowUp, Minus, Network } from 'lucide-react';
import type { TopDownAnalysis, TopDownRead } from '../../types/topDown';
import { topDownDirection } from '../../types/topDown';
import { SectionCard } from '../ui/primitives';

const BIAS_LABEL: Record<TopDownRead['bias'], string> = {
  bullish: 'Bullish',
  bearish: 'Bearish',
  neutral: 'Neutral',
};

const BIAS_CLASS: Record<TopDownRead['bias'], string> = {
  bullish: 'text-emerald-400',
  bearish: 'text-rose-400',
  neutral: 'text-muted',
};

function BiasIcon({ bias }: { bias: TopDownRead['bias'] }) {
  if (bias === 'bullish') return <ArrowUp className="w-3 h-3" aria-hidden="true" />;
  if (bias === 'bearish') return <ArrowDown className="w-3 h-3" aria-hidden="true" />;
  return <Minus className="w-3 h-3" aria-hidden="true" />;
}

const ROLE_LABEL: Record<TopDownRead['role'], string> = {
  MAJOR: 'Major bias',
  INTERMEDIATE: 'Intermediate',
  EXECUTION: 'Execution (M5)',
  REFINEMENT: 'Refinement',
};

/**
 * Shared top-down ten-timeframe ladder panel. Every AI module attaches the SAME
 * `TopDownAnalysis` to its instrument analysis, so this panel shows an identical picture
 * wherever it is rendered — no module re-derives the ladder.
 */
export function TopDownPanel({ analysis }: { analysis: TopDownAnalysis }) {
  const direction = topDownDirection(analysis);
  const groups: TopDownRead['role'][] = ['MAJOR', 'INTERMEDIATE', 'EXECUTION', 'REFINEMENT'];

  return (
    <SectionCard
      title="Top-down ladder"
      subtitle="M30 → M1 · higher timeframes set the bias, M5 executes, the rest refine — never forced to agree"
      icon={<Network className="w-3.5 h-3.5" aria-hidden="true" />}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-faint">Alignment</span>
          <span className="text-sm font-extrabold text-ink">{analysis.alignmentScore}/100</span>
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
              analysis.aligned
                ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/12'
                : 'text-warn border-amber-500/30 bg-amber-500/12'
            }`}
          >
            {analysis.aligned ? 'ALIGNED' : analysis.executionConfirmed ? 'PARTIAL' : 'NO M5 CONFIRMATION'}
          </span>
        </div>
        <span className={`text-[11px] font-bold ${direction === 'RISE' ? 'text-emerald-400' : direction === 'FALL' ? 'text-rose-400' : 'text-muted'}`}>
          {direction === 'RISE' ? 'Entry direction: RISE' : direction === 'FALL' ? 'Entry direction: FALL' : 'No entry authorised'}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        {groups.map((role) => {
          const reads = analysis.reads.filter((r) => r.role === role);
          return (
            <div key={role} className="rounded-lg border border-line bg-panel px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-faint mb-1.5">{ROLE_LABEL[role]}</div>
              {reads.length === 0 ? (
                <p className="text-[11px] text-faint">No timeframe with enough confirmed data.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {reads.map((r) => (
                    <div key={r.timeframe} className="flex items-start gap-2">
                      <span className="text-[10px] font-mono text-faint w-8 shrink-0 pt-0.5">{r.timeframe}</span>
                      <span className={`flex items-center gap-1 text-[11px] font-bold shrink-0 pt-0.5 ${BIAS_CLASS[r.bias]}`}>
                        <BiasIcon bias={r.bias} />
                        {BIAS_LABEL[r.bias]}
                      </span>
                      <span className="text-[11px] text-muted leading-snug min-w-0">{r.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {analysis.contradictions.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-warn mb-1">Timeframe contradictions (surfaced, never hidden)</div>
          <ul className="text-[11px] text-muted leading-snug list-disc pl-4 space-y-0.5">
            {analysis.contradictions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {analysis.insufficient && (
        <p className="text-[11px] text-faint mt-3">
          {analysis.reads.length < 5
            ? 'Not enough confirmed timeframes for a trustworthy top-down read yet — no entry is fabricated from partial data.'
            : 'M5 has not committed to a direction yet — no entry is authorised until the execution timeframe does.'}
        </p>
      )}
    </SectionCard>
  );
}
