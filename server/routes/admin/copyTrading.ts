import { Router, type Response } from 'express';
import { createHash } from 'node:crypto';
import type { AdminRouteContext } from './helpers.js';
import { parsePagination, paginate, fail, auditFromRequest } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import { createOpaqueId } from '../../lib/pkce.js';
import { seal, open } from '../../lib/crypto.js';
import { revokeToken } from '../../lib/deriv.js';
import { validatePatToken, PAT_FAILURE_MESSAGE } from '../../copyTrading/pat.js';
import { buildCopyPerformance } from '../../copyTrading/performance.js';
import { buildCopyReadiness, listReadinessOwners } from '../../copyTrading/readiness.js';
import { buildPlatformOverview, buildReconciliation, buildExecutions, followerPnl } from '../../copyTrading/reporting.js';
import { applyFollowerCommissions, buildStatement } from '../../copyTrading/finance.js';
import type {
  CopyTradingFollowerRecord,
  CopyFollowerStatus,
  CopyTradingInvitationRecord
} from '../../copyTrading/types.js';
import type { UserRecord } from '../../store/store.js';

/**
 * Copy Trading client management (`/api/admin/v1/copy-trading/*`).
 *
 * An administrative view and control surface over the *existing* Copy Trading
 * domain. It reuses, and does not duplicate:
 *   - the follower record and its sealed-credential storage,
 *   - `validatePatToken` — the same validator the trader route calls,
 *   - the OAuth invitation + callback flow in `routes/auth.ts`,
 *   - `revokeToken` for OAuth grant revocation,
 *   - the audit log and its secret redaction.
 *
 * Ownership model (unchanged from the existing backend): a follower record's
 * `ownerUserId` is the *master* — the WickSentinel user on whose behalf copied
 * trades would be placed. The `derivSub`/`accounts` on that record identify the
 * *client* whose Deriv account is the source. "Assigning a client to a master"
 * is therefore choosing `ownerUserId`; there is no second assignment table.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 32;
const MAX_NOTE_LENGTH = 2000;
const DEFAULT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

function maskAccountId(id: string): string {
  if (id.length <= 4) return '••••';
  return `${id.slice(0, 2)}${'•'.repeat(Math.max(0, id.length - 4))}${id.slice(-2)}`;
}

function effectiveStatus(record: CopyTradingFollowerRecord): CopyFollowerStatus {
  return record.status ?? 'authorized';
}

/** The WickSentinel user who owns this Deriv identity, when one exists. */
function clientUser(store: AdminRouteContext['store'], record: CopyTradingFollowerRecord): UserRecord | null {
  return store.getUserByDerivSub(record.derivSub);
}

/**
 * Administrative projection of a follower.
 *
 * Deliberately excludes `tokenSealed` and every raw credential. Account ids are
 * masked, matching the rule already used by the users module.
 */
function clientView(record: CopyTradingFollowerRecord, store: AdminRouteContext['store']) {
  const master = store.getUserById(record.ownerUserId);
  const client = clientUser(store, record);
  const consent = store.getCopyTradingConsent(record.id);
  return {
    id: record.id,
    client: {
      loginId: record.loginId ?? null,
      derivAccountMasked: record.accounts[0] ? maskAccountId(record.accounts[0].accountId) : null,
      userId: client?.id ?? null
    },
    master: master ? { userId: master.id, loginId: master.loginId ?? null } : null,
    authMethod: record.authMethod,
    accountType: record.accounts.some((a) => a.type === 'real') ? 'real' : 'demo',
    currency: record.accounts[0]?.currency ?? null,
    accounts: record.accounts.map((a) => ({
      accountId: maskAccountId(a.accountId),
      type: a.type,
      currency: a.currency ?? null,
      status: a.status ?? null
    })),
    status: effectiveStatus(record),
    pausedAt: record.pausedAt ?? null,
    suspendedAt: record.suspendedAt ?? null,
    suspendedReason: record.suspendedReason ?? null,
    connection: {
      /** A PAT has no server-known expiry; only an OAuth grant does. */
      authorizationExpiresAt: record.authMethod === 'oauth' ? record.tokenExpiresAt : null,
      authorizationExpired:
        record.authMethod === 'oauth' && record.tokenExpiresAt > 0 && record.tokenExpiresAt <= Date.now()
    },
    consent: consent
      ? { recordedAt: consent.consentedAt, method: consent.method, attestedBy: consent.attestedBy }
      : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision ?? 0
  };
}

function invitationView(record: CopyTradingInvitationRecord, store: AdminRouteContext['store']) {
  const now = Date.now();
  let status: 'pending' | 'accepted' | 'expired' | 'revoked';
  if (record.revokedAt) status = 'revoked';
  else if (record.consumedAt !== null) status = 'accepted';
  else if (record.expiresAt <= now) status = 'expired';
  else status = 'pending';
  const master = store.getUserById(record.ownerUserId);
  return {
    id: record.id,
    invitedEmail: record.invitedEmail ?? null,
    invitedName: record.invitedName ?? null,
    invitedPhone: record.invitedPhone ?? null,
    note: record.note ?? null,
    status,
    master: master ? { userId: master.id, loginId: master.loginId ?? null } : null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    consumedAt: record.consumedAt
  };
}

