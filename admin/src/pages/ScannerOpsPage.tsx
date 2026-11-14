import { AlertTriangle, Gauge, Radar, Wifi } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, Card, Empty, LoadingBlock, Notice, PageHeader, StatCard } from '../components/UI';
import { formatDuration, formatNumber, formatRelative } from '../lib/format';

/**
 * Scanner operations.
 *
 * The scanner engines execute in the browser, so the server learns about them
 * only through the client heartbeat and event stream. This page presents those
 * real figures: active sessions, generated signals and reported engine errors.
 * Where a figure has no source it is stated plainly rather than invented.
 */

interface Overview {
  metrics: {
    uptimeSeconds: number;
    requests: number;
    errorRate: number;
    activeScannerSessions: number;
    signalsLast24h: number;
    engineErrorsLast24h: number;
  };
}

interface ScannerSession {
  id: string;
  userId: string;
  symbols: string[];
  timeframes: string[];
  startedAt: number;
  lastSeenAt: number;
  signalCount: number;
  errorCount: number;
  clientVersion: string | null;
  active: boolean;
}

interface SessionsResponse {
  active: number;
  total: number;
  signalsLast24h: number;
  engineErrorsLast24h: number;
  items: ScannerSession[];
}

export function ScannerOpsPage() {
  const overview = useAsync<Overview>(() => api.get('/monitoring/overview'), []);
  const sessions = useAsync<SessionsResponse>(() => api.get('/monitoring/scanner-sessions'), []);

  const metrics = overview.data?.metrics;
  const active = sessions.data?.active ?? 0;
  const errorCount = sessions.data?.engineErrorsLast24h ?? 0;

  return (
    <>
      <PageHeader title="Scanner Operations" subtitle="Live scanner sessions, reported by the client." />

      <div className="grid grid-4 mb-lg">
        <StatCard label="Active scanner sessions" value={formatNumber(active)} icon={<Radar size={14} />} hint="Heartbeat within 2 minutes" />
        <StatCard label="Signals (last 24h)" value={formatNumber(sessions.data?.signalsLast24h ?? 0)} tone="violet" icon={<Gauge size={14} />} hint="Reported by the client" />
        <StatCard label="Backend requests" value={formatNumber(metrics?.requests ?? 0)} icon={<Wifi size={14} />} hint="Total since start" />
        <StatCard label="Process uptime" value={formatDuration(metrics?.uptimeSeconds ?? null)} tone="success" icon={<Gauge size={14} />} hint="Backend availability" />
      </div>

      {errorCount > 0 && (
        <Notice kind="warn">
          <strong>{formatNumber(errorCount)} engine errors reported in the last 24 hours. </strong>
          These come from the client; open the monitoring page for request-level detail.
        </Notice>
      )}

      <Card
        title="Live sessions"
        subtitle={sessions.loading ? 'Loading…' : `${active} active of ${sessions.data?.total ?? 0} recent sessions`}
        className="mb-lg"
      >
        {sessions.loading ? (
          <LoadingBlock />
        ) : sessions.data && sessions.data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>State</th>
                  <th>Symbols</th>
                  <th>Timeframes</th>
                  <th>Signals</th>
                  <th>Errors</th>
                  <th>Last heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data.items.slice(0, 50).map((s) => (
                  <tr key={s.id}>
                    <td className="mono tiny">{s.id.slice(0, 12)}</td>
                    <td>
                      {s.active ? <Badge tone="green" dot="green">Active</Badge> : <Badge tone="slate">Idle</Badge>}
                    </td>
                    <td className="tiny">
                      {s.symbols.length > 0
                        ? s.symbols.slice(0, 4).join(', ') + (s.symbols.length > 4 ? ` +${s.symbols.length - 4}` : '')
                        : '—'}
                    </td>
                    <td className="tiny">{s.timeframes.length > 0 ? s.timeframes.join(', ') : '—'}</td>
                    <td className="mono">{formatNumber(s.signalCount)}</td>
                    <td className="mono">
                      {s.errorCount > 0 ? <span className="strong">{formatNumber(s.errorCount)}</span> : '0'}
                    </td>
                    <td className="tiny faint">{formatRelative(s.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No scanner sessions reported">
            Sessions appear here when a trader runs the scanner. The client sends a heartbeat every 45 seconds.
          </Empty>
        )}
      </Card>

      <Notice kind="info">
        <strong>What these figures mean. </strong>
        Sessions and signals are reported by the client heartbeat, so they are near-real-time but not guaranteed — a
        client that is offline or has telemetry blocked will not appear. Sessions idle for over an hour are pruned.
      </Notice>

      <Card title="Engine configuration" subtitle="Fixed analytical parameters" className="mt-lg">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Value</th>
                <th>Editable here</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Strategy set</td>
                <td className="mono">Momentum · Reversal · Flip · Precision entry</td>
                <td>
                  <span className="badge badge-slate">No</span>
                </td>
              </tr>
              <tr>
                <td>Max entries per candle</td>
                <td className="mono">1</td>
                <td>
                  <span className="badge badge-slate">Protected</span>
                </td>
              </tr>
              <tr>
                <td>Account-mode validation</td>
                <td className="mono">Enforced client-side</td>
                <td>
                  <span className="badge badge-slate">Protected</span>
                </td>
              </tr>
              <tr>
                <td>Market data source</td>
                <td className="mono">Deriv WebSocket</td>
                <td>
                  <span className="badge badge-slate">No</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="notice notice-violet mt">
          <AlertTriangle size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
          Trading-safety controls are deliberately outside the admin surface and cannot be changed from this console.
        </div>
      </Card>

      {overview.loading && <LoadingBlock />}
    </>
  );
}
