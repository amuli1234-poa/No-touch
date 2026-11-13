import type { Request, Response, NextFunction } from 'express';
import type { ServerConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { AdminSessionRecord, AdminUserRecord } from '../admin/types.js';
import { parseCookies, setCookie, clearCookie } from './http.js';
import { verifySigned, sign } from './crypto.js';

/**
 * Administrator session resolution and guards.
 *
 * Deliberately separate from the trader session (`server/lib/session.ts`):
 *  - a different cookie name (`ws_admin_session`),
 *  - a different HMAC derivation context (`admin-cookie-sign`),
 *  - a different server-side collection (`adminSessions`).
 *
 * An admin session can therefore never be produced by, or accepted as, a trader
 * session, and vice versa — even though both are signed with SESSION_SECRET.
 */

export interface AdminAuthedRequest extends Request {
  adminSession?: AdminSessionRecord;
  admin?: AdminUserRecord;
}

export interface AdminContext {
  cfg: ServerConfig;
  store: Store;
}

const ADMIN_SIGN_CONTEXT = 'admin-cookie-sign';

export function resolveAdminSession(ctx: AdminContext, req: Request): AdminSessionRecord | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[ctx.cfg.admin.cookieName];
  if (!raw) return null;
  const sessionId = verifySigned(raw, ctx.cfg.session.secret, ADMIN_SIGN_CONTEXT);
  if (!sessionId) return null;
  const session = ctx.store.getAdminSession(sessionId);
  if (!session) return null;
  if (session.revoked) return null;
  if (session.expiresAt <= Date.now()) return null;
  if (session.mfaPending) return null; // pre-MFA sessions cannot reach the API
  return session;
}

export function adminCookieOptions(cfg: ServerConfig, maxAge: number) {
  return {
    maxAge,
    path: '/',
    httpOnly: true,
    secure: cfg.isProduction,
    // The admin SPA and API are same-site by default (admin.<host> + api.<host>)
    // so Lax is correct and avoids the CSRF exposure of None.
    sameSite: 'Lax' as const
  };
}

export function issueAdminSessionCookie(ctx: AdminContext, res: Response, sessionId: string, maxAgeSeconds: number): void {
  setCookie(res, ctx.cfg.admin.cookieName, sign(sessionId, ctx.cfg.session.secret, ADMIN_SIGN_CONTEXT), adminCookieOptions(ctx.cfg, maxAgeSeconds));
}

export function clearAdminSessionCookie(ctx: AdminContext, res: Response): void {
  clearCookie(res, ctx.cfg.admin.cookieName, { path: '/' });
}

/** Attaches the admin session/user when present. Never rejects. */
export function attachAdminSession(ctx: AdminContext) {
  return (req: AdminAuthedRequest, _res: Response, next: NextFunction): void => {
    const session = resolveAdminSession(ctx, req);
    if (session) {
      req.adminSession = session;
      req.admin = ctx.store.getAdminById(session.adminId) ?? undefined;
    }
    next();
  };
}
