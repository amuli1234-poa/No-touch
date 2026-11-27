import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, FileCode2, LoaderCircle, Play, RefreshCw, Save, Square, Undo2, Users } from 'lucide-react';
import { useBalances } from '../../lib/balances';
import {
  fetchBotXml,
  listBots,
  listBotRuns,
  revertBot,
  saveBotTree,
  startBotRun,
  stopBotRun,
  tickBotRun,
  type BotRun,
  type ImportedBot
} from '../../lib/bots';

const TICK_INTERVAL_MS = 1200;

function compatLabel(level: ImportedBot['compatibility']['level']): string {
  switch (level) {
    case 'full':
      return 'Fully compatible';
    case 'partial':
      return 'Partially compatible';
    case 'unsupported':
      return 'Not supported';
    default:
      return 'Invalid file';
  }
}

function compatClass(level: ImportedBot['compatibility']['level']): string {
  if (level === 'full') return 'text-success';
  if (level === 'partial') return 'text-warning';
  return 'text-danger';
}

/**
 * Rewrites the initial `base_stake` value in a DBot XML tree.
 *
 * The stake is stored as a `variables_set` whose VAR is `base_stake` and whose
 * value is a `math_number`. Returns the new XML, or the original when the shape
 * is not found (the caller then falls back to the raw editor).
 */
function setBaseStake(xml: string, stake: number): string {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return xml;
    const setters = Array.from(doc.querySelectorAll('block[type="variables_set"]'));
    for (const setter of setters) {
      const varField = setter.querySelector(':scope > field[name="VAR"]');
      const varId = varField?.getAttribute('id') ?? varField?.textContent ?? '';
      if (varId !== 'base_stake' && !/base\s*stake/i.test(varId)) continue;
      const num = setter.querySelector('block[type="math_number"] > field[name="NUM"]');
      if (num) {
        num.textContent = String(stake);
        return new XMLSerializer().serializeToString(doc.documentElement);
      }
    }
    return xml;
  } catch {
    return xml;
  }
}

/**
 * WickSentinel Bot Builder.
 *
 * Runs an imported bot through the server-side runner, the only path that goes
 * through the execution gateway and therefore mirrors the manager's entry to
 * connected copy-trading followers. Ticking is browser-driven: the run advances
 * only while this view is open, and closing the tab stops it.
 */
