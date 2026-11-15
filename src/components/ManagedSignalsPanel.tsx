import { ArrowDownRight, ArrowUpRight, Lock, MoveUpRight, Sparkles } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import type { ManagedSignal, TpAdjustment } from '../types/training';
import { formatPrice } from '../utils/derivParser';

function TpTimeline({ signal }: { signal: ManagedSignal }) {
  const adjustments = signal.tpHistory.filter((t) => t.kind !== 'INITIAL');
  if (adjustments.length === 0) {
    return (
      <p className="text-[10px] text-faint">
        Take-profit unchanged since publication — no structural or momentum trigger yet.
      </p>
    );
  }
  return (
    <ol className="space-y-1.5">
      {adjustments.map((adj: TpAdjustment, i) => (
        <li key={i} className="flex gap-2">
          <MoveUpRight
            className={`w-3 h-3 mt-0.5 shrink-0 ${
              adj.kind === 'EXTEND' ? 'text-emerald-400' : 'text-warn'
            }`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="text-[10px] font-mono text-ink">
              {formatPrice(adj.previous, 5)} → {formatPrice(adj.next, 5)}{' '}
              <span
                className={`font-bold ${
                  adj.kind === 'EXTEND' ? 'text-emerald-400' : 'text-warn'
                }`}
              >
                {adj.kind}
              </span>
            </div>
            <div className="text-[10px] text-muted leading-relaxed">{adj.reason}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ManagedSignalRow({ signal, onOpen }: { signal: ManagedSignal; onOpen: () => void }) {
  const isRise = signal.direction === 'RISE';
  const adjustments = signal.tpHistory.length - 1;
  return (
    <div className="py-3 border-b border-line-soft last:border-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isRise ? (
            <ArrowUpRight className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          ) : (
            <ArrowDownRight className="w-4 h-4 text-bear shrink-0" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <div className="text-xs font-bold text-ink truncate">
              {signal.displayName}{' '}
              <span className="text-faint font-mono font-normal">
                {signal.symbol} · {signal.timeframe}
              </span>
            </div>
            <div className="text-[10px] text-muted truncate">{signal.modelLabel}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${
              signal.status === 'ACTIVE'
                ? 'bg-accent/12 text-accent border-accent/30'
                : signal.status === 'TARGET_HIT'
                  ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
                  : signal.status === 'STOP_HIT'
                    ? 'bg-red-500/12 text-bear border-red-500/30'
                    : 'bg-panel text-muted border-line'
            }`}
          >
            {signal.status.replace('_', ' ')}
          </span>
          <button
            type="button"
            onClick={onOpen}
            className="text-[10px] font-bold text-accent hover:text-accent-soft cursor-pointer"
          >
            OPEN CHART
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-2">
        <div className="bg-panel border border-line-soft rounded-md px-2 py-1">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-faint flex items-center gap-1">
            <Lock className="w-2.5 h-2.5" aria-hidden="true" /> Entry (locked)
          </div>
          <div className="text-[11px] font-mono text-ink">{formatPrice(signal.entry, 5)}</div>
        </div>
        <div className="bg-panel border border-line-soft rounded-md px-2 py-1">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-faint flex items-center gap-1">
            <Lock className="w-2.5 h-2.5" aria-hidden="true" /> Stop (locked)
          </div>
          <div className="text-[11px] font-mono text-bear">{formatPrice(signal.stopLoss, 5)}</div>
        </div>
        <div className="bg-panel border border-line-soft rounded-md px-2 py-1">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-faint">
            Take-profit (dynamic)
          </div>
          <div className="text-[11px] font-mono text-accent">
            {formatPrice(signal.takeProfit, 5)}
            {adjustments > 0 && (
              <span className="text-faint font-normal"> · {adjustments} adj</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2">
        <TpTimeline signal={signal} />
      </div>
    </div>
  );
}

/**
 * Live trade-management panel: shows managed signals with locked entry/stop-loss,
 * the dynamic take-profit and its full adjustment history. Entry and stop-loss are
 * never moved; only the take-profit evolves.
 */
export function ManagedSignalsPanel({ limit = 6 }: { limit?: number }) {
  const ws = useWorkspace();
  const signals = ws.managedSignals.slice(0, limit);

  if (signals.length === 0) {
    return (
      <p className="text-xs text-muted leading-relaxed">
        No managed signals yet. Confirmed setups from the scanner or analyser become managed
        trades here, with a locked entry and stop-loss and a take-profit that adapts to
        structure and momentum as the market moves.
      </p>
    );
  }

  return (
    <div>
      {signals.map((signal) => (
        <ManagedSignalRow
          key={signal.id}
          signal={signal}
          onOpen={() => ws.openAnalyser(signal.symbol, signal.timeframe)}
        />
      ))}
      <div className="flex items-center gap-1.5 mt-2 text-[10px] text-faint">
        <Sparkles className="w-3 h-3" aria-hidden="true" />
        Entry and stop-loss are immutable once published. Only the take-profit adapts.
      </div>
    </div>
  );
}
