import { useMemo, useState, type ReactNode } from 'react';
import { Activity, Download, RotateCcw, ShieldCheck } from 'lucide-react';

import type { BotRunEvent } from '../../lib/bots';
import type { ExecutionContract } from '../../lib/trade';
import type { BotExecution } from './useBotExecution';

/**
 * RUN PANEL — the right-hand column of the bot builder.
 *
 * Mirrors Deriv Bot's run panel: Summary / Transactions / Journal tabs, the
 * statistics tile grid beneath them, and a reset control in the footer. Run and
 * stop live in the floating `RunControl` over the canvas, so they are not
 * repeated here. The tiles are derived from real contracts on the selected demo
 * account and the run's own counters; a figure that has no data shows an em dash
 * rather than a zero, so an empty account is never mistaken for a flat one.
 */

type Tab = 'summary' | 'transactions' | 'journal';

const VERDICT_LABEL: Record<string, string> = {
  entry: 'Entry placed',
  no_entry: 'Conditions not met',
  insufficient: 'Waiting for market data',
  ineligible: 'Strategy not executable',
  skipped: 'Skipped',
  stopped: 'Stopped'
};

function money(value: number, currency: string): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)} ${currency}`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 px-2 py-1.5 text-center">
      <p className="truncate text-[9px] font-semibold uppercase tracking-wide text-faint">{label}</p>
      <p className={`mt-0.5 truncate text-[11.5px] font-bold tabular-nums ${tone ?? 'text-ink'}`}>
        {value}
      </p>
    </div>
  );
}

function Tabs({
  active,
  onChange
}: {
  active: Tab;
  onChange: (tab: Tab) => void;
}) {
  const items: { key: Tab; label: string }[] = [
    { key: 'summary', label: 'Summary' },
    { key: 'transactions', label: 'Transactions' },
    { key: 'journal', label: 'Journal' }
  ];
  return (
    <div role="tablist" className="flex border-b border-line">
      {items.map((item) => {
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(item.key)}
            className={`relative flex-1 px-2 py-2 text-[11px] font-bold transition-colors cursor-pointer ${
              selected ? 'text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            {item.label}
            {selected && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}

export interface RunPanelProps {
  execution: BotExecution;
  /** Symbol the strategy trades, for the summary card. */
  symbol: string | null;
  contractType: string | null;
  /** Disabled while the canvas has unsaved changes, so a run is never ambiguous. */
  dirty: boolean;
  /** Server-side eligibility; false means the XML would not be what runs. */
  runnable: boolean;
  reasons: string[];
  /**
   * Strategy configuration and contract availability, collapsed at the foot of
   * the Summary tab. It reads from the saved strategy, so it is reference
   * material rather than part of the live run.
   */
  configDetails?: ReactNode;
}

export function RunPanel({
  execution,
  symbol,
  contractType,
  dirty,
  runnable,
  reasons,
  configDetails
}: RunPanelProps) {
  const [tab, setTab] = useState<Tab>('summary');
  const {
    authenticated,
    demoAccounts,
    accountId,
    setAccountId,
    maxEntries,
    setMaxEntries,
    run,
    error,
    lastVerdict,
    active,
    stats,
    recent,
    contractsError,
    resetStats,
    hasBaseline
  } = execution;

  const hasStats = recent.length > 0 || (run?.counters.ticks ?? 0) > 0;
  const runtimeStatus = run?.runtimeStatus ?? 'idle';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* Header ----------------------------------------------------------- */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Activity className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted">Run panel</h2>
        <span className="ml-auto inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9.5px] font-bold text-emerald-400">
          <ShieldCheck className="h-2.5 w-2.5" aria-hidden="true" />
          DEMO
        </span>
      </header>

      {/* Run settings ------------------------------------------------------ */}
      <div className="shrink-0 space-y-2 border-b border-line px-3 py-2.5">
        {!authenticated && (
          <p className="rounded-lg border border-line bg-surface-raised/40 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted">
            Sign in with Deriv to run this strategy on your demo account.
          </p>
        )}

        {authenticated && !runnable && (
          <details className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[10.5px] text-warning">
            <summary className="cursor-pointer font-bold">This strategy is not executable yet</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </details>
        )}

        {authenticated && demoAccounts.length === 0 && (
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[10.5px] text-warning">
            No Deriv demo account is linked to this login, so there is nothing to run on.
          </p>
        )}

        {authenticated && demoAccounts.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <label className="min-w-0">
              <span className="mb-1 block text-[9.5px] font-semibold uppercase tracking-wide text-faint">
                Demo account
              </span>
              {demoAccounts.length > 1 ? (
                <select
                  aria-label="Demo account"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  disabled={active}
                  className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-[11px] text-ink disabled:opacity-50 cursor-pointer"
                >
                  {demoAccounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.accountId}
                      {a.currency ? ` · ${a.currency}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="truncate py-1.5 text-[11px] font-medium text-ink">
                  {demoAccounts[0].accountId}
                  {demoAccounts[0].currency ? ` · ${demoAccounts[0].currency}` : ''}
                </p>
              )}
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[9.5px] font-semibold uppercase tracking-wide text-faint">
                Max entries
              </span>
              <input
                type="number"
                min={1}
                max={20}
                value={maxEntries}
                disabled={active}
                onChange={(e) =>
                  setMaxEntries(Math.max(1, Math.min(20, Number(e.target.value) || 1)))
                }
                className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-[11px] text-ink disabled:opacity-50"
              />
            </label>
          </div>
        )}

        {dirty && !active && (
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-warning">
            Save changes before running. The server executes the saved strategy.
          </p>
        )}

        {lastVerdict && !active && (
          <p className="px-0.5 text-[10px] text-muted">
            Last evaluation: {VERDICT_LABEL[lastVerdict] ?? lastVerdict}
          </p>
        )}
      </div>

      <Tabs active={tab} onChange={setTab} />

      {/* A refused start belongs next to the control that caused it, not only
          inside the Journal tab, which is not the tab the user is looking at. */}
      {error && tab !== 'journal' && (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2">
          <p className="text-[10.5px] font-bold text-danger">The bot could not start.</p>
          <p className="mt-0.5 break-words text-[10px] leading-relaxed text-danger/90">
            {error.message}
            {error.code && !error.message.includes(error.code) ? ` (${error.code})` : ''}
          </p>
        </div>
      )}

      {/* Tab content ----------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'summary' && (
          <SummaryTab
            run={run}
            symbol={symbol}
            contractType={contractType}
            open={stats.open}
            lastVerdict={lastVerdict}
            runtimeStatus={runtimeStatus}
            maxEntries={maxEntries}
            configDetails={configDetails}
          />
        )}
        {tab === 'transactions' && (
          <TransactionsTab contracts={recent} currency={stats.currency} error={contractsError} />
        )}
        {tab === 'journal' && <JournalTab run={run} error={error?.message ?? run?.error ?? null} />}
      </div>

      {/* Statistics tiles — Deriv keeps these below the tabs, and hides them
          on the Journal tab, which is the one view that is already a log. */}
      {tab !== 'journal' && (
        <div className="grid shrink-0 grid-cols-3 divide-x divide-line border-t border-line">
          <Stat label="Total stake" value={hasStats ? stats.totalStake.toFixed(2) : '—'} />
          <Stat label="Total payout" value={hasStats ? stats.totalPayout.toFixed(2) : '—'} />
          <Stat label="No. of runs" value={String(run ? 1 : 0)} />
          <Stat
            label="Contracts lost"
            value={hasStats ? String(stats.lost) : '—'}
            tone={stats.lost > 0 ? 'text-rose-400' : undefined}
          />
          <Stat
            label="Contracts won"
            value={hasStats ? String(stats.won) : '—'}
            tone={stats.won > 0 ? 'text-emerald-400' : undefined}
          />
          <Stat
            label="Total P/L"
            value={hasStats ? money(stats.pnl, stats.currency) : '—'}
            tone={stats.pnl > 0 ? 'text-emerald-400' : stats.pnl < 0 ? 'text-rose-400' : undefined}
          />
        </div>
      )}

      {/* Footer ----------------------------------------------------------- */}
      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-[9.5px] text-faint">
          {hasBaseline ? 'Statistics since your last reset.' : 'Statistics for this account.'}
        </p>
        <button
          type="button"
          onClick={resetStats}
          disabled={!hasStats}
          title="Start counting the statistics from now"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[10.5px] font-bold text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Reset
        </button>
      </footer>
    </div>
  );
}

function SummaryTab({
  run,
  symbol,
  contractType,
  open,
  lastVerdict,
  runtimeStatus,
  maxEntries,
  configDetails
}: {
  run: BotExecution['run'];
  symbol: string | null;
  contractType: string | null;
  open: number;
  lastVerdict: string | null;
  runtimeStatus: string;
  maxEntries: number;
  configDetails?: ReactNode;
}) {
  return (
    <div className="space-y-2 p-3">
      <dl className="rounded-lg border border-line bg-surface-raised/40 px-2.5 py-1.5">
        {[
          ['Market', symbol ?? 'not set'],
          ['Contract', contractType ?? 'not set'],
          ['Status', runtimeStatus],
          ['Open contracts', String(open)],
          ['Entries', run ? `${run.counters.entries}/${run.maxEntries}` : `0/${maxEntries}`],
          ['Ticks', run ? String(run.counters.ticks) : '0'],
          ['Signals', run ? String(run.counters.signals) : '0'],
          ['Refused', run ? String(run.counters.rejected) : '0'],
          ['Last evaluation', lastVerdict ? VERDICT_LABEL[lastVerdict] ?? lastVerdict : '—']
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-3 border-b border-line-soft/60 py-1.5 last:border-0"
          >
            <dt className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-faint">
              {label}
            </dt>
            <dd className="truncate text-right text-[11.5px] font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {configDetails && (
        <details className="rounded-lg border border-line bg-surface-raised/40">
          <summary className="cursor-pointer px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-faint">
            Strategy configuration
          </summary>
          <div className="border-t border-line px-1 pb-1">{configDetails}</div>
        </details>
      )}
      <p className="px-0.5 text-[10px] leading-relaxed text-faint">
        DEMO only. Keep this browser tab open while the bot is running. The bot stops on its own
        take-profit, stop-loss, and session caps, and after the entry limit above.
      </p>
    </div>
  );
}

function TransactionsTab({
  contracts,
  currency,
  error
}: {
  contracts: ExecutionContract[];
  currency: string;
  error: string | null;
}) {
  if (error) {
    return (
      <details className="m-3 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[10.5px] text-warning">
        <summary className="cursor-pointer font-semibold">Trade history is unavailable</summary>
        <p className="mt-1 break-words">{error}</p>
      </details>
    );
  }
  if (contracts.length === 0) {
    return <p className="p-3 text-[10.5px] text-faint">No contracts on this account yet.</p>;
  }
  return (
    <div className="p-2">
      <table className="w-full text-left">
        <thead>
          <tr className="text-[9px] font-semibold uppercase tracking-wide text-faint">
            <th className="px-1 py-1">Contract</th>
            <th className="px-1 py-1 text-right">Stake</th>
            <th className="px-1 py-1 text-right">P/L</th>
          </tr>
        </thead>
        <tbody>
          {contracts.slice(0, 25).map((c) => (
            <tr key={c.id} className="border-t border-line-soft/60">
              <td className="min-w-0 px-1 py-1.5">
                <span className="block truncate text-[10.5px] font-semibold text-ink">
                  {c.contractType} · {c.symbol}
                </span>
                <span className="block text-[9.5px] text-faint">
                  {new Date(c.purchaseTime).toLocaleTimeString()} · {c.status}
                </span>
              </td>
              <td className="px-1 py-1.5 text-right text-[10.5px] tabular-nums text-muted">
                {c.stake.toFixed(2)}
              </td>
              <td
                className={`px-1 py-1.5 text-right text-[10.5px] font-bold tabular-nums ${
                  c.profit === null
                    ? 'text-muted'
                    : c.profit > 0
                      ? 'text-emerald-400'
                      : c.profit < 0
                        ? 'text-rose-400'
                        : 'text-muted'
                }`}
              >
                {c.profit === null ? 'open' : money(c.profit, c.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <a
        href="#/history"
        className="mt-2 inline-flex items-center gap-1 px-1 text-[10.5px] text-accent transition-colors hover:text-accent-strong"
      >
        <Download className="h-2.5 w-2.5" aria-hidden="true" />
        Full trade history
      </a>
    </div>
  );
}

function JournalTab({ run, error }: { run: BotExecution['run']; error: string | null }) {
  const events = useMemo<BotRunEvent[]>(() => (run ? run.events.slice().reverse() : []), [run]);
  return (
    <div className="p-3">
      {error && (
        <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-[10.5px] text-danger">
          <p className="font-semibold">The last run encountered an error.</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      )}
      {events.length === 0 ? (
        <p className="text-[10.5px] text-faint">The run log fills in as the bot ticks.</p>
      ) : (
        <ol aria-label="Run log" className="space-y-1 font-mono text-[10px]">
          {events.slice(0, 80).map((event, i) => (
            <li key={`${event.at}-${i}`} className="flex gap-1.5">
              <span className="shrink-0 text-muted/60">
                {new Date(event.at).toLocaleTimeString()}
              </span>
              <span className="min-w-0">
                <span className="font-semibold text-ink">{event.kind}</span>{' '}
                <span className="break-words text-muted">{event.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
