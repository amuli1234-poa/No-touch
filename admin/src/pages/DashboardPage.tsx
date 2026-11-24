import { Activity, AlertTriangle, CheckCircle2, Clock, Gauge, Repeat, Server, TrendingUp, UserCheck, Users } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Card, Empty, LoadingBlock, PageHeader, Sparkline, StatCard, UnavailableNote } from '../components/UI';
import { formatDuration, formatNumber, formatPercent, formatRelative, humanizeAction } from '../lib/format';
import { useAuth } from '../lib/auth';

interface Summary {
  generatedAt: number;
  users: { total: number; active: number; suspended: number; newToday: number; newThisMonth: number; withLiveSession: number };
  subscriptions: { paid: number | null; free: number | null; conversionRate: number | null; unavailable?: string };
  revenue: { mrr: number | null; currency: string | null; unavailable?: string };
  support: { open: number };
  system: { uptimeSeconds: number; requests: number; errorRate: number; latency: { count: number; avgMs: number; p95Ms: number; maxMs: number } };
  scanner: {
    activeSessions: number;
    signalsLast24h: number;
    engineErrorsLast24h: number;
    lastEventAt: number | null;
  };
  /**
   * Absent when the admin API predates the copy-trading module (a backend that
   * has not been restarted after a deploy). Declared optional because the page
   * must degrade to an honest note rather than throw: an unguarded read here
   * blanks the entire dashboard after a successful login.
   */
  copyTrading?: {
    clients: number;
    activeFollowers: number;
    pausedFollowers: number;
    suspendedFollowers: number;
    pendingAuthorizations: number;
    connectedAccounts: number;
    oauthConnections: number;
    tokenConnections: number;
    engine: { implemented: boolean; note: string };
  };
}

interface Alert {
  level: 'info' | 'warning' | 'critical';
  message: string;
  at: number;
}

