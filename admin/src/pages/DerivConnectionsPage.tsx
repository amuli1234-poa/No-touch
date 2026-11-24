import { Link2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, Card, Empty, LoadingBlock, Notice, PageHeader, StatCard } from '../components/UI';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';

interface ConnectionRow {
  followerId: string;
  method: 'oauth' | 'pat';
  client: string | null;
  masterUserId: string;
  accountType: 'demo' | 'real';
  currency: string | null;
  accounts: { accountId: string; type: string; status: string | null }[];
  status: string;
  authorizationExpiresAt: number | null;
  expired: boolean;
  health: 'OK' | 'EXPIRED' | 'SUSPENDED';
  lastUpdatedAt: number;
  consentRecorded: boolean;
}

interface ConnectionsResponse {
  generatedAt: number;
  items: ConnectionRow[];
  summary: { total: number; oauth: number; token: number; expired: number; withoutConsent: number };
  appIds: { oauthConfigured: boolean; patConfigured: boolean; note: string };
  balancesUnavailable: string;
}

function healthTone(h: string): string {
  if (h === 'OK') return 'green';
  if (h === 'EXPIRED') return 'amber';
  return 'red';
}

export function DerivConnectionsPage() {
  const data = useAsync<ConnectionsResponse>(() => api.get('/copy-trading/connections'), []);
  const d = data.data;

  return (
    <>
      <PageHeader
        title="Deriv connections"
        subtitle="Authorization health for every Copy Trading connection. Account identifiers are masked."
      />

      {data.loading ? (
        <LoadingBlock />
      ) : data.error ? (
        <Empty title="Connections could not be loaded">{data.error.code.replace(/_/g, ' ')}</Empty>
      ) : d ? (
        <>
          <div className="grid grid-4 mb">
            <StatCard label="Connections" value={formatNumber(d.summary.total)} icon={<Link2 size={14} />} />
            <StatCard label="OAuth" value={formatNumber(d.summary.oauth)} tone="violet" icon={<ShieldCheck size={14} />} hint="Client-owned authorization" />
            <StatCard label="API token" value={formatNumber(d.summary.token)} icon={<Link2 size={14} />} hint="Client-provided token" />
            <StatCard
              label="Expired / missing consent"
              value={`${formatNumber(d.summary.expired)} / ${formatNumber(d.summary.withoutConsent)}`}
              tone={d.summary.expired + d.summary.withoutConsent > 0 ? 'warn' : 'success'}
              icon={<ShieldAlert size={14} />}
            />
          </div>

          <Notice kind="info">{d.balancesUnavailable}</Notice>

          <Card tight title="Application identifiers" subtitle="OAuth and API tokens use different Deriv App IDs">
            <div className="row gap-sm wrap" style={{ padding: 12 }}>
              <Badge tone={d.appIds.oauthConfigured ? 'green' : 'red'}>
                OAuth App ID {d.appIds.oauthConfigured ? 'configured' : 'missing'}
              </Badge>
              <Badge tone={d.appIds.patConfigured ? 'green' : 'amber'}>
                PAT App ID {d.appIds.patConfigured ? 'configured' : 'missing'}
              </Badge>
              <span className="tiny muted">{d.appIds.note}</span>
            </div>
          </Card>

          <Card tight title="All connections" subtitle={`${d.items.length} record(s)`}>
            {d.items.length === 0 ? (
              <Empty title="No Deriv connections yet">
                Connections appear here after a client authorizes via OAuth or an administrator submits a token.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>Method</th>
                      <th>Mode</th>
                      <th>Account</th>
                      <th>Health</th>
                      <th>Consent</th>
                      <th>Expires</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((c) => (
                      <tr key={c.followerId}>
                        <td className="strong">{c.client ?? 'Deriv client'}</td>
                        <td>
                          <Badge tone={c.method === 'oauth' ? 'violet' : 'blue'}>{c.method === 'oauth' ? 'OAuth' : 'Token'}</Badge>
                        </td>
                        <td>
                          <Badge tone={c.accountType === 'demo' ? 'slate' : 'amber'}>{c.accountType}</Badge>
                        </td>
                        <td className="num tiny">{c.accounts.map((a) => a.accountId).join(', ') || '—'}</td>
                        <td>
                          <Badge tone={healthTone(c.health)}>{c.health}</Badge>
                        </td>
                        <td>{c.consentRecorded ? <Badge tone="green">on file</Badge> : <Badge tone="amber">missing</Badge>}</td>
                        <td className="tiny muted">{c.authorizationExpiresAt ? formatDateTime(c.authorizationExpiresAt) : 'n/a'}</td>
                        <td className="tiny muted">{formatRelative(c.lastUpdatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
