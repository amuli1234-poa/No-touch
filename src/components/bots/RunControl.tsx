import { CircleStop, Loader2, Play, ShieldCheck } from 'lucide-react';

import type { BotExecution } from './useBotExecution';

/**
 * The run/stop control that floats over the workspace, as Deriv Bot does.
 *
 * It shows the two transitions the server actually models — run and stop —
 * and the run's live status. There is no Pause because a run has no suspended
 * state; a Pause button would either do nothing or lie about it.
 */

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  failed: 'Failed'
};

export function RunControl({
  execution,
  reason
}: {
  execution: BotExecution;
  /** Why Run is unavailable, shown as the button's tooltip. */
  reason: string | null;
}) {
  const { active, busy, canStart, run, start, stop } = execution;
  const status = run?.runtimeStatus ?? 'idle';

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-end p-2.5">
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-line bg-surface/95 px-2 py-1.5 shadow-lg shadow-black/30 backdrop-blur">
        <span className="inline-flex items-center gap-1 pl-1 pr-1.5 text-[9.5px] font-bold uppercase tracking-widest text-emerald-400">
          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
          Demo
        </span>

        <span className="h-5 w-px bg-line" />

        {active ? (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={busy}
            title="Stop this bot run"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-[11.5px] font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={!canStart}
            title={reason ?? 'Run this strategy on your Deriv demo account'}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-[11.5px] font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Run
          </button>
        )}

        <span className="flex items-center gap-1.5 pr-1">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              status === 'running'
                ? 'animate-pulse bg-emerald-400'
                : status === 'stopping'
                  ? 'animate-pulse bg-amber-400'
                  : status === 'failed'
                    ? 'bg-rose-400'
                    : 'bg-muted/50'
            }`}
            aria-hidden="true"
          />
          <span className="text-[10.5px] font-semibold text-muted">{STATUS_LABEL[status] ?? status}</span>
        </span>
      </div>
    </div>
  );
}
