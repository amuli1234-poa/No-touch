import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Pause, Play, RefreshCw } from 'lucide-react';
import { useAsync } from '../lib/hooks';
import { isOutcomeUnknown } from '../lib/api';
import { copyControlApi, copyTradingApi, type ClientBalanceAccount, type CopyControlView } from '../lib/copyTrading';
import { Badge, Card, Empty, LoadingBlock, Notice, StatCard } from './UI';
import { CopyReadinessPanel } from './CopyReadinessPanel';
import { formatCurrency, formatDateTime, formatNumber } from '../lib/format';

/**
 * Operator-facing text for a switch request the backend definitively rejected.
 *
 * Only reachable for a real answer (4xx), never for an ambiguous outcome: those
 * are reported as "state unknown" by the caller, which is a different thing to
 * say and calls for a different action.
 */
function controlErrorMessage(code: string): string {
  switch (code) {
    case 'no_followers':
      return 'Connect at least one client to this master before starting.';
    case 'forbidden':
      return 'Your administrator role may view copy trading but not start or stop it.';
    case 'csrf_failed':
      return 'Your security token was out of date. Reload the page and try again.';
    case 'master_not_found':
      return 'That master no longer exists. Reload the list and select another.';
    case 'master_required':
    case 'enabled_required':
      return 'The request was incomplete. Reload the page and try again.';
    case 'admin_unauthorized':
    case 'unauthorized':
      return 'Your administrator session has expired. Sign in again.';
    default:
      return code ? `The server rejected the change (${code.replace(/_/g, ' ')}).` : 'Please try again.';
  }
}

/**
 * Start/Stop control and profit-and-loss dashboard for the copy engine.
 *
 * The switch is per master because each master manages their own clients. It is
 * off by default: a master's trade is theirs alone until an operator starts
 * copying. Stopping never cancels a contract already open at the broker.
 */
