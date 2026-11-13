import { useState } from 'react';
import { Ban, KeyRound, Mail, RotateCcw, ShieldCheck, UserPlus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAsync, useToast } from '../lib/hooks';
import { Badge, Card, Empty, LoadingBlock, Modal, Notice, PageHeader } from '../components/UI';
import { formatDateTime, formatRelative, initials, statusTone, titleCase } from '../lib/format';
import { useAuth } from '../lib/auth';

interface AdminRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  extraPermissions: string[];
  permissions: string[];
  mfaEnrolled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

interface Meta {
  roles: { role: string; label: string; description: string; permissions: string[] }[];
  permissions: string[];
}

export function AdministratorsPage() {
  const { has, admin } = useAuth();
  const { push } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleTarget, setRoleTarget] = useState<AdminRow | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useAsync<{ admins: AdminRow[]; invitations: Invitation[]; activeSuperAdmins: number }>(
    () => api.get('/administrators'),
    []
  );
  const meta = useAsync<Meta>(() => api.get('/administrators/meta'), []);

  async function act(path: string, body: unknown, title: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await api.post(path, body);
      push('success', title);
      list.reload();
    } catch (err) {
      push('error', 'Action failed', err instanceof ApiError ? (err.detail?.reason as string) ?? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Administrators"
        subtitle="Who can access this console, and what they are allowed to do."
        actions={
          has('admins.invite') && (
            <button className="btn btn-primary" onClick={() => setInviteOpen(true)}>
              <UserPlus size={15} /> Invite administrator
            </button>
          )
        }
      />

      <div className="grid grid-3 mb-lg">
        <Card title="Active Super Admins" subtitle="At least one must always exist">
          <div className="stat-value">{list.data?.activeSuperAdmins ?? '—'}</div>
        </Card>
        <Card title="Administrators" subtitle="Active and suspended">
          <div className="stat-value">{list.data?.admins.length ?? '—'}</div>
        </Card>
        <Card title="Pending invitations" subtitle="Not yet accepted">
          <div className="stat-value">{list.data?.invitations.length ?? '—'}</div>
        </Card>
      </div>

      <Card title="All administrators" tight className="mb-lg">
        {list.loading ? (
          <LoadingBlock />
        ) : list.data && list.data.admins.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Administrator</th>
                  <th>Role</th>
                  <th>MFA</th>
                  <th>Last sign-in</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.admins.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="row gap-sm">
                        <div className="sidebar-avatar" style={{ width: 30, height: 30, fontSize: 11 }}>
                          {initials(a.displayName || a.email)}
                        </div>
                        <div>
                          <div className="strong">
                            {a.displayName} {a.id === admin?.id && <span className="badge badge-blue">You</span>}
                          </div>
                          <div className="tiny faint">{a.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={a.role === 'SUPER_ADMIN' ? 'badge-violet' : 'badge-blue'}>{titleCase(a.role)}</Badge>
                    </td>
                    <td>
                      {a.mfaEnrolled ? <Badge tone="badge-green">Enrolled</Badge> : <Badge tone="badge-amber">Pending</Badge>}
                    </td>
                    <td className="muted small">{a.lastLoginAt ? formatRelative(a.lastLoginAt) : 'Never'}</td>
                    <td>
                      <Badge tone={statusTone(a.status)} dot={a.status === 'active' ? 'dot-green' : 'dot-red'}>
                        {titleCase(a.status)}
                      </Badge>
                    </td>
                    <td>
                      <div className="row-actions">
                        {has('admins.roles.manage') && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setRoleTarget(a)}>
                            <ShieldCheck size={13} /> Role
                          </button>
                        )}
                        {has('admins.sessions.revoke') && (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void act(`/administrators/${a.id}/sessions/revoke`, {}, 'Sessions revoked', `Revoke all sessions for ${a.email}?`)}
                          >
                            <KeyRound size={13} />
                          </button>
                        )}
                        {has('admins.suspend') &&
                          (a.status === 'active' ? (
                            <button
                              className="btn btn-danger-ghost btn-sm"
                              disabled={busy || a.id === admin?.id}
                              title={a.id === admin?.id ? 'You cannot suspend yourself' : 'Suspend'}
                              onClick={() => void act(`/administrators/${a.id}/suspend`, {}, 'Administrator suspended', `Suspend ${a.email}?`)}
                            >
                              <Ban size={13} />
                            </button>
                          ) : (
                            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(`/administrators/${a.id}/reactivate`, {}, 'Administrator reactivated')}>
                              <RotateCcw size={13} />
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No administrators">Invite your first teammate.</Empty>
        )}
      </Card>

      <Card title="Pending invitations" tight className="mb-lg">
        {list.data && list.data.invitations.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Invited</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {list.data.invitations.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>
                      <Badge tone="badge-blue">{titleCase(i.role)}</Badge>
                    </td>
                    <td className="muted small">{formatDateTime(i.createdAt)}</td>
                    <td className="muted small">{formatRelative(i.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No pending invitations" icon={<Mail size={22} />}>
            Invitations appear here until they are accepted or expire.
          </Empty>
        )}
      </Card>

      <Card title="Role reference" subtitle="Each role maps to a fixed set of permissions">
        {meta.loading ? (
          <LoadingBlock />
        ) : meta.data ? (
          <div className="col gap">
            {meta.data.roles.map((r) => (
              <div key={r.role} className="card">
                <div className="card-body">
                  <div className="row-between mb" style={{ marginBottom: 8 }}>
                    <div>
                      <div className="strong">{r.label}</div>
                      <div className="tiny muted">{r.description}</div>
                    </div>
                    <Badge tone={r.role === 'SUPER_ADMIN' ? 'badge-violet' : 'badge-blue'}>{r.permissions.length} permissions</Badge>
                  </div>
                  <div className="row gap-sm wrap">
                    {r.permissions.map((p) => (
                      <span key={p} className="badge badge-slate mono" style={{ fontSize: 10 }}>
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Role catalogue unavailable" />
        )}
      </Card>

      {inviteOpen && <InviteModal meta={meta.data} onClose={() => setInviteOpen(false)} onDone={() => list.reload()} />}
      {roleTarget && (
        <RoleModal
          admin={roleTarget}
          meta={meta.data}
          onClose={() => setRoleTarget(null)}
          onDone={() => {
            list.reload();
            setRoleTarget(null);
          }}
        />
      )}
    </>
  );
}

function InviteModal({ meta, onClose, onDone }: { meta: Meta | null; onClose: () => void; onDone: () => void }) {
  const { push } = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('SUPPORT_AGENT');
  const [busy, setBusy] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    try {
      const res = await api.post<{ devToken?: string }>('/administrators/invite', { email, role });
      push('success', 'Invitation created', `An invitation for ${email} is ready.`);
      setDevToken(res.devToken ?? null);
      if (!res.devToken) onDone();
    } catch (err) {
      push('error', 'Could not invite', err instanceof ApiError ? (err.detail?.reason as string) ?? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title="Invite administrator"
      description="The invitee sets their own password and enrols MFA on first sign-in."
      onClose={onClose}
      footer={
        devToken ? (
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || !email} onClick={() => void submit()}>
              {busy ? <span className="spinner" /> : <UserPlus size={14} />} Send invitation
            </button>
          </>
        )
      }
    >
      {devToken ? (
        <>
          <Notice kind="warn">
            No email provider is configured, so the invitation token is shown here instead. Deliver it to the invitee securely.
          </Notice>
          <div className="card mt">
            <div className="card-body mono small" style={{ wordBreak: 'break-all' }}>
              {devToken}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label>Email address</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Role</label>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
              {meta?.roles.map((r) => (
                <option key={r.role} value={r.role}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="hint">{meta?.roles.find((r) => r.role === role)?.description}</span>
          </div>
        </>
      )}
    </Modal>
  );
}

function RoleModal({ admin, meta, onClose, onDone }: { admin: AdminRow; meta: Meta | null; onClose: () => void; onDone: () => void }) {
  const { push } = useToast();
  const [role, setRole] = useState(admin.role);
  const [extras, setExtras] = useState<string[]>(admin.extraPermissions);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/administrators/${admin.id}`, { role, extraPermissions: extras });
      push('success', 'Role updated');
      onDone();
    } catch (err) {
      push('error', 'Could not update role', err instanceof ApiError ? (err.detail?.reason as string) ?? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={`Role for ${admin.displayName}`}
      description={admin.email}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? <span className="spinner" /> : null} Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Role</label>
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
          {meta?.roles.map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Extra permissions</label>
        <div className="row gap-sm wrap">
          {meta?.permissions.map((p) => (
            <label key={p} className="badge badge-slate mono" style={{ cursor: 'pointer', fontSize: 10 }}>
              <input
                type="checkbox"
                checked={extras.includes(p)}
                onChange={(e) => setExtras((prev) => (e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)))}
                style={{ marginRight: 4 }}
              />
              {p}
            </label>
          ))}
        </div>
        <span className="hint">Extras are added on top of the role's default permissions.</span>
      </div>
    </Modal>
  );
}