function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

function optionalText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value.slice(0, max) : null;
}

/**
 * Resolves an eligible master: a real, active user with a connected account,
 * which is the precondition the copy engine would need to place anything on
 * their behalf. Returns a code rather than throwing so the caller can respond.
 */
function resolveMaster(
  store: AdminRouteContext['store'],
  raw: unknown
): { user: UserRecord } | { error: string; message: string } {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return { error: 'master_required', message: 'Select the master trader this client will copy.' };
  const user = store.getUserById(id);
  if (!user) return { error: 'master_not_found', message: 'That master trader does not exist.' };
  if (user.suspended) return { error: 'master_suspended', message: 'That master trader is suspended.' };
  if (user.accounts.length === 0) {
    return { error: 'master_ineligible', message: 'That master trader has no connected Deriv account.' };
  }
  return { user };
}

export function createCopyTradingAdminRouter(ctx: AdminRouteContext): Router {
  const { store, cfg } = ctx;
  const router = Router();

  /* ==================================================================== */
  /*  Reads                                                               */
  /* ==================================================================== */

  router.get('/clients', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const { page, pageSize } = parsePagination(req);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const statusFilter = String(req.query.status ?? '').trim();
    const method = String(req.query.method ?? '').trim();

    let rows = store.listAllCopyTradingFollowers();

    if (q) {
      rows = rows.filter((r) => {
        if (r.loginId && r.loginId.toLowerCase().includes(q)) return true;
        if (r.id.toLowerCase().includes(q)) return true;
        if (r.ownerUserId.toLowerCase().includes(q)) return true;
        const owner = store.getUserById(r.ownerUserId);
        if (owner?.loginId && owner.loginId.toLowerCase().includes(q)) return true;
        return r.accounts.some((a) => a.accountId.toLowerCase().includes(q));
      });
    }
    if (statusFilter) rows = rows.filter((r) => effectiveStatus(r) === statusFilter);
    if (method === 'oauth' || method === 'pat') rows = rows.filter((r) => r.authMethod === method);

    const pageData = paginate(rows, page, pageSize);
    return res.json({
      ...pageData,
      items: pageData.items.map((r) => clientView(r, store)),
      counts: {
        total: store.listAllCopyTradingFollowers().length,
        pendingInvitations: store
          .listAllCopyTradingInvitations()
          .filter((i) => i.consumedAt === null && !i.revokedAt && i.expiresAt > Date.now()).length
      }
    });
  });

  router.get('/invitations', requireAdmin(ctx, 'copytrading.read'), (_req: AdminAuthedRequest, res: Response) => {
    const items = store.listAllCopyTradingInvitations().map((i) => invitationView(i, store));
    return res.json({
      items,
      pending: items.filter((i) => i.status === 'pending').length,
      total: items.length
    });
  });

  /** Eligible masters for the assignment picker. */
  router.get('/masters', requireAdmin(ctx, 'copytrading.read'), (_req: AdminAuthedRequest, res: Response) => {
    const items = store
      .listUsers()
      .filter((u) => !u.suspended && u.accounts.length > 0)
      .slice(0, 200)
      .map((u) => ({
        userId: u.id,
        loginId: u.loginId ?? null,
        accountCount: u.accounts.length,
        demoAccounts: u.accounts.filter((a) => a.type === 'demo').length,
        realAccounts: u.accounts.filter((a) => a.type === 'real').length,
        clients: store.listCopyTradingFollowers(u.id).length
      }));
    return res.json({ items });
  });

  router.get('/clients/search', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ items: [], hint: 'Enter at least 2 characters.' });
    const needle = q.toLowerCase();
    const items = store
      .listUsers()
      .filter((u) => {
        if (u.id.toLowerCase().includes(needle)) return true;
        if (u.loginId && u.loginId.toLowerCase().includes(needle)) return true;
        return u.accounts.some((a) => a.accountId.toLowerCase().includes(needle));
      })
      .slice(0, 20)
      .map((u) => {
        const asClient = store.findCopyTradingFollowerByIdentity(u.derivSub);
        return {
          id: u.id,
          loginId: u.loginId ?? null,
          createdAt: u.createdAt,
          suspended: Boolean(u.suspended),
          accountCount: u.accounts.length,
          /** True when this user's Deriv identity is already a connected client. */
          hasFollowerConnection: Boolean(asClient),
          followerStatus: asClient ? effectiveStatus(asClient) : null
        };
      });
    return res.json({ items });
  });

  /**
   * Readiness facts for one user, so the Add Client dialog can show exactly
   * what is and is not satisfied rather than guessing.
   */
  router.get('/clients/:userId/profile', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const user = store.getUserById(req.params.userId);
    if (!user) return fail(res, 404, 'user_not_found');

    const follower = store.findCopyTradingFollowerByIdentity(user.derivSub);
    const consent = follower ? store.getCopyTradingConsent(follower.id) : null;
    return res.json({
      user: {
        id: user.id,
        loginId: user.loginId ?? null,
        createdAt: user.createdAt,
        suspended: Boolean(user.suspended),
        accounts: user.accounts.map((a) => ({
          accountId: maskAccountId(a.accountId),
          type: a.type,
          currency: a.currency ?? null
        }))
      },
      connection: follower ? clientView(follower, store) : null,
      checks: {
        hasConnection: Boolean(follower),
        hasDemoAccount: Boolean(follower?.accounts.some((a) => a.type === 'demo')),
        authorizationUsable: follower
          ? follower.authMethod === 'pat' || follower.tokenExpiresAt === 0 || follower.tokenExpiresAt > Date.now()
          : false,
        consentRecorded: Boolean(consent),
        duplicateAssignment: Boolean(follower),
        userSuspended: Boolean(user.suspended)
      }
    });
  });

  /* ==================================================================== */
  /*  Workflow 1 — invite a genuinely new client                          */
  /* ==================================================================== */

  router.post('/clients/invitations', requireAdmin(ctx, 'copytrading.onboard'), async (req: AdminAuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = normaliseEmail(body.email);
    if (!email) return fail(res, 400, 'invalid_email', { message: 'Enter a valid email address.' });

    const master = resolveMaster(store, body.masterUserId);
    if ('error' in master) return fail(res, 400, master.error, { message: master.message });

    const name = optionalText(body.name, MAX_NAME_LENGTH);
    const phone = optionalText(body.phone, MAX_PHONE_LENGTH);
    const note = optionalText(body.note, MAX_NOTE_LENGTH);

    // A WickSentinel account exists only once a Deriv identity is verified, and
    // it carries no email. A duplicate therefore means an invitation is already
    // outstanding for this address — never a fabricated user record.
    const existing = store
      .listAllCopyTradingInvitations()
      .find((inv) => inv.invitedEmail === email && inv.consumedAt === null && !inv.revokedAt && inv.expiresAt > Date.now());
    if (existing) {
      return fail(res, 409, 'duplicate_invitation', {
        message: 'An active invitation already exists for this email address.',
        invitationId: existing.id,
        expiresAt: existing.expiresAt
      });
    }

    const now = Date.now();
    const id = createOpaqueId(18);
    const secret = createOpaqueId(24);
    const record: CopyTradingInvitationRecord = {
      id,
      // The master is fixed at issue time: the shared OAuth callback resolves
      // `ownerUserId` to a real user and refuses to continue otherwise.
      ownerUserId: master.user.id,
      tokenHash: createHash('sha256').update(secret).digest('base64url'),
      createdAt: now,
      expiresAt: now + DEFAULT_INVITATION_TTL_MS,
      consumedAt: null,
      invitedEmail: email,
      invitedName: name,
      invitedPhone: phone,
      note,
      createdByAdminId: req.admin!.id,
      acceptedByUserId: null,
      revokedAt: null
    };
    await store.putCopyTradingInvitation(record);

    await auditFromRequest(ctx, req, {
      action: 'copytrading.invitation.create',
      targetType: 'copy_trading_invitation',
      targetId: id,
      newState: { email, name, phone, masterUserId: master.user.id, expiresAt: record.expiresAt }
    });

    const url = new URL(`/auth/copy-trading/connect/${id}`, cfg.appOrigin);
    url.searchParams.set('token', secret);
    return res.status(201).json({
      invitation: invitationView(record, store),
      // Returned once so the administrator can deliver it. Only the hash is
      // stored, so the link cannot be recovered afterwards.
      url: url.toString()
    });
  });

  router.post('/invitations/:id/revoke', requireAdmin(ctx, 'copytrading.onboard'), async (req: AdminAuthedRequest, res: Response) => {
    const record = await store.revokeCopyTradingInvitation(req.params.id);
    if (!record) return fail(res, 404, 'invitation_not_found_or_consumed');
    await auditFromRequest(ctx, req, {
      action: 'copytrading.invitation.revoke',
      targetType: 'copy_trading_invitation',
      targetId: record.id
    });
    return res.json({ invitation: invitationView(record, store) });
  });

  /* ==================================================================== */
  /*  Workflow 2 — authorize an existing client                           */
  /* ==================================================================== */

  /**
   * Connects a client's Deriv account from a client-provided API token.
   *
   * The token is validated by the shared `validatePatToken` (the same call the
   * trader route makes), sealed with AES-256-GCM before it is persisted, and
   * never returned, logged, or written to an audit record. Consent is required
   * and stored separately from the credential.
   */
  router.post('/clients/:userId/authorize-token', requireAdmin(ctx, 'copytrading.authorize'), async (req: AdminAuthedRequest, res: Response) => {
    const user = store.getUserById(req.params.userId);
    if (!user) return fail(res, 404, 'user_not_found');
    if (user.suspended) {
      return fail(res, 409, 'user_suspended', { message: 'Reactivate this user before authorizing a connection.' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.consent !== true) {
      return fail(res, 400, 'consent_required', {
        message: 'The client must explicitly consent to sharing their Deriv token before it can be connected.'
      });
    }
    const master = resolveMaster(store, body.masterUserId);
    if ('error' in master) return fail(res, 400, master.error, { message: master.message });
    if (master.user.id === user.id) {
      return fail(res, 400, 'master_is_client', { message: 'A client cannot be their own master.' });
    }

    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const validation = await validatePatToken(cfg, token);
    if (!validation.ok) {
      // The token is never echoed, and never included in the error.
      return fail(res, validation.failure.status, validation.failure.error, {
        message: PAT_FAILURE_MESSAGE[validation.failure.error]
      });
    }

    const { demoAccounts, identity } = validation;

    // Ownership: the token must belong to the selected client, not someone else.
    if (identity.sub !== user.derivSub) {
      return fail(res, 409, 'account_ownership_mismatch', {
        message: 'This token does not belong to the selected client. Ask the client for a token from their own Deriv account.'
      });
    }
    // A client token must never be usable to copy the master's own account.
    if (master.user.accounts.some((owned) => demoAccounts.some((a) => a.accountId === owned.accountId))) {
      return fail(res, 409, 'master_account_conflict', {
        message: 'The token includes the master’s own account. Use a client account token.'
      });
    }

    const existing =
      store.findCopyTradingFollowerByIdentity(identity.sub) ??
      store.findCopyTradingFollowerByAccountIds(demoAccounts.map((a) => a.accountId));
    if (existing && existing.ownerUserId !== master.user.id) {
      return fail(res, 409, 'already_linked', {
        message: 'This Deriv account is already connected to another manager.',
        existingMasterUserId: existing.ownerUserId
      });
    }

    const now = Date.now();
    const record: CopyTradingFollowerRecord = {
      id: existing?.id ?? createOpaqueId(),
      ownerUserId: master.user.id,
      derivSub: identity.sub,
      authMethod: 'pat',
      loginId: identity.loginId,
      accounts: demoAccounts.map((a) => ({
        accountId: a.accountId,
        type: 'demo' as const,
        currency: a.currency,
        status: a.status
      })),
      tokenSealed: seal(token, cfg.session.secret),
      tokenExpiresAt: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: existing?.status ?? 'authorized',
      revision: (existing?.revision ?? 0) + 1
    };
    await store.putCopyTradingFollower(record);

    await store.putCopyTradingConsent({
      followerId: record.id,
      ownerUserId: master.user.id,
      method: 'pat',
      recordedByAdminId: req.admin!.id,
      attestedBy: optionalText(body.attestedBy, MAX_NAME_LENGTH) ?? `admin:${req.admin!.email}`,
      consentedAt: now,
      note: optionalText(body.consentNote, MAX_NOTE_LENGTH)
    });

    await auditFromRequest(ctx, req, {
      action: 'copytrading.token.authorize',
      targetType: 'copy_trading_follower',
      targetId: record.id,
      newState: {
        clientUserId: user.id,
        masterUserId: master.user.id,
        authMethod: 'pat',
        accountCount: record.accounts.length,
        realAccountsReported: validation.realAccountIds.length
      }
    });

    return res.status(existing ? 200 : 201).json({
      client: clientView(record, store),
      /** Reported so the administrator knows real accounts were seen and ignored. */
      ignoredRealAccounts: validation.realAccountIds.length
    });
  });

  /**
   * Starts the client-owned OAuth flow for an existing user.
   *
   * Reuses the invitation + callback path, so the client authorizes their own
   * Deriv account and the platform never handles their credential.
   */
  router.post('/clients/:userId/authorize-oauth', requireAdmin(ctx, 'copytrading.authorize'), async (req: AdminAuthedRequest, res: Response) => {
    const user = store.getUserById(req.params.userId);
    if (!user) return fail(res, 404, 'user_not_found');
    if (user.suspended) return fail(res, 409, 'user_suspended');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const master = resolveMaster(store, body.masterUserId);
    if ('error' in master) return fail(res, 400, master.error, { message: master.message });
    if (master.user.id === user.id) {
      return fail(res, 400, 'master_is_client', { message: 'A client cannot be their own master.' });
    }

    const now = Date.now();
    const id = createOpaqueId(18);
    const secret = createOpaqueId(24);
    const record: CopyTradingInvitationRecord = {
      id,
      ownerUserId: master.user.id,
      tokenHash: createHash('sha256').update(secret).digest('base64url'),
      createdAt: now,
      expiresAt: now + DEFAULT_INVITATION_TTL_MS,
      consumedAt: null,
      invitedEmail: null,
      invitedName: user.loginId ?? null,
      invitedPhone: null,
      note: null,
      createdByAdminId: req.admin!.id,
      acceptedByUserId: null,
      revokedAt: null
    };
    await store.putCopyTradingInvitation(record);

    await auditFromRequest(ctx, req, {
      action: 'copytrading.oauth.invite',
      targetType: 'copy_trading_invitation',
      targetId: id,
      metadata: { clientUserId: user.id, masterUserId: master.user.id }
    });

    const url = new URL(`/auth/copy-trading/connect/${id}`, cfg.appOrigin);
    url.searchParams.set('token', secret);
    return res.status(201).json({ invitation: invitationView(record, store), url: url.toString() });
  });

  /* ==================================================================== */
  /*  Follower lifecycle                                                  */
  /* ==================================================================== */

  /**
   * Lifecycle transitions.
   *
   * `paused` and `suspended` block *future* copied submissions. They cannot
   * cancel contracts the broker has already accepted, and this endpoint never
   * implies that they did.
   */
  router.post('/clients/:id/status', requireAdmin(ctx, 'copytrading.followers.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const record = store.listAllCopyTradingFollowers().find((f) => f.id === req.params.id);
    if (!record) return fail(res, 404, 'client_not_found');

    const next = String((req.body ?? {}).status ?? '');
    const allowed: CopyFollowerStatus[] = ['active', 'paused', 'suspended'];
    if (!allowed.includes(next as CopyFollowerStatus)) return fail(res, 400, 'invalid_status', { allowed });

    const previous = effectiveStatus(record);
    const now = Date.now();
    const updated: CopyTradingFollowerRecord = {
      ...record,
      status: next as CopyFollowerStatus,
      pausedAt: next === 'paused' ? now : null,
      pausedBy: next === 'paused' ? req.admin!.id : null,
      suspendedAt: next === 'suspended' ? now : null,
      suspendedReason: next === 'suspended' ? optionalText((req.body ?? {}).reason, MAX_NOTE_LENGTH) : null,
      updatedAt: now,
      revision: (record.revision ?? 0) + 1
    };
    await store.putCopyTradingFollower(updated);

    await auditFromRequest(ctx, req, {
      action: `copytrading.follower.${next}`,
      targetType: 'copy_trading_follower',
      targetId: record.id,
      previousState: { status: previous },
      newState: { status: next },
      reason: optionalText((req.body ?? {}).reason, MAX_NOTE_LENGTH)
    });

    return res.json({
      client: clientView(updated, store),
      note:
        next === 'active'
          ? 'Follower resumed. Future copied submissions may proceed.'
          : 'Future copied submissions are blocked. Contracts already accepted by the broker are unaffected.'
    });
  });

  /**
   * Removes the follower assignment.
   *
   * An OAuth grant is revoked at Deriv. A PAT cannot be revoked by us — only
   * the client can do that in Deriv's settings — so the response says so
   * instead of implying the credential is dead.
   */
  router.delete('/clients/:id', requireAdmin(ctx, 'copytrading.followers.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const record = store.listAllCopyTradingFollowers().find((f) => f.id === req.params.id);
    if (!record) return fail(res, 404, 'client_not_found');

    if (record.authMethod === 'oauth') {
      const token = open(record.tokenSealed, cfg.session.secret);
      if (token) await revokeToken(cfg, token);
    }

    await store.deleteCopyTradingFollower(record.ownerUserId, record.id);
    await store.deleteCopyTradingConsent(record.id);

    await auditFromRequest(ctx, req, {
      action: 'copytrading.follower.remove',
      targetType: 'copy_trading_follower',
      targetId: record.id,
      previousState: { ownerUserId: record.ownerUserId, authMethod: record.authMethod }
    });

    return res.json({
      removed: true,
      providerRevoked: record.authMethod === 'oauth',
      note:
        record.authMethod === 'oauth'
          ? 'Connection removed and its OAuth grant revoked at Deriv.'
          : 'Connection removed from WickSentinel. The client must revoke the token in Deriv settings to invalidate it.'
    });
  });

  /* ==================================================================== */
  /*  Deriv integration health                                            */
  /* ==================================================================== */

  /**
   * Administrative view of every Deriv connection.
   *
   * Balances are deliberately NOT included: this endpoint never calls Deriv, so
   * it cannot present a figure that was not freshly verified. Connection state,
   * method, mode and expiry are all real fields on the stored record.
   */
  router.get('/connections', requireAdmin(ctx, 'copytrading.read'), (_req: AdminAuthedRequest, res: Response) => {
    const followers = store.listAllCopyTradingFollowers();
    const now = Date.now();

    const items = followers.map((f) => {
      const expired = f.authMethod === 'oauth' && f.tokenExpiresAt > 0 && f.tokenExpiresAt <= now;
      return {
        followerId: f.id,
        method: f.authMethod,
        client: f.loginId ?? null,
        masterUserId: f.ownerUserId,
        accountType: f.accounts.some((a) => a.type === 'real') ? 'real' : 'demo',
        currency: f.accounts[0]?.currency ?? null,
        accounts: f.accounts.map((a) => ({
          accountId: maskAccountId(a.accountId),
          type: a.type,
          status: a.status ?? null
        })),
        status: effectiveStatus(f),
        authorizationExpiresAt: f.authMethod === 'oauth' ? f.tokenExpiresAt : null,
        expired,
        health: expired ? 'EXPIRED' : effectiveStatus(f) === 'suspended' ? 'SUSPENDED' : 'OK',
        lastUpdatedAt: f.updatedAt,
        consentRecorded: Boolean(store.getCopyTradingConsent(f.id))
      };
    });

    return res.json({
      generatedAt: now,
      items,
      summary: {
        total: items.length,
        oauth: items.filter((i) => i.method === 'oauth').length,
        token: items.filter((i) => i.method === 'pat').length,
        expired: items.filter((i) => i.expired).length,
        withoutConsent: items.filter((i) => !i.consentRecorded).length
      },
      /** PAT app ids and OAuth app ids are distinct; never conflate them. */
      appIds: {
        oauthConfigured: Boolean(cfg.deriv.appId),
        patConfigured: Boolean(cfg.deriv.patAppId),
        note: 'OAuth and API-token connections use separate Deriv App IDs.'
      },
      balancesUnavailable:
        'Balances are not listed here because this view does not call Deriv. Open a client (Copy Trading → Clients → Manage) to read their live balance per account.'
    });
  });

  /* ==================================================================== */
  /*  Copy engine control + performance                                    */
  /* ==================================================================== */

  /**
   * The Start/Stop switch for a master's copy engine.
   *
   * Off is the default and the safe state: a master's accepted trade is theirs
   * alone until an administrator starts copying. The switch is per master
   * because each master manages their own set of followers.
   */
  function controlView(ownerUserId: string) {
    const record = store.getCopyTradingControl(ownerUserId);
    const master = store.getUserById(ownerUserId);
    const followers = store.listAllCopyTradingFollowers().filter((f) => f.ownerUserId === ownerUserId);
    const eligible = followers.filter((f) => effectiveStatus(f) === 'authorized' || effectiveStatus(f) === 'active');
    return {
      ownerUserId,
      master: master ? { userId: master.id, loginId: master.loginId ?? null } : null,
      enabled: Boolean(record?.enabled),
      updatedAt: record?.updatedAt ?? null,
      updatedBy: record?.updatedBy ?? null,
      updatedByEmail: record?.updatedByEmail ?? null,
      stoppedReason: record?.stoppedReason ?? null,
      followers: {
        total: followers.length,
        eligible: eligible.length,
        held: followers.length - eligible.length
      }
    };
  }

  router.get('/control', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const ownerUserId = String(req.query.masterUserId ?? '').trim();
    if (ownerUserId) {
      if (!store.getUserById(ownerUserId)) return fail(res, 404, 'master_not_found');
      return res.json({ control: controlView(ownerUserId) });
    }
    // Without a master, report every master that has a control or a follower.
    const ids = new Set<string>([
      ...store.listAllCopyTradingFollowers().map((f) => f.ownerUserId),
      ...store.listUsers().map((u) => u.id).filter((id) => store.getCopyTradingControl(id) !== null)
    ]);
    return res.json({ items: [...ids].map(controlView) });
  });

  router.post('/control', requireAdmin(ctx, 'copytrading.control'), async (req: AdminAuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { masterUserId?: unknown; enabled?: unknown; reason?: unknown };
    const ownerUserId = typeof body.masterUserId === 'string' ? body.masterUserId.trim() : '';
    if (!ownerUserId) return fail(res, 400, 'master_required');
    const master = store.getUserById(ownerUserId);
    if (!master) return fail(res, 404, 'master_not_found');
    if (typeof body.enabled !== 'boolean') return fail(res, 400, 'enabled_required');

    const followers = store.listAllCopyTradingFollowers().filter((f) => f.ownerUserId === ownerUserId);
    if (body.enabled && followers.length === 0) {
      return fail(res, 409, 'no_followers', {
        message: 'Connect at least one client before starting copy trading for this master.'
      });
    }

    const now = Date.now();
    const reason = optionalText(body.reason, MAX_NOTE_LENGTH);
    // Captured before the write: reading it afterwards would record the new value
    // as the previous state and make the audit trail unable to show a change.
    const previousEnabled = Boolean(store.getCopyTradingControl(ownerUserId)?.enabled);
    await store.putCopyTradingControl({
      ownerUserId,
      enabled: body.enabled,
      updatedBy: req.admin!.id,
      updatedByEmail: req.admin!.email,
      updatedAt: now,
      stoppedReason: body.enabled ? null : reason
    });

    /*
     * The control write above has already committed, so nothing from here on may
     * turn this into a failure: if the audit append throws (a poisoned store, a
     * concurrent-writer conflict) the honest answer is still "the switch changed",
     * and reporting an error would invite the operator to retry a mutation that
     * already happened. The audit gap is logged loudly instead.
     */
    try {
      await auditFromRequest(ctx, req, {
        action: body.enabled ? 'copytrading.control.started' : 'copytrading.control.stopped',
        targetType: 'copy_trading_control',
        targetId: ownerUserId,
        previousState: { enabled: previousEnabled },
        newState: { enabled: body.enabled },
        reason
      });
    } catch (err) {
      console.error(
        `[admin] Copy control for ${ownerUserId} was saved but its audit record failed`,
        err
      );
    }

    return res.json({
      control: controlView(ownerUserId),
      note: body.enabled
        ? 'Copy trading started. Each accepted DEMO trade is mirrored onto every eligible follower DEMO account.'
        : 'Copy trading stopped. New master trades are no longer mirrored; contracts already open are unaffected.'
    });
  });

  /* ==================================================================== */
  /*  Operational readiness (read-only projection)                        */
  /* ==================================================================== */

  /**
   * Whether copying is operationally ready for one master, derived only from
   * persisted state.
   *
   * This route is deliberately read-only. It never creates a missing
   * `copyTradingControl`, never enables one, and never resumes copying — a
   * missing control is reported as `enabled: false` because that is how the
   * engine reads it. `READY` describes prerequisites only and is not a promise
   * that a trade will execute.
   */
  router.get('/readiness', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const ownerUserId = String(req.query.masterUserId ?? '').trim();
    if (ownerUserId) {
      if (!store.getUserById(ownerUserId)) return fail(res, 404, 'master_not_found');
      return res.json({ readiness: buildCopyReadiness({ store, cfg, flags: ctx.flags }, ownerUserId) });
    }
    return res.json({
      items: listReadinessOwners(store).map((id) => buildCopyReadiness({ store, cfg, flags: ctx.flags }, id))
    });
  });

  /** Profit and loss across the master and every follower they manage. */
  router.get('/performance', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const ownerUserId = String(req.query.masterUserId ?? '').trim();
    if (!ownerUserId) return fail(res, 400, 'master_required');
    if (!store.getUserById(ownerUserId)) return fail(res, 404, 'master_not_found');
    const days = Number.parseInt(String(req.query.days ?? '30'), 10);
    return res.json(buildCopyPerformance(store, ownerUserId, { days: Number.isFinite(days) ? days : 30 }));
  });

  /* ==================================================================== */
  /*  Risk configuration (existing engine, read-through)                  */
  /* ==================================================================== */

  /* ==================================================================== */
  /*  Client balance (read-through to Deriv, never cached in the store)    */
  /* ==================================================================== */

  /**
   * Reads the client's own Deriv account balances.
   *
   * The figure comes from Deriv over the follower's sealed credential — the
   * same one the copy engine uses — and is never stored. DEMO and REAL stay
   * separate, exactly as `/api/balances` presents them, so an administrator
   * cannot mistake demo funds for real funds. Nothing here grants execution
   * authority; it is a read.
   */
  router.get('/clients/:id/balance', requireAdmin(ctx, 'copytrading.read'), async (req: AdminAuthedRequest, res: Response) => {
    const record = store.listAllCopyTradingFollowers().find((f) => f.id === req.params.id);
    if (!record) return fail(res, 404, 'client_not_found');

    if (!ctx.balances) {
      return res.json({
        followerId: record.id,
        accounts: [],
        available: false,
        reason: 'balance_service_unavailable',
        note: 'This build has no balance service wired, so no figure can be shown.'
      });
    }

    if (record.tokenExpiresAt > 0 && record.tokenExpiresAt <= Date.now()) {
      return res.json({
        followerId: record.id,
        accounts: [],
        available: false,
        reason: 'authorization_expired',
        note: 'The client authorization has expired, so Deriv cannot be asked for a balance.'
      });
    }

    const accessToken = open(record.tokenSealed, cfg.session.secret);
    if (!accessToken) {
      return res.json({
        followerId: record.id,
        accounts: [],
        available: false,
        reason: 'token_unavailable',
        note: 'The stored credential could not be opened, so no balance can be read.'
      });
    }

    // The follower's own accounts are the ones that may be read: a follower
    // record carries no other identity, and BalanceService re-checks ownership
    // against this principal before it calls Deriv.
    const principal: UserRecord = {
      id: `copy_follower_${record.id}`,
      derivSub: record.derivSub,
      loginId: record.loginId,
      accounts: record.accounts,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      preferences: {}
    };

    const force = req.query.refresh === '1';
    // PAT clients need the PAT App ID on the OTP call; OAuth clients do not.
    const appId = record.authMethod === 'pat' ? (ctx.cfg.deriv.patAppId ?? undefined) : undefined;
    const accounts = await ctx.balances.readAll(principal, accessToken, { force, appId });
    return res.json({
      followerId: record.id,
      accounts: accounts.map((a) => ({
        accountId: maskAccountId(a.accountId),
        mode: a.mode,
        currency: a.currency,
        balance: a.balance,
        state: a.state,
        lastUpdated: a.lastUpdated,
        ...(a.reason ? { reason: a.reason } : {})
      })),
      available: accounts.some((a) => a.state === 'ok' || a.state === 'stale'),
      fetchedAt: Date.now(),
      note: 'Read live from Deriv with the client credential. DEMO and REAL accounts are listed separately.'
    });
  });

  router.get('/clients/:id/risk', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const record = store.listAllCopyTradingFollowers().find((f) => f.id === req.params.id);
    if (!record) return fail(res, 404, 'client_not_found');
    // Risk profiles are per trader and enforced by the existing engine; the
    // console reads them rather than defining a parallel limit set.
    const profile = store.getRiskProfile(record.ownerUserId);
    return res.json({
      ownerUserId: record.ownerUserId,
      profile,
      configured: Boolean(profile),
      unavailable: profile
        ? undefined
        : 'No custom risk profile is stored; the platform default limits apply and are enforced server-side.'
    });
  });

  /* ====================================================================== */
  /*  Reporting, revenue, reconciliation and audit (Phase 2)                */
  /* ====================================================================== */

  /** Platform-wide snapshot for the overview page. All values from stored records. */
  router.get('/overview', requireAdmin(ctx, 'copytrading.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json(buildPlatformOverview(store));
  });

  /**
   * Revenue and commission statement for one master's book. Applies any newly
   * settled contracts to the commission ledger (idempotent) and returns the
   * aggregated statement: realised P/L, 40/60 split, estimated vs confirmed
   * markup. No figure is projected; unsettled contracts contribute nothing.
   */
  router.get('/finance', requireAdmin(ctx, 'copytrading.read'), async (req: AdminAuthedRequest, res: Response) => {
    const ownerUserId = String(req.query.masterUserId ?? '').trim();
    if (!ownerUserId) return fail(res, 400, 'master_required');
    if (!store.getUserById(ownerUserId)) return fail(res, 404, 'master_not_found');
    const applied = await applyFollowerCommissions(store, ownerUserId);
    const statement = buildStatement(store, ownerUserId);
    return res.json({ applied, statement });
  });

  /** Intents and contracts that need an operator to reconcile. */
  router.get('/reconciliation', requireAdmin(ctx, 'copytrading.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json(buildReconciliation(store));
  });

  /** Recent executions across the whole book, newest first. */
  router.get('/executions', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    return res.json({ items: buildExecutions(store, Number.isFinite(limit) ? limit : 50) });
  });

  /** One client's full detail: profile, P/L, commission records and risk. */
  router.get('/clients/:id/detail', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const record = store.listAllCopyTradingFollowers().find((f) => f.id === req.params.id);
    if (!record) return fail(res, 404, 'client_not_found');
    const pnl = followerPnl(store, record.id);
    const commissions = store
      .listCommissionEntries(record.ownerUserId)
      .filter((e) => e.followerId === record.id);
    const profile = store.getRiskProfile(record.ownerUserId);
    return res.json({
      client: clientView(record, store),
      pnl,
      commissions,
      risk: { profile, configured: Boolean(profile) }
    });
  });

  /** Imported strategies (bots) across all owners — read-only, no execution. */
  router.get('/strategies', requireAdmin(ctx, 'copytrading.read'), (_req: AdminAuthedRequest, res: Response) => {
    const items = store.listAllImportedBots().map((b) => ({
      id: b.id,
      ownerUserId: b.userId,
      name: b.name,
      compatibility: b.compatibility,
      compatibilityReason: b.compatibilityReason,
      status: b.status,
      revision: b.revision ?? 0,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt
    }));
    return res.json({ items });
  });

  /** Copy-trading audit: the execution audit plus copy-scoped admin audit. */
  router.get('/audit', requireAdmin(ctx, 'copytrading.read'), (req: AdminAuthedRequest, res: Response) => {
    const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100;
    const execution = store.listExecutionAudit().slice(-n).reverse();
    const admin = store
      .listAudit()
      .filter((a) => a.action.startsWith('copytrading.'))
      .slice(-n)
      .reverse();
    return res.json({ execution, admin });
  });

  return router;
}
