import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AdminRouteContext } from './helpers.js';
import { parsePagination, paginate, fail, auditFromRequest } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import type { AdminNoteRecord } from '../../admin/types.js';

/**
 * User management (`/api/admin/v1/users/*`).
 *
 * Suspension is persisted on the trader user record and enforced by the
 * existing `requireSession` guard, so a suspended user loses access on their
 * very next request — not merely a label in this dashboard.
 */

/** Public, masked view of a user. Never returns Deriv tokens or raw ids beyond the internal id. */
function userSummary(u: ReturnType<AdminRouteContext['store']['listUsers']>[number], store: AdminRouteContext['store']) {
  return {
    id: u.id,
    loginId: u.loginId ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    accountCount: u.accounts.length,
    demoAccounts: u.accounts.filter((a) => a.type === 'demo').length,
    realAccounts: u.accounts.filter((a) => a.type === 'real').length,
    suspended: Boolean(u.suspended),
    suspendedAt: u.suspendedAt ?? null,
    activeSessions: store.countActiveSessionsForUser(u.id)
  };
}

/** Deriv account ids are masked in listings: keep first 2 and last 2 chars. */
function maskAccountId(id: string): string {
  if (id.length <= 4) return '••••';
  return `${id.slice(0, 2)}${'•'.repeat(Math.max(0, id.length - 4))}${id.slice(-2)}`;
}

export function createUsersRouter(ctx: AdminRouteContext): Router {
  const { store } = ctx;
  const router = Router();

  /* ------------------------------- list -------------------------------- */

  router.get('/', requireAdmin(ctx, 'users.read'), (req: AdminAuthedRequest, res: Response) => {
    const { page, pageSize } = parsePagination(req);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = String(req.query.status ?? '').trim();
    const sort = String(req.query.sort ?? 'createdAt');
    const dir = String(req.query.dir ?? 'desc') === 'asc' ? 1 : -1;

    let users = store.listUsers();

    if (q) {
      users = users.filter((u) => {
        if (u.loginId && u.loginId.toLowerCase().includes(q)) return true;
        if (u.id.toLowerCase().includes(q)) return true;
        return u.accounts.some((a) => a.accountId.toLowerCase().includes(q));
      });
    }
    if (status === 'active') users = users.filter((u) => !u.suspended);
    if (status === 'suspended') users = users.filter((u) => u.suspended);

    const sorters: Record<string, (u: any) => number | string> = {
      createdAt: (u) => u.createdAt,
      updatedAt: (u) => u.updatedAt,
      accounts: (u) => u.accounts.length,
      loginId: (u) => u.loginId ?? ''
    };
    const sorter = sorters[sort] ?? sorters.createdAt;
    users = users.sort((a, b) => {
      const av = sorter(a);
      const bv = sorter(b);
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });

    const pageData = paginate(users, page, pageSize);
    return res.json({ ...pageData, items: pageData.items.map((u) => userSummary(u, store)) });
  });

  /* ------------------------------ detail ------------------------------- */

  router.get('/:id', requireAdmin(ctx, 'users.read'), (req: AdminAuthedRequest, res: Response) => {
    const user = store.getUserById(req.params.id);
    if (!user) return fail(res, 404, 'user_not_found');

    const sessions = store.listSessionsForUser(user.id).map((s) => ({
      id: s.id.slice(0, 8) + '…', // opaque prefix only; never the full signing value
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      lastSeenAt: s.lastSeenAt,
      revoked: s.revoked,
      derivTokenExpiresAt: s.derivTokenExpiresAt
    }));

    return res.json({
      user: {
        id: user.id,
        loginId: user.loginId ?? null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        suspended: Boolean(user.suspended),
        suspendedAt: user.suspendedAt ?? null,
        suspendedReason: user.suspendedReason ?? null,
        accounts: user.accounts.map((a) => ({
          accountId: maskAccountId(a.accountId),
          type: a.type,
          currency: a.currency ?? null,
          status: a.status ?? null
        }))
      },
      sessions,
      notes: store.listAdminNotes(user.id).map((n) => ({
        id: n.id,
        body: n.body,
        authorAdminId: n.authorAdminId,
        createdAt: n.createdAt
      })),
      subscription: null,
      subscriptionUnavailable: 'No subscription records exist for this deployment.'
    });
  });

  /* ----------------------------- suspend ------------------------------- */

  router.post('/:id/suspend', requireAdmin(ctx, 'users.suspend'), async (req: AdminAuthedRequest, res: Response) => {
    const user = store.getUserById(req.params.id);
    if (!user) return fail(res, 404, 'user_not_found');
    if (user.suspended) return fail(res, 409, 'already_suspended');

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
    const previous = { suspended: false };
    user.suspended = true;
    user.suspendedAt = Date.now();
    user.suspendedReason = reason;
    await store.saveUser(user);
    // Immediately cut live access.
    await store.revokeUserSessions(user.id);

    await auditFromRequest(ctx, req, {
      action: 'user.suspend',
      targetType: 'user',
      targetId: user.id,
      previousState: previous,
      newState: { suspended: true, reason },
      reason
    });
    return res.json({ ok: true, user: userSummary(user, store) });
  });

  /* ---------------------------- reactivate ----------------------------- */

  router.post('/:id/reactivate', requireAdmin(ctx, 'users.reactivate'), async (req: AdminAuthedRequest, res: Response) => {
    const user = store.getUserById(req.params.id);
    if (!user) return fail(res, 404, 'user_not_found');
    if (!user.suspended) return fail(res, 409, 'not_suspended');

    const previous = { suspended: true, reason: user.suspendedReason ?? null };
    user.suspended = false;
    user.suspendedAt = null;
    user.suspendedReason = null;
    await store.saveUser(user);

    await auditFromRequest(ctx, req, {
      action: 'user.reactivate',
      targetType: 'user',
      targetId: user.id,
      previousState: previous,
      newState: { suspended: false }
    });
    return res.json({ ok: true, user: userSummary(user, store) });
  });

  /* ------------------------- revoke sessions --------------------------- */

  router.post('/:id/sessions/revoke', requireAdmin(ctx, 'users.sessions.revoke'), async (req: AdminAuthedRequest, res: Response) => {
    const user = store.getUserById(req.params.id);
    if (!user) return fail(res, 404, 'user_not_found');
    const before = store.countActiveSessionsForUser(user.id);
    await store.revokeUserSessions(user.id);

    await auditFromRequest(ctx, req, {
      action: 'user.sessions.revoke',
      targetType: 'user',
      targetId: user.id,
      previousState: { activeSessions: before },
      newState: { activeSessions: 0 },
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
    });
    return res.json({ ok: true, revoked: before });
  });

  /* ------------------------------ notes -------------------------------- */

  router.post('/:id/notes', requireAdmin(ctx, 'users.notes.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const user = store.getUserById(req.params.id);
    if (!user) return fail(res, 404, 'user_not_found');
    const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 2000) : '';
    if (!body) return fail(res, 400, 'empty_note');

    const note: AdminNoteRecord = {
      id: `note_${randomUUID()}`,
      userId: user.id,
      body,
      authorAdminId: req.admin!.id,
      createdAt: Date.now()
    };
    await store.addAdminNote(note);

    await auditFromRequest(ctx, req, {
      action: 'user.note.added',
      targetType: 'user',
      targetId: user.id,
      newState: { noteId: note.id }
    });
    return res.json({ ok: true, note });
  });

  return router;
}
