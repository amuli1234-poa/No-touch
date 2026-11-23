import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CircleStop,
  ExternalLink,
  Play,
  Radio,
  ShieldCheck,
  Wallet
} from 'lucide-react';

import { useAuth } from '../../lib/auth';
import { useBotRun, type BotRun, type BotRunStatus } from '../../lib/bots';
import { fetchExecutionContracts, type ExecutionContract } from '../../lib/trade';
import { PanelSection } from './PanelSection';

/**
 * EXECUTION RAIL — run this strategy on a real Deriv DEMO account.
 *
 * This is the only surface in the builder that can place a trade. It is
 * deliberately explicit about the truth of how a run works:
 *
 *  - DEMO only. A real account is never offered, and the server refuses one
 *    regardless of what this component sends.
 *  - Ticking happens from this browser tab, so a closed tab stops the bot from
 *    advancing. Reopening the editor picks an in-flight run back up. That is a
 *    real limitation and hiding it would misrepresent behaviour.
 *  - There is no Pause. The server models a run as running → stopping → stopped
 *    with no suspended state, so a Pause button would either do nothing or lie.
 *    Run and Stop are the two real transitions, and both are shown.
 *
 * Open contracts and profit/loss are read from the existing
 * `GET /api/execution/contracts` endpoint, which is the same data the trade
 * panel uses. Nothing here is simulated.
 */

const STATUS_STYLE: Record<BotRunStatus, string> = {
  idle: 'bg-muted/10 text-muted border-line',
  running: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  stopping: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  stopped: 'bg-muted/10 text-muted border-line',
  failed: 'bg-rose-500/10 text-rose-400 border-rose-500/30'
};

const VERDICT_LABEL: Record<string, string> = {
  entry: 'Entry placed',
  no_entry: 'Conditions not met',
  insufficient: 'Waiting for market data',
  ineligible: 'Strategy not executable',
  skipped: 'Skipped',
  stopped: 'Stopped'
};

export interface ExecutionRailProps {
  botId: string;
  /** Disabled while the editor has unsaved changes, so a run is never ambiguous. */
  dirty: boolean;
  /** Server-side strategy plan; false means execution would not match the XML. */
  executionEligibility: {
    runnable: boolean;
    reasons: string[];
    unsupported: string[];
  };
  /** The symbol the strategy trades, for the summary line. */
  symbol: string | null;
  contractType: string | null;
}

