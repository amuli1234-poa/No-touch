import express, { Router, type Response } from 'express';
import { createHash } from 'node:crypto';
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
import {
  parseCookies,
  setCookie,
  clearCookie,
  redirectWithError,
  resolveRequestOrigin
} from '../lib/http.js';
import { seal } from '../lib/crypto.js';
import {
  issueSessionCookie,
  requireSession,
  type SessionContext,
  type AuthedRequest
} from '../lib/session.js';
import type { BalanceService } from '../services/balance.js';
import { recordServerEvent } from '../activity/service.js';

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

function copyTradingLinkResult(res: Response, success: boolean, message: string): void {
  res
    .status(success ? 200 : 400)
    .type('html')
    .set('Cache-Control', 'no-store')
    .set('Referrer-Policy', 'no-referrer')
    .send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WickSentinel account connection</title><body style="margin:0;background:#080d16;color:#e8edf5;font:16px system-ui,sans-serif"><main style="max-width:560px;margin:12vh auto;padding:32px;background:#162033;border:1px solid #26344b;border-radius:16px"><p style="color:#60a5fa;font-weight:700;letter-spacing:.12em;text-transform:uppercase">WickSentinel · Copy Trading</p><h1>${success ? 'Account connection complete' : 'Account connection failed'}</h1><p style="line-height:1.6;color:#bac5d5">${message}</p><p style="line-height:1.6;color:#bac5d5">You may close this page. The account manager can refresh their connected accounts list.</p></main></body></html>`);
}

/** Escapes text for HTML text and double-quoted attribute contexts. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the two-path invitation page.
 *
 * Both actions are deliberately separate: "I already have an account" posts the
 * invitation token back to this origin to start OAuth, while "create an
 * account" is a plain outbound link to the manager's official referral URL. The
 * referral URL is emitted verbatim — attribution lives in its query string, so
 * rewriting or appending to it would break the referral.
 *
 * The referral link is a link, not a redirect: a client who already has a Deriv
 * account must be able to skip it. Nothing here claims the referral registered,
 * because only Deriv can confirm that.
 */
function renderInvitationChoicePage(input: {
  invitationId: string;
  secret: string;
  referralUrl?: string;
}): string {
  const action = `/auth/copy-trading/connect/${encodeURIComponent(input.invitationId)}`;
  const referral = input.referralUrl
    ? `<a class="secondary" href="${escapeHtml(input.referralUrl)}" target="_blank" rel="noopener noreferrer">Create a Deriv Account</a>
        <p class="note">Opens Deriv's official registration page in a new tab. When you are done, come back to this page and choose "I Already Have a Deriv Account".</p>`
    : `<p class="note">No Deriv registration link is configured for this invitation. Ask the account manager for one, then return here and choose "I Already Have a Deriv Account".</p>`;

  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WickSentinel · Copy Trading invitation</title><body style="margin:0;background:#080d16;color:#e8edf5;font:16px system-ui,-apple-system,sans-serif"><main style="max-width:600px;margin:8vh auto;padding:32px;background:#162033;border:1px solid #26344b;border-radius:16px"><p style="color:#60a5fa;font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px">WickSentinel · Copy Trading</p><h1 style="margin:12px 0 8px;font-size:24px;line-height:1.25">You have been invited to copy a trading strategy</h1><p style="line-height:1.6;color:#bac5d5;margin:0 0 24px">To accept, WickSentinel needs permission to read your Deriv account. Choose the option that applies to you.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="token" value="${escapeHtml(input.secret)}"><button type="submit" style="display:block;width:100%;padding:14px 18px;margin:0 0 12px;border:0;border-radius:10px;background:#2878d0;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer">I Already Have a Deriv Account</button></form>${referral}<div style="margin-top:24px;padding-top:20px;border-top:1px solid #26344b"><p style="line-height:1.6;color:#93a4bd;font-size:13px;margin:0">Connecting does not start trading. After you connect, you will review the strategy and risk disclosures and must explicitly authorize copying. You can revoke access at any time, and WickSentinel never sees your Deriv password.</p></div></main></body></html>`;
}

/**
 * Accepts only a same-origin absolute path, so a crafted `returnTo` can never
 * turn the OAuth callback into an open redirect. `//host` and backslash forms are
 * rejected because browsers treat them as protocol-relative.
 */
function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  return value;
}

