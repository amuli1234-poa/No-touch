import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../lib/auth';
import { useBotRun, type BotRunVerdict } from '../../lib/bots';
import { fetchExecutionContracts, type ExecutionContract } from '../../lib/trade';

/**
 * One execution state for the whole builder.
 *
 * The run control floats over the workspace and the run panel sits beside it.
 * They are two views of the same run, so the state has to live above both:
 * two `useBotRun` instances would each drive their own tick loop and the bot
 * would advance twice per interval.
 *
 * Nothing here places a trade on its own. `start` opens a DEMO run through the
 * server, which still applies its own flags and risk checks.
 */

/** Session totals for the panel's statistic tiles. */
export interface ExecutionStats {
  totalStake: number;
  totalPayout: number;
  won: number;
  lost: number;
  open: number;
  pnl: number;
  currency: string;
}

export interface BotExecution {
  authenticated: boolean;
  demoAccounts: { accountId: string; currency?: string }[];
  accountId: string;
  setAccountId: (id: string) => void;
  maxEntries: number;
  setMaxEntries: (value: number) => void;
  run: ReturnType<typeof useBotRun>['run'];
  error: ReturnType<typeof useBotRun>['error'];
  busy: boolean;
  lastVerdict: BotRunVerdict | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  active: boolean;
  canStart: boolean;
  contracts: ExecutionContract[];
  contractsError: string | null;
  stats: ExecutionStats;
  /** Contracts on the selected account, newest first. */
  recent: ExecutionContract[];
  /**
   * Statistics are derived from the account's contracts, which the server
   * owns, so they cannot be deleted. Reset moves a baseline instead: the tiles
   * then report what happened since it, which is what the readout is for.
   */
  resetStats: () => void;
  /** True once a reset has been made, so the panel can say "since reset". */
  hasBaseline: boolean;
}

export function useBotExecution(
  botId: string,
  options: { runnable: boolean; dirty: boolean }
): BotExecution {
  const auth = useAuth();
  const { run, error, busy, lastVerdict, start: runStart, stop } = useBotRun(botId);
  const [maxEntries, setMaxEntries] = useState(1);
  const [contracts, setContracts] = useState<ExecutionContract[]>([]);
  const [contractsError, setContractsError] = useState<string | null>(null);
  // Newest purchase time at the moment of reset; contracts at or before it are
  // excluded from the tiles.
  const [baseline, setBaseline] = useState<number | null>(null);

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
    options.runnable &&
    !active &&
    !busy &&
    !options.dirty &&
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

  // Refresh while a run is live, and once when it settles, so the panel shows
  // what the run actually opened rather than a stale list.
  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    void loadContracts();
    if (!active) return;
    const timer = window.setInterval(() => void loadContracts(), 8000);
    return () => window.clearInterval(timer);
  }, [auth.status, active, loadContracts]);

  const recent = useMemo(() => {
    if (!accountId) return [];
    return contracts
      .filter((c) => c.accountId === accountId)
      .slice()
      .sort((a, b) => b.purchaseTime - a.purchaseTime);
  }, [contracts, accountId]);

  const stats = useMemo<ExecutionStats>(() => {
    let totalStake = 0;
    let totalPayout = 0;
    let won = 0;
    let lost = 0;
    let open = 0;
    let pnl = 0;
    for (const c of recent) {
      if (baseline !== null && c.purchaseTime <= baseline) continue;
      totalStake += c.stake;
      if (c.status === 'open') {
        open += 1;
        continue;
      }
      if (c.profit === null) continue;
      pnl += c.profit;
      if (c.status === 'won') {
        won += 1;
        // A won contract pays stake plus profit back; a lost one pays nothing.
        totalPayout += c.stake + c.profit;
      } else if (c.status === 'lost') {
        lost += 1;
      } else {
        totalPayout += c.stake + c.profit;
      }
    }
    return {
      totalStake,
      totalPayout,
      won,
      lost,
      open,
      pnl,
      currency: recent[0]?.currency ?? demoAccounts[0]?.currency ?? 'USD'
    };
  }, [recent, demoAccounts, baseline]);

  const resetStats = useCallback(() => {
    setBaseline(recent[0]?.purchaseTime ?? Date.now());
  }, [recent]);

  const start = useCallback(async () => {
    if (!accountId) return;
    await runStart(accountId, maxEntries);
  }, [accountId, maxEntries, runStart]);

  const stopRun = useCallback(async () => {
    await stop();
  }, [stop]);

  return {
    authenticated: auth.status === 'authenticated',
    demoAccounts,
    accountId,
    setAccountId,
    maxEntries,
    setMaxEntries,
    run,
    error,
    busy,
    lastVerdict,
    start,
    stop: stopRun,
    active,
    canStart,
    contracts,
    contractsError,
    stats,
    recent,
    resetStats,
    hasBaseline: baseline !== null
  };
}
