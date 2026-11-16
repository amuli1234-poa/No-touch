import { Layers, TrendingDown, TrendingUp, GitBranch } from 'lucide-react';
import type { AiInstrumentAnalysis } from '../../types/aiModule';
import type { AlignmentTimeframeRead, TimeframeAlignmentRead } from '../../types/timeframeAlignment';
import { formatPrice } from '../../utils/derivParser';
import { SectionCard, StatTile, StatusPill } from '../ui/primitives';

/**
 * TIMEFRAME ALIGNMENT AI — module panel.
 *
 * Renders the top-down alignment ladder (major bias → intermediate structure → setup →
 * refinement), the resolved directional read, the pullback/reversal character and the
 * structurally valid trade when the ladder authorises one. The learner hint shows the
 * learned analysis/confirmation timeframes the Timeframe Learner proved for this index.
 */

const CHARACTER_LABELS: Record<string, string> = {
  ALIGNED_CONTINUATION: 'Aligned continuation',
  PULLBACK_IN_TREND: 'Pullback in trend',
  GENUINE_REVERSAL: 'Genuine reversal',
  CONFLICTING: 'Conflicting timeframes',
  NEUTRAL: 'Neutral / undecided',
};

const CHARACTER_STYLE: Record<string, string> = {
  ALIGNED_CONTINUATION: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  PULLBACK_IN_TREND: 'bg-amber-500/12 text-warn border-amber-500/30',
  GENUINE_REVERSAL: 'bg-amber-500/12 text-warn border-amber-500/30',
  CONFLICTING: 'bg-panel text-faint border-line',
  NEUTRAL: 'bg-elevated text-muted border-line',
};

const ROLE_LABELS: Record<string, string> = {
  MAJOR: 'Major bias',
  INTERMEDIATE: 'Intermediate',
  SETUP: 'Setup',
  REFINEMENT: 'Refinement',
};

function biasClass(bias: 'bullish' | 'bearish' | 'neutral'): string {
  if (bias === 'bullish') return 'text-emerald-400';
  if (bias === 'bearish') return 'text-bear';
  return 'text-muted';
}

function LadderRow({ read }: { read: AlignmentTimeframeRead }) {
  const Icon = read.bias === 'bullish' ? TrendingUp : read.bias === 'bearish' ? TrendingDown : GitBranch;
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className={`w-3.5 h-3.5 shrink-0 ${biasClass(read.bias)}`} aria-hidden="true" />
          <span className="text-[11px] font-bold text-ink">{read.timeframe}</span>
          <span className="text-[10px] uppercase tracking-wide text-faint">{ROLE_LABELS[read.role] ?? read.role}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {read.pullback && (
            <StatusPill label="Pullback" className="bg-amber-500/12 text-warn border-amber-500/30" />
          )}
          {!read.agrees && !read.pullback && (
            <StatusPill label="Opposes" className="bg-panel text-faint border-line" />
          )}
          <span className="text-[10px] font-mono text-faint">{Math.round(read.strength * 100)}%</span>
        </div>
      </div>
      <p className="text-[11px] text-muted leading-snug mt-1">{read.detail}</p>
    </div>
  );
}

function isAlignmentRead(value: AiInstrumentAnalysis['intelligence']): value is TimeframeAlignmentRead {
  return Boolean(value && 'character' in value);
}

export function TimeframeAlignmentPanel({ analysis }: { analysis: AiInstrumentAnalysis }) {
  const read = isAlignmentRead(analysis.intelligence) ? analysis.intelligence : null;
  if (!read) {
    return (
      <SectionCard
        title="Timeframe Alignment"
        subtitle="Top-down multi-timeframe alignment read"
        icon={<Layers className="w-3.5 h-3.5" aria-hidden="true" />}
      >
        <p className="text-[11px] text-faint py-2">
          {analysis.rejectionReason ?? 'No timeframe alignment read for this instrument yet.'}
        </p>
      </SectionCard>
    );
  }

  const p = analysis.precision;
  const dirClass = read.direction === 'RISE' ? 'text-emerald-400' : read.direction === 'FALL' ? 'text-bear' : 'text-muted';

  return (
    <SectionCard
      title="Timeframe Alignment"
      subtitle={`${read.ladder.length} timeframes read top-down · M5 execution`}
      icon={<Layers className="w-3.5 h-3.5" aria-hidden="true" />}
      right={
        <StatusPill
          label={CHARACTER_LABELS[read.character] ?? read.character}
          className={CHARACTER_STYLE[read.character] ?? 'bg-elevated text-muted border-line'}
        />
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="Direction" value={read.direction ?? '—'} valueClass={dirClass} />
        <StatTile label="Alignment" value={read.alignmentScore == null ? '—' : `${read.alignmentScore}/100`} />
        <StatTile label="Major" value={read.majorBias ?? '—'} />
        <StatTile label="Intermediate" value={read.intermediateBias ?? '—'} />
      </div>

      <div className="flex flex-col gap-1.5 mt-3">
        {read.ladder.map((tf) => (
          <LadderRow key={tf.timeframe} read={tf} />
        ))}
      </div>

      {read.contradictions.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-faint mb-1">Contradictions</p>
          <ul className="flex flex-col gap-1">
            {read.contradictions.map((c, i) => (
              <li key={i} className="text-[11px] text-muted leading-snug">
                • {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-muted leading-snug mt-3">
        <span className="text-faint">Confirmation: </span>
        {read.requiredEntryConfirmation}
      </p>
      <p className="text-[11px] text-muted leading-snug mt-1">
        <span className="text-faint">Invalidation: </span>
        {read.invalidationCondition}
      </p>

      <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-faint">Learner hint</span>
          <StatusPill
            label={read.learner.reliable ? 'Reliable' : 'Unlearned'}
            className={read.learner.reliable ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30' : 'bg-elevated text-muted border-line'}
          />
        </div>
        <p className="text-[11px] text-muted leading-snug mt-1">{read.learner.note}</p>
        {read.falseSignalTimeframes.length > 0 && (
          <p className="text-[11px] text-faint leading-snug mt-1">
            False-signal timeframes: {read.falseSignalTimeframes.join(', ')}
          </p>
        )}
      </div>

      {read.trade ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          <StatTile label="Entry" value={formatPrice(read.trade.entry, p)} />
          <StatTile label="Stop" value={formatPrice(read.trade.stop, p)} valueClass="text-bear" />
          <StatTile label="TP1" value={formatPrice(read.trade.tp1, p)} valueClass="text-emerald-400" />
          <StatTile label="R:R" value={read.trade.riskRewardRatio.toFixed(2)} />
        </div>
      ) : (
        <p className="text-[11px] text-faint leading-snug mt-3">
          No trade authorised — the ladder is not aligned enough to publish an entry.
        </p>
      )}
    </SectionCard>
  );
}
