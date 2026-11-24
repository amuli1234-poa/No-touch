import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  KeyRound,
  Link2,
  Pause,
  Play,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  XCircle
} from 'lucide-react';
import { ApiError, qs } from '../lib/api';
import { useAsync, useDebounced, useToast } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import {
  copyTradingApi,
  type AdminCopyClient,
  type AdminInvitation,
  type AdminMaster,
  type ClientProfile,
  type CopyFollowerStatus,
  type UserSearchRow
} from '../lib/copyTrading';
import { Badge, Card, Empty, LoadingBlock, Modal, Notice, PageHeader, Pagination, StatCard } from '../components/UI';
import { formatDateTime, formatNumber, formatRelative } from '../lib/format';

const PAGE_SIZE = 20;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All clients' },
  { value: 'authorized', label: 'Authorized' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'suspended', label: 'Suspended' }
];

function statusToneFor(status: CopyFollowerStatus): string {
  if (status === 'active') return 'green';
  if (status === 'paused') return 'amber';
  if (status === 'suspended') return 'red';
  return 'blue';
}

export function CopyTradingClientsPage() {
  const { has } = useAuth();
  const { push } = useToast();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const q = useDebounced(search, 320);

  const [addOpen, setAddOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitationsOpen, setInvitationsOpen] = useState(false);
  const [selected, setSelected] = useState<AdminCopyClient | null>(null);

  const canOnboard = has('copytrading.onboard');
  const canAuthorize = has('copytrading.authorize');
  const canManage = has('copytrading.followers.manage');

  const clients = useAsync(
    () => copyTradingApi.listClients(qs({ page, pageSize: PAGE_SIZE, q, status })),
    [page, q, status]
  );

  const counts = clients.data?.counts;

  return (
    <>
      <PageHeader
        title="Copy Trading clients"
        subtitle="Onboard clients, record Deriv authorization and manage follower status."
        actions={
          <div className="row gap-sm">
            {canOnboard && (
              <button className="btn btn-ghost" onClick={() => setInviteOpen(true)}>
                <UserPlus size={15} /> Invite new client
              </button>
            )}
            {canAuthorize && (
              <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
                <Link2 size={15} /> Add existing client
              </button>
            )}
          </div>
        }
      />

      <div className="grid grid-4 mb">
        <StatCard label="Clients" value={formatNumber(counts?.total ?? 0)} icon={<Activity size={14} />} />
        <StatCard
          label="Pending invitations"
          value={formatNumber(counts?.pendingInvitations ?? 0)}
          tone="violet"
          icon={<UserPlus size={14} />}
          hint="Awaiting client acceptance"
        />
        <StatCard
          label="Active followers"
          value={formatNumber(clients.data?.items.filter((c) => c.status === 'active').length ?? 0)}
          tone="success"
          icon={<Play size={14} />}
          hint="On this page"
        />
        <StatCard
          label="Held (paused / suspended)"
          value={formatNumber(clients.data?.items.filter((c) => c.status !== 'active' && c.status !== 'authorized').length ?? 0)}
          tone="warn"
          icon={<Pause size={14} />}
          hint="On this page"
        />
      </div>

      <Notice kind="info">
        <strong>Connections are live; trade mirroring is not.</strong> This module stores and manages Deriv
        authorizations through the existing Copy Trading backend. Automatic copying of trades is not implemented in
        this deployment, so a follower marked “Active” will not place trades on anyone’s behalf.
      </Notice>

      <Card
        tight
        title="Client connections"
        subtitle="Deriv credentials are never shown. Account identifiers are masked."
        actions={
          <div className="row gap-sm">
            <div className="input-search">
              <Search size={15} />
              <input
                className="input"
                placeholder="Search client, master or account"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                style={{ width: 250 }}
              />
            </div>
            <select
              className="select"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              style={{ width: 150 }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm" onClick={() => setInvitationsOpen(true)}>
              Invitations
            </button>
          </div>
        }
      >
        {clients.loading ? (
          <LoadingBlock label="Loading clients…" />
        ) : clients.error ? (
          <Empty title="Clients could not be loaded" icon={<AlertTriangle size={22} />}>
            {clients.error.code.replace(/_/g, ' ')}
          </Empty>
        ) : (clients.data?.items.length ?? 0) === 0 ? (
          <Empty title="No Copy Trading clients yet">
            Use <strong>Invite new client</strong> to issue a secure invitation, or <strong>Add existing client</strong>{' '}
            to connect a WickSentinel user who already has a Deriv account.
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Master</th>
                    <th>Deriv account</th>
                    <th>Auth</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th>Consent</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {clients.data!.items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className="strong">{c.client.loginId ?? 'Deriv client'}</div>
                        <div className="tiny muted">{c.client.userId ? `User ${c.client.userId.slice(0, 10)}…` : 'No WickSentinel profile'}</div>
                      </td>
                      <td>{c.master?.loginId ?? c.master?.userId.slice(0, 10) ?? '—'}</td>
                      <td className="num">{c.client.derivAccountMasked ?? '—'}</td>
                      <td>
                        <Badge tone={c.authMethod === 'oauth' ? 'violet' : 'blue'}>
                          {c.authMethod === 'oauth' ? 'OAuth' : 'API token'}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={c.accountType === 'demo' ? 'slate' : 'amber'}>{c.accountType}</Badge>
                      </td>
                      <td>
                        <Badge tone={statusToneFor(c.status)} dot={`dot-${statusToneFor(c.status)}`}>
                          {c.status}
                        </Badge>
                      </td>
                      <td>
                        {c.consent ? (
                          <span className="tiny muted" title={formatDateTime(c.consent.recordedAt)}>
                            {formatRelative(c.consent.recordedAt)}
                          </span>
                        ) : (
                          <Badge tone="amber">missing</Badge>
                        )}
                      </td>
                      <td className="tiny muted">{formatRelative(c.createdAt)}</td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(c)}>
                            Manage
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={clients.data!.page}
              pageSize={clients.data!.pageSize}
              total={clients.data!.total}
              totalPages={clients.data!.totalPages}
              onPage={setPage}
            />
          </>
        )}
      </Card>

      {addOpen && (
        <AddExistingClientModal
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setAddOpen(false);
            clients.reload();
            push('success', 'Client authorized');
          }}
        />
      )}

      {inviteOpen && (
        <InviteClientModal
          onClose={() => setInviteOpen(false)}
          onDone={() => {
            setInviteOpen(false);
            clients.reload();
          }}
        />
      )}

      {invitationsOpen && <InvitationsModal onClose={() => setInvitationsOpen(false)} canRevoke={canOnboard} onChanged={() => clients.reload()} />}

      {selected && (
        <ManageClientModal
          client={selected}
          canManage={canManage}
          onClose={() => setSelected(null)}
          onChanged={() => {
            clients.reload();
          }}
        />
      )}
    </>
  );
}

