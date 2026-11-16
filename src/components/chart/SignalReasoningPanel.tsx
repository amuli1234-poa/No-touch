import { useState } from 'react';
import {
  ChevronDown,
  Info,
  Lock,
  MoveUpRight,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { SignalLevels } from './SignalAnnotationPrimitive';
import type { TradeSignalCard } from '../../types/analysis';

/**
 * The clickable reasoning behind the chart annotations. It explains the locked
 * entry, the locked stop-loss and the dynamic take-profit, and — when a full signal
 * card is available — the confirmation model and quality breakdown.
 */
export function SignalReasoningPanel({
  levels,
  detail,
  onClose,
  forceOpen = false,
}: {
  levels: SignalLevels;
  detail: TradeSignalCard | null;
  onClose: () => void;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = forceOpen || open;
  const isRise = levels.direction === 'RISE';
  const DirIcon = isRise ? TrendingUp : TrendingDown;
  const dirColor = isRise ? 'text-emerald-400' : 'text-bear';

  const risk = Math.abs(levels.entry - levels.stopLoss);
  const reward = Math.abs(levels.takeProfit - levels.entry);
  const rr = risk > 0 ? reward / risk : null;

  return (
    <div className="absolute left-2 right-2 bottom-2 sm:left-auto sm:right-3 sm:bottom-3 sm:w-[300px] z-30">
      <div className="bg-surface/95 backdrop-blur border border-line rounded-xl shadow-lg overflow-hidden">
        <button
          type="button"
          onClick={() => (forceOpen ? onClose() : setOpen((v) => !v))}
          aria-expanded={isOpen}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-elevated/50 transition-colors"
        >
          <span
            className={`inline-flex items-center justify-center w-6 h-6 rounded-md border shrink-0 ${
              isRise
                ? 'bg-emerald-500/12 border-emerald-500/30'
                : 'bg-red-500/12 border-red-500/30'
            }`}
          >
            <DirIcon className={`w-3.5 h-3.5 ${dirColor}`} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-bold text-ink truncate">
              {isRise ? 'RISE' : 'FALL'} signal reasoning
            </span>
            <span className="block text-[11px] text-faint truncate">
              Tap the chart levels to inspect
            </span>
          </span>
          <ChevronDown
            className={`w-4 h-4 text-faint shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>

        {isOpen && (
          <div className="px-3 pb-3 space-y-2.5 max-h-[46vh] overflow-y-auto animate-slide-up">
            <div className="grid grid-cols-3 gap-1.5">
              <Level label="Entry" value={levels.entry} icon={<Lock className="w-2.5 h-2.5" />} tone="text-accent" />
              <Level label="Stop" value={levels.stopLoss} icon={<ShieldAlert className="w-2.5 h-2.5" />} tone="text-bear" />
              <Level label="TP" value={levels.takeProfit} icon={<Target className="w-2.5 h-2.5" />} tone="text-emerald-400" />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-accent/30 bg-accent/12 text-accent font-bold">
                <Lock className="w-2.5 h-2.5" aria-hidden="true" /> ENTRY + SL LOCKED
              </span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/12 text-emerald-400 font-bold">
                <MoveUpRight className="w-2.5 h-2.5" aria-hidden="true" /> TP DYNAMIC
              </span>
              {rr !== null && (
                <span className="px-1.5 py-0.5 rounded border border-line bg-panel text-muted font-mono font-bold">
                  R:R 1:{rr.toFixed(2)}
                </span>
              )}
            </div>

            {levels.modelLabel && (
              <Row icon={<Sparkles className="w-3 h-3 text-accent" />} title="Entry model" body={levels.modelLabel} />
            )}
            {typeof levels.quality === 'number' && (
              <Row
                icon={<Info className="w-3 h-3 text-accent" />}
                title={`Setup quality ${levels.quality}/100`}
                body={
                  detail?.quality
                    ? `Structure ${detail.quality.structure}/20 · Level ${detail.quality.levelZone}/20 · Entry ${detail.quality.entryConfirmation}/25 · Momentum ${detail.quality.momentum}/15`
                    : 'Technical quality score from the analysis engine.'
                }
              />
            )}
            {detail && (
              <>
                <Row
                  icon={<Info className="w-3 h-3 text-accent" />}
                  title="Confirmation"
                  body={detail.confirmationExplanation}
                />
                <Row
                  icon={<Info className="w-3 h-3 text-accent" />}
                  title="Why the target is here"
                  body={`The take-profit sits beyond the next opposing level with ${detail.availableSpaceAtr.toFixed(1)}x ATR of open space. It is the only level the AI is allowed to move.`}
                />
              </>
            )}
            {!detail && (
              <p className="text-[11px] text-faint leading-relaxed">
                Entry and stop-loss are locked at publication and never move. Only the
                take-profit adjusts as structure and momentum evolve.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Level({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: string;
}) {
  return (
    <div className="bg-panel border border-line-soft rounded-md px-1.5 py-1">
      <div className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide text-faint">
        {icon}
        {label}
      </div>
      <div className={`text-[12px] font-mono tabular-nums font-bold ${tone}`}>
        {value.toFixed(3)}
      </div>
    </div>
  );
}

function Row({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-ink">{title}</div>
        <div className="text-[11px] text-muted leading-relaxed">{body}</div>
      </div>
    </div>
  );
}
