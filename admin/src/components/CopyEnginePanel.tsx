import { useState } from 'react';
import { Activity, AlertTriangle, Pause, Play, RefreshCw } from 'lucide-react';
import { useAsync } from '../lib/hooks';
import { copyControlApi, copyTradingApi, type CopyControlView } from '../lib/copyTrading';
import { Badge, Card, Empty, LoadingBlock, Notice, StatCard } from './UI';
import { formatCurrency, formatDateTime, formatNumber } from '../lib/format';

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
  onNotify: (kind: 'success' | 'error' | 'info', title: string, message?: string) => void;
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

  const view = control.data?.control ?? null;

  const toggle = async (next: boolean) => {
    if (!masterId) return;
    setBusy(true);
    try {
      const result = await copyControlApi.set({ masterUserId: masterId, enabled: next });
      onNotify('success', next ? 'Copy trading started' : 'Copy trading stopped', result.note);
      control.reload();
      performance.reload();
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      onNotify(
        'error',
        'The switch could not be changed',
        code === 'no_followers'
          ? 'Connect at least one client to this master before starting.'
          : code.replace(/_/g, ' ') || 'Please try again.'
      );
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
