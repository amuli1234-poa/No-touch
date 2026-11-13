import { useState } from 'react';
import { Ban, KeyRound, RotateCcw, Search, StickyNote, UserRound } from 'lucide-react';
import { api, ApiError, qs } from '../lib/api';
import { useAsync, useDebounced, useToast } from '../lib/hooks';
import { Badge, Card, Empty, LoadingBlock, Modal, PageHeader, Pagination } from '../components/UI';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';
import { useAuth } from '../lib/auth';

interface UserRow {
  id: string;
  loginId: string | null;
  createdAt: number;
  updatedAt: number;
  accountCount: number;
  demoAccounts: number;
  realAccounts: number;
  suspended: boolean;
  suspendedAt: number | null;
  activeSessions: number;
}

interface UserDetail {
  user: UserRow & { suspendedReason: string | null; accounts: { accountId: string; type: string; currency: string | null; status: string | null }[] };
  sessions: { id: string; createdAt: number; expiresAt: number; lastSeenAt: number; revoked: boolean }[];
  notes: { id: string; body: string; authorAdminId: string; createdAt: number }[];
  subscriptionUnavailable?: string;
}

const PAGE_SIZE = 20;

export function UsersPage() {
  const { has } = useAuth();
  const { push } = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const q = useDebounced(search, 320);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useAsync<{ items: UserRow[]; total: number; page: number; totalPages: number }>(
    () => api.get(`/users${qs({ page, pageSize: PAGE_SIZE, q, status })}`),
    [page, q, status]
  );

  const detail = useAsync<UserDetail>(() => api.get(`/users/${selected}`), [selected]);

  async function act(path: string, body: unknown, successTitle: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await api.post(path, body);
      push('success', successTitle);
      list.reload();
      if (selected) detail.reload();
    } catch (err) {
      push('error', 'Action failed', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Trader accounts, their sessions and administrative notes."
        actions={
          <div className="input-search">
            <Search size={15} />
            <input
              className="input"
              placeholder="Search by login id, account or id"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{ width: 280 }}
            />
          </div>
        }
      />

      <Card
        tight
        title={`${formatNumber(list.data?.total ?? 0)} accounts`}
        subtitle="Suspension takes effect on the user's next request"
        actions={
          <select className="select" style={{ width: 150 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        }
      >
        {list.loading ? (
          <LoadingBlock />
        ) : list.error ? (
          <Empty title="Could not load users">{list.error.code.replace(/_/g, ' ')}</Empty>
        ) : list.data && list.data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Accounts</th>
                    <th>Live sessions</th>
                    <th>Joined</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="row gap-sm">
                          <UserRound size={15} className="faint" />
                          <div>
                            <div className="strong">{u.loginId ?? 'No login id'}</div>
                            <div className="tiny faint mono truncate" style={{ maxWidth: 200 }}>{u.id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="num">
                        {u.accountCount}
                        <span className="tiny faint"> ({u.demoAccounts} demo / {u.realAccounts} real)</span>
                      </td>
                      <td className="num">{u.activeSessions}</td>
                      <td className="muted small">{formatDateTime(u.createdAt)}</td>
                      <td>
                        {u.suspended ? <Badge tone="badge-red" dot="dot-red">Suspended</Badge> : <Badge tone="badge-green" dot="dot-green">Active</Badge>}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(u.id)}>
                            View
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={list.data.page}
              pageSize={PAGE_SIZE}
              total={list.data.total}
              totalPages={list.data.totalPages}
              onPage={setPage}
            />
          </>
        ) : (
          <Empty title="No users found">{search || status ? 'Try clearing the filters.' : 'Registered traders will appear here.'}</Empty>
        )}
      </Card>

      <Modal
        open={Boolean(selected)}
        title={detail.data?.user.loginId ?? 'User detail'}
        description={selected ?? undefined}
        onClose={() => setSelected(null)}
        wide
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setSelected(null)}>
              Close
            </button>
            {has('users.sessions.revoke') && (
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void act(`/users/${selected}/sessions/revoke`, { reason: 'Admin revoked' }, 'Sessions revoked', 'Revoke all active sessions for this user?')}
              >
                <KeyRound size={14} /> Revoke sessions
              </button>
            )}
            {detail.data?.user.suspended
              ? has('users.reactivate') && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => void act(`/users/${selected}/reactivate`, {}, 'User reactivated')}>
                    <RotateCcw size={14} /> Reactivate
                  </button>
                )
              : has('users.suspend') && (
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => {
                      const reason = window.prompt('Reason for suspension (recorded in the audit log):');
                      if (reason === null) return;
                      void act(`/users/${selected}/suspend`, { reason }, 'User suspended', 'Suspend this user and revoke their sessions?');
                    }}
                  >
                    <Ban size={14} /> Suspend
                  </button>
                )}
          </>
        }
      >
        {detail.loading ? (
          <LoadingBlock />
        ) : detail.data ? (
          <div className="col gap-lg">
            <div className="grid grid-2">
              <div>
                <div className="tiny faint">Status</div>
                {detail.data.user.suspended ? (
                  <Badge tone="badge-red" dot="dot-red">
                    Suspended {detail.data.user.suspendedAt ? formatRelative(detail.data.user.suspendedAt) : ''}
                  </Badge>
                ) : (
                  <Badge tone="badge-green" dot="dot-green">Active</Badge>
                )}
                {detail.data.user.suspendedReason && <div className="tiny muted mt-0" style={{ marginTop: 6 }}>Reason: {detail.data.user.suspendedReason}</div>}
              </div>
              <div>
                <div className="tiny faint">Joined</div>
                <div>{formatDateTime(detail.data.user.createdAt)}</div>
              </div>
            </div>

            <div>
              <h3 className="mb">Deriv accounts</h3>
              {detail.data.user.accounts.length > 0 ? (
                <div className="table-wrap card">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Type</th>
                        <th>Currency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.user.accounts.map((a) => (
                        <tr key={a.accountId}>
                          <td className="mono small">{a.accountId}</td>
                          <td>
                            <Badge tone={a.type === 'real' ? 'badge-violet' : 'badge-slate'}>{a.type}</Badge>
                          </td>
                          <td>{a.currency ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="muted small">No Deriv accounts linked.</div>
              )}
            </div>

            <div>
              <h3 className="mb">Sessions</h3>
              {detail.data.sessions.length > 0 ? (
                <div className="table-wrap card">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th>Started</th>
                        <th>Last seen</th>
                        <th>Expires</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.sessions.map((s) => (
                        <tr key={s.id}>
                          <td className="mono small">{s.id}</td>
                          <td className="muted small">{formatRelative(s.createdAt)}</td>
                          <td className="muted small">{formatRelative(s.lastSeenAt)}</td>
                          <td className="muted small">{s.revoked ? <Badge tone="badge-slate">Revoked</Badge> : formatRelative(s.expiresAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="muted small">No sessions on record.</div>
              )}
            </div>

            <div>
              <h3 className="mb">Internal notes</h3>
              {has('users.notes.manage') && <NoteComposer userId={selected!} onAdded={() => detail.reload()} />}
              {detail.data.notes.length > 0 ? (
                <div className="col gap-sm mt">
                  {detail.data.notes.map((n) => (
                    <div key={n.id} className="card">
                      <div className="card-body">
                        <div className="row-between mb" style={{ marginBottom: 6 }}>
                          <span className="tiny faint">{formatDateTime(n.createdAt)}</span>
                          <span className="tiny faint mono">{n.authorAdminId}</span>
                        </div>
                        <div>{n.body}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted small">No notes yet.</div>
              )}
            </div>

            {detail.data.subscriptionUnavailable && (
              <div className="notice notice-warn">{detail.data.subscriptionUnavailable}</div>
            )}
          </div>
        ) : (
          <Empty title="User not found" />
        )}
      </Modal>
    </>
  );
}

function NoteComposer({ userId, onAdded }: { userId: string; onAdded: () => void }) {
  const { push } = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post(`/users/${userId}/notes`, { body });
      setBody('');
      push('success', 'Note added');
      onAdded();
    } catch {
      push('error', 'Could not add note');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row gap-sm" style={{ alignItems: 'flex-start' }}>
      <div className="input-search grow">
        <StickyNote size={15} />
        <input className="input" placeholder="Add an internal note (visible to admins only)" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <button className="btn btn-primary" disabled={busy || !body.trim()} onClick={() => void add()}>
        Add
      </button>
    </div>
  );
}
