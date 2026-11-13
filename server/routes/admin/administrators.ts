import { Router, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { AdminRouteContext } from './helpers.js';
import { fail, auditFromRequest, clientIp } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import { ROLES, PERMISSIONS, ROLE_META, ROLE_PERMISSIONS, effectivePermissions, type Role } from '../../admin/permissions.js';
import { generateTotpSecret } from '../../admin/totp.js';
import { seal } from '../../lib/crypto.js';
import { createOpaqueId } from '../../lib/pkce.js';
import { createHash } from 'node:crypto';
import type { AdminUserRecord, AdminInvitationRecord } from '../../admin/types.js';

/**
 * Administrator management (`/api/admin/v1/administrators/*`).
 *
 * Sensitive invariants enforced here (not in the UI):
 *  - only a SUPER_ADMIN may create or modify SUPER_ADMIN privileges;
 *  - the last active SUPER_ADMIN cannot be demoted or suspended.
 */

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function publicAdmin(a: AdminUserRecord) {
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    role: a.role,
    status: a.status,
    extraPermissions: a.extraPermissions,
    permissions: effectivePermissions(a.role, a.extraPermissions),
    mfaEnrolled: a.mfa.enrolled,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt
  };
}

export function createAdministratorsRouter(ctx: AdminRouteContext): Router {
  const { cfg, store } = ctx;
  const router = Router();

  /** Role/permission catalogue for the UI. */
  router.get('/meta', requireAdmin(ctx, 'admins.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({
      roles: ROLES.map((r) => ({ role: r, ...ROLE_META[r], permissions: ROLE_PERMISSIONS[r] })),
      permissions: PERMISSIONS
    });
  });

  router.get('/', requireAdmin(ctx, 'admins.read'), (_req: AdminAuthedRequest, res: Response) => {
    const admins = store.listAdmins().map(publicAdmin);
    const invitations = store
      .listInvitations()
      .filter((i) => i.consumedAt === null && i.expiresAt > Date.now())
      .map((i) => ({ id: i.id, email: i.email, role: i.role, invitedBy: i.invitedBy, createdAt: i.createdAt, expiresAt: i.expiresAt }));
    return res.json({ admins, invitations, activeSuperAdmins: store.countActiveSuperAdmins() });
  });

  /* ------------------------------- invite ------------------------------- */

  router.post('/invite', requireAdmin(ctx, 'admins.invite'), async (req: AdminAuthedRequest, res: Response) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const role = String(req.body?.role ?? '') as Role;
    const displayName = String(req.body?.displayName ?? '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'invalid_email');
    if (!ROLES.includes(role)) return fail(res, 400, 'invalid_role');
    if (store.getAdminByEmail(email)) return fail(res, 409, 'admin_exists');

    // Only a Super Admin may create another Super Admin.
    if (role === 'SUPER_ADMIN' && req.admin!.role !== 'SUPER_ADMIN') {
      return fail(res, 403, 'forbidden', { reason: 'Only a Super Admin can invite a Super Admin.' });
    }

    const token = createOpaqueId(32);
    const invitation: AdminInvitationRecord = {
      id: `inv_${createOpaqueId(12)}`,
      email,
      role,
      extraPermissions: [],
      tokenHash: sha256(token),
      invitedBy: req.admin!.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + cfg.admin.invitationTtlSeconds * 1000,
      consumedAt: null
    };
    await store.createInvitation(invitation);

    await auditFromRequest(ctx, req, {
      action: 'admin.invitation.created',
      targetType: 'admin',
      targetId: invitation.id,
      newState: { email, role, displayName }
    });

    // No transactional email provider is configured (see audit doc). In dev the
    // token is returned/logged so the invite can be completed; production must
    // deliver it out-of-band.
    if (!cfg.isProduction) console.log(`[admin] invitation for ${email}: ${token}`);
    return res.json({ ok: true, invitation: { id: invitation.id, email, role, expiresAt: invitation.expiresAt }, devToken: cfg.isProduction ? undefined : token });
  });

  /* ------------------------- role / permission -------------------------- */

  router.patch('/:id', requireAdmin(ctx, 'admins.roles.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const target = store.getAdminById(req.params.id);
    if (!target) return fail(res, 404, 'admin_not_found');

    const nextRole = req.body?.role !== undefined ? (String(req.body.role) as Role) : target.role;
    if (!ROLES.includes(nextRole)) return fail(res, 400, 'invalid_role');

    const nextExtras = Array.isArray(req.body?.extraPermissions)
      ? req.body.extraPermissions.filter((p: unknown): p is string => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p))
      : target.extraPermissions;

    // Privilege escalation guards: only a Super Admin may touch Super Admin
    // role, and the last active Super Admin cannot be demoted.
    if ((target.role === 'SUPER_ADMIN' || nextRole === 'SUPER_ADMIN') && req.admin!.role !== 'SUPER_ADMIN') {
      return fail(res, 403, 'forbidden', { reason: 'Only a Super Admin can manage Super Admin privileges.' });
    }
    if (target.role === 'SUPER_ADMIN' && nextRole !== 'SUPER_ADMIN' && store.countActiveSuperAdmins() <= 1) {
      return fail(res, 409, 'last_super_admin', { reason: 'Cannot demote the last active Super Admin.' });
    }

    const previous = { role: target.role, extraPermissions: target.extraPermissions };
    target.role = nextRole;
    target.extraPermissions = nextExtras;
    await store.upsertAdmin(target);

    await auditFromRequest(ctx, req, {
      action: 'admin.role.changed',
      targetType: 'admin',
      targetId: target.id,
      previousState: previous,
      newState: { role: nextRole, extraPermissions: nextExtras },
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
    });
    return res.json({ ok: true, admin: publicAdmin(target) });
  });

  /* ---------------------------- suspend -------------------------------- */

  router.post('/:id/suspend', requireAdmin(ctx, 'admins.suspend'), async (req: AdminAuthedRequest, res: Response) => {
    const target = store.getAdminById(req.params.id);
    if (!target) return fail(res, 404, 'admin_not_found');
    if (target.id === req.admin!.id) return fail(res, 409, 'cannot_suspend_self');
    if (target.role === 'SUPER_ADMIN' && req.admin!.role !== 'SUPER_ADMIN') {
      return fail(res, 403, 'forbidden', { reason: 'Only a Super Admin can suspend a Super Admin.' });
    }
    if (target.role === 'SUPER_ADMIN' && target.status === 'active' && store.countActiveSuperAdmins() <= 1) {
      return fail(res, 409, 'last_super_admin', { reason: 'Cannot suspend the last active Super Admin.' });
    }

    const previous = { status: target.status };
    target.status = 'suspended';
    await store.upsertAdmin(target);
    await store.revokeAdminSessions(target.id);

    await auditFromRequest(ctx, req, {
      action: 'admin.suspend',
      targetType: 'admin',
      targetId: target.id,
      previousState: previous,
      newState: { status: 'suspended' },
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
    });
    return res.json({ ok: true, admin: publicAdmin(target) });
  });

  router.post('/:id/reactivate', requireAdmin(ctx, 'admins.suspend'), async (req: AdminAuthedRequest, res: Response) => {
    const target = store.getAdminById(req.params.id);
    if (!target) return fail(res, 404, 'admin_not_found');
    if (target.role === 'SUPER_ADMIN' && req.admin!.role !== 'SUPER_ADMIN') {
      return fail(res, 403, 'forbidden', { reason: 'Only a Super Admin can reactivate a Super Admin.' });
    }
    const previous = { status: target.status };
    target.status = 'active';
    await store.upsertAdmin(target);
    await auditFromRequest(ctx, req, {
      action: 'admin.reactivate',
      targetType: 'admin',
      targetId: target.id,
      previousState: previous,
      newState: { status: 'active' }
    });
    return res.json({ ok: true, admin: publicAdmin(target) });
  });

  /* ------------------------ revoke sessions ---------------------------- */

  router.post('/:id/sessions/revoke', requireAdmin(ctx, 'admins.sessions.revoke'), async (req: AdminAuthedRequest, res: Response) => {
    const target = store.getAdminById(req.params.id);
    if (!target) return fail(res, 404, 'admin_not_found');
    await store.revokeAdminSessions(target.id);
    await auditFromRequest(ctx, req, {
      action: 'admin.sessions.revoke',
      targetType: 'admin',
      targetId: target.id
    });
    return res.json({ ok: true });
  });

  /* ------------------------ rotate MFA secret -------------------------- */

  router.post('/:id/mfa/reset', requireAdmin(ctx, 'admins.roles.manage'), async (req: AdminAuthedRequest, res: Response) => {
    const target = store.getAdminById(req.params.id);
    if (!target) return fail(res, 404, 'admin_not_found');
    if (target.role === 'SUPER_ADMIN' && req.admin!.role !== 'SUPER_ADMIN') {
      return fail(res, 403, 'forbidden');
    }
    const secret = generateTotpSecret();
    target.mfa = { enrolled: false, secretSealed: seal(secret, cfg.session.secret), enrolledAt: null, recoveryCodeHashes: [] };
    await store.upsertAdmin(target);
    await store.revokeAdminSessions(target.id);
    await auditFromRequest(ctx, req, {
      action: 'admin.mfa.reset',
      targetType: 'admin',
      targetId: target.id
    });
    return res.json({ ok: true });
  });

  return router;
}
