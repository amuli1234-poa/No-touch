import type { ServerConfig } from '../config.js';
import type { UserRecord } from '../store/store.js';
import { fetchBalance, DerivBalanceError, type DerivBalance } from '../lib/balance.js';

/**
 * Per-user Deriv balance reads, with ownership and account-mode validation.
 *
 * Rules enforced here (not in the browser):
 *  - The requested account MUST appear in the session user's own account list.
 *    The list is re-read from the store on every request, so a revoked or
 *    changed account stops working immediately — this is the "revalidate
 *    authorization after connection changes" requirement.
 *  - DEMO and REAL are never mixed: every record is keyed by account id and
 *    carries its own mode, and a request that asserts a mode which disagrees
 *    with the account's real mode is rejected rather than substituted.
 *  - The Deriv access token is used only here, server-side. It never appears in
 *    any response body.
 *
 * Balance figures are informational. Nothing in this service grants execution
 * authority; execution (when it exists) must re-validate independently.
 */

export type BalanceState = 'ok' | 'unavailable' | 'stale' | 'disconnected';

export interface AccountBalance {
  accountId: string;
  /** Derived from the account's own record, never from a client parameter. */
  mode: 'demo' | 'real';
  currency: string | null;
  /** Null unless state is 'ok' or 'stale'. Never a fabricated 0. */
  balance: number | null;
  state: BalanceState;
  /** Epoch ms of the last successful read, or null if there has never been one. */
  lastUpdated: number | null;
  /** Non-sensitive reason code when state is not 'ok'. */
  reason?: string;
}

export type BalanceAccessErrorCode = 'account_not_authorized' | 'account_mode_mismatch';

export class BalanceAccessError extends Error {
  readonly code: BalanceAccessErrorCode;
  constructor(code: BalanceAccessErrorCode, message: string) {
    super(message);
    this.name = 'BalanceAccessError';
    this.code = code;
  }
}

interface CacheEntry {
  mode: 'demo' | 'real';
  currency: string | null;
  balance: number | null;
  lastUpdated: number;
}

export interface ReadBalanceOptions {
  /** Client-asserted mode. If present and wrong, the request is rejected. */
  expectedMode?: 'demo' | 'real';
  /** Bypass the freshness cache (used on reconnect and account switches). */
  force?: boolean;
  /**
   * Deriv App ID sent as `Deriv-App-ID` for PAT-authenticated reads. Omitted for
   * OAuth reads (the token's own app is implied and the header is not required).
   */
  appId?: string;
}

export type BalanceFetcher = (
  cfg: ServerConfig,
  accessToken: string,
  accountId: string,
  appId?: string
) => Promise<DerivBalance>;

export interface BalanceServiceDeps {
  fetcher?: BalanceFetcher;
  now?: () => number;
  /** How long a successful read stays fresh before a refresh is attempted. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

export class BalanceService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetcher: BalanceFetcher;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly cfg: ServerConfig, deps: BalanceServiceDeps = {}) {
    this.fetcher = deps.fetcher ?? ((c, t, a, appId) => fetchBalance(c, t, a, { appId }));
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  private key(userId: string, accountId: string): string {
    return `${userId}:${accountId}`;
  }

  /** Drops one account's cached value so the next read refetches it. */
  invalidateAccount(userId: string, accountId: string): void {
    this.cache.delete(this.key(userId, accountId));
  }

  /** Drops every cached value for a user (reconnect / reauthorization). */
  invalidateUser(userId: string): void {
    const prefix = `${userId}:`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) this.cache.delete(k);
    }
  }

  /**
   * Resolves the account from the user's own records, enforcing ownership and
   * mode. Throws BalanceAccessError on any mismatch — it never falls back to a
   * different account.
   */
  private resolveAccount(user: UserRecord, accountId: string, expectedMode?: 'demo' | 'real') {
    const account = user.accounts.find((a) => a.accountId === accountId);
    if (!account) {
      throw new BalanceAccessError(
        'account_not_authorized',
        'The requested account does not belong to this user.'
      );
    }
    if (expectedMode && expectedMode !== account.type) {
      throw new BalanceAccessError(
        'account_mode_mismatch',
        'The requested account mode does not match the account.'
      );
    }
    return account;
  }

  /** Reads one account's balance, applying ownership, mode and cache rules. */
  async read(
    user: UserRecord,
    accountId: string,
    accessToken: string | null,
    opts: ReadBalanceOptions = {}
  ): Promise<AccountBalance> {
    const account = this.resolveAccount(user, accountId, opts.expectedMode);
    const key = this.key(user.id, accountId);
    const cached = this.cache.get(key);

    // No usable Deriv token (expired or revoked): we cannot refresh. Report the
    // connection state plainly rather than a value we cannot back up.
    if (!accessToken) {
      return {
        accountId,
        mode: account.type,
        currency: account.currency ?? null,
        balance: null,
        state: 'disconnected',
        lastUpdated: cached?.lastUpdated ?? null
      };
    }

    if (!opts.force && cached && this.now() - cached.lastUpdated < this.ttlMs) {
      return {
        accountId,
        mode: cached.mode,
        currency: cached.currency,
        balance: cached.balance,
        state: 'ok',
        lastUpdated: cached.lastUpdated
      };
    }

    try {
      const fresh = await this.fetcher(this.cfg, accessToken, accountId, opts.appId);
      const entry: CacheEntry = {
        mode: account.type,
        currency: fresh.currency ?? account.currency ?? null,
        balance: fresh.balance,
        lastUpdated: this.now()
      };
      this.cache.set(key, entry);
      return {
        accountId,
        mode: entry.mode,
        currency: entry.currency,
        balance: entry.balance,
        state: 'ok',
        lastUpdated: entry.lastUpdated
      };
    } catch (err) {
      const reason = err instanceof DerivBalanceError ? err.code : 'unknown';
      // A previous good value is shown as stale — clearly labelled, with its own
      // timestamp — rather than replaced by zero or hidden.
      if (cached) {
        return {
          accountId,
          mode: cached.mode,
          currency: cached.currency,
          balance: cached.balance,
          state: 'stale',
          lastUpdated: cached.lastUpdated,
          reason
        };
      }
      return {
        accountId,
        mode: account.type,
        currency: account.currency ?? null,
        balance: null,
        state: 'unavailable',
        lastUpdated: null,
        reason
      };
    }
  }

  /**
   * Reads every account the user owns, DEMO and REAL kept separate. Bounded
   * concurrency so a user with many accounts cannot fan out unboundedly.
   */
  async readAll(
    user: UserRecord,
    accessToken: string | null,
    opts: { force?: boolean; appId?: string } = {}
  ): Promise<AccountBalance[]> {
    const accounts = [...user.accounts];
    const results: AccountBalance[] = new Array(accounts.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < accounts.length) {
        const i = cursor++;
        const account = accounts[i];
        try {
          results[i] = await this.read(user, account.accountId, accessToken, { force: opts.force, appId: opts.appId });
        } catch (err) {
          // Ownership was already proven for these ids; anything else is a read
          // failure and is reported as unavailable rather than dropped.
          results[i] = {
            accountId: account.accountId,
            mode: account.type,
            currency: account.currency ?? null,
            balance: null,
            state: 'unavailable',
            lastUpdated: null,
            reason: err instanceof DerivBalanceError ? err.code : 'unknown'
          };
        }
      }
    };
    const workers = Array.from({ length: Math.min(3, accounts.length) }, worker);
    await Promise.all(workers);
    return results;
  }
}
