import { useState } from 'react';
import { Activity, BarChart3, Users } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Card, Empty, LoadingBlock, PageHeader, Sparkline, StatCard, UnavailableNote } from '../components/UI';
import { formatNumber, formatPercent } from '../lib/format';

/**
 * Analytics. Only metrics computable from real records are charted; anything
 * requiring an event history the platform does not retain is shown as
 * unavailable with an explanation.
 */

interface UserSeries {
  days: number;
  series: { date: string; newUsers: number; totalUsers: number }[];
  total: number;
}

interface ActiveUsers {
  withLiveSession: number;
  dau: number;
  mau: number;
  activeScannerSessions: number;
  signalsLast24h: number;
  lastEventAt: number | null;
}

interface FeatureUsage {
  days: number;
  items: { kind: string; count: number }[];
  topSymbols: { symbol: string; count: number }[];
  total: number;
}

/** Human labels for the event kinds the client reports. */
const KIND_LABELS: Record<string, string> = {
  'auth.login': 'Sign-ins',
  'auth.logout': 'Sign-outs',
  'app.opened': 'App opened',
  'scan.started': 'Scans started',
  'scan.stopped': 'Scans stopped',
  'signal.generated': 'Signals generated',
  'engine.error': 'Engine errors',
  'settings.changed': 'Settings changed'
};

export function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const users = useAsync<UserSeries>(() => api.get('/analytics/users' + qs({ days })), [days]);
  const active = useAsync<ActiveUsers>(() => api.get('/analytics/active-users'), []);
  const retention = useAsync<{ unavailable?: string }>(() => api.get('/analytics/retention'), []);
  const conversion = useAsync<{ rate: number | null; unavailable?: string }>(() => api.get('/analytics/conversion'), []);
  const churn = useAsync<{ rate: number | null; unavailable?: string }>(() => api.get('/analytics/churn'), []);
  const usage = useAsync<FeatureUsage>(() => api.get('/analytics/feature-usage' + qs({ days })), [days]);

  const series = users.data?.series ?? [];
  const totalNew = series.reduce((acc, p) => acc + p.newUsers, 0);

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Growth and engagement, computed from the records the platform actually holds."
        actions={
          <select className="select" style={{ width: 160 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 365 days</option>
          </select>
        }
      />

      <div className="grid grid-4 mb-lg">
        <StatCard label="Total users" value={formatNumber(users.data?.total ?? 0)} icon={<Users size={14} />} hint="All registered traders" />
        <StatCard label="New in period" value={formatNumber(totalNew)} tone="success" icon={<BarChart3 size={14} />} hint={`Last ${days} days`} />
        <StatCard label="Active today (DAU)" value={formatNumber(active.data?.dau ?? 0)} icon={<Activity size={14} />} hint="Produced an event in the last 24h" />
        <StatCard label="Conversion rate" value={conversion.data?.rate === null || conversion.data?.rate === undefined ? 'Unavailable' : formatPercent(conversion.data.rate)} unavailable tone="violet" icon={<BarChart3 size={14} />} hint="Needs subscription records" />
      </div>

      <Card title="User growth" subtitle={`New and cumulative users, last ${days} days`} className="mb-lg">
        {users.loading ? (
          <LoadingBlock />
        ) : series.some((p) => p.newUsers > 0) ? (
          <>
            <div className="mb">
              <div className="tiny faint mb" style={{ marginBottom: 6 }}>New users per day</div>
              <Sparkline points={series.map((p) => ({ label: p.date.slice(5), value: p.newUsers }))} />
            </div>
            <div>
              <div className="tiny faint mb" style={{ marginBottom: 6 }}>Cumulative users</div>
              <Sparkline points={series.map((p) => ({ label: p.date.slice(5), value: p.totalUsers }))} showArea={false} />
            </div>
          </>
        ) : (
          <Empty title="No growth in this period">No new registrations were recorded in the selected window.</Empty>
        )}
      </Card>

      <div className="grid grid-2 mb-lg">
        <Card title="Engagement" subtitle="Active users, from the activity log">
          {active.loading ? (
            <LoadingBlock />
          ) : (
            <div className="col gap">
              <div className="row-between">
                <span className="muted small">Users with a live session</span>
                <span className="strong">{formatNumber(active.data?.withLiveSession ?? 0)}</span>
              </div>
              <div className="row-between">
                <span className="muted small">Daily active users</span>
                <span className="strong">{formatNumber(active.data?.dau ?? 0)}</span>
              </div>
              <div className="row-between">
                <span className="muted small">Monthly active users</span>
                <span className="strong">{formatNumber(active.data?.mau ?? 0)}</span>
              </div>
              <div className="row-between">
                <span className="muted small">Active scanner sessions</span>
                <span className="strong">{formatNumber(active.data?.activeScannerSessions ?? 0)}</span>
              </div>
              <div className="row-between">
                <span className="muted small">Signals (last 24h)</span>
                <span className="strong">{formatNumber(active.data?.signalsLast24h ?? 0)}</span>
              </div>
              <div className="tiny faint">
                Active = at least one recorded event in the window. A user with no activity since telemetry began is
                not counted.
              </div>
            </div>
          )}
        </Card>

        <Card title="Feature usage" subtitle={`Event volume, last ${days} days`}>
          {usage.loading ? (
            <LoadingBlock />
          ) : usage.data && usage.data.items.length > 0 ? (
            <div className="col gap">
              {usage.data.items.map((i) => (
                <div className="row-between" key={i.kind}>
                  <span className="muted small">{KIND_LABELS[i.kind] ?? i.kind}</span>
                  <span className="strong">{formatNumber(i.count)}</span>
                </div>
              ))}
              {usage.data.topSymbols.length > 0 && (
                <div className="tiny faint" style={{ marginTop: 8 }}>
                  Top signal symbols: {usage.data.topSymbols.map((s) => `${s.symbol} (${s.count})`).join(', ')}
                </div>
              )}
            </div>
          ) : (
            <Empty title="No activity recorded yet">
              No client events have been reported in this window. Usage appears here once traders run the scanner.
            </Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Retention" subtitle="Cohort analysis">
          {retention.loading ? <LoadingBlock /> : <UnavailableNote text={retention.data?.unavailable ?? 'Retention data is not retained.'} />}
        </Card>
        <Card title="Churn" subtitle="Subscription attrition">
          {churn.loading ? <LoadingBlock /> : <UnavailableNote text={churn.data?.unavailable ?? 'Churn requires subscription history.'} />}
        </Card>
      </div>
    </>
  );
}
