import type { Request, Response, NextFunction } from 'express';
import type { ServerConfig } from '../config.js';
import type { Store, SessionRecord, UserRecord } from '../store/store.js';
import { parseCookies, setCookie } from './http.js';
import { verifySigned, sign } from './crypto.js';

/**
 * Session resolution and route guards.
 *
 * A request is authenticated when it carries a valid signed session cookie that
 * maps to a live, non-revoked server-side session. Protected endpoints answer
 * 401 with a machine-readable code so the SPA can route to login.
 */

export interface AuthedRequest extends Request {
  session?: SessionRecord;
  user?: UserRecord;
}

export interface SessionContext {
  cfg: ServerConfig;
  store: Store;
}

/** Reads the signed cookie and returns the live session, or null. */
export function resolveSession(ctx: SessionContext, req: Request): SessionRecord | null {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[ctx.cfg.session.cookieName];
  if (!raw) return null;
  const sessionId = verifySigned(raw, ctx.cfg.session.secret);
  if (!sessionId) return null;
  const session = ctx.store.getSession(sessionId);
  if (!session) return null;
  if (session.revoked) return null;
  if (session.expiresAt <= Date.now()) return null;
  return session;
}

export function issueSessionCookie(ctx: SessionContext, res: Response, sessionId: string, maxAgeSeconds: number): void {
  setCookie(res, ctx.cfg.session.cookieName, sign(sessionId, ctx.cfg.session.secret), {
    maxAge: maxAgeSeconds,
    path: '/',
    httpOnly: true,
    secure: ctx.cfg.isProduction,
    sameSite: 'Lax'
  });
}

/** Attaches session/user when present. Never rejects. */
export function attachSession(ctx: SessionContext) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    const session = resolveSession(ctx, req);
    if (session) {
      req.session = session;
      req.user = ctx.store.getUserById(session.userId) ?? undefined;
    }
    next();
  };
}

/** Requires a valid session; otherwise 401 { error: 'unauthorized' }. */
export function requireSession(ctx: SessionContext) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const session = resolveSession(ctx, req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.session = session;
    req.user = ctx.store.getUserById(session.userId) ?? undefined;
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // Sliding renewal: extend an otherwise-valid session on use.
    const now = Date.now();
    if (session.expiresAt - now < ctx.cfg.session.ttlSeconds * 1000 * 0.5) {
      session.expiresAt = now + ctx.cfg.session.ttlSeconds * 1000;
      session.lastSeenAt = now;
      void ctx.store.updateSession(session);
    } else if (now - session.lastSeenAt > 60_000) {
      session.lastSeenAt = now;
      void ctx.store.updateSession(session);
    }
    next();
  };
}
