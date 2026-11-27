import { RefreshCw } from 'lucide-react';
import { Card, Badge, Empty, LoadingBlock, Notice, PageHeader } from '../../components/UI';
import { useAsync } from '../../lib/hooks';
import { formatCurrency, formatDateTime, formatNumber } from '../../lib/format';
import { copyReportingApi } from '../../lib/copyTrading';

function statusTone(status: string): string {
  if (status === 'won' || status === 'sold') return 'green';
  if (status === 'lost') return 'red';
  if (status === 'open') return 'blue';
  if (status === 'cancelled') return 'slate';
  return 'amber';
}

/** Live execution monitor: recent contracts across the whole book, newest first. */
export function CopyExecutionsPage() {
  const { data, loading, error, reload } = useAsync(() => copyReportingApi.executions(100), []);

  return (
    <>
      <PageHeader
        title="Live Executions"
        subtitle="Recent contracts across every client account. Read-only; the server owns execution."
        actions={
          <button className="btn btn-ghost btn-sm" onClick={reload} aria-label="Refresh executions">
            <RefreshCw size={14} /> Refresh
          </button>
        }
      />
      {loading ? (
        <LoadingBlock label="Loading executions…" />
      ) : error ? (
        <Notice kind="danger">{error.message}</Notice>
      ) : data && data.items.length > 0 ? (
        <Card tight>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Principal</th>
                  <th>Account</th>
                  <th>Symbol</th>
                  <th>Type</th>
                  <th className="num">Stake</th>
                  <th>Status</th>
                  <th className="num">P/L</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.contractId}>
                    <td className="mono">{row.contractId}</td>
                    <td>{row.userId.startsWith('copy_follower_') ? 'Client' : 'Master'}</td>
                    <td>{row.accountId}</td>
                    <td>{row.symbol}</td>
                    <td>{row.contractType}</td>
                    <td className="num">{formatNumber(row.stake)} {row.currency}</td>
                    <td>
                      <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                    </td>
                    <td className="num">{row.profit === null ? '—' : formatCurrency(row.profit, row.currency)}</td>
                    <td className="small muted">{formatDateTime(row.purchaseTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Empty title="No executions yet">Contracts appear here once the master or a client places a trade.</Empty>
      )}
    </>
  );
}