export function CopyEnginePanel({
  canControl,
  onNotify
}: {
  canControl: boolean;
  onNotify: (kind: 'success' | 'error' | 'info' | 'warn', title: string, message?: string) => void;
}) {
  const masters = useAsync(() => copyTradingApi.listMasters(), []);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const masterId = selected || masters.data?.items[0]?.userId || '';
  const control = useAsync(
    () => (masterId ? copyControlApi.get(masterId) : Promise.resolve(null)),
    [masterId]
  );
  const performance = useAsync(
    () => (masterId ? copyControlApi.performance(masterId) : Promise.resolve(null)),
    [masterId]
  );
  // Read-only: this asks the backend what it can prove about readiness. It never
  // creates or enables a control, so it is safe to load alongside the switch.
  const readiness = useAsync(
    () => (masterId ? copyControlApi.readiness(masterId) : Promise.resolve(null)),
    [masterId]
  );

  const view = control.data?.control ?? null;

  // Balances are read live from Deriv, separately from the P/L figures, so a
  // missing figure renders as "—" rather than delaying the table.
  const [balances, setBalances] = useState<Record<string, ClientBalanceAccount>>({});
  const accountKey = (performance.data?.accounts ?? [])
    .map((row) => `${row.followerId ?? 'master'}:${row.accountId}`)
    .join('|');

  useEffect(() => {
    const rows = performance.data?.accounts ?? [];
    if (rows.length === 0) {
      setBalances({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, ClientBalanceAccount> = {};
      const followerIds = [
        ...new Set(rows.map((r) => r.followerId).filter((id): id is string => id !== null))
      ];
      for (const followerId of followerIds) {
        try {
          const result = await copyTradingApi.balance(followerId);
          for (const account of result.accounts) next[account.accountId] = account;
        } catch {
          // Leave the cell as "—"; the read is advisory, not part of the P/L.
        }
      }
      if (!cancelled) setBalances(next);
    })();
    return () => { cancelled = true; };
  }, [accountKey]);

  /**
   * Applies the switch and reports only what the backend can prove.
   *
   * The mutation is never applied optimistically: the button reflects
   * `control.data`, which is re-read from the backend afterwards. A request that
   * fails ambiguously (no response at all, or a 5xx) is *not* reported as a failed
   * change, because the server may have committed it and then failed to answer —
   * that is exactly how the switch used to end up enabled while the console said
   * "network error". In that case the persisted state is re-read and the operator
   * is told the state is unknown rather than being invited to retry a write that
   * may already have landed.
   */
  const toggle = async (next: boolean) => {
    if (!masterId) return;
    setBusy(true);
    const reload = () => {
      control.reload();
      performance.reload();
      readiness.reload();
    };
    try {
      const result = await copyControlApi.set({ masterUserId: masterId, enabled: next });
      // The POST returns the persisted record, but re-read it so the panel shows
      // what the backend actually holds rather than what it said it wrote.
      const confirmed = await copyControlApi.get(masterId).catch(() => null);
      const persisted = confirmed?.control.enabled ?? result.control.enabled;
      if (persisted === next) {
        onNotify('success', next ? 'Copy trading started' : 'Copy trading stopped', result.note);
      } else {
        onNotify(
          'warn',
          'The switch did not change',
          `The server accepted the request but still reports ${persisted ? 'started' : 'stopped'}. Reload before trying again.`
        );
      }
      reload();
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      if (isOutcomeUnknown(err)) {
        // Ambiguous: refresh what the backend holds, then say so plainly.
        let observed: boolean | null = null;
        try {
          observed = (await copyControlApi.get(masterId)).control.enabled;
        } catch {
          observed = null;
        }
        reload();
        onNotify(
          'warn',
          'Switch state unknown — verify status',
          observed === null
            ? 'The server could not be reached to confirm the change. Check the switch once the console reconnects.'
            : `The change could not be confirmed. The backend currently reports copy trading as ${observed ? 'started' : 'stopped'}.`
        );
        return;
      }
      onNotify('error', 'The switch could not be changed', controlErrorMessage(code));
    } finally {
      setBusy(false);
    }
  };

  const totals = performance.data?.totals;
  const pnl = totals?.realisedPnl ?? 0;

  return (
    <Card
      title="Copy engine"
      subtitle="Start or stop mirroring a master's DEMO trades onto the clients they manage."
      actions={
        <div className="row gap-sm">
          <select
            className="select"
            value={masterId}
            onChange={(e) => setSelected(e.target.value)}
            style={{ minWidth: 220 }}
            aria-label="Select master trader"
          >
            {(masters.data?.items ?? []).length === 0 && <option value="">No masters available</option>}
            {(masters.data?.items ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.loginId ?? m.userId} · {m.clients} client{m.clients === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          <button
            className={`btn ${view?.enabled ? 'btn-danger' : 'btn-primary'}`}
            disabled={!masterId || busy || !canControl || control.loading}
            onClick={() => void toggle(!(view?.enabled ?? false))}
          >
            {view?.enabled ? <Pause size={15} /> : <Play size={15} />}
            {view?.enabled ? 'Stop copy trading' : 'Start copy trading'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              control.reload();
              performance.reload();
              readiness.reload();
            }}
            aria-label="Refresh copy engine status"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      }
    >
      {!canControl && (
        <Notice kind="warn">
          You can view copy-trading status, but starting or stopping the engine needs the{' '}
          <code>copytrading.control</code> permission.
        </Notice>
      )}

      {control.loading ? (
        <LoadingBlock label="Loading copy engine…" />
      ) : control.error ? (
        <Empty title="Copy engine status could not be loaded" icon={<AlertTriangle size={22} />}>
          {control.error.code.replace(/_/g, ' ')}
        </Empty>
      ) : !view ? (
        <Empty title="Select a master trader">
          Copying is configured per master. Choose the master whose clients you want to copy.
        </Empty>
      ) : (
        <>
          <div className="grid grid-4 mb">
            <StatCard
              label="Engine state"
              value={<Badge tone={view.enabled ? 'green' : 'amber'}>{view.enabled ? 'Running' : 'Stopped'}</Badge>}
              icon={<Activity size={14} />}
              hint={view.updatedAt ? `Changed ${formatDateTime(view.updatedAt)}` : 'Never started'}
            />
            <StatCard
              label="Eligible clients"
              value={formatNumber(view.followers.eligible)}
              tone="violet"
              hint={`${view.followers.held} held of ${view.followers.total}`}
            />
            <StatCard
              label="Net profit / loss"
              value={formatCurrency(pnl)}
              tone={pnl > 0 ? 'success' : pnl < 0 ? 'danger' : 'blue'}
              hint="Realised, across all accounts"
            />
            <StatCard
              label="Return on stake"
              value={totals?.roiPercent === null || totals?.roiPercent === undefined ? '—' : `${totals.roiPercent.toFixed(2)}%`}
              tone={(totals?.roiPercent ?? 0) > 0 ? 'success' : (totals?.roiPercent ?? 0) < 0 ? 'danger' : 'blue'}
              hint={`${formatNumber(totals?.wins ?? 0)} wins / ${formatNumber(totals?.losses ?? 0)} losses`}
            />
          </div>

          {view.stoppedReason && !view.enabled && (
            <Notice kind="warn">Stopped: {view.stoppedReason}</Notice>
          )}

          <div className="mb">
            <CopyReadinessPanel
              readiness={readiness.data?.readiness ?? null}
              loading={readiness.loading}
              error={readiness.error}
            />
          </div>

          {performance.loading ? (
            <LoadingBlock label="Loading performance…" />
          ) : (performance.data?.accounts.length ?? 0) === 0 ? (
            <Empty title="No accounts to report yet">
              Performance appears once the master or a connected client has traded.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Owner</th>
                    <th>Trades</th>
                    <th>Open</th>
                    <th>Wins</th>
                    <th>Losses</th>
                    <th>Staked</th>
                    <th>Profit / loss</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {(performance.data?.accounts ?? []).map((row) => (
                    <tr key={`${row.followerId ?? 'master'}:${row.accountId}`}>
                      <td>
                        <div className="col gap-sm">
                          <strong>{row.loginId ?? row.accountId}</strong>
                          <span className="tiny muted">{row.accountId}</span>
                        </div>
                      </td>
                      <td>
                        <Badge tone={row.followerId === null ? 'blue' : 'violet'}>
                          {row.followerId === null ? 'Master' : 'Client'}
                        </Badge>
                      </td>
                      <td>{formatNumber(row.trades)}</td>
                      <td>{formatNumber(row.openTrades)}</td>
                      <td>{formatNumber(row.wins)}</td>
                      <td>{formatNumber(row.losses)}</td>
                      <td>{formatCurrency(row.staked, row.currency)}</td>
                      <td>
                        <strong
                          style={{
                            color:
                              row.realisedPnl > 0 ? 'var(--success)' : row.realisedPnl < 0 ? 'var(--danger)' : undefined
                          }}
                        >
                          {formatCurrency(row.realisedPnl, row.currency)}
                        </strong>
                      </td>
                      <td>
                        {(() => {
                          const balance = balances[row.accountId];
                          if (!balance || balance.balance === null) return <span className="muted">—</span>;
                          return (
                            <strong>
                              {formatCurrency(balance.balance, balance.currency ?? row.currency)}
                              {balance.state !== 'ok' && <span className="tiny muted"> {balance.state}</span>}
                            </strong>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export type { CopyControlView };
