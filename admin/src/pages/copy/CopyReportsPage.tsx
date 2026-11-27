import { Card, Badge, Empty, LoadingBlock, Notice, PageHeader } from '../../components/UI';
import { useAsync } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { copyReportingApi } from '../../lib/copyTrading';

interface ExecAudit {
  id: string;
  timestamp: number;
  action: string;
  outcome: 'allowed' | 'denied' | 'error';
  accountId: string | null;
  intentId: string | null;
}
interface AdminAudit {
  id: string;
  timestamp: number;
  action: string;
  targetType: string;
  targetId: string | null;
}

function outcomeTone(outcome: string): string {
  if (outcome === 'allowed') return 'green';
  if (outcome === 'denied') return 'red';
  return 'amber';
}

/** Reports, audit and reconciliation. */
export function CopyReportsPage() {
  const recon = useAsync(() => copyReportingApi.reconciliation(), []);
  const audit = useAsync(() => copyReportingApi.audit(100), []);

  return (
    <>
      <PageHeader title="Reports, Audit & Reconciliation" subtitle="Execution and administrative audit trails plus the reconciliation backlog." />

      <Card title="Reconciliation summary" className="mb">
        {recon.loading ? (
          <LoadingBlock />
        ) : recon.error ? (
          <Notice kind="danger">{recon.error.message}</Notice>
        ) : recon.data ? (
          <div className="row gap-lg wrap">
            <span>
              <strong>{recon.data.stuckIntents.length}</strong> stuck intents
            </span>
            <span>
              <strong>{recon.data.openContracts}</strong> open contracts
            </span>
            <span>
              <strong>{recon.data.expiredOpenContracts}</strong> expired open
            </span>
            <span className="small muted">{recon.data.note}</span>
          </div>
        ) : null}
      </Card>

      <Card title="Execution audit" subtitle="Most recent first. Sensitive values are redacted before storage." className="mb" tight>
        {audit.loading ? (
          <LoadingBlock />
        ) : audit.error ? (
          <Notice kind="danger">{audit.error.message}</Notice>
        ) : audit.data && audit.data.execution.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Account</th>
                  <th>Intent</th>
                </tr>
              </thead>
              <tbody>
                {(audit.data.execution as ExecAudit[]).map((a) => (
                  <tr key={a.id}>
                    <td className="small muted">{formatDateTime(a.timestamp)}</td>
                    <td className="mono">{a.action}</td>
                    <td>
                      <Badge tone={outcomeTone(a.outcome)}>{a.outcome}</Badge>
                    </td>
                    <td>{a.accountId ?? '—'}</td>
                    <td className="mono small">{a.intentId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No execution audit yet">Execution decisions appear here once trades are attempted.</Empty>
        )}
      </Card>

      <Card title="Copy-trading admin audit" tight>
        {audit.loading ? (
          <LoadingBlock />
        ) : audit.error ? (
          <Notice kind="danger">{audit.error.message}</Notice>
        ) : audit.data && audit.data.admin.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {(audit.data.admin as AdminAudit[]).map((a) => (
                  <tr key={a.id}>
                    <td className="small muted">{formatDateTime(a.timestamp)}</td>
                    <td className="mono">{a.action}</td>
                    <td className="small muted">
                      {a.targetType}
                      {a.targetId ? ` · ${a.targetId}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No administrative actions yet">Copy-trading admin actions are recorded here.</Empty>
        )}
      </Card>
    </>
  );
}