/* ====================================================================== */
/*  Workflow 2 — add an existing client                                   */
/* ====================================================================== */

function AddExistingClientModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { push } = useToast();
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 320);
  const [picked, setPicked] = useState<UserSearchRow | null>(null);
  const [masterUserId, setMasterUserId] = useState('');
  const [method, setMethod] = useState<'oauth' | 'pat'>('oauth');
  const [busy, setBusy] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const searchResults = useAsync(() => copyTradingApi.searchUsers(qs({ q })), [q]);
  const masters = useAsync(() => copyTradingApi.listMasters(), []);
  const profile = useAsync<ClientProfile | null>(
    () => (picked ? copyTradingApi.profile(picked.id) : Promise.resolve(null)),
    [picked?.id]
  );

  const duplicate = profile.data?.checks.duplicateAssignment ?? false;

  async function startOauth() {
    if (!picked || !masterUserId) return;
    setBusy(true);
    try {
      const res = await copyTradingApi.authorizeOauth(picked.id, { masterUserId });
      setResultUrl(res.url);
      push('success', 'Authorization link created', 'Send it to the client privately.');
      onDone();
    } catch (err) {
      push('error', 'Could not create authorization link', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="Add an existing client" wide onClose={onClose} description="Search a WickSentinel user, then connect their Deriv account.">
      <div className="field">
        <label className="small muted">Find the user</label>
        <div className="input-search">
          <Search size={15} />
          <input
            className="input"
            autoFocus
            placeholder="Email is not stored — search by login id, user id or Deriv account"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <p className="tiny muted mt-0">
          WickSentinel accounts are created from a verified Deriv identity, so no email address is stored. Search by
          the Deriv login id or account shown in the Users module.
        </p>
      </div>

      {q.length >= 2 && (
        <div className="mb">
          {searchResults.loading ? (
            <div className="tiny muted">Searching…</div>
          ) : (searchResults.data?.items.length ?? 0) === 0 ? (
            <div className="tiny muted">No matching user. Issue an invitation instead.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Accounts</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {searchResults.data!.items.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="strong">{u.loginId ?? u.id.slice(0, 12)}</div>
                        <div className="tiny muted">{u.id}</div>
                      </td>
                      <td className="num">{u.accountCount}</td>
                      <td>
                        {u.suspended ? (
                          <Badge tone="red">suspended</Badge>
                        ) : u.hasFollowerConnection ? (
                          <Badge tone="violet">connected</Badge>
                        ) : (
                          <Badge tone="green">eligible</Badge>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-ghost btn-sm" onClick={() => setPicked(u)}>
                            Select
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {picked && (
        <>
          <Card title="Selected user" tight>
            {profile.loading ? (
              <LoadingBlock label="Loading readiness…" />
            ) : profile.error ? (
              <div className="tiny muted">Profile could not be loaded.</div>
            ) : profile.data ? (
              <>
                <div className="grid grid-2">
                  <div>
                    <div className="small strong">{profile.data.user.loginId ?? profile.data.user.id}</div>
                    <div className="tiny muted">Joined {formatDateTime(profile.data.user.createdAt)}</div>
                    <div className="tiny muted">{profile.data.user.accounts.length} Deriv account(s)</div>
                  </div>
                  <div>
                    <ReadinessCheck ok={profile.data.checks.hasConnection} label="Deriv account connected" />
                    <ReadinessCheck ok={profile.data.checks.authorizationUsable} label="Authorization usable" />
                    <ReadinessCheck ok={profile.data.checks.consentRecorded} label="Consent recorded" />
                    <ReadinessCheck ok={!profile.data.checks.userSuspended} label="User active" />
                  </div>
                </div>
                {duplicate && (
                  <Notice kind="warn">
                    This user already has a follower connection. Re-authorizing will update the existing record rather
                    than create a duplicate.
                  </Notice>
                )}
              </>
            ) : null}
          </Card>

          <div className="field mt">
            <label className="small muted">Master trader</label>
            <select className="select" value={masterUserId} onChange={(e) => setMasterUserId(e.target.value)}>
              <option value="">Select an eligible master…</option>
              {(masters.data?.items ?? []).map((m: AdminMaster) => (
                <option key={m.userId} value={m.userId} disabled={m.userId === picked.id}>
                  {m.loginId ?? m.userId.slice(0, 10)} · {m.demoAccounts} demo · {m.clients} clients
                </option>
              ))}
            </select>
            <p className="tiny muted mt-0">A master must be an active user with a connected Deriv account.</p>
          </div>

          <div className="field">
            <label className="small muted">Authorization method</label>
            <div className="row gap-sm">
              <button
                className={`btn ${method === 'oauth' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setMethod('oauth')}
                type="button"
              >
                <Link2 size={14} /> Deriv OAuth (client-owned)
              </button>
              <button
                className={`btn ${method === 'pat' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setMethod('pat')}
                type="button"
              >
                <KeyRound size={14} /> Deriv API token
              </button>
            </div>
          </div>

          {method === 'oauth' ? (
            <Notice kind="info">
              The client authorizes their own account in Deriv’s OAuth screen. WickSentinel never sees their credential.
            </Notice>
          ) : (
            <TokenEntryForm
              userId={picked.id}
              masterUserId={masterUserId}
              onDone={() => {
                onDone();
              }}
            />
          )}

          {resultUrl && (
            <div className="field">
              <label className="small muted">Authorization link</label>
              <input className="input" readOnly value={resultUrl} />
            </div>
          )}
        </>
      )}

      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
        {method === 'oauth' && (
          <button className="btn btn-primary" disabled={!picked || !masterUserId || busy} onClick={() => void startOauth()}>
            {busy ? 'Creating…' : 'Create authorization link'}
          </button>
        )}
      </div>
    </Modal>
  );
}

function ReadinessCheck({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="row gap-sm" style={{ marginBottom: 4 }}>
      {ok ? <CheckCircle2 size={14} color="var(--success)" /> : <XCircle size={14} color="var(--text-faint)" />}
      <span className={`tiny ${ok ? '' : 'muted'}`}>{label}</span>
    </div>
  );
}

/* ====================================================================== */
/*  Token entry — the credential never leaves this component's local var   */
/* ====================================================================== */

function TokenEntryForm({ userId, masterUserId, onDone }: { userId: string; masterUserId: string; onDone: () => void }) {
  const { push } = useToast();
  const [token, setToken] = useState('');
  const [consent, setConsent] = useState(false);
  const [attestedBy, setAttestedBy] = useState('');
  const [consentNote, setConsentNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = consent && masterUserId !== '' && token.trim().length >= 20 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await copyTradingApi.authorizeToken(userId, {
        token: token.trim(),
        consent: true,
        masterUserId,
        attestedBy: attestedBy.trim() || undefined,
        consentNote: consentNote.trim() || undefined
      });
      // Clear the credential from memory as soon as the server confirms.
      setToken('');
      push(
        'success',
        'Token validated and connection sealed',
        res.ignoredRealAccounts > 0
          ? `${res.ignoredRealAccounts} real account(s) were visible to the token and were not connected.`
          : undefined
      );
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown';
      setError(
        code === 'account_ownership_mismatch'
          ? 'This token belongs to a different Deriv account than the selected client.'
          : code === 'consent_required'
            ? 'Record the client’s consent before submitting a token.'
            : code.replace(/_/g, ' ')
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Notice kind="warn">
        A Deriv API token is a bearer credential. Ask the client to provide it privately, confirm they consent to
        sharing it, and submit it here only. It is validated against Deriv and sealed with AES-256-GCM server-side —
        it is never stored in the browser, returned in a response, or written to logs.
      </Notice>

      <div className="field">
        <label className="small muted">Deriv API token (trade scope)</label>
        <input
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste the client’s token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="small muted">Who attested the consent?</label>
        <input
          className="input"
          placeholder="e.g. client email or support ticket reference"
          value={attestedBy}
          onChange={(e) => setAttestedBy(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="small muted">Consent note (optional)</label>
        <textarea
          className="textarea"
          rows={2}
          placeholder="How and when the client agreed to share this token"
          value={consentNote}
          onChange={(e) => setConsentNote(e.target.value)}
        />
      </div>

      <label className="row gap-sm small" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
        <span>
          The client has explicitly consented to WickSentinel using this Deriv token to read their trading account.
        </span>
      </label>

      {error && (
        <div className="mt">
          <Notice kind="danger">{error}</Notice>
        </div>
      )}

      <div className="mt row right">
        <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
          {busy ? 'Validating…' : 'Validate & connect'}
        </button>
      </div>
    </form>
  );
}

/* ====================================================================== */
/*  Workflow 1 — invite a new client                                     */
/* ====================================================================== */

function InviteClientModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { push } = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [masterUserId, setMasterUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ url: string; expiresAt: number } | null>(null);

  const masters = useAsync(() => copyTradingApi.listMasters(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await copyTradingApi.invite({
        email: email.trim(),
        name: name.trim() || undefined,
        phone: phone.trim() || undefined,
        note: note.trim() || undefined,
        masterUserId
      });
      setCreated({ url: res.url, expiresAt: res.invitation.expiresAt });
      push('success', 'Invitation created', 'Deliver the link privately to the client.');
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown';
      setError(
        code === 'duplicate_invitation'
          ? 'An active invitation already exists for this email address.'
          : code === 'invalid_email'
            ? 'Enter a valid email address.'
            : code.replace(/_/g, ' ')
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="Invite a new client" onClose={onClose} description="Issue a single-use invitation that expires in 24 hours.">
      {created ? (
        <>
          <Notice kind="info">
            Invitation created. Only a hash is stored, so this link cannot be shown again. Send it to the client
            privately; they will sign in to Deriv to authorize their own account.
          </Notice>
          <div className="field">
            <label className="small muted">Invitation link</label>
            <div className="row gap-sm">
              <input className="input grow" readOnly value={created.url} />
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(created.url).then(
                    () => push('success', 'Copied'),
                    () => push('warn', 'Copy manually', 'Clipboard access is unavailable.')
                  );
                }}
              >
                <ClipboardCopy size={14} /> Copy
              </button>
            </div>
            <p className="tiny muted">Expires {formatDateTime(created.expiresAt)}</p>
          </div>
          <div className="modal-foot">
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label className="small muted">Email address</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <p className="tiny muted mt-0">
              Email is used to address the invitation and prevent duplicates. It is not stored on a user record, because
              WickSentinel accounts are created from a verified Deriv identity.
            </p>
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="small muted">Full name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label className="small muted">Phone (optional)</label>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="small muted">Master trader</label>
            <select className="select" required value={masterUserId} onChange={(e) => setMasterUserId(e.target.value)}>
              <option value="">Select an eligible master…</option>
              {(masters.data?.items ?? []).map((m: AdminMaster) => (
                <option key={m.userId} value={m.userId}>
                  {m.loginId ?? m.userId.slice(0, 10)} · {m.clients} clients
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="small muted">Notes (optional)</label>
            <textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <Notice kind="info">
            An invitation does not create a Deriv connection. The client must authorize their own account through
            Deriv before any follower assignment exists.
          </Notice>

          {error && (
            <div className="mt">
              <Notice kind="danger">{error}</Notice>
            </div>
          )}

          <div className="modal-foot">
            <button className="btn btn-ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={busy || !email.trim() || !masterUserId}>
              {busy ? 'Creating…' : 'Create invitation'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* ====================================================================== */
/*  Invitations queue                                                    */
/* ====================================================================== */

function InvitationsModal({ onClose, canRevoke, onChanged }: { onClose: () => void; canRevoke: boolean; onChanged: () => void }) {
  const { push } = useToast();
  const list = useAsync(() => copyTradingApi.listInvitations(), []);

  async function revoke(id: string) {
    try {
      await copyTradingApi.revokeInvitation(id);
      push('success', 'Invitation revoked');
      list.reload();
      onChanged();
    } catch (err) {
      push('error', 'Could not revoke', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    }
  }

  return (
    <Modal open wide title="Client invitations" onClose={onClose}>
      {list.loading ? (
        <LoadingBlock label="Loading invitations…" />
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <Empty title="No invitations issued yet" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Master</th>
                <th>Status</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data!.items.map((inv: AdminInvitation) => (
                <tr key={inv.id}>
                  <td>{inv.invitedEmail ?? '—'}</td>
                  <td>{inv.invitedName ?? '—'}</td>
                  <td>{inv.master?.loginId ?? '—'}</td>
                  <td>
                    <Badge tone={inv.status === 'pending' ? 'blue' : inv.status === 'accepted' ? 'green' : 'slate'}>
                      {inv.status}
                    </Badge>
                  </td>
                  <td className="tiny muted">{formatRelative(inv.expiresAt)}</td>
                  <td>
                    <div className="row-actions">
                      {canRevoke && inv.status === 'pending' && (
                        <button className="btn btn-danger-ghost btn-sm" onClick={() => void revoke(inv.id)}>
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/* ====================================================================== */
/*  Manage one client                                                    */
/* ====================================================================== */

function ManageClientModal({
  client,
  canManage,
  onClose,
  onChanged
}: {
  client: AdminCopyClient;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const risk = useAsync(() => copyTradingApi.risk(client.id), [client.id]);

  async function setStatus(status: 'active' | 'paused' | 'suspended') {
    setBusy(true);
    try {
      const res = await copyTradingApi.setStatus(client.id, status, reason.trim() || undefined);
      push('success', `Follower ${status}`, res.note);
      onChanged();
      onClose();
    } catch (err) {
      push('error', 'Could not update status', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Remove this follower assignment? Future copied submissions will stop immediately.')) return;
    setBusy(true);
    try {
      const res = await copyTradingApi.remove(client.id);
      push('success', 'Follower removed', res.note);
      onChanged();
      onClose();
    } catch (err) {
      push('error', 'Could not remove follower', err instanceof ApiError ? err.code.replace(/_/g, ' ') : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="Manage client" wide onClose={onClose} description={client.client.loginId ?? client.id}>
      <div className="grid grid-2">
        <div>
          <h4 className="small muted">Connection</h4>
          <dl className="tiny">
            <div>Master: {client.master?.loginId ?? client.master?.userId ?? '—'}</div>
            <div>Method: {client.authMethod === 'oauth' ? 'Deriv OAuth' : 'API token'}</div>
            <div>Mode: {client.accountType}</div>
            <div>Currency: {client.currency ?? '—'}</div>
            <div>Deriv: {client.client.derivAccountMasked ?? '—'}</div>
            <div>Status: {client.status}</div>
            {client.connection.authorizationExpiresAt && (
              <div>
                Authorization expires {formatDateTime(client.connection.authorizationExpiresAt)}
                {client.connection.authorizationExpired && <Badge tone="red">expired</Badge>}
              </div>
            )}
          </dl>
        </div>
        <div>
          <h4 className="small muted">Consent</h4>
          {client.consent ? (
            <dl className="tiny">
              <div>Recorded {formatDateTime(client.consent.recordedAt)}</div>
              <div>Method: {client.consent.method}</div>
              <div>Attested by: {client.consent.attestedBy}</div>
            </dl>
          ) : (
            <Notice kind="warn">No consent is on file for this connection.</Notice>
          )}
        </div>
      </div>

      <h4 className="small muted mt">Risk limits (enforced by the existing engine)</h4>
      {risk.loading ? (
        <div className="tiny muted">Loading…</div>
      ) : risk.data?.profile ? (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {Object.entries(risk.data.profile)
                .filter(([k]) => k !== 'userId' && k !== 'updatedAt')
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="tiny muted">{k}</td>
                    <td className="num">{String(v)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tiny muted">{risk.data?.unavailable ?? 'No custom risk profile.'}</div>
      )}

      {canManage && (
        <>
          <h4 className="small muted mt">Follower controls</h4>
          <div className="field">
            <input
              className="input"
              placeholder="Reason (optional, recorded in the audit log)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="row gap-sm wrap">
            <button className="btn btn-ghost" disabled={busy || client.status === 'active'} onClick={() => void setStatus('active')}>
              <Play size={14} /> Resume
            </button>
            <button className="btn btn-ghost" disabled={busy || client.status === 'paused'} onClick={() => void setStatus('paused')}>
              <Pause size={14} /> Pause
            </button>
            <button className="btn btn-danger-ghost" disabled={busy || client.status === 'suspended'} onClick={() => void setStatus('suspended')}>
              <ShieldCheck size={14} /> Suspend
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={14} /> Remove
            </button>
          </div>
          <Notice kind="warn">
            Pause and suspend block <strong>future</strong> copied submissions. They do not cancel contracts the broker
            has already accepted.
          </Notice>
        </>
      )}

      <div className="modal-foot">
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
