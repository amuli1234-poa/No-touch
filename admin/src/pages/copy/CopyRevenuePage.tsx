import { useEffect, useState } from 'react';
import { Card, StatCard, Notice, Empty, LoadingBlock, PageHeader } from '../../components/UI';
import { useAsync } from '../../lib/hooks';
import { formatCurrency, formatNumber } from '../../lib/format';
import { copyReportingApi, copyTradingApi, type AdminMaster } from '../../lib/copyTrading';

/**
 * Revenue and commission management for one master's book.
 *
 * The statement is computed server-side from settled contracts (idempotent
 * commission application). Estimated markup is shown separately from confirmed
 * (collected) markup and is never presented as revenue.
 */
export function CopyRevenuePage() {
  const masters = useAsync(() => copyTradingApi.listMasters(), []);
  const [masterId, setMasterId] = useState('');
  useEffect(() => {
    if (!masterId && masters.data?.items.length) setMasterId(masters.data.items[0].userId);
  }, [masters.data, masterId]);

  const finance = useAsync(
    () => (masterId ? copyReportingApi.finance(masterId) : Promise.resolve(null)),
    [masterId]
  );

  return (
    <>
      <PageHeader
        title="Revenue & Commissions"
        subtitle="40% manager commission, 60% client allocation and 3% App ID markup — computed only from settled contracts."
        actions={
          <select className="select" value={masterId} onChange={(e) => setMasterId(e.target.value)} style={{ minWidth: 240 }} aria-label="Select master">
            {(masters.data?.items ?? []).map((m: AdminMaster) => (
              <option key={m.userId} value={m.userId}>
                {m.loginId ?? m.userId} · {m.clients} client{m.clients === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        }
      />

      {finance.loading ? (
        <LoadingBlock label="Computing statement…" />
      ) : finance.error ? (
        <Notice kind="danger">{finance.error.message}</Notice>
      ) : finance.data ? (
        <>
          <div className="grid grid-4 mb">
            <StatCard label="Realized P/L (book)" value={formatCurrency(finance.data.statement.totals.realisedPnl)} tone={finance.data.statement.totals.realisedPnl >= 0 ? 'success' : 'danger'} />
            <StatCard label="Manager commission (40%)" value={formatCurrency(finance.data.statement.totals.managerCommission)} tone="violet" />
            <StatCard label="Client allocation (60%)" value={formatCurrency(finance.data.statement.totals.clientAllocation)} />
            <StatCard label="Confirmed markup" value={formatCurrency(finance.data.statement.totals.confirmedMarkup)} tone="success" hint="Collected" />
          </div>

          <Card title="Per-client statement" subtitle="One row per connected client. Master's own P/L is reported separately and never commissioned." className="mb" tight>
            {finance.data.statement.followers.length === 0 ? (
              <Empty title="No clients connected">Revenue appears once a connected client has settled trades.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th className="num">Trades</th>
                      <th className="num">Realized P/L</th>
                      <th className="num">Commission base</th>
                      <th className="num">Manager 40%</th>
                      <th className="num">Client 60%</th>
                      <th className="num">Confirmed markup</th>
                      <th className="num">High-water mark</th>
                    </tr>
                  </thead>
                  <tbody>
                    {finance.data.statement.followers.map((f) => (
                      <tr key={f.followerId}>
                        <td>{f.loginId ?? f.followerId}</td>
                        <td className="num">{formatNumber(f.trades)}</td>
                        <td className="num">{formatCurrency(f.realisedPnl)}</td>
                        <td className="num">{formatCurrency(f.commissionBase)}</td>
                        <td className="num">{formatCurrency(f.managerCommission)}</td>
                        <td className="num">{formatCurrency(f.clientAllocation)}</td>
                        <td className="num">{formatCurrency(f.confirmedMarkup)}</td>
                        <td className="num">{formatCurrency(f.highWaterMark)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Notice kind="info">
            <strong>Markup status. </strong>
            Estimated markup {formatCurrency(finance.data.statement.totals.estimatedMarkup)} is not counted as collected revenue; only the confirmed figure (
            {formatCurrency(finance.data.statement.totals.confirmedMarkup)}) is. The master's own realized P/L is{' '}
            {finance.data.statement.masterRealisedPnl === null
              ? 'unavailable (not recorded)'
              : formatCurrency(finance.data.statement.masterRealisedPnl)}{' '}
            and is not commissioned.
          </Notice>
        </>
      ) : (
        <Empty title="Select a master">Choose a master trader to view their revenue and commission statement.</Empty>
      )}
    </>
  );
}