import { useEffect, useState } from 'react';
import { Card, StatCard, Badge, Notice, Empty, LoadingBlock, PageHeader } from '../../components/UI';
import { useAsync } from '../../lib/hooks';
import { formatNumber } from '../../lib/format';
import { copyReportingApi, copyControlApi, copyTradingApi, type AdminMaster } from '../../lib/copyTrading';

function readinessTone(state: string): string {
  if (state === 'READY') return 'green';
  if (state === 'DEGRADED') return 'red';
  if (state === 'PAUSED' || state === 'AWAITING_AUTHORIZATION') return 'amber';
  return 'slate';
}

/** Risk & Safety Centre: readiness per master plus the reconciliation backlog. */
export function CopyRiskPage() {
  const masters = useAsync(() => copyTradingApi.listMasters(), []);
  const recon = useAsync(() => copyReportingApi.reconciliation(), []);
  const [masterId, setMasterId] = useState('');
  useEffect(() => {
    if (!masterId && masters.data?.items.length) setMasterId(masters.data.items[0].userId);
  }, [masters.data, masterId]);
  const readiness = useAsync(
    () => (masterId ? copyControlApi.readiness(masterId).then((r) => r.readiness) : Promise.resolve(null)),
    [masterId]
  );

  return (
    <>
      <PageHeader
        title="Risk & Safety Centre"
        subtitle="Readiness, kill-switch posture and reconciliation backlog. Read-only; execution safety is enforced server-side."
        actions={
          <select className="select" value={masterId} onChange={(e) => setMasterId(e.target.value)} style={{ minWidth: 240 }} aria-label="Select master">
            {(masters.data?.items ?? []).map((m: AdminMaster) => (
              <option key={m.userId} value={m.userId}>
                {m.loginId ?? m.userId}
              </option>
            ))}
          </select>
        }
      />

      {readiness.loading ? (
        <LoadingBlock label="Loading readiness…" />
      ) : readiness.error ? (
        <Notice kind="danger">{readiness.error.message}</Notice>
      ) : readiness.data ? (
        <Card title="Master readiness" subtitle={readiness.data.explanation} className="mb">
          <div className="row gap-sm mb">
            <Badge tone={readinessTone(readiness.data.state)}>{readiness.data.state}</Badge>
            <span className="small muted">Copy switch: {readiness.data.control.enabled ? 'running' : 'stopped'}</span>
            {readiness.data.degraded && <span className="small muted">Degraded: {readiness.data.degraded.summary}</span>}
          </div>
          <div className="grid grid-4">
            <StatCard label="Followers" value={formatNumber(readiness.data.counts.followers)} />
            <StatCard label="Eligible" value={formatNumber(readiness.data.counts.eligible)} tone="success" />
            <StatCard label="Held" value={formatNumber(readiness.data.counts.held)} tone="warn" />
            <StatCard label="Pending invites" value={formatNumber(readiness.data.counts.pendingInvitations)} />
          </div>
        </Card>
      ) : (
        <Empty title="Select a master">Choose a master to view readiness.</Empty>
      )}

      <Card title="Reconciliation backlog" subtitle="Stuck intents are never retried automatically." tight>
        {recon.loading ? (
          <LoadingBlock label="Loading reconciliation…" />
        ) : recon.error ? (
          <Notice kind="danger">{recon.error.message}</Notice>
        ) : recon.data ? (
          <>
            <div className="grid grid-4 mb">
              <StatCard label="Stuck intents" value={formatNumber(recon.data.stuckIntents.length)} tone={recon.data.stuckIntents.length ? 'danger' : 'success'} />
              <StatCard label="Open contracts" value={formatNumber(recon.data.openContracts)} />
              <StatCard label="Expired open" value={formatNumber(recon.data.expiredOpenContracts)} tone="warn" />
              <StatCard label="Unknown contracts" value={formatNumber(recon.data.unknownContracts)} />
            </div>
            {recon.data.stuckIntents.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Intent</th>
                      <th>Principal</th>
                      <th>State</th>
                      <th>Contract</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recon.data.stuckIntents.map((i) => (
                      <tr key={i.id}>
                        <td className="mono">{i.id}</td>
                        <td>{i.userId}</td>
                        <td>
                          <Badge tone="amber">{i.state}</Badge>
                        </td>
                        <td className="mono">{i.contractId ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </Card>
    </>
  );
}