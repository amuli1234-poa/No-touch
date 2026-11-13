import { useState } from 'react';
import { Headphones, Plus, Send } from 'lucide-react';
import { api, ApiError, qs } from '../lib/api';
import { useAsync, useToast } from '../lib/hooks';
import { Badge, Card, Empty, LoadingBlock, Modal, PageHeader, Pagination } from '../components/UI';
import { formatRelative, statusTone, titleCase } from '../lib/format';
import { useAuth } from '../lib/auth';

interface Ticket {
  id: string;
  subject: string;
  description: string;
  priority: string;
  status: string;
  userId: string | null;
  assignedAdminId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Message {
  id: string;
  ticketId: string;
  internal: boolean;
  body: string;
  authorKind: string;
  createdAt: number;
}

const PAGE_SIZE = 20;
const STATUSES = ['open', 'in_progress', 'waiting_for_user', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/**
 * Support centre. Internal notes are flagged and only ever visible here; no
 * user-facing route returns them.
 */
export function SupportPage() {
  const { has } = useAuth();
  const { push } = useToast();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useAsync<{ items: Ticket[]; total: number; page: number; totalPages: number }>(
    () => api.get(`/support${qs({ page, pageSize: PAGE_SIZE, status })}`),
    [page, status]
  );
  const detail = useAsync<{ ticket: Ticket; messages: Message[]; user: { id: string; loginId: string | null } | null }>(
    () => api.get(`/support/${selected}`),
    [selected]
  );

  async function updateTicket(patch: Record<string, unknown>) {
    try {
      await api.patch(`/support/${selected}`, patch);
      push('success', 'Ticket updated');
      detail.reload();
      list.reload();
    } catch (err) {
      push('error', 'Update failed', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    }
  }

  return (
    <>
      <PageHeader
        title="Support"
        subtitle="Customer tickets, replies and internal notes."
        actions={
          has('support.manage') && (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> New ticket
            </button>
          )
        }
      />

      <Card
        tight
        title={`${list.data?.total ?? 0} tickets`}
        actions={
          <select className="select" style={{ width: 170 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </select>
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
                    <th>Ticket</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="strong">{t.subject}</div>
                        <div className="tiny faint mono">{t.id}</div>
                      </td>
                      <td>
                        <Badge tone={statusTone(t.priority)}>{titleCase(t.priority)}</Badge>
                      </td>
                      <td>
                        <Badge tone={statusTone(t.status)}>{titleCase(t.status)}</Badge>
                      </td>
                      <td className="muted small">{formatRelative(t.updatedAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(t.id)}>
                            Open
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data.page} pageSize={PAGE_SIZE} total={list.data.total} totalPages={list.data.totalPages} onPage={setPage} />
          </>
        ) : (
          <Empty title="No tickets" icon={<Headphones size={22} />}>
            {status ? 'No tickets with this status.' : 'Customer tickets will appear here.'}
          </Empty>
        )}
      </Card>

      <Modal
        open={Boolean(selected)}
        title={detail.data?.ticket.subject ?? 'Ticket'}
        description={detail.data?.ticket.id}
        onClose={() => setSelected(null)}
        wide
        footer={
          <button className="btn btn-ghost" onClick={() => setSelected(null)}>
            Close
          </button>
        }
      >
        {detail.loading ? (
          <LoadingBlock />
        ) : detail.data ? (
          <div className="col gap-lg">
            <div className="grid grid-2">
              <div>
                <div className="tiny faint">Status</div>
                <select className="select" value={detail.data.ticket.status} onChange={(e) => void updateTicket({ status: e.target.value })} disabled={!has('support.manage')}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {titleCase(s)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="tiny faint">Priority</div>
                <select className="select" value={detail.data.ticket.priority} onChange={(e) => void updateTicket({ priority: e.target.value })} disabled={!has('support.manage')}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {titleCase(p)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {detail.data.ticket.description && <div className="notice notice-info">{detail.data.ticket.description}</div>}

            {detail.data.user && (
              <div className="row-between card" style={{ padding: '10px 14px' }}>
                <span className="muted small">Linked user</span>
                <span className="mono small">{detail.data.user.loginId ?? detail.data.user.id}</span>
              </div>
            )}

            <div>
              <h3 className="mb">Conversation</h3>
              {detail.data.messages.length > 0 ? (
                <div className="col gap-sm">
                  {detail.data.messages.map((m) => (
                    <div key={m.id} className={`card ${m.internal ? '' : ''}`} style={{ borderLeft: m.internal ? '3px solid var(--violet)' : '3px solid var(--blue)' }}>
                      <div className="card-body">
                        <div className="row-between" style={{ marginBottom: 6 }}>
                          <Badge tone={m.internal ? 'badge-violet' : 'badge-blue'}>{m.internal ? 'Internal note' : 'Reply'}</Badge>
                          <span className="tiny faint">{formatRelative(m.createdAt)}</span>
                        </div>
                        <div>{m.body}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted small">No messages yet.</div>
              )}
              {has('support.manage') && <ReplyComposer ticketId={selected!} onSent={() => detail.reload()} />}
            </div>
          </div>
        ) : (
          <Empty title="Ticket not found" />
        )}
      </Modal>

      {createOpen && (
        <CreateTicketModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            list.reload();
            setCreateOpen(false);
          }}
        />
      )}
    </>
  );
}

function ReplyComposer({ ticketId, onSent }: { ticketId: string; onSent: () => void }) {
  const { push } = useToast();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post(`/support/${ticketId}/messages`, { body, internal });
      setBody('');
      push('success', internal ? 'Internal note added' : 'Reply added');
      onSent();
    } catch {
      push('error', 'Could not send');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt">
      <textarea className="textarea" placeholder={internal ? 'Internal note (admins only)' : 'Reply to the user'} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row-between mt" style={{ marginTop: 8 }}>
        <label className="row gap-sm small muted" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          Internal note
        </label>
        <button className="btn btn-primary btn-sm" disabled={busy || !body.trim()} onClick={() => void send()}>
          <Send size={13} /> Send
        </button>
      </div>
    </div>
  );
}

function CreateTicketModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { push } = useToast();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await api.post('/support', { subject, description, priority, userId: userId || null });
      push('success', 'Ticket created');
      onCreated();
    } catch (err) {
      push('error', 'Could not create ticket', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="New ticket"
      description="Log a support request on behalf of a user."
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !subject} onClick={() => void create()}>
            {busy ? <span className="spinner" /> : <Plus size={14} />} Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Subject</label>
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label>Priority</label>
        <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {titleCase(p)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Linked user id (optional)</label>
        <input className="input mono" placeholder="u_…" value={userId} onChange={(e) => setUserId(e.target.value)} />
        <span className="hint">Leave blank for a general ticket.</span>
      </div>
    </Modal>
  );
}
