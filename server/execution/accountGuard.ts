/**
 * Tenant and account isolation guard.
 *
 * Every execution-adjacent path must resolve the account through this module
 * before doing anything else. It enforces, in one place:
 *
 *  - the account MUST appear in the session user's own stored account list;
 *  - a client-asserted mode that disagrees with the account's real mode is
 *    rejected, never silently substituted;
 *  - the resolved mode is taken from the stored account record, never from the
 *    request.
 *
 * It deliberately mirrors `BalanceService.resolveAccount` so there is one
 * ownership rule in the codebase, and it throws a typed error whose `code` is a
 * stable machine-readable reason. Nothing here executes a trade.
 */

import type { UserRecord, DerivAccountRef } from '../store/store.js';
import type { AccountMode } from './types.js';

export type AccountAccessErrorCode =
  | 'account_not_authorized'
  | 'account_mode_mismatch'
  | 'account_mode_invalid'
  | 'account_unavailable';

export class AccountAccessError extends Error {
  readonly code: AccountAccessErrorCode;
  constructor(code: AccountAccessErrorCode, message: string) {
    super(message);
    this.name = 'AccountAccessError';
    this.code = code;
  }
}

/** A validated account: its mode is authoritative and taken from the store. */
export interface ResolvedAccount {
  accountId: string;
  mode: AccountMode;
  currency: string | null;
  /** True only for an account whose stored status permits trading. */
  tradable: boolean;
}

/**
 * Parses a client-asserted mode. Anything other than the exact strings
 * `demo`/`real` is an error, so a caller cannot smuggle an unexpected value
 * through and have it treated as "no assertion".
 */
export function parseAccountMode(value: unknown): AccountMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'demo' || value === 'real') return value;
  throw new AccountAccessError('account_mode_invalid', 'Account mode must be "demo" or "real".');
}

/** Deriv marks an account unusable for trading when its status is not active. */
function isTradable(account: DerivAccountRef): boolean {
  const status = account.status?.toLowerCase();
  // A missing status is treated as usable (Deriv omits it on some payloads);
  // any explicit non-active status is not.
  return status === undefined || status === 'active';
}

/**
 * Resolves `accountId` for `user`, enforcing ownership and (when asserted) mode.
 * Throws AccountAccessError on any mismatch; it never falls back to another
 * account and never trusts a mode supplied by the client.
 */
export function resolveAccountForUser(
  user: UserRecord,
  accountId: string,
  assertedMode?: AccountMode
): ResolvedAccount {
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new AccountAccessError('account_not_authorized', 'No account id was supplied.');
  }
  const account = user.accounts.find((a) => a.accountId === accountId);
  if (!account) {
    throw new AccountAccessError(
      'account_not_authorized',
      'The requested account does not belong to this user.'
    );
  }
  if (assertedMode && assertedMode !== account.type) {
    throw new AccountAccessError(
      'account_mode_mismatch',
      'The requested account mode does not match the account.'
    );
  }
  return {
    accountId: account.accountId,
    // Authoritative: the stored account's own type, not the assertion.
    mode: account.type,
    currency: account.currency ?? null,
    tradable: isTradable(account)
  };
}

/**
 * Resolves an account for execution. Identical to `resolveAccountForUser` but
 * additionally refuses an account whose status is not active, since executing
 * on an unavailable account must fail rather than proceed.
 */
export function resolveTradableAccountForUser(
  user: UserRecord,
  accountId: string,
  assertedMode?: AccountMode
): ResolvedAccount {
  const resolved = resolveAccountForUser(user, accountId, assertedMode);
  if (!resolved.tradable) {
    throw new AccountAccessError('account_unavailable', 'The account is not available for trading.');
  }
  return resolved;
}

/** Convenience: the accounts a user owns in a given mode. */
export function accountsInMode(user: UserRecord, mode: AccountMode): DerivAccountRef[] {
  return user.accounts.filter((a) => a.type === mode);
}
