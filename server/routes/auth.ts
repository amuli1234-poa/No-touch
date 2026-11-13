import { Router, type Response } from 'express';
import type { ServerConfig } from '../config.js';
import type { Store, UserRecord, SessionRecord } from '../store/store.js';
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  resolveIdentity,
  fetchAccounts,
  revokeToken,
  DerivRequestError,
  type DerivAccount
} from '../lib/deriv.js';
import { createCodeVerifier, createCodeChallenge, createState, createOpaqueId, timingSafeEqual } from '../lib/pkce.js';
import { parseCookies, setCookie, clearCookie, redirectWithError } from '../lib/http.js';
import { seal } from '../lib/crypto.js';
import { issueSessionCookie, requireSession, type SessionContext, type AuthedRequest } from '../lib/session.js';

/**
 * OAuth 2.0 Authorization Code + PKCE routes.
 *
 *   GET  /auth/start               -> 302 to Deriv authorization endpoint
 *   GET  /auth/deriv/callback      -> validate state, exchange code, open session, 302 to app
 *   POST /auth/logout              -> revoke + destroy session
 *   GET  /auth/session             -> current user (or 401)
 *   GET  /auth/error               -> SPA-rendered error (handled client-side)
 *
 * `/auth/deriv/callback` matches the redirect URI registered in the Deriv app
 * dashboard exactly. The code_verifier is held in a server-side transaction AND
 * mirrored into a short-lived HttpOnly cookie, so the callback works whether or
 * not the flow began in the same tab. State is validated server-side on every
 * callback.
 */

function oauthCookieOptions(cfg: ServerConfig, maxAge: number) {
  return { maxAge, path: '/', httpOnly: true, secure: cfg.isProduction, sameSite: 'Lax' as const };
}

/** Derives the stable internal user id from the verified Deriv subject. */
function userIdFromSub(sub: string): string {
  return `u_${Buffer.from(sub).toString('base64url')}`;
}

/** User ids are internal and derived from `sub`; nothing user-supplied here. */
function accountRefs(accounts: DerivAccount[]) {
  return accounts.map((a) => ({ accountId: a.accountId, type: a.type, currency: a.currency, status: a.status }));
}

