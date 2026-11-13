import { Activity, AlertTriangle, Clock, Server, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, Card, Empty, LoadingBlock, PageHeader, StatCard } from '../components/UI';
import { formatDuration, formatNumber, formatPercent, formatRelative } from '../lib/format';

interface Overview {
  generatedAt: number;
  services: { key: string; label: string; status: string; detail: string }[];
  metrics: {
    uptimeSeconds: number;
    requests: number;
    errors: number;
    errorRate: number;
    latency: { count: number; avgMs: number; p95Ms: number; maxMs: number };
  };
  notes: string[];
}

interface ErrorRow {
  at: number;
  method: string;
  path: string;
  status: number;
  message: string | null;
}

/** Maps a service status to a badge tone and dot colour. */
function statusMeta(status: string): { tone: string; dot: string } {
  switch (status) {
    case 'HEALTHY':
      return { tone: 'badge-green', dot: 'dot-green' };
    case 'DEGRADED':
      return { tone: 'badge-amber', dot: 'dot-amber pulse' };
    case 'OFFLINE':
      return { tone: 'badge-red', dot: 'dot-red pulse' };
    default:
      return { tone: 'badge-slate', dot: 'dot-slate' };
  }
}

export function MonitoringPage() {
  const overview = useAsync<Overview>(() => api.get('/monitoring/overview'), []);
  const errors = useAsync<{ items: ErrorRow[] }>(() => api.get('/monitoring/errors'), []);
  const freshness = useAsync<{ lastAdminActivityAt: number | null; unavailable?: string }>(() => api.get('/monitoring/data-freshness'), []);

  const m = overview.data?.metrics;

  return (
    <>
      <PageHeader title="System Health" subtitle="Live telemetry from the running backend process." />

      <div className="grid grid-4 mb-lg">
        <StatCard label="Uptime" value={formatDuration(m?.uptimeSeconds ?? null)} icon={<Clock size={14} />} hint="Since process start" />
        <StatCard label="Requests" value={formatNumber(m?.requests ?? 0)} icon={<Server size={14} />} hint="Excludes health probes" />
        <StatCard label="Error rate" value={formatPercent(m?.errorRate ?? 0, 2)} tone={(m?.errorRate ?? 0) > 0.05 ? 'warn' : 'success'} icon={<AlertTriangle size={14} />} hint={`${formatNumber(m?.errors ?? 0)} server errors`} />
        <StatCard label="p95 latency" value={`${m?.latency.p95Ms ?? 0} ms`} icon={<Zap size={14} />} hint={`avg ${m?.latency.avgMs ?? 0} ms · max ${m?.latency.maxMs ?? 0} ms`} />
      </div>

      <Card title="Services" subtitle="Status is derived from real signals; UNKNOWN means no telemetry source exists" className="mb-lg">
        {overview.loading ? (
          <LoadingBlock />
        ) : overview.data ? (
          <div className="col gap">
            {overview.data.services.map((s) => {
              const meta = statusMeta(s.status);
              return (
                <div key={s.key} className="row-between card" style={{ padding: '12px 16px' }}>
                  <div className="row gap">
                    <Activity size={16} className="faint" />
                    <div>
                      <div className="strong">{s.label}</div>
                      <div className="tiny muted">{s.detail}</div>
                    </div>
                  </div>
                  <Badge tone={meta.tone} dot={meta.dot}>
                    {s.status}
                  </Badge>
                </div>
              );
            })}
            {overview.data.notes.length > 0 && (
              <div className="notice notice-info mt">
                <div>
                  {overview.data.notes.map((n, i) => (
                    <div key={i}>{n}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <Empty title="Telemetry unavailable" />
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Recent server errors" subtitle="Last 20, most recent first" tight>
          {errors.loading ? (
            <LoadingBlock />
          ) : errors.data && errors.data.items.length > 0 ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Request</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.data.items.map((e, i) => (
                    <tr key={i}>
                      <td className="muted small">{formatRelative(e.at)}</td>
                      <td className="mono small">
                        {e.method} {e.path}
                      </td>
                      <td>
                        <Badge tone="badge-red">{e.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No server errors">The backend has not recorded any 5xx responses.</Empty>
          )}
        </Card>

        <Card title="Data freshness" subtitle="What the server can observe">
          {freshness.loading ? (
            <LoadingBlock />
          ) : (
            <div className="col gap">
              <div className="row-between">
                <span className="muted small">Last administrative activity</span>
                <span className="strong">{freshness.data?.lastAdminActivityAt ? formatRelative(freshness.data.lastAdminActivityAt) : 'None yet'}</span>
              </div>
              <div className="row-between">
                <span className="muted small">Market data</span>
                <span className="faint">Client-side</span>
              </div>
              {freshness.data?.unavailable && <div className="notice notice-warn">{freshness.data.unavailable}</div>}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