function money(value: number | null, currency: string): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)} ${currency}`;
}

export function ExecutionRail({
  botId,
  dirty,
  executionEligibility,
  symbol,
  contractType
}: ExecutionRailProps) {
  const auth = useAuth();
  const { run, error, busy, lastVerdict, start, stop } = useBotRun(botId);
  const [maxEntries, setMaxEntries] = useState(1);
  const [contracts, setContracts] = useState<ExecutionContract[]>([]);
  const [contractsError, setContractsError] = useState<string | null>(null);

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
  const canStart =
    executionEligibility.runnable &&
    !active &&
    !busy &&
    !dirty &&
    accountId !== '' &&
    auth.status === 'authenticated';

  const loadContracts = useCallback(async () => {
    if (auth.status !== 'authenticated') return;
    const result = await fetchExecutionContracts();
    if (result.ok) {
      setContracts(result.contracts);
      setContractsError(null);
    } else {
      setContractsError(result.message);
    }
  }, [auth.status]);

  // Refresh contracts while a run is live, and once when it settles, so the
  // panel reflects what the run actually opened.
  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    void loadContracts();
    if (!active) return;
    const timer = window.setInterval(() => void loadContracts(), 8000);
    return () => window.clearInterval(timer);
  }, [auth.status, active, loadContracts]);

  const relevant = useMemo(() => {
    if (!accountId) return [];
    return contracts
      .filter((c) => c.accountId === accountId)
      .slice()
      .sort((a, b) => b.purchaseTime - a.purchaseTime)
      .slice(0, 6);
  }, [contracts, accountId]);

  const openContracts = relevant.filter((c) => c.status === 'open');
  const settled = relevant.filter((c) => c.status !== 'open' && c.profit !== null);
  const sessionPnl = settled.reduce((sum, c) => sum + (c.profit ?? 0), 0);
  const currency = relevant[0]?.currency ?? demoAccounts[0]?.currency ?? 'USD';

  return (
    <section aria-label="Bot execution" className="flex flex-col gap-2 p-2.5">
      <header className="flex items-center gap-2">
        <Radio className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted">Execution</h2>
        <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-bold text-emerald-400">
          <ShieldCheck className="w-2.5 h-2.5" aria-hidden="true" />
          DEMO
        </span>
      </header>

      {auth.status !== 'authenticated' && (
        <div className="flex items-start gap-2 rounded-lg border border-line bg-surface/60 px-2.5 py-2 text-[11px] text-muted">
          <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>Sign in with Deriv to run this strategy on your demo account.</span>
        </div>
      )}

      {!executionEligibility.runnable && (
        <div
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[10.5px] text-warning"
        >
          <p className="font-bold">This strategy is not executable yet.</p>
          <details className="mt-1">
            <summary className="cursor-pointer font-semibold">Why Run is disabled</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {executionEligibility.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {auth.status === 'authenticated' && demoAccounts.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>No Deriv demo account is linked to this login, so there is nothing to run on.</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void start(accountId, maxEntries)}
          disabled={!canStart}
          title={
            auth.status !== 'authenticated'
              ? 'Sign in with Deriv to run this strategy'
              : demoAccounts.length === 0
                ? 'Link a Deriv demo account to run this strategy'
                : dirty
                  ? 'Save your changes before running the strategy'
                  : executionEligibility.runnable
                    ? 'Run this strategy on your Deriv demo account'
                    : executionEligibility.reasons[0] ?? 'This strategy cannot run yet'
          }
          className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-accent text-white text-xs font-bold hover:bg-accent-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <Play className="w-4 h-4" aria-hidden="true" />
          Run bot
        </button>
        <button
          type="button"
          onClick={() => void stop()}
          disabled={!active || busy || auth.status !== 'authenticated'}
          title={active ? 'Stop this bot run' : 'No bot run is active'}
          className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-danger text-white text-xs font-bold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <CircleStop className="w-4 h-4" aria-hidden="true" />
          Stop bot
        </button>
        {run && (
          <span
            className={`inline-flex items-center px-2 py-1 rounded-full border text-[10.5px] font-bold uppercase tracking-wide ${STATUS_STYLE[run.runtimeStatus]}`}
          >
            {run.runtimeStatus}
          </span>
        )}
      </div>

      {auth.status === 'authenticated' && demoAccounts.length > 0 && (
        <>
          <PanelSection title="Account information" icon={<Wallet className="h-3.5 w-3.5 text-accent" />} defaultOpen>
            <div className="space-y-2">
              <label className="block">
                <span className="block text-[10px] uppercase tracking-wide text-faint font-semibold mb-1">
                  Demo account
                </span>
                {demoAccounts.length > 1 ? (
                  <select
                    aria-label="Demo account"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    disabled={active}
                    className="w-full px-2 py-1.5 rounded-lg border border-line bg-canvas text-[11px] text-ink disabled:opacity-50 cursor-pointer"
                  >
                    {demoAccounts.map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.accountId}
                        {a.currency ? ` · ${a.currency}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-[11.5px] text-ink font-medium">
                    {demoAccounts[0].accountId}
                    {demoAccounts[0].currency ? ` · ${demoAccounts[0].currency}` : ''}
                  </p>
                )}
              </label>

              <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0">
                  <span className="block text-[10px] uppercase tracking-wide text-faint font-semibold mb-1">
                    Market
                  </span>
                  <p className="text-[11.5px] text-ink font-medium truncate">{symbol ?? '—'}</p>
                </div>
                <div className="min-w-0">
                  <span className="block text-[10px] uppercase tracking-wide text-faint font-semibold mb-1">
                    Contract
                  </span>
                  <p className="text-[11.5px] text-ink font-medium truncate">{contractType ?? '—'}</p>
                </div>
              </div>

              <label className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-faint font-semibold">
                  Max entries
                </span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxEntries}
                  disabled={active}
                  onChange={(e) => setMaxEntries(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  className="w-16 px-2 py-1 rounded-lg border border-line bg-canvas text-[11px] text-ink disabled:opacity-50"
                />
              </label>
            </div>
          </PanelSection>

          {dirty && !active && (
            <p className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[10.5px] text-warning leading-relaxed">
              Save changes before running. The server executes the saved strategy.
            </p>
          )}

          <p className="px-1 text-[10px] leading-relaxed text-faint">
            DEMO only. Keep this browser tab open while the bot is running.
          </p>

          <PanelSection title="Run statistics" icon={<Activity className="h-3.5 w-3.5 text-accent" />} defaultOpen={Boolean(run)}>
            {run ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-1.5">
                  <Stat label="Entries" value={`${run.counters.entries}/${run.maxEntries}`} />
                  <Stat label="Ticks" value={String(run.counters.ticks)} />
                  <Stat label="Signals" value={String(run.counters.signals)} />
                  <Stat
                    label="Refused"
                    value={String(run.counters.rejected)}
                    tone={run.counters.rejected > 0 ? 'text-warning' : undefined}
                  />
                </div>
                {lastVerdict && !active && (
                  <p className="text-[10.5px] text-muted">
                    Last evaluation: {VERDICT_LABEL[lastVerdict] ?? lastVerdict}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[10.5px] text-faint">Run counters appear here when a bot starts.</p>
            )}
          </PanelSection>

          <PanelSection title={`Trade history · ${openContracts.length} open`} icon={<Wallet className="h-3.5 w-3.5 text-accent" />}>
            <div className="space-y-2">

            {contractsError && (
              <details className="text-[10.5px] text-warning">
                <summary className="cursor-pointer">Trade history is unavailable</summary>
                <p className="mt-1 break-words">{contractsError}</p>
              </details>
            )}

            {!contractsError && relevant.length === 0 && (
              <p className="text-[10.5px] text-faint">No contracts on this account yet.</p>
            )}

            {relevant.length > 0 && (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-faint font-semibold">
                    Realised P/L
                  </span>
                  <span
                    className={`text-[12px] font-bold ${sessionPnl > 0 ? 'text-emerald-400' : sessionPnl < 0 ? 'text-rose-400' : 'text-muted'}`}
                  >
                    {money(sessionPnl, currency)}
                  </span>
                </div>
                <ul className="space-y-1">
                  {relevant.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center gap-2 rounded-lg border border-line-soft bg-surface-raised/40 px-2 py-1.5"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          c.status === 'open'
                            ? 'bg-accent animate-pulse'
                            : c.status === 'won'
                              ? 'bg-emerald-400'
                              : c.status === 'lost'
                                ? 'bg-rose-400'
                                : 'bg-muted/50'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[10.5px] font-semibold text-ink truncate">
                          {c.contractType} · {c.symbol}
                        </span>
                        <span className="block text-[9.5px] text-faint">
                          {c.status} · {c.stake.toFixed(2)} {c.currency}
                        </span>
                      </span>
                      <span
                        className={`text-[10.5px] font-bold shrink-0 ${
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
                      </span>
                    </li>
                  ))}
                </ul>
                <a
                  href="#/history"
                  className="inline-flex items-center gap-1 text-[10.5px] text-accent hover:text-accent-strong transition-colors"
                >
                  <ExternalLink className="w-2.5 h-2.5" aria-hidden="true" />
                  Full trade history
                </a>
              </>
            )}
            </div>

            {run && run.events.length > 0 && (
              <details className="mt-2 border-t border-line pt-2">
                <summary className="cursor-pointer text-[10.5px] font-semibold text-muted">
                  Run log
                </summary>
              <ol
                aria-label="Run log"
                className="max-h-32 overflow-y-auto space-y-0.5 text-[10px] text-muted font-mono"
              >
                {run.events
                  .slice(-10)
                  .reverse()
                  .map((event, i) => (
                    <li key={`${event.at}-${i}`} className="truncate">
                      <span className="text-muted/60">
                        {new Date(event.at).toLocaleTimeString()}
                      </span>{' '}
                      <span className="text-ink">{event.kind}</span> {event.detail}
                    </li>
                  ))}
              </ol>
              </details>
            )}
          </PanelSection>

          {(error || run?.error) && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-[10.5px] text-danger">
              <p className="font-semibold">The last run encountered an error.</p>
              <details className="mt-1">
                <summary className="cursor-pointer font-semibold">Technical details</summary>
                {error && <p className="mt-1 break-words">{error.message}</p>}
                {run?.error && <p className="mt-1 break-words">{run.error}</p>}
              </details>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface-raised/40 px-2 py-1.5">
      <p className="text-[9.5px] uppercase tracking-wide text-faint font-semibold">{label}</p>
      <p className={`text-[12px] font-bold ${tone ?? 'text-ink'}`}>{value}</p>
    </div>
  );
}