export function DashboardPage() {
  const { admin } = useAuth();
  const summary = useAsync<Summary>(() => api.get<Summary>('/dashboard/summary'), []);
  const regs = useAsync<{ days: number; series: { date: string; count: number }[] }>(
    () => api.get('/dashboard/registrations' + qs({ days: 30 })),
    []
  );
  const alerts = useAsync<{ items: Alert[] }>(() => api.get('/dashboard/alerts'), []);
  const activity = useAsync<{ items: { id: string; timestamp: number; actorEmail: string | null; action: string; targetType: string | null; targetId: string | null }[] }>(
    () => api.get('/dashboard/recent-admin-activity'),
    []
  );

  const s = summary.data;

  return (
    <>
      <PageHeader
        title={`Welcome back${admin ? `, ${admin.displayName.split(' ')[0]}` : ''}`}
        subtitle="A live snapshot of the platform. Figures come from real records and the running process."
      />

      {summary.error && <UnavailableNote text="The dashboard summary could not be loaded. The backend may be unreachable." />}

      {summary.loading && !s ? (
        <LoadingBlock label="Loading platform metrics…" />
      ) : s ? (
        <>
          <div className="grid grid-4 mb-lg">
            <StatCard label="Total users" value={formatNumber(s.users.total)} icon={<Users size={14} />} hint={`${formatNumber(s.users.newThisMonth)} new this month`} />
            <StatCard label="Active users" value={formatNumber(s.users.active)} tone="success" icon={<UserCheck size={14} />} hint={`${formatNumber(s.users.withLiveSession)} with a live session`} />
            <StatCard label="Suspended" value={formatNumber(s.users.suspended)} tone="danger" icon={<AlertTriangle size={14} />} hint="Access blocked immediately" />
            <StatCard label="New today" value={formatNumber(s.users.newToday)} icon={<TrendingUp size={14} />} hint={`${formatNumber(s.users.newThisMonth)} this month`} />
          </div>

          <div className="grid grid-4 mb-lg">
            <StatCard label="Open tickets" value={formatNumber(s.support.open)} tone="violet" icon={<Clock size={14} />} hint="Open or in progress" />
            <StatCard label="API requests" value={formatNumber(s.system.requests)} icon={<Server size={14} />} hint={`Uptime ${formatDuration(s.system.uptimeSeconds)}`} />
            <StatCard label="Error rate" value={formatPercent(s.system.errorRate, 2)} tone={s.system.errorRate > 0.05 ? 'warn' : 'success'} icon={<Activity size={14} />} hint={`p95 ${s.system.latency.p95Ms} ms`} />
            <StatCard
              label="Scanner sessions"
              value={formatNumber(s.scanner.activeSessions)}
              tone="blue"
              icon={<Gauge size={14} />}
              hint={`${formatNumber(s.scanner.signalsLast24h)} signals · 24h`}
            />
          </div>

          {s.copyTrading ? (
            <div className="grid grid-4 mb-lg">
              <StatCard
                label="Copy Trading clients"
                value={formatNumber(s.copyTrading.clients)}
                tone="violet"
                icon={<Repeat size={14} />}
                hint={`${formatNumber(s.copyTrading.activeFollowers)} active · ${formatNumber(s.copyTrading.pausedFollowers)} paused`}
              />
              <StatCard
                label="Pending authorizations"
                value={formatNumber(s.copyTrading.pendingAuthorizations)}
                icon={<Clock size={14} />}
                hint="Invitations awaiting acceptance"
              />
              <StatCard
                label="Connected Deriv accounts"
                value={formatNumber(s.copyTrading.connectedAccounts)}
                icon={<UserCheck size={14} />}
                hint={`${formatNumber(s.copyTrading.oauthConnections)} OAuth · ${formatNumber(s.copyTrading.tokenConnections)} token`}
              />
              <StatCard
                label="Copy engine"
                value={s.copyTrading.engine.implemented ? 'Active' : 'Not enabled'}
                tone={s.copyTrading.engine.implemented ? 'success' : 'warn'}
                icon={<Activity size={14} />}
                hint={s.copyTrading.engine.implemented ? 'DEMO trades mirrored' : 'Connections only'}
              />
            </div>
          ) : (
            <div className="mb-lg">
              <UnavailableNote text="Copy Trading figures are unavailable: the backend did not report them. The admin API may be running an older build than this console." />
            </div>
          )}

          <div className="grid grid-2 mb-lg">
            <Card title="New registrations" subtitle="Last 30 days, by UTC day">
              {regs.loading ? (
                <LoadingBlock />
              ) : regs.data && regs.data.series.some((p) => p.count > 0) ? (
                <Sparkline points={regs.data.series.map((p) => ({ label: p.date.slice(5), value: p.count }))} />
              ) : (
                <Empty title="No registrations in this period">New sign-ups will appear here as they happen.</Empty>
              )}
            </Card>

            <Card title="Operational alerts" subtitle="Derived from live signals only">
              {alerts.loading ? (
                <LoadingBlock />
              ) : alerts.data && alerts.data.items.length > 0 ? (
                <div className="col gap">
                  {alerts.data.items.map((a, i) => (
                    <div key={i} className={`notice notice-${a.level === 'critical' ? 'danger' : a.level === 'warning' ? 'warn' : 'info'}`}>
                      <span>{a.message}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="All clear" icon={<CheckCircle2 size={22} />}>
                  No active alerts. Nothing needs attention right now.
                </Empty>
              )}
            </Card>
          </div>

          <div className="grid grid-2">
            <Card title="Recent administrator activity" subtitle="From the append-only audit log" tight>
              {activity.loading ? (
                <LoadingBlock />
              ) : activity.data && activity.data.items.length > 0 ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Administrator</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.data.items.map((row) => (
                        <tr key={row.id}>
                          <td className="muted small">{formatRelative(row.timestamp)}</td>
                          <td className="truncate">{row.actorEmail ?? 'System'}</td>
                          <td>
                            <span className="small">{humanizeAction(row.action)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No activity yet">Administrative actions will be listed here.</Empty>
              )}
            </Card>

            <Card title="Unavailable modules" subtitle="Reported honestly — not estimated">
              <div className="col gap">
                {s.subscriptions.unavailable && <UnavailableNote text={s.subscriptions.unavailable} />}
                {s.revenue.unavailable && <UnavailableNote text={s.revenue.unavailable} />}
                {s.copyTrading && !s.copyTrading.engine.implemented && <UnavailableNote text={s.copyTrading.engine.note} />}
              </div>
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
