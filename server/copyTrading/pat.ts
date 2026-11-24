import type { ServerConfig } from '../config.js';
import { DerivRequestError, fetchAccounts, resolveIdentity, type DerivAccount, type DerivIdentity } from '../lib/deriv.js';

/**
 * Shared validation for a client-supplied Deriv Personal Access Token.
 *
 * Both the trader route (`POST /api/copy-trading/followers`) and the admin
 * console route (`POST /api/admin/v1/copy-trading/clients/token`) call this, so
 * there is exactly one token-validation implementation. It only ever returns
 * derived facts about the accounts — never the token, and never the raw Deriv
 * payload — so a caller cannot accidentally echo a credential.
 */

const MAX_PAT_LENGTH = 4096;

export type PatValidationFailure =
  | { kind: 'malformed'; status: 400; error: 'invalid_token' }
  | { kind: 'pat_not_configured'; status: 503; error: 'pat_app_not_configured' }
  | { kind: 'rejected'; status: 422; error: 'invalid_token' }
  | { kind: 'scope'; status: 422; error: 'trade_scope_required' }
  | { kind: 'unavailable'; status: 503; error: 'deriv_unavailable' }
  | { kind: 'no_demo'; status: 422; error: 'demo_account_required' }
  | { kind: 'identity'; status: 422; error: 'identity_unverified' };

export type PatValidationResult =
  | {
      ok: true;
      identity: DerivIdentity;
      /** Demo accounts only — the stage this platform supports for copying. */
      demoAccounts: DerivAccount[];
      /** Real accounts the token can see. Reported, never connected. */
      realAccountIds: string[];
    }
  | { ok: false; failure: PatValidationFailure };

/** True when a pasted string is at least shaped like a Deriv PAT. */
export function isPlausiblePat(token: string): boolean {
  return token.length >= 20 && token.length <= MAX_PAT_LENGTH && !/\s/.test(token);
}

/**
 * Validates a token against Deriv and resolves the identity behind it.
 *
 * Order matters: the token is checked for shape before any network call, the
 * PAT App ID is required (a PAT is only valid against a PAT-type App ID), and
 * identity is resolved from Deriv's own response rather than any client claim.
 */
export async function validatePatToken(cfg: ServerConfig, rawToken: string): Promise<PatValidationResult> {
  const patAppId = cfg.deriv.patAppId;
  if (!patAppId) return { ok: false, failure: { kind: 'pat_not_configured', status: 503, error: 'pat_app_not_configured' } };

  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!isPlausiblePat(token)) return { ok: false, failure: { kind: 'malformed', status: 400, error: 'invalid_token' } };

  let accounts: DerivAccount[];
  try {
    accounts = await fetchAccounts(cfg, token, patAppId);
  } catch (error) {
    if (error instanceof DerivRequestError && error.status === 401) {
      return { ok: false, failure: { kind: 'rejected', status: 422, error: 'invalid_token' } };
    }
    if (error instanceof DerivRequestError && error.status === 403) {
      return { ok: false, failure: { kind: 'scope', status: 422, error: 'trade_scope_required' } };
    }
    return { ok: false, failure: { kind: 'unavailable', status: 503, error: 'deriv_unavailable' } };
  }

  const demoAccounts = accounts.filter((account) => account.type === 'demo' && account.accountId);
  if (demoAccounts.length === 0) {
    return { ok: false, failure: { kind: 'no_demo', status: 422, error: 'demo_account_required' } };
  }

  let identity: DerivIdentity;
  try {
    identity = await resolveIdentity(cfg, token, accounts);
  } catch {
    return { ok: false, failure: { kind: 'identity', status: 422, error: 'identity_unverified' } };
  }

  return {
    ok: true,
    identity,
    demoAccounts,
    realAccountIds: accounts.filter((account) => account.type === 'real').map((account) => account.accountId)
  };
}

/** Human-readable message per failure code, shared by both surfaces. */
export const PAT_FAILURE_MESSAGE: Record<PatValidationFailure['error'], string> = {
  invalid_token: 'Deriv rejected this token or PAT App ID. Check both and try again.',
  pat_app_not_configured:
    'The server needs a separate Deriv PAT-type App ID (DERIV_PAT_APP_ID) before token entry is available.',
  trade_scope_required: 'This token needs the Deriv trade scope to read the client’s trading accounts.',
  deriv_unavailable: 'Deriv could not validate the token right now. Try again shortly.',
  demo_account_required: 'This stage accepts demo accounts only. The token must authorize at least one Deriv demo account.',
  identity_unverified: 'Deriv did not return enough account information to verify this token.'
};