export function BotBuilderView() {
  const { accounts } = useBalances();
  const demoAccounts = useMemo(() => accounts.filter((a) => a.mode === 'demo'), [accounts]);

  const [bots, setBots] = useState<ImportedBot[]>([]);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [activeRun, setActiveRun] = useState<BotRun | null>(null);

  const [xml, setXml] = useState<string>('');
  const [xmlLoading, setXmlLoading] = useState(false);
  const [stake, setStake] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextBots, nextRuns] = await Promise.all([listBots(), listBotRuns()]);
      setBots(nextBots);
      setRuns(nextRuns);
      setSelectedBotId((current) => {
        if (current && nextBots.some((b) => b.id === current)) return current;
        const preferred = nextBots.find((b) => b.compatibility.level === 'full') ?? nextBots[0];
        return preferred?.id ?? null;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The bots could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!accountId && demoAccounts.length > 0) setAccountId(demoAccounts[0].accountId);
  }, [accountId, demoAccounts]);

  const loadXml = useCallback(async (botId: string) => {
    setXmlLoading(true);
    try {
      setXml(await fetchBotXml(botId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The strategy XML could not be loaded.');
    } finally {
      setXmlLoading(false);
    }
  }, []);

  // Load the selected bot's XML whenever the selection changes.
  useEffect(() => {
    if (selectedBotId) void loadXml(selectedBotId);
    else setXml('');
  }, [selectedBotId, loadXml]);

  const selectedBot = bots.find((b) => b.id === selectedBotId) ?? null;
  const running = activeRun?.runtimeStatus === 'running';

  useEffect(() => {
    if (!running || !activeRun) return;
    const runId = activeRun.runId;
    const id = setInterval(() => {
      void (async () => {
        try {
          const result = await tickBotRun(runId);
          setActiveRun(result.run);
          if (result.run.runtimeStatus !== 'running') {
            setNotice(`Run finished: ${result.run.counters.entries} entr${result.run.counters.entries === 1 ? 'y' : 'ies'}.`);
            void load();
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : 'The run could not be ticked.');
          setActiveRun((current) => (current ? { ...current, runtimeStatus: 'error' } : current));
        }
      })();
    }, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [running, activeRun?.runId, load]);

  const start = async () => {
    if (!selectedBot || !accountId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await startBotRun(selectedBot.id, accountId, 'demo');
      setActiveRun(result.run);
      setNotice('Run started. It copies to your connected clients while this page stays open.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The bot could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!activeRun) return;
    setBusy(true);
    setError(null);
    try {
      const run = await stopBotRun(activeRun.runId);
      setActiveRun(run);
      setNotice('Run stopped.');
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The run could not be stopped.');
    } finally {
      setBusy(false);
    }
  };

  const applyStake = () => {
    const value = Number(stake);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter a stake greater than zero.');
      return;
    }
    const next = setBaseStake(xml, value);
    if (next === xml) {
      setNotice('Could not find a base-stake field to rewrite — edit the XML directly below.');
    } else {
      setXml(next);
      setNotice(`Stake set to ${value}. Save to apply it to the next run.`);
    }
    setError(null);
  };

  const save = async () => {
    if (!selectedBot) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveBotTree(selectedBot.id, xml);
      setNotice(`Saved (revision ${result.revision}). The next run uses this version.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The strategy could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    if (!selectedBot) return;
    setBusy(true);
    setError(null);
    try {
      await revertBot(selectedBot.id);
      await loadXml(selectedBot.id);
      setNotice('Reverted to the imported file.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The strategy could not be reverted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
            <Bot className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Copy-enabled runner</p>
            <h1 className="mt-1 text-2xl font-bold text-ink">Bot Builder</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
              Run an imported bot on your demo account. Every entry goes through the execution gateway, so it is
              mirrored to your connected copy-trading clients. Ticking is browser-driven — keep this page open.
            </p>
          </div>
        </div>
      </header>

      {error && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}
      {notice && <div className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">{notice}</div>}

      <section className="rounded-2xl border border-line bg-surface p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Bot</span>
            <select
              value={selectedBotId ?? ''}
              onChange={(e) => setSelectedBotId(e.target.value || null)}
              disabled={loading || bots.length === 0}
              className="rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-ink disabled:opacity-50"
            >
              {bots.length === 0 && <option value="">No imported bots</option>}
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name} — {compatLabel(bot.compatibility.level)}
                </option>
              ))}
            </select>
            {selectedBot && (
              <span className={`text-xs font-semibold ${compatClass(selectedBot.compatibility.level)}`}>
                {compatLabel(selectedBot.compatibility.level)}
                {selectedBot.symbol ? ` · ${selectedBot.symbol}` : ''}
                {selectedBot.contractType ? ` · ${selectedBot.contractType}` : ''}
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Demo account</span>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={demoAccounts.length === 0}
              className="rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-ink disabled:opacity-50"
            >
              {demoAccounts.length === 0 && <option value="">No demo account</option>}
              {demoAccounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.accountId}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">
              {demoAccounts.length === 0
                ? 'Connect a Deriv demo account to run a bot.'
                : 'Copy trading is demo-only; a real account is never used here.'}
            </span>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {!running ? (
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy || loading || !selectedBot || !accountId || selectedBot?.compatibility.level === 'unsupported' || selectedBot?.compatibility.level === 'invalid'}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run bot
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-danger px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />} Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-elevated px-4 py-2.5 text-sm font-semibold text-ink transition hover:border-accent/50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {running && (
            <span className="inline-flex items-center gap-2 text-xs font-semibold text-live">
              <span className="h-2 w-2 animate-pulse rounded-full bg-live" /> Running
            </span>
          )}
        </div>

        {activeRun && (
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Ticks" value={activeRun.counters.ticks} />
            <Stat label="Signals" value={activeRun.counters.signals} />
            <Stat label="Entries" value={activeRun.counters.entries} />
            <Stat label="Rejected" value={activeRun.counters.rejected} />
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-4 w-4 text-accent" aria-hidden="true" />
            <h2 className="text-sm font-bold text-ink">Strategy XML</h2>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase tracking-wide text-muted">Stake (USD)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                placeholder="e.g. 1.00"
                className="w-28 rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-ink"
              />
            </label>
            <button
              type="button"
              onClick={applyStake}
              disabled={!xml || busy}
              className="rounded-lg border border-line bg-elevated px-3 py-2 text-xs font-semibold text-ink transition hover:border-accent/50 disabled:opacity-50"
            >
              Apply stake
            </button>
          </div>
        </div>

        {xmlLoading ? (
          <p className="mt-3 inline-flex items-center gap-2 text-sm text-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading XML…
          </p>
        ) : (
          <textarea
            value={xml}
            onChange={(e) => setXml(e.target.value)}
            spellCheck={false}
            rows={14}
            disabled={!selectedBot}
            className="mt-3 w-full rounded-lg border border-line bg-elevated p-3 font-mono text-[11px] leading-relaxed text-ink disabled:opacity-50"
          />
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!selectedBot || busy || xmlLoading}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white transition hover:bg-accent-strong disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" /> Save changes
          </button>
          <button
            type="button"
            onClick={() => void revert()}
            disabled={!selectedBot || busy || xmlLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-line bg-elevated px-4 py-2 text-xs font-semibold text-ink transition hover:border-accent/50 disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" /> Revert to import
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Saving creates a new revision used on the next run. The stake field rewrites the base-stake value; edit the
          XML directly for anything else.
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-accent" aria-hidden="true" />
          <h2 className="text-sm font-bold text-ink">Recent runs</h2>
        </div>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No runs yet. Start a bot above to see it here.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {runs.slice(0, 8).map((run) => (
              <li key={run.runId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="inline-flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${run.runtimeStatus === 'running' ? 'bg-live' : run.runtimeStatus === 'error' ? 'bg-danger' : 'bg-muted'}`} />
                  <span className="text-ink">{run.accountId}</span>
                  <span className="text-muted">· {run.symbol ?? '—'}</span>
                </span>
                <span className="text-muted">
                  {run.counters.entries} entr{run.counters.entries === 1 ? 'y' : 'ies'} · {run.runtimeStatus}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-elevated px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-bold text-ink">{value}</p>
    </div>
  );
}