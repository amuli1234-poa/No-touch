import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DollarSign, RefreshCw } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { formatMoney } from '../../lib/balances';
import { isHiddenSettledContract, summarizeContracts } from '../../lib/positions';
import {
  closeExecutionContract,
  fetchExecutionContracts,
  type AccountMode,
  type ExecutionContract
} from '../../lib/trade';
import { Card, EmptyState, SectionCard, StatTile } from '../ui/primitives';

type PositionsTab = 'open' | 'closed';

function formatPnl(amount: number | null, currency: string): string {
  if (amount === null) return 'Unavailable';
  return `${amount > 0 ? '+' : ''}${formatMoney(amount, currency)}`;
}

function pnlClass(amount: number | null): string {
  if (amount === null || amount === 0) return 'text-ink';
  return amount > 0 ? 'text-success' : 'text-bear';
}

function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  return new Date(seconds * 1000).toLocaleString();
}

function directionLabel(contractType: ExecutionContract['contractType']): string {
  return contractType === 'CALL' || contractType === 'MULTUP' ? 'Rise' : 'Fall';
}

function statusLabel(status: ExecutionContract['status'], closePending: boolean): string {
  if (closePending) return 'Close pending';
  return status === 'unknown' ? 'Unconfirmed' : status;
}

export function ExecutionPositions() {
  const auth = useAuth();
  const [mode, setMode] = useState<AccountMode>('demo');
  const [tab, setTab] = useState<PositionsTab>('open');
  const [contracts, setContracts] = useState<ExecutionContract[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [closeConfirmId, setCloseConfirmId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [historyHiddenBefore, setHistoryHiddenBefore] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [deleteHistoryConfirm, setDeleteHistoryConfirm] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const historyStorageKey =
    auth.status === 'authenticated' ? `wicksentinel_history_hidden_before:${auth.user.id}` : null;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (mounted.current) setRefreshing(true);
    try {
      const result = await fetchExecutionContracts();
      if (!mounted.current) return;
      if (result.ok) {
        setContracts(result.contracts);
        setError(null);
        setUpdatedAt(Date.now());
      } else {
        setError(result.message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!historyStorageKey) {
      setHistoryHiddenBefore(null);
      return;
    }
    try {
      const saved = window.localStorage.getItem(historyStorageKey);
      const cutoff = saved === null ? null : Number(saved);
      if (cutoff !== null && (!Number.isFinite(cutoff) || cutoff <= 0)) {
        setHistoryError('The saved history view setting is invalid. Restore or reset it to continue.');
        return;
      }
      setHistoryHiddenBefore(cutoff);
      setHistoryError(null);
    } catch {
      setHistoryError('Could not load the saved history view setting.');
    }
  }, [historyStorageKey]);

  const hideClosedHistory = () => {
    if (!historyStorageKey) return;
    const cutoff = Date.now();
    try {
      window.localStorage.setItem(historyStorageKey, String(cutoff));
      setHistoryHiddenBefore(cutoff);
      setHistoryError(null);
    } catch {
      setHistoryError('Could not save the history view setting.');
    }
  };

  const restoreClosedHistory = () => {
    if (!historyStorageKey) return;
    try {
      window.localStorage.removeItem(historyStorageKey);
      setHistoryHiddenBefore(null);
      setHistoryError(null);
    } catch {
      setHistoryError('Could not restore the hidden history.');
    }
  };

  const visibleHistoryContracts = useMemo(
    () => (contracts ?? []).filter((contract) => !isHiddenSettledContract(contract, historyHiddenBefore)),
    [contracts, historyHiddenBefore]
  );
  const modeContracts = useMemo(
    () => visibleHistoryContracts.filter((contract) => contract.accountMode === mode),
    [visibleHistoryContracts, mode]
  );
  const summaries = useMemo(
    () => summarizeContracts(visibleHistoryContracts, mode),
    [visibleHistoryContracts, mode]
  );
  const hiddenClosedCount = (contracts ?? []).filter(
    (contract) => contract.accountMode === mode && isHiddenSettledContract(contract, historyHiddenBefore)
  ).length;
  const visibleContracts = modeContracts
    .filter((contract) => (tab === 'open' ? contract.status === 'open' : contract.status !== 'open'))
    .sort((a, b) => b.purchaseTime - a.purchaseTime);
  const closeConfirmContract =
    tab === 'open'
      ? modeContracts.find(
          (contract) => contract.id === closeConfirmId && contract.status === 'open' && !contract.closePending
        )
      : undefined;

  const submitClose = async () => {
    if (!closeConfirmContract || closingId !== null) return;
    const contractId = closeConfirmContract.id;
    setClosingId(contractId);
    setCloseError(null);
    try {
      const result = await closeExecutionContract(contractId);
      if (!mounted.current) return;
      if (!result.ok) setCloseError(result.message);
      setCloseConfirmId(null);
      await refresh();
    } finally {
      if (mounted.current) setClosingId(null);
    }
  };

  return (
    <SectionCard
      title="Account positions"
      subtitle="Live and settled profit/loss from your Deriv contracts. Demo and Real are kept separate."
      icon={<DollarSign className="w-4 h-4" />}
      className="@container min-w-0"
      right={
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
            {(['demo', 'real'] as const).map((accountMode) => (
              <button
                key={accountMode}
                type="button"
                aria-pressed={mode === accountMode}
                onClick={() => setMode(accountMode)}
                className={`px-2.5 py-1 text-[11px] font-bold uppercase rounded ${
                  mode === accountMode ? 'bg-accent text-app' : 'text-muted hover:text-ink'
                }`}
              >
                {accountMode}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh account positions"
            className="inline-flex items-center justify-center w-8 h-8 text-muted bg-surface border border-line rounded-md hover:bg-elevated disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      }
    >
      {error && (
        <div role="alert" className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          {error}
        </div>
      )}
      {closeError && (
        <div role="alert" className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          {closeError}
        </div>
      )}
      {historyError && (
        <div role="alert" className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          {historyError}
        </div>
      )}
      {closeConfirmContract && (
        <div
          role="group"
          aria-label="Confirm position close"
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2"
        >
          <p className="text-[12px] text-ink">
            Sell {closeConfirmContract.symbol} at Deriv&apos;s current market price? Final proceeds and P/L may differ
            from the live estimate.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void submitClose()}
              disabled={closingId !== null}
              className="rounded-md border border-bear/30 bg-bear/10 px-2.5 py-1.5 text-[11px] font-bold text-bear hover:bg-bear/20 disabled:opacity-50 cursor-pointer"
            >
              {closingId === closeConfirmContract.id ? 'Closing…' : 'Confirm sale'}
            </button>
            <button
              type="button"
              onClick={() => setCloseConfirmId(null)}
              disabled={closingId !== null}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11px] font-bold text-muted hover:bg-elevated disabled:opacity-50 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {deleteHistoryConfirm && tab === 'closed' && (
        <div
          role="group"
          aria-label="Confirm deleting closed positions from history"
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2"
        >
          <p className="text-[12px] text-ink">
            Remove all currently closed positions from this history view, across DEMO and REAL accounts? Server
            contract and ledger records are retained for risk controls and audit, and can be restored here.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                hideClosedHistory();
                setDeleteHistoryConfirm(false);
              }}
              disabled={!historyStorageKey}
              className="rounded-md border border-bear/30 bg-bear/10 px-2.5 py-1.5 text-[11px] font-bold text-bear hover:bg-bear/20 disabled:opacity-50 cursor-pointer"
            >
              Confirm delete
            </button>
            <button
              type="button"
              onClick={() => setDeleteHistoryConfirm(false)}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11px] font-bold text-muted hover:bg-elevated cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {summaries.length > 0 && (
        <div className="grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-3 mb-4">
          {summaries.map((summary) => (
            <Card key={`${summary.accountId}:${summary.currency}`} className="p-3 min-w-0 @container">
              <div className="text-[12px] font-bold text-ink truncate">
                Account {summary.accountId} · {summary.currency}
              </div>
              <div className="grid grid-cols-1 @sm:grid-cols-2 gap-2 mt-2">
                <StatTile
                  label="Open P/L"
                  value={summary.openCount === 0 ? '—' : formatPnl(summary.openProfit, summary.currency)}
                  valueClass={pnlClass(summary.openProfit)}
                  hint={
                    summary.openCount === 0
                      ? 'No open positions'
                      : summary.openProfitUnavailableCount > 0
                        ? `${summary.openProfitUnavailableCount} live result unavailable`
                        : `${summary.openCount} open position${summary.openCount === 1 ? '' : 's'}`
                  }
                />
                <StatTile
                  label="Realized P/L"
                  value={
                    summary.closedCount === 0
                      ? '—'
                      : formatPnl(summary.realizedProfit, summary.currency)
                  }
                  valueClass={pnlClass(summary.realizedProfit)}
                  hint={
                    summary.closedCount === 0
                      ? 'No settled positions'
                      : summary.realizedProfitUnavailableCount > 0
                        ? `${summary.realizedProfitUnavailableCount} result unavailable`
                        : `${summary.closedCount} closed · ${summary.wins} wins · ${summary.losses} losses`
                  }
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
          {(['open', 'closed'] as const).map((positionsTab) => (
            <button
              key={positionsTab}
              type="button"
              aria-pressed={tab === positionsTab}
              onClick={() => setTab(positionsTab)}
              className={`px-3 py-1.5 text-[11px] font-bold capitalize rounded ${
                tab === positionsTab ? 'bg-elevated text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {positionsTab} ({modeContracts.filter((contract) =>
                positionsTab === 'open' ? contract.status === 'open' : contract.status !== 'open'
              ).length})
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {tab === 'closed' && modeContracts.some((contract) => contract.status !== 'open') && (
            <button
              type="button"
              onClick={() => setDeleteHistoryConfirm(true)}
              disabled={!historyStorageKey}
              className="rounded-md border border-bear/30 bg-bear/10 px-2 py-1 text-[11px] font-semibold text-bear hover:bg-bear/20 disabled:opacity-50 cursor-pointer"
            >
              <span>Delete closed history</span>
            </button>
          )}
          {tab === 'closed' && hiddenClosedCount > 0 && (
            <button
              type="button"
              onClick={restoreClosedHistory}
              disabled={!historyStorageKey}
              className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-semibold text-muted hover:bg-elevated disabled:opacity-50 cursor-pointer"
            >
              <span>Restore hidden ({hiddenClosedCount})</span>
            </button>
          )}
          {updatedAt !== null && (
            <span className="text-[11px] text-faint">
              Updated {new Date(updatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {loading && contracts === null ? (
        <p className="py-5 text-center text-xs text-muted">Loading account positions…</p>
      ) : visibleContracts.length === 0 ? (
        <EmptyState
          title={tab === 'open' ? 'No open positions' : 'No closed positions'}
          description={
            contracts === null
              ? 'Positions could not be loaded. Refresh or sign in again to retry.'
              : tab === 'closed' && hiddenClosedCount > 0
                ? `${hiddenClosedCount} older closed position${hiddenClosedCount === 1 ? ' is' : 's are'} hidden from this view.`
                : `No ${tab} ${mode.toUpperCase()} contracts are recorded yet.`
          }
        />
      ) : (
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="text-faint border-b border-line">
              <tr className="text-[11px] uppercase tracking-wide">
                <th className="py-2 pr-3 font-semibold">Market / contract</th>
                <th className="py-2 pr-3 font-semibold">Account</th>
                <th className="py-2 pr-3 font-semibold">Opened</th>
                <th className="py-2 pr-3 font-semibold text-right">Stake</th>
                <th className="py-2 pr-3 font-semibold text-right">Profit / loss</th>
                <th className="py-2 font-semibold text-right">Status</th>
                <th className="py-2 pl-3 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft font-mono tabular-nums">
              {visibleContracts.map((contract) => (
                <tr key={contract.id} className="hover:bg-elevated">
                  <td className="py-2.5 pr-3">
                    <div className="font-sans font-semibold text-ink">{contract.symbol}</div>
                    <div className="text-[11px] text-muted">
                      {directionLabel(contract.contractType)} · {contract.contractType}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-muted">{contract.accountId}</td>
                  <td className="py-2.5 pr-3 text-faint whitespace-nowrap">
                    {formatTimestamp(contract.purchaseTime)}
                  </td>
                  <td className="py-2.5 pr-3 text-right text-muted whitespace-nowrap">
                    {formatMoney(contract.stake, contract.currency)}
                  </td>
                  <td className={`py-2.5 pr-3 text-right font-bold whitespace-nowrap ${pnlClass(contract.profit)}`}>
                    {formatPnl(contract.profit, contract.currency)}
                  </td>
                  <td className="py-2.5 text-right">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        contract.status === 'won'
                          ? 'bg-success/10 text-success'
                          : contract.status === 'lost'
                            ? 'bg-bear/10 text-bear'
                            : contract.closePending
                              ? 'bg-warn/10 text-warn'
                              : contract.status === 'open'
                              ? 'bg-accent/10 text-accent'
                              : 'bg-elevated text-muted'
                      }`}
                    >
                      {statusLabel(contract.status, contract.closePending)}
                    </span>
                  </td>
                  <td className="py-2 pl-3 text-right whitespace-nowrap">
                    {contract.status === 'open' &&
                      (contract.closePending ? (
                        <span className="text-[11px] font-semibold text-warn">Waiting for Deriv</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setCloseError(null);
                            setCloseConfirmId(contract.id);
                          }}
                          disabled={closingId !== null}
                          aria-label={`Close ${contract.symbol} at market`}
                          className="rounded-md border border-bear/30 bg-bear/10 px-2 py-1 text-[11px] font-bold text-bear hover:bg-bear/20 disabled:opacity-50 cursor-pointer"
                        >
                          Close at market
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