export function createAuthRouter(ctx: SessionContext): Router {
  const { cfg, store } = ctx;
  const router = Router();

  /* ------------------------------- start -------------------------------- */

  router.get('/auth/start', async (req, res) => {
    const mode = req.query.mode === 'signup' ? 'signup' : 'login';
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const state = createState();

    await store.createOAuthTransaction({
      state,
      codeVerifier,
      redirectUri: cfg.deriv.redirectUri,
      mode,
      createdAt: Date.now(),
      consumedAt: null
    });

    // Mirror the verifier into an HttpOnly cookie so the callback can complete
    // even if storage was partitioned; it is single-use and short-lived.
    setCookie(res, cfg.session.oauthCookieName, `${state}:${codeVerifier}`, oauthCookieOptions(cfg, cfg.session.oauthCookieTtlSeconds));

    res.redirect(buildAuthorizationUrl(cfg, { state, codeChallenge, mode }));
  });

  /* ------------------------------ callback ------------------------------ */

  router.get('/auth/deriv/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;

    if (error) {
      // Deriv reported a failure (access_denied, invalid_scope, etc.).
      return redirectWithError(res, cfg.appOrigin, error === 'access_denied' ? 'cancelled' : 'authorization_failed');
    }
    if (!state || !code) return redirectWithError(res, cfg.appOrigin, 'invalid_callback');

    // 1. Validate state against the server-side transaction (CSRF + replay).
    const tx = store.getOAuthTransaction(state);
    if (!tx || !timingSafeEqual(tx.state, state)) {
      return redirectWithError(res, cfg.appOrigin, 'invalid_state');
    }

    // 2. Reject duplicates: a consumed transaction cannot be processed again.
    const fresh = await store.consumeOAuthTransaction(state);
    if (!fresh) return redirectWithError(res, cfg.appOrigin, 'duplicate_callback');

    // 3. Recover the verifier (server transaction is authoritative; the cookie
    //    is a cross-tab fallback and must agree on state).
    let codeVerifier = tx.codeVerifier;
    const cookie = parseCookies(req.headers.cookie)[cfg.session.oauthCookieName];
    if (cookie) {
      const [cookieState, cookieVerifier] = cookie.split(':');
      if (cookieState === state && cookieVerifier) codeVerifier = cookieVerifier;
    }
    clearCookie(res, cfg.session.oauthCookieName, { path: '/' });

    // 4. Exchange the single-use code (backend only).
    let token;
    try {
      token = await exchangeCodeForToken(cfg, { code, codeVerifier });
    } catch (err) {
      const code2 = err instanceof DerivRequestError ? err.code : 'token_exchange_failed';
      // invalid_grant usually means the code expired or was already used.
      const mapped = code2 === 'invalid_grant' ? 'expired_code' : 'authorization_failed';
      return redirectWithError(res, cfg.appOrigin, mapped);
    }

    // 5. Best-effort account listing. `trade` is the minimum scope, and this
    //    endpoint doubles as the identity source when userinfo is unavailable.
    let accounts: DerivAccount[] = [];
    try {
      accounts = await fetchAccounts(cfg, token.accessToken);
    } catch {
      accounts = [];
    }

    // 6. Validate the authenticated identity (userinfo when available, else the
    //    verified accounts). Never a display name.
    let identity;
    try {
      identity = await resolveIdentity(cfg, token.accessToken, accounts);
    } catch {
      return redirectWithError(res, cfg.appOrigin, 'identity_unverified');
    }

    // 7. Identify an existing profile by the stable subject — or, when the
    //    subject is derived from the account set, by any shared account — and
    //    otherwise create one. This keeps a returning user on the same profile.
    const now = Date.now();
    const existing =
      store.getUserByDerivSub(identity.sub) ??
      store.findUserByAccountIds(accounts.map((a) => a.accountId));
    const userId = existing?.id ?? userIdFromSub(identity.sub);
    const user: UserRecord = existing
      ? { ...existing, derivSub: identity.sub, loginId: identity.loginId ?? existing.loginId, accounts: accountRefs(accounts), updatedAt: now }
      : {
          id: userId,
          derivSub: identity.sub,
          loginId: identity.loginId,
          accounts: accountRefs(accounts),
          createdAt: now,
          updatedAt: now,
          preferences: {}
        };
    await store.upsertUser(user);

    // 8. Open a fresh application session bound to the user and the token.
    //    Any prior sessions for this user are revoked to keep one live session.
    await store.revokeUserSessions(user.id);
    const sessionId = createOpaqueId();
    const session: SessionRecord = {
      id: sessionId,
      userId: user.id,
      createdAt: now,
      expiresAt: now + cfg.session.ttlSeconds * 1000,
      lastSeenAt: now,
      revoked: false,
      derivTokenSealed: seal(token.accessToken, cfg.session.secret),
      derivTokenExpiresAt: token.expiresAt,
      derivSub: identity.sub
    };
    await store.createSession(session);
    issueSessionCookie(ctx, res, sessionId, cfg.session.ttlSeconds);

    // 9. Hand off to the SPA workspace.
    res.redirect(`${cfg.appOrigin}/app`);
  });

  /* ------------------------------- logout ------------------------------- */

  router.post('/auth/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[cfg.session.cookieName];
    if (raw) {
      const sessionId = raw.split('.')[0];
      const session = store.getSession(sessionId);
      if (session) {
        try {
          const { open } = await import('../lib/crypto.js');
          const token = open(session.derivTokenSealed, cfg.session.secret);
          if (token) await revokeToken(cfg, token);
        } catch {
          // best effort
        }
        await store.deleteSession(sessionId);
      }
    }
    clearCookie(res, cfg.session.cookieName, { path: '/' });
    res.status(204).end();
  });

  /* ------------------------------ session ------------------------------- */

  router.get('/auth/session', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const u = req.user!;
    res.json({
      authenticated: true,
      user: {
        id: u.id,
        loginId: u.loginId ?? null,
        createdAt: u.createdAt,
        accounts: u.accounts.map((a) => ({ accountId: a.accountId, type: a.type, currency: a.currency })),
        demoAccounts: u.accounts.filter((a) => a.type === 'demo').length,
        realAccounts: u.accounts.filter((a) => a.type === 'real').length
      },
      session: {
        expiresAt: req.session!.expiresAt,
        derivTokenExpiresAt: req.session!.derivTokenExpiresAt
      }
    });
  });

  /* --------------------------- preferences ------------------------------ */

  router.get('/api/preferences', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ preferences: req.user!.preferences });
  });

  router.put('/api/preferences', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const { readJsonBody } = await import('../lib/http.js');
    try {
      const body = await readJsonBody<{ preferences?: Record<string, unknown> }>(req);
      const prefs = body.preferences;
      if (!prefs || typeof prefs !== 'object') {
        res.status(400).json({ error: 'invalid_preferences' });
        return;
      }
      req.user!.preferences = prefs;
      await store.upsertUser(req.user!);
      res.json({ preferences: req.user!.preferences });
    } catch (err: any) {
      res.status(err?.statusCode || 400).json({ error: 'invalid_request' });
    }
  });

  /* ------------------- Deriv authorization revalidation ------------------ */

  /**
   * Confirms the stored Deriv authorization is still valid. If Deriv rejects
   * the token (revoked or expired), the application session is revoked so the
   * user must authenticate again — a revoked Deriv authorization cannot keep a
   * WickSentinel session alive.
   */
  router.get('/api/deriv/verify', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const { open } = await import('../lib/crypto.js');
    const token = open(req.session!.derivTokenSealed, cfg.session.secret);
    if (!token) {
      await store.revokeUserSessions(req.user!.id);
      clearCookie(res, cfg.session.cookieName, { path: '/' });
      res.status(401).json({ error: 'deriv_authorization_revoked' });
      return;
    }
    try {
      // Re-validate using the same identity source as login. userinfo needs
      // `openid`, which Deriv does not allow for this app, so the accounts
      // endpoint (scope `trade`) is the reliable revalidation path.
      const accounts = await fetchAccounts(cfg, token);
      const identity = await resolveIdentity(cfg, token, accounts);
      if (identity.sub !== req.session!.derivSub) {
        // Token belongs to a different subject than the session claims.
        await store.revokeUserSessions(req.user!.id);
        clearCookie(res, cfg.session.cookieName, { path: '/' });
        res.status(401).json({ error: 'identity_mismatch' });
        return;
      }
      res.json({ authorized: true, tokenExpiresAt: req.session!.derivTokenExpiresAt });
    } catch {
      await store.revokeUserSessions(req.user!.id);
      clearCookie(res, cfg.session.cookieName, { path: '/' });
      res.status(401).json({ error: 'deriv_authorization_revoked' });
    }
  });

  return router;
}
