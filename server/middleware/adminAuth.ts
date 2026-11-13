import type { Response, NextFunction } from 'express';
import type { Store } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import type { Permission } from '../admin/permissions.js';
import { roleHasPermission } from '../admin/permissions.js';
import { resolveAdminSession, type AdminAuthedRequest } from '../lib/adminSession.js';

/**
 * Administrator authorization middleware.
 *
 * Every admin route passes through `requireAdmin`. Permission checks are always
 * server-side; hiding a button in React is never authorization.
 */

export interface AdminMiddlewareContext {
  cfg: ServerConfig;
  store: Store;
}

function unauthorized(res: Response, code = 'unauthorized'): void {
  res.status(401).json({ error: code });
}

/** Requires a live, MFA-complete admin session. Optionally requires a permission. */
export function requireAdmin(ctx: AdminMiddlewareContext, permission?: Permission) {
  return (req: AdminAuthedRequest, res: Response, next: NextFunction): void => {
    const session = resolveAdminSession(ctx, req);
    if (!session) {
      unauthorized(res, 'admin_unauthorized');
      return;
    }
    const admin = ctx.store.getAdminById(session.adminId);
    if (!admin) {
      unauthorized(res, 'admin_unauthorized');
      return;
    }
    if (admin.status !== 'active') {
      res.status(403).json({ error: 'admin_inactive' });
      return;
    }
    if (!admin.mfa.enrolled) {
      res.status(403).json({ error: 'mfa_required' });
      return;
    }
    if (permission && !roleHasPermission(admin.role, permission, admin.extraPermissions)) {
      res.status(403).json({ error: 'forbidden', requiredPermission: permission });
      return;
    }
    // CSRF: state-changing methods must echo the per-session token.
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (!header || header !== session.csrfToken) {
        res.status(403).json({ error: 'csrf_failed' });
        return;
      }
    }
    req.adminSession = session;
    req.admin = admin;
    // Sliding renewal.
    const now = Date.now();
    if (session.expiresAt - now < ctx.cfg.admin.sessionTtlSeconds * 1000 * 0.5) {
      session.expiresAt = now + ctx.cfg.admin.sessionTtlSeconds * 1000;
      session.lastSeenAt = now;
      void ctx.store.updateAdminSession(session);
    } else if (now - session.lastSeenAt > 60_000) {
      session.lastSeenAt = now;
      void ctx.store.updateAdminSession(session);
    }
    next();
  };
}
