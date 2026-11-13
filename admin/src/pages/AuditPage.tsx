import { useState } from 'react';
import { ChevronDown, ChevronRight, Download, ScrollText, Search } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAsync, useDebounced } from '../lib/hooks';
import { Card, Empty, LoadingBlock, PageHeader, Pagination } from '../components/UI';
import { formatDateTime, humanizeAction } from '../lib/format';

interface AuditRow {
  id: string;
  timestamp: number;
  actorAdminId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  previousState: unknown;
  newState: unknown;
  reason: string | null;
  correlationId: string;
  sourceIp: string | null;
  metadata: Record<string, unknown>;
}

const PAGE_SIZE = 40;

/**
 * Audit log. Read-only by construction: the API exposes no mutation route for
 * audit records, so nothing here can alter history.
 */
export function AuditPage() {
  const [page, setPage] = useState(1);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const qActor = useDebounced(actor, 320);
  const qAction = useDebounced(action, 320);

  const list = useAsync<{ items: AuditRow[]; total: number; page: number; totalPages: number }>(
    () => api.get(`/audit${qs({ page, pageSize: PAGE_SIZE, actor: qActor, action: qAction })}`),
    [page, qActor, qAction]
  );

  function exportJson() {
    const rows = list.data?.items ?? [];
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wicksentinel-audit-page-${page}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Audit Log"
        subtitle="An append-only record of administrative actions. Entries cannot be edited or removed."
        actions={
          <button className="btn btn-ghost" onClick={exportJson} disabled={!list.data || list.data.items.length === 0}>
            <Download size={15} /> Export page
          </button>
        }
      />

      <Card
        tight
        title="Events"
        subtitle="Newest first"
        actions={
          <div className="row gap-sm">
            <div className="input-search">
              <Search size={14} />
              <input className="input" placeholder="Filter by actor" value={actor} onChange={(e) => { setActor(e.target.value); setPage(1); }} style={{ width: 170 }} />
            </div>
            <div className="input-search">
              <Search size={14} />
              <input className="input" placeholder="Filter by action" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} style={{ width: 170 }} />
            </div>
          </div>
        }
      >
        {list.loading ? (
          <LoadingBlock />
        ) : list.data && list.data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 30 }} />
                    <th>Timestamp</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((row) => (
                    <>
                      <tr key={row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)} style={{ cursor: 'pointer' }}>
                        <td>{expanded === row.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.timestamp)}</td>
                        <td className="truncate">{row.actorEmail ?? <span className="faint">System</span>}</td>
                        <td>
                          <span className="strong small">{humanizeAction(row.action)}</span>
                          <div className="tiny faint mono">{row.action}</div>
                        </td>
                        <td className="small">
                          {row.targetType ? (
                            <>
                              {row.targetType}
                              {row.targetId && <span className="faint mono"> · {row.targetId}</span>}
                            </>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                        <td className="mono tiny faint">{row.sourceIp ?? '—'}</td>
                      </tr>
                      {expanded === row.id && (
                        <tr key={`${row.id}-detail`}>
                          <td />
                          <td colSpan={5}>
                            <div className="grid grid-2" style={{ gap: 12 }}>
                              <div>
                                <div className="tiny faint mb" style={{ marginBottom: 4 }}>Previous state</div>
                                <pre className="card mono tiny" style={{ margin: 0, padding: 10, overflow: 'auto', maxHeight: 200 }}>
                                  {JSON.stringify(row.previousState, null, 2)}
                                </pre>
                              </div>
                              <div>
                                <div className="tiny faint mb" style={{ marginBottom: 4 }}>New state</div>
                                <pre className="card mono tiny" style={{ margin: 0, padding: 10, overflow: 'auto', maxHeight: 200 }}>
                                  {JSON.stringify(row.newState, null, 2)}
                                </pre>
                              </div>
                            </div>
                            <div className="row gap mt" style={{ marginTop: 10 }}>
                              {row.reason && <span className="badge badge-slate">Reason: {row.reason}</span>}
                              <span className="badge badge-slate mono">Correlation: {row.correlationId.slice(0, 8)}</span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} totalPages={list.data.totalPages} onPage={setPage} />
          </>
        ) : (
          <Empty title="No audit events" icon={<ScrollText size={22} />}>
            {actor || action ? 'No events match the current filters.' : 'Administrative actions will be recorded here.'}
          </Empty>
        )}
      </Card>
    </>
  );
}
