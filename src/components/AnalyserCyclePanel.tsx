import { CheckCircle2, Loader2, RefreshCw, Target, XCircle } from 'lucide-react';
import type { AnalyserCycleValue } from '../hooks/useAnalyserCycle';
import { formatPrice } from '../utils/derivParser';

const PHASE_TONE: Record<string, string> = {
  WAITING: 'bg-panel text-muted border-line',
  ACTIVE_SETUP: 'bg-accent/12 text-accent border-accent/30',
  VERIFYING: 'bg-accent/12 text-accent border-accent/30',
  RECORDING: 'bg-accent/12 text-accent border-accent/30',
  CLEARING: 'bg-warn/12 text-warn border-amber-500/30',
  REANALYSING: 'bg-accent/12 text-accent border-accent/30',
  VALIDATING: 'bg-accent/12 text-accent border-accent/30',
  FRESH_ENTRY: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
};

/**
 * AUTOMATIC CHART RESET & FRESH-ENTRY CYCLE panel. Compact, low-noise: shows the current
 * phase, the last completed trade (outcome, accuracy, realised R) and the fresh-entry
 * status. It never invents a trade — every figure comes from a verified completion.
 */
export function AnalyserCyclePanel({ cycle }: { cycle: AnalyserCycleValue }) {
  const { state, lastTrade } = cycle;
  const tone = PHASE_TONE[state.phase] ?? PHASE_TONE.WAITING;
  const busy = state.phase === 'REANALYSING' || state.phase === 'VERIFYING' || state.phase === 'RECORDING' || state.phase === 'CLEARING';

  return (
    <div data-testid="analyser-cycle-panel" data-phase={state.phase} className="rounded-xl border border-line bg-panel p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide text-ink">
          <RefreshCw className={`w-3.5 h-3.5 text-accent ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
          Auto Cycle
        </span>
        <span
          data-testid="analyser-cycle-phase"
          className={`ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-bold uppercase tracking-wide ${tone}`}
        >
          {state.phase.replace('_', ' ')}
        </span>
      </div>

      <p className="text-[12px] text-muted leading-snug">{state.message}</p>

      {lastTrade && (
        <div className="rounded-lg border border-line-soft bg-surface/60 p-2 space-y-1.5">
          <div className="flex items-center gap-2">
            {lastTrade.outcome === 'TARGET_HIT' ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-bear shrink-0" aria-hidden="true" />
            )}
            <span className="text-[12px] font-semibold text-ink truncate">
              {lastTrade.displayName} · {lastTrade.timeframe} · {lastTrade.direction}
            </span>
            <span
              data-testid="analyser-cycle-outcome"
              className={`ml-auto text-[11px] font-bold uppercase ${
                lastTrade.outcome === 'TARGET_HIT' ? 'text-emerald-400' : 'text-bear'
              }`}
            >
              {lastTrade.outcome === 'TARGET_HIT' ? 'TP HIT' : 'SL HIT'}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5 text-[11px]">
            <div>
              <div className="text-faint">Entry</div>
              <div className="font-mono text-ink">{formatPrice(lastTrade.entry, lastTrade.precision)}</div>
            </div>
            <div>
              <div className="text-faint">Exit</div>
              <div className="font-mono text-ink">{formatPrice(lastTrade.exitPrice, lastTrade.precision)}</div>
            </div>
            <div>
              <div className="text-faint">Accuracy</div>
              <div className={`font-mono font-bold ${lastTrade.outcome === 'TARGET_HIT' ? 'text-emerald-400' : 'text-bear'}`}>
                {lastTrade.accuracy.accuracyPercent}%
              </div>
            </div>
            <div>
              <div className="text-faint">R</div>
              <div className={`font-mono font-bold ${lastTrade.accuracy.realisedRr >= 0 ? 'text-emerald-400' : 'text-bear'}`}>
                {lastTrade.accuracy.realisedRr >= 0 ? '+' : ''}
                {lastTrade.accuracy.realisedRr}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-faint">
        <Target className="w-3 h-3" aria-hidden="true" />
        {state.completedCount} completed trade{state.completedCount === 1 ? '' : 's'} recorded this session · history is permanent.
      </div>

      {busy && (
        <div className="flex items-center gap-1.5 text-[11px] text-accent">
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
          Running the fresh-entry cycle…
        </div>
      )}
    </div>
  );
}