export function createAuthRouter(ctx: SessionContext, balances?: BalanceService): Router {
  const { cfg, store } = ctx;
  const router = Router();

  /* ------------------------------- start -------------------------------- */

  router.get('/auth/start', async (req, res) => {
    const mode = req.query.mode === 'signup' ? 'signup' : 'login';
    const returnTo = safeReturnPath(req.query.returnTo);
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const state = createState();

    await store.createOAuthTransaction({
      state,
      codeVerifier,
      redirectUri: cfg.deriv.redirectUri,
      mode,
      returnTo,
      createdAt: Date.now(),
      consumedAt: null
    });

    // Mirror the verifier into an HttpOnly cookie so the callback can complete
    // even if storage was partitioned; it is single-use and short-lived.
    setCookie(res, cfg.session.oauthCookieName, `${state}:${codeVerifier}`, oauthCookieOptions(cfg, cfg.session.oauthCookieTtlSeconds));

    res.redirect(buildAuthorizationUrl(cfg, { state, codeChallenge, mode }));
  });

  /**
   * A one-use invitation lets a client authorize their account without the
   * manager's WickSentinel session. This renders the choice page instead of
   * redirecting straight to Deriv, so a client without a Deriv account can be
   * sent to the manager's official referral link first.
   */
  router.get('/auth/copy-trading/connect/:invitationId', async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const invitationId = req.params.invitationId;
    const secret = typeof req.query.token === 'string' ? req.query.token : '';
    const invitation = store.getCopyTradingInvitation(invitationId);
    const suppliedHash = createHash('sha256').update(secret).digest('base64url');
    if (
      !secret || !invitation || invitation.consumedAt !== null || invitation.expiresAt <= Date.now() ||
      !timingSafeEqual(invitation.tokenHash, suppliedHash) || !store.getUserById(invitation.ownerUserId)
    ) {
      res.status(410).send('This Copy Trading invitation is invalid, expired, or already used. Ask the account manager for a new link.');
      return;
    }

    // Self-contained page: inline styles only, no scripts, no framing.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    res
      .status(200)
      .type('html')
      .send(renderInvitationChoicePage({ invitationId: invitation.id, secret, referralUrl: cfg.derivReferralUrl }));
  });

  /**
   * Starts the real OAuth authorization for an invitation. Kept as a POST so the
   * invitation token never appears in a form-action URL, and so the referral
   * choice is an explicit user decision rather than a redirect chain.
   */
  router.post('/auth/copy-trading/connect/:invitationId', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const invitationId = req.params.invitationId;
    const secret = typeof req.body?.token === 'string' ? req.body.token : '';
    const invitation = store.getCopyTradingInvitation(invitationId);
    const suppliedHash = createHash('sha256').update(secret).digest('base64url');
    if (
      !secret || !invitation || invitation.consumedAt !== null || invitation.expiresAt <= Date.now() ||
      !timingSafeEqual(invitation.tokenHash, suppliedHash) || !store.getUserById(invitation.ownerUserId)
    ) {
      res.status(410).send('This Copy Trading invitation is invalid, expired, or already used. Ask the account manager for a new link.');
      return;
    }

    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const state = createState();
    await store.createOAuthTransaction({
      state,
      codeVerifier,
      redirectUri: cfg.deriv.redirectUri,
      mode: 'login',
      flow: 'copy_trading_follower',
      ownerUserId: invitation.ownerUserId,
      invitationId: invitation.id,
      createdAt: Date.now(),
      consumedAt: null
    });
    setCookie(res, cfg.session.oauthCookieName, `${state}:${codeVerifier}`, oauthCookieOptions(cfg, cfg.session.oauthCookieTtlSeconds));
    res.redirect(buildAuthorizationUrl(cfg, { state, codeChallenge, mode: 'login' }));
  });

  /* ------------------------------ callback ------------------------------ */

  router.get('/auth/deriv/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;

    if (error) {
      // Deriv reported a failure (access_denied, invalid_scope, etc.).
      const safeError = /^[a-z0-9_]{1,80}$/i.test(error) ? error : 'unknown_oauth_error';
      console.warn('[auth] Deriv returned an OAuth error:', safeError);
      const failedLinkTx = state ? store.getOAuthTransaction(state) : null;
      if (failedLinkTx?.flow === 'copy_trading_follower') {
        copyTradingLinkResult(res, false, 'Deriv authorization was cancelled or could not be completed.');
        return;
      }
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
      const status = err instanceof DerivRequestError ? err.status : 'unknown';
      console.error('[auth] Deriv authorization-code exchange failed:', { status, code: code2 });
      // invalid_grant usually means the code expired or was already used.
      const mapped = code2 === 'invalid_grant' ? 'expired_code' : 'authorization_failed';
      if (tx.flow === 'copy_trading_follower') {
        copyTradingLinkResult(res, false, 'Deriv could not complete this account authorization. Ask the manager for a new invitation if needed.');
        return;
      }
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
      if (tx.flow === 'copy_trading_follower') {
        copyTradingLinkResult(res, false, 'Deriv did not return a verified account identity, so the account was not connected.');
        return;
      }
      return redirectWithError(res, cfg.appOrigin, 'identity_unverified');
    }

    if (tx.flow === 'copy_trading_follower') {
      const owner = tx.ownerUserId ? store.getUserById(tx.ownerUserId) : null;
      const demoAccounts = accounts.filter((account) => account.type === 'demo');
      const pendingInvitation = tx.invitationId ? store.getCopyTradingInvitation(tx.invitationId) : null;
      if (
        !owner || !pendingInvitation || pendingInvitation.ownerUserId !== owner.id ||
        pendingInvitation.consumedAt !== null || pendingInvitation.expiresAt <= Date.now() || demoAccounts.length === 0
      ) {
        copyTradingLinkResult(res, false, 'The invitation expired or was already used. Ask the manager for a new link.');
        return;
      }
      const overlappingAccounts = accounts.some((account) => owner.accounts.some((owned) => owned.accountId === account.accountId));
      if (identity.sub === owner.derivSub || overlappingAccounts) {
        copyTradingLinkResult(res, false, 'This is the manager account. Open the invitation while signed in to your own Deriv account.');
        return;
      }
      const existingFollower =
        store.findCopyTradingFollowerByIdentity(identity.sub) ??
        store.findCopyTradingFollowerByAccountIds(demoAccounts.map((account) => account.accountId));
      if (existingFollower && existingFollower.ownerUserId !== owner.id) {
        copyTradingLinkResult(res, false, 'This Deriv account is already connected to another manager.');
        return;
      }
      const invitation = await store.consumeCopyTradingInvitation(pendingInvitation.id);
      if (!invitation) {
        copyTradingLinkResult(res, false, 'The invitation expired or was already used. Ask the manager for a new link.');
        return;
      }
      const now = Date.now();
      const followerId = existingFollower?.id ?? createOpaqueId();
      await store.putCopyTradingFollower({
        id: followerId,
        ownerUserId: owner.id,
        derivSub: identity.sub,
        authMethod: 'oauth',
        loginId: identity.loginId,
        accounts: accountRefs(demoAccounts),
        tokenSealed: seal(token.accessToken, cfg.session.secret),
        tokenExpiresAt: token.expiresAt,
        createdAt: existingFollower?.createdAt ?? now,
        updatedAt: now,
        status: existingFollower?.status ?? 'authorized',
        revision: (existingFollower?.revision ?? 0) + 1
      });
      // The client personally approved access on Deriv, so the grant itself is
      // the consent record. Stored separately from the credential.
      await store.putCopyTradingConsent({
        followerId,
        ownerUserId: owner.id,
        method: 'oauth',
        recordedByAdminId: null,
        attestedBy: `deriv-oauth:${identity.sub}`,
        consentedAt: now,
        note: 'Client authorized the connection in the Deriv OAuth flow.'
      });
      copyTradingLinkResult(res, true, 'Your Deriv account was linked to the manager through your authorization.');
      return;
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
    // Reauthorization may have changed the account set; drop any cached balances
    // so the next read reflects the new authorization rather than a stale one.
    balances?.invalidateUser(user.id);
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

    // Best-effort activity trail; a failure here must not break sign-in.
    try {
      await recordServerEvent(store, 'auth.login', user.id);
    } catch {
      // ignore — telemetry is not on the critical path
    }

    // 9. Hand off to the SPA workspace, or back to the page that started sign-in
    //    (the bot app passes its own path so the trader lands where they were).
    // Redirect to the host the trader actually used, not the configured OAuth
    // origin: behind a proxy those differ, and landing on the wrong host drops
    // the session cookie the callback just set.
    res.redirect(`${resolveRequestOrigin(req, cfg.appOrigin)}${tx.returnTo ?? '/app'}`);
  });

  /* ------------------------------- logout ------------------------------- */

  router.post('/auth/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[cfg.session.cookieName];
    let logoutUserId: string | null = null;
    if (raw) {
      const sessionId = raw.split('.')[0];
      const session = store.getSession(sessionId);
      if (session) {
        logoutUserId = session.userId;
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
    try {
      await recordServerEvent(store, 'auth.logout', logoutUserId);
    } catch {
      // ignore — telemetry is not on the critical path
    }
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
