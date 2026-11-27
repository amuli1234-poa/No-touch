import { Card, Badge, Empty, LoadingBlock, Notice, PageHeader } from '../../components/UI';
import { useAsync } from '../../lib/hooks';
import { formatDate } from '../../lib/format';
import { copyReportingApi } from '../../lib/copyTrading';

/**
 * Strategy management (read-only). Lists imported bot strategies across all
 * owners with their compatibility verdict recorded at import. It never executes,
 * edits or deletes, and never re-derives a verdict as supported.
 */
export function CopyStrategiesPage() {
  const { data, loading, error } = useAsync(() => copyReportingApi.strategies(), []);

  return (
    <>
      <PageHeader title="Strategy Management" subtitle="Imported bot strategies across all owners. Read-only; the recorded compatibility verdict is shown as-is." />
      {loading ? (
        <LoadingBlock label="Loading strategies…" />
      ) : error ? (
        <Notice kind="danger">{error.message}</Notice>
      ) : data && data.items.length > 0 ? (
        <Card tight>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Owner</th>
                  <th>Compatibility</th>
                  <th>Status</th>
                  <th className="num">Revision</th>
                  <th>Imported</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td className="mono small">{b.ownerUserId}</td>
                    <td>
                      <Badge tone={b.compatibility === 'full' ? 'green' : b.compatibility === 'partial' ? 'amber' : 'slate'}>
                        {b.compatibility}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={b.status === 'imported' ? 'blue' : 'slate'}>{b.status}</Badge>
                    </td>
                    <td className="num">{b.revision}</td>
                    <td className="small muted">{formatDate(b.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Empty title="No strategies imported">Imported bot strategies appear here once an owner imports one.</Empty>
      )}
    </>
  );
}