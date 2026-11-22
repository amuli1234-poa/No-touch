import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CircleStop, Play, Radio, ShieldCheck } from 'lucide-react';

import { useAuth } from '../../lib/auth';
import { useBotRun, type BotRun, type BotRunStatus } from '../../lib/bots';

/**
 * BOT RUN CONTROL — real Deriv demo execution.
 *
 * This is the only part of the bot builder that can place a trade. It is
 * deliberately explicit about what it does:
 *
 *  - It runs on a Deriv DEMO account only. A real account is not offered, and
 *    the server refuses one regardless of what the client sends.
 *  - It says, in the panel, that ticking happens from this browser tab and that
 *    closing the tab stops the bot. That is a real limitation and hiding it
 *    would misrepresent how the bot behaves.
 *  - Every refusal from the server is shown with its own reason rather than a
 *    generic failure, so "why did nothing happen" always has an answer.
 */

const STATUS_STYLE: Record<BotRunStatus, string> = {
  idle: 'bg-muted/10 text-muted border-line',
  running: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  stopping: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  stopped: 'bg-muted/10 text-muted border-line',
  failed: 'bg-rose-500/10 text-rose-400 border-rose-500/30'
};

/** Verdict wording, so the customer can tell "no trade" from "could not decide". */
const VERDICT_LABEL: Record<string, string> = {
  entry: 'Entry placed',
  no_entry: 'Conditions not met',
  insufficient: 'Waiting for market data',
  ineligible: 'Strategy not executable',
  skipped: 'Skipped',
  stopped: 'Stopped'
};

export interface BotRunPanelProps {
  botId: string;
  /** Disabled while the editor has unsaved changes, so a run is never ambiguous. */
  dirty: boolean;
}

export function BotRunPanel({ botId, dirty }: BotRunPanelProps) {
  const auth = useAuth();
  const { run, error, busy, lastVerdict, start, stop } = useBotRun(botId);
  const [maxEntries, setMaxEntries] = useState(1);

  const demoAccounts = useMemo(
    () => (auth.status === 'authenticated' ? auth.user.accounts.filter((a) => a.type === 'demo') : []),
    [auth]
  );
  const [accountId, setAccountId] = useState<string>('');

  useEffect(() => {
    if (accountId || demoAccounts.length === 0) return;
    setAccountId(demoAccounts[0].accountId);
  }, [accountId, demoAccounts]);

  const active = run?.runtimeStatus === 'running' || run?.runtimeStatus === 'stopping';
  const canStart = !active && !busy && !dirty && accountId !== '' && auth.status === 'authenticated';

  if (auth.status !== 'authenticated') {
    return (
      <div className="flex items-start gap-2 px-3 sm:px-4 py-2 border-b border-line bg-surface text-[11px] text-muted shrink-0">
        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
        <span>Sign in with Deriv to run this strategy on your demo account.</span>
      </div>
    );
  }

  if (demoAccounts.length === 0) {
    return (
      <div className="flex items-start gap-2 px-3 sm:px-4 py-2 border-b border-line bg-warning/10 text-[11px] text-warning shrink-0">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
        <span>No Deriv demo account is linked to this login, so there is nothing to run on.</span>
      </div>
    );
  }

  return (
    <section
      aria-label="Bot execution"
      className="border-b border-line bg-surface shrink-0"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted">
          <Radio className="w-3.5 h-3.5" aria-hidden="true" />
          Demo execution
        </span>

        {demoAccounts.length > 1 ? (
          <select
            aria-label="Demo account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={active}
            className="px-2 py-1 rounded-lg border border-line bg-canvas text-xs text-ink disabled:opacity-50"
          >
            {demoAccounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.accountId}
                {a.currency ? ` · ${a.currency}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-muted">{accountId || demoAccounts[0].accountId}</span>
        )}

        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
          Max entries
          <input
            type="number"
            min={1}
            max={20}
            value={maxEntries}
            disabled={active}
            onChange={(e) => setMaxEntries(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className="w-14 px-2 py-1 rounded-lg border border-line bg-canvas text-xs text-ink disabled:opacity-50"
          />
        </label>

        {active ? (
          <button
            type="button"
            onClick={() => void stop()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-danger text-white text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer"
          >
            <CircleStop className="w-3.5 h-3.5" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start(accountId, maxEntries)}
            disabled={!canStart}
            title={
              dirty
                ? 'Save your changes before running the strategy'
                : 'Run this strategy on your Deriv demo account'
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-semibold hover:bg-accent-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" aria-hidden="true" />
            Run
          </button>
        )}

        {run && (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold ${STATUS_STYLE[run.runtimeStatus]}`}
          >
            {run.runtimeStatus}
          </span>
        )}

        {run && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted">
            <Activity className="w-3.5 h-3.5" aria-hidden="true" />
            {run.counters.entries}/{run.maxEntries} entries · {run.counters.ticks} ticks
            {run.counters.rejected > 0 ? ` · ${run.counters.rejected} refused` : ''}
          </span>
        )}
      </div>

      <p className="px-3 sm:px-4 pb-2 text-[11px] text-muted">
        Trades are placed on Deriv <strong className="text-ink">demo</strong> only. The bot is
        evaluated from this browser tab, so closing or reloading it stops the bot — the run is
        not continued on the server.
      </p>

      {dirty && !active && (
        <p className="px-3 sm:px-4 pb-2 text-[11px] text-warning">
          Save your changes first. Running uses the saved strategy, so unsaved edits would not
          be the strategy that trades.
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 mx-3 sm:mx-4 mb-2 px-2.5 py-1.5 rounded-lg bg-danger/10 border border-danger/30 text-[11px] text-danger">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error.message}</span>
        </div>
      )}

      {run?.error && (
        <div className="flex items-start gap-2 mx-3 sm:mx-4 mb-2 px-2.5 py-1.5 rounded-lg bg-danger/10 border border-danger/30 text-[11px] text-danger">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{run.error}</span>
        </div>
      )}

      {run && run.events.length > 0 && (
        <ol
          aria-label="Run log"
          className="max-h-28 overflow-y-auto px-3 sm:px-4 pb-2 space-y-0.5 text-[11px] text-muted font-mono"
        >
          {run.events
            .slice(-8)
            .reverse()
            .map((event, i) => (
              <li key={`${event.at}-${i}`} className="truncate">
                <span className="text-muted/70">{new Date(event.at).toLocaleTimeString()}</span>{' '}
                <span className="text-ink">{event.kind}</span> {event.detail}
              </li>
            ))}
        </ol>
      )}

      {lastVerdict && !active && (
        <p className="px-3 sm:px-4 pb-2 text-[11px] text-muted">
          Last evaluation: {VERDICT_LABEL[lastVerdict] ?? lastVerdict}
        </p>
      )}
    </section>
  );
}
