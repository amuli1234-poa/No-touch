import { Activity, AlertTriangle, Users, Wallet } from 'lucide-react';
import { Card, StatCard, Notice, LoadingBlock, PageHeader, Badge } from '../../components/UI';
import { useAsync } from '../../lib/hooks';
import { formatCurrency, formatNumber } from '../../lib/format';
import { copyReportingApi } from '../../lib/copyTrading';

/** Platform-wide copy-trading overview. Every figure is read from stored records. */
export function CopyOverviewPage() {
  const { data, loading, error } = useAsync(() => copyReportingApi.overview(), []);

  return (
    <>
      <PageHeader
        title="Copy Trading Overview"
        subtitle="Clients, executions and revenue across the platform. All figures come from verified backend records."
      />
      {loading ? (
        <LoadingBlock label="Loading overview…" />
      ) : error ? (
        <Notice kind="danger">{error.message}</Notice>
      ) : data ? (
        <>
          <div className="grid grid-4 mb">
            <StatCard label="Total clients" value={formatNumber(data.clients.total)} icon={<Users size={14} />} />
            <StatCard label="Active clients" value={formatNumber(data.clients.active)} tone="success" />
            <StatCard label="Pending authorizations" value={formatNumber(data.clients.pendingAuthorizations)} tone="warn" />
            <StatCard label="Trades today" value={formatNumber(data.today.trades)} tone="violet" icon={<Activity size={14} />} />
          </div>
          <div className="grid grid-4 mb">
            <StatCard
              label="Today's realized P/L"
              value={formatCurrency(data.today.realisedPnl)}
              tone={data.today.realisedPnl >= 0 ? 'success' : 'danger'}
            />
            <StatCard label="Confirmed markup" value={formatCurrency(data.revenue.confirmedMarkup)} tone="success" hint="Collected revenue" icon={<Wallet size={14} />} />
            <StatCard label="Estimated markup" value={formatCurrency(data.revenue.estimatedMarkup)} hint="Not yet collected" />
            <StatCard label="Performance commissions" value={formatCurrency(data.revenue.performanceCommissions)} tone="violet" hint="Manager 40% share" />
          </div>

          {data.warnings.length > 0 && (
            <Card title="Operational warnings" className="mb" tight>
              <div className="card-body">
                {data.warnings.map((w) => (
                  <Notice key={w} kind="warn" icon={<AlertTriangle size={16} />}>
                    {w}
                  </Notice>
                ))}
              </div>
            </Card>
          )}

          <div className="grid grid-2">
            <StatCard
              label="Failed executions"
              value={formatNumber(data.execution.failed)}
              tone={data.execution.failed > 0 ? 'danger' : 'success'}
              hint="Rejected or failed intents"
            />
            <StatCard
              label="Awaiting reconciliation"
              value={formatNumber(data.execution.stuck)}
              tone={data.execution.stuck > 0 ? 'warn' : 'success'}
              hint="Unknown / reconciliation required"
              icon={<Badge tone="slate">read-only</Badge>}
            />
          </div>
        </>
      ) : null}
    </>
  );
}