import { createHash } from 'node:crypto';

import type { ServerConfig } from '../config.js';

/**
 * Server-side Deriv OAuth client.
 *
 * Endpoints are taken verbatim from Deriv's published discovery document
 * (https://auth.deriv.com/.well-known/openid-configuration) and the OAuth guide
 * at https://developers.deriv.com/docs/intro/oauth/ . The token exchange runs
 * only here on the backend; the browser never sees the access token.
 */

export interface TokenResult {
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
  expiresAt: number;
}

export interface DerivIdentity {
  /** Stable OIDC subject — the only value used to identify a user. */
  sub: string;
  /** Non-identifying login id, for display convenience only. */
  loginId?: string;
}

export interface DerivAccount {
  accountId: string;
  type: 'demo' | 'real';
  currency?: string;
  status?: string;
  /** Stable user-facing login id (e.g. CR1234567), when the API returns it. */
  loginId?: string;
}

export class DerivRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function postForm(url: string, params: Record<string, string>): Promise<{ status: number; json: any }> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** Builds the authorization URL. `signup` adds prompt=registration per the docs. */
export function buildAuthorizationUrl(
  cfg: ServerConfig,
  opts: { state: string; codeChallenge: string; mode: 'login' | 'signup' }
): string {
  const url = new URL(cfg.deriv.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.deriv.appId);
  url.searchParams.set('redirect_uri', cfg.deriv.redirectUri);
  url.searchParams.set('scope', cfg.deriv.scopes);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (opts.mode === 'signup') {
    // Tells Deriv to show the registration form instead of login.
    url.searchParams.set('prompt', 'registration');
  }
  return url.toString();
}

/**
 * Exchanges an authorization code for an access token (Authorization Code +
 * PKCE). No client secret for the documented public-client flow.
 */
export async function exchangeCodeForToken(
  cfg: ServerConfig,
  opts: { code: string; codeVerifier: string }
): Promise<TokenResult> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: cfg.deriv.appId,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: cfg.deriv.redirectUri
  };
  // Only include the secret when the registered app is a confidential client
  // (token_endpoint_auth_methods_supported includes client_secret_post).
  if (cfg.deriv.clientSecret) params.client_secret = cfg.deriv.clientSecret;

  const { status, json } = await postForm(cfg.deriv.tokenEndpoint, params);
  if (status !== 200 || !json.access_token) {
    // Deriv returns { error, error_description } on failure (e.g. invalid_grant).
    throw new DerivRequestError(
      status,
      json.error || 'token_exchange_failed',
      json.error_description || 'Deriv rejected the authorization code.'
    );
  }
  const expiresInSeconds = Number(json.expires_in) || 0;
  return {
    accessToken: json.access_token,
    tokenType: json.token_type || 'Bearer',
    expiresInSeconds,
    expiresAt: Date.now() + expiresInSeconds * 1000
  };
}

/** Validates the authenticated identity via the OIDC userinfo endpoint. */
export async function fetchIdentity(cfg: ServerConfig, accessToken: string): Promise<DerivIdentity> {
  const res = await fetch(cfg.deriv.userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok || !json.sub) {
    throw new DerivRequestError(
      res.status,
      json.error || 'userinfo_failed',
      json.error_description || 'Could not verify the Deriv identity.'
    );
  }
  return {
    sub: String(json.sub),
    // Deriv may surface a login id (e.g. CR1234567 / VRTC...) as a convenience
    // claim; it is display-only and never the identity key.
    loginId: json.loginid || json.login_id || json.preferred_username || undefined
  };
}

/**
 * Lists the user's Options accounts (demo + real). Requires the `trade` scope;
 * callers treat any failure as "accounts unavailable" rather than fatal.
 */
export async function fetchAccounts(cfg: ServerConfig, accessToken: string, patAppId?: string): Promise<DerivAccount[]> {
  const res = await fetch(`${cfg.deriv.apiBaseUrl}/trading/v1/options/accounts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(patAppId ? { 'Deriv-App-ID': patAppId } : {})
    }
  });
  if (!res.ok) {
    throw new DerivRequestError(res.status, 'accounts_failed', 'Could not read Deriv accounts.');
  }
  const json: any = await res.json();
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  return rows.map((r) => ({
    accountId: String(r.account_id ?? r.accountId ?? ''),
    // Deriv marks demo accounts as account_type "demo"; anything else is real.
    type: r.account_type === 'demo' ? 'demo' : 'real',
    currency: r.currency,
    status: r.status,
    // Some responses carry the login id alongside the account id.
    loginId: r.loginid ?? r.login_id ?? undefined
  }));
}

/**
 * Resolves the stable identity for a session.
 *
 * Deriv's documented OAuth scopes are `trade`, `account_manage`,
 * `application_read`, `payment` — `openid` is not among them, and Deriv rejects
 * it with `invalid_scope` unless it has been enabled for the app. The
 * `trade`-scoped accounts endpoint is therefore the primary identity source: it
 * returns the user's stable account logins (e.g. CR1234567), never a display
 * name. When the OIDC userinfo endpoint *is* reachable its `sub` wins, because
 * that is the canonical OIDC subject.
 */
export async function resolveIdentity(
  cfg: ServerConfig,
  accessToken: string,
  accounts: DerivAccount[]
): Promise<DerivIdentity> {
  try {
    return await fetchIdentity(cfg, accessToken);
  } catch {
    // openid/userinfo unavailable — fall through to the accounts-derived identity.
  }

  const ids = accounts.map((a) => a.accountId).filter(Boolean).sort();
  if (ids.length === 0) {
    throw new DerivRequestError(
      400,
      'identity_unavailable',
      'Could not identify the Deriv account: no verified identity or accounts were returned.'
    );
  }
  // Deterministic across ordering and stable per account set; opaque so it is
  // never mistaken for a display name.
  const digest = createHash('sha256').update(ids.join(',')).digest('base64url');
  return {
    sub: `deriv-accounts:${digest}`,
    loginId: accounts.find((a) => a.loginId)?.loginId ?? ids[0]
  };
}

/**
 * Mints a short-lived, single-use authenticated WebSocket URL for one account.
 *
 * The bot app needs an authorised WebSocket to trade. Fetching it in the browser
 * would require handing the OAuth access token to the page, which contradicts the
 * "token never reaches the browser" invariant this backend maintains. So the
 * exchange happens here and only the resulting OTP URL — scoped to one account
 * and expiring in minutes — is returned.
 */
export async function fetchOtpWebSocketUrl(
  cfg: ServerConfig,
  accessToken: string,
  accountId: string
): Promise<string> {
  const res = await fetch(
    `${cfg.deriv.apiBaseUrl}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
  );
  if (!res.ok) {
    throw new DerivRequestError(res.status, 'otp_failed', 'Could not open a trading session for this account.');
  }
  const json: any = await res.json();
  const url = json?.data?.url ?? json?.url;
  if (typeof url !== 'string' || url === '') {
    throw new DerivRequestError(502, 'otp_missing_url', 'Deriv did not return a WebSocket URL.');
  }
  return url;
}

/** Best-effort RFC 7009 token revocation when the user logs out. */
export async function revokeToken(cfg: ServerConfig, accessToken: string): Promise<void> {
  try {
    await postForm(cfg.deriv.revocationEndpoint, {
      token: accessToken,
      client_id: cfg.deriv.appId,
      ...(cfg.deriv.clientSecret ? { client_secret: cfg.deriv.clientSecret } : {})
    });
  } catch {
    // Revocation is advisory; the local session is still destroyed by the caller.
  }
}
