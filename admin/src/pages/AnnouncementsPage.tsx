import { useState } from 'react';
import { Archive, Bell, Megaphone, Plus, Send } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAsync, useToast } from '../lib/hooks';
import { Badge, Card, Empty, LoadingBlock, Modal, PageHeader } from '../components/UI';
import { formatDateTime, statusTone, titleCase } from '../lib/format';
import { useAuth } from '../lib/auth';

interface Announcement {
  id: string;
  title: string;
  body: string;
  kind: string;
  audience: string;
  status: string;
  publishAt: number | null;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const KINDS = ['platform', 'maintenance', 'feature', 'subscription'];
const AUDIENCES = ['all', 'subscribers', 'free'];

/** Announcements: draft → published → archived lifecycle with audit trail. */
export function AnnouncementsPage() {
  const { has } = useAuth();
  const { push } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = useAsync<{ items: Announcement[] }>(() => api.get('/announcements'), []);

  async function act(id: string, verb: 'publish' | 'archive') {
    setBusy(true);
    try {
      await api.post(`/announcements/${id}/${verb}`);
      push('success', `Announcement ${verb === 'publish' ? 'published' : 'archived'}`);
      list.reload();
    } catch (err) {
      push('error', 'Action failed', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Announcements"
        subtitle="Platform messages for your users."
        actions={
          has('announcements.manage') && (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> New announcement
            </button>
          )
        }
      />

      <div className="notice notice-info mb-lg">
        <strong>Delivery note. </strong>
        Publishing records the message and its author here and in the audit log. No user-facing delivery channel (in-app
        banner, email or push) is wired up yet, so publishing does not yet reach users.
      </div>

      <Card title="All announcements" tight>
        {list.loading ? (
          <LoadingBlock />
        ) : list.data && list.data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Audience</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="strong">{a.title}</div>
                      <div className="tiny faint truncate" style={{ maxWidth: 320 }}>
                        {a.body.slice(0, 90)}
                        {a.body.length > 90 ? '…' : ''}
                      </div>
                    </td>
                    <td>
                      <Badge tone="badge-slate">{titleCase(a.kind)}</Badge>
                    </td>
                    <td className="small">{titleCase(a.audience)}</td>
                    <td>
                      <Badge tone={statusTone(a.status)}>{titleCase(a.status)}</Badge>
                    </td>
                    <td className="muted small">{formatDateTime(a.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        {has('announcements.manage') && a.status !== 'published' && a.status !== 'archived' && (
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(a.id, 'publish')}>
                            <Send size={13} /> Publish
                          </button>
                        )}
                        {has('announcements.manage') && a.status !== 'archived' && (
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(a.id, 'archive')}>
                            <Archive size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No announcements" icon={<Megaphone size={22} />}>
            Create an announcement to inform users about platform news or maintenance.
          </Empty>
        )}
      </Card>

      {createOpen && (
        <CreateModal
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

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { push } = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('platform');
  const [audience, setAudience] = useState('all');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await api.post('/announcements', { title, body, kind, audience });
      push('success', 'Draft created');
      onCreated();
    } catch (err) {
      push('error', 'Could not create', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="New announcement"
      description="Saved as a draft. Publish it when you are ready."
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !title} onClick={() => void create()}>
            {busy ? <span className="spinner" /> : <Bell size={14} />} Save draft
          </button>
        </>
      }
    >
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Body</label>
        <textarea className="textarea" style={{ minHeight: 120 }} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label>Type</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {titleCase(k)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Audience</label>
          <select className="select" value={audience} onChange={(e) => setAudience(e.target.value)}>
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {titleCase(a)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}
