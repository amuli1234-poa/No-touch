import { Gauge, Radar, Wifi } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Card, Empty, LoadingBlock, Notice, PageHeader, StatCard } from '../components/UI';
import { formatDuration, formatNumber } from '../lib/format';

/**
 * Scanner operations. The scanner engines execute in the browser, so the server
 * cannot observe live engine sessions. This page therefore presents the
 * operational facts it does know — process uptime and request throughput — and
 * states the limitation plainly rather than inventing session counts.
 */

interface Overview {
  metrics: { uptimeSeconds: number; requests: number; errorRate: number };
}

export function ScannerOpsPage() {
  const overview = useAsync<Overview>(() => api.get('/monitoring/overview'), []);

  return (
    <>
      <PageHeader title="Scanner Operations" subtitle="Runtime health for the market-scanning service." />

      <div className="grid grid-4 mb-lg">
        <StatCard label="Active scanner sessions" value="Unavailable" unavailable icon={<Radar size={14} />} hint="Runs in the browser" />
        <StatCard label="Signals generated" value="Unavailable" unavailable tone="violet" icon={<Gauge size={14} />} hint="Not reported to the server" />
        <StatCard label="Backend requests" value={formatNumber(overview.data?.metrics.requests ?? 0)} icon={<Wifi size={14} />} hint="Total since start" />
        <StatCard label="Process uptime" value={formatDuration(overview.data?.metrics.uptimeSeconds ?? null)} tone="success" icon={<Gauge size={14} />} hint="Backend availability" />
      </div>

      <Notice kind="info">
        <strong>Why some figures are unavailable. </strong>
        The scanner engines run entirely in the user's browser and do not send telemetry to the server. Counting live
        engine sessions or generated signals would require a client heartbeat that does not exist, so those figures are
        reported as unavailable rather than estimated. Adding a heartbeat is the prerequisite for populating them.
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
          Trading-safety controls are deliberately outside the admin surface and cannot be changed from this console.
        </div>
      </Card>

      {overview.loading && <LoadingBlock />}
      {!overview.loading && !overview.data && <Empty title="Scanner telemetry unavailable" />}
    </>
  );
}
