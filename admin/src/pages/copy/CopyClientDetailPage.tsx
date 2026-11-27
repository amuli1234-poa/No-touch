import { useEffect, useState } from 'react';
import { Card, StatCard, Badge, Empty, LoadingBlock, Notice, PageHeader } from '../../components/UI';
import { useAsync } from '../../lib/hooks';
import { formatCurrency, formatNumber } from '../../lib/format';
import { copyReportingApi, copyTradingApi } from '../../lib/copyTrading';

/** Individual client detail: profile, P/L, commission records and risk. */
export function CopyClientDetailPage() {
  const clients = useAsync(() => copyTradingApi.listClients(''), []);
  const [clientId, setClientId] = useState('');
  useEffect(() => {
    if (!clientId && clients.data?.items.length) setClientId(clients.data.items[0].id);
  }, [clients.data, clientId]);

  const detail = useAsync(
    () => (clientId ? copyReportingApi.clientDetail(clientId) : Promise.resolve(null)),
    [clientId]
  );

  return (
    <>
      <PageHeader
        title="Client Details"
        subtitle="One client's profile, settled P/L, commission records and risk posture."
        actions={
          <select className="select" value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ minWidth: 240 }} aria-label="Select client">
            {(clients.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.client.loginId ?? c.id}
              </option>
            ))}
          </select>
        }
      />

      {detail.loading ? (
        <LoadingBlock label="Loading client…" />
      ) : detail.error ? (
        <Notice kind="danger">{detail.error.message}</Notice>
      ) : detail.data ? (
        <>
          <div className="grid grid-4 mb">
            <StatCard label="Settled trades" value={formatNumber(detail.data.pnl.trades)} />
            <StatCard label="Realized P/L" value={formatCurrency(detail.data.pnl.realisedPnl)} tone={detail.data.pnl.realisedPnl >= 0 ? 'success' : 'danger'} />
            <StatCard label="Manager commission" value={formatCurrency(detail.data.commissions.reduce((s, e) => s + e.managerCommission, 0))} tone="violet" />
            <StatCard label="Risk profile" value={detail.data.risk.configured ? 'Custom' : 'Default'} hint={detail.data.risk.configured ? 'Stored limits apply' : 'Platform defaults apply'} />
          </div>

          <Card title="Commission records" subtitle="One immutable record per settled contract. Never charged twice." tight>
            {detail.data.commissions.length === 0 ? (
              <Empty title="No commissions yet">Commissions appear once this client has settled trades.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Account</th>
                      <th className="num">Realized P/L</th>
                      <th className="num">Base</th>
                      <th className="num">Manager 40%</th>
                      <th className="num">Client 60%</th>
                      <th className="num">Markup</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.commissions.map((e) => (
                      <tr key={e.id}>
                        <td className="mono">{e.contractId}</td>
                        <td className="small muted">{e.accountId}</td>
                        <td className="num">{formatCurrency(e.realisedPnl, e.currency)}</td>
                        <td className="num">{formatCurrency(e.commissionBase, e.currency)}</td>
                        <td className="num">{formatCurrency(e.managerCommission, e.currency)}</td>
                        <td className="num">{formatCurrency(e.clientAllocation, e.currency)}</td>
                        <td className="num">
                          {e.confirmedMarkup === null ? (
                            <Badge tone="amber">estimated</Badge>
                          ) : (
                            formatCurrency(e.confirmedMarkup, e.currency)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : (
        <Empty title="Select a client">Choose a client to view their detail.</Empty>
      )}
    </>
  );
}