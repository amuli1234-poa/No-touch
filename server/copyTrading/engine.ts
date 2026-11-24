import { randomUUID } from 'node:crypto';

import type { Store, UserRecord, DerivAccountRef } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import type { ExecutionGateway } from '../execution/gateway.js';
import { ExecutionError } from '../execution/gateway.js';
import type { ExecutionAuditor } from '../execution/audit.js';
import type { SignalRecord, TradeIntentRecord } from '../execution/types.js';
import { open } from '../lib/crypto.js';
import { resolveContractType, SignalError } from '../services/signals.js';
import type { CopyTradingFollowerRecord } from './types.js';

/**
 * DEMO copy trading.
 *
 * When a manager's DEMO trade is accepted by the broker, each connected follower
 * has the same trade mirrored into their own DEMO account. This module adds only
 * the fan-out; it does not buy anything itself. Every mirrored trade goes through
 * `gateway.createIntent` → `gateway.submit`, which remains the single purchase
 * path, so a copied trade is subject to exactly the controls a hand-placed one
 * is: the three kill switches, account ownership, the risk engine and signal
 * single-use.
 *
 * Three properties are enforced here and nowhere else:
 *
 *  - REAL accounts never copy. A follower's REAL accounts are ignored outright,
 *    and the principal handed to the gateway contains only DEMO accounts, so the
 *    gateway could not resolve a REAL account for a copied trade even if asked.
 *  - Administrative holds are honoured. A follower the admin has paused or
 *    suspended is skipped before any work is done.
 *  - One copy per (master trade, follower account). The idempotency key is
 *    derived from the master intent, so a retried fan-out cannot double-trade.
 *
 * The follower is represented to the gateway as its own principal `UserRecord`
 * built from the follower record. The gateway keys ownership, risk and intents by
 * `user.id`, so a stable synthetic id derived from the follower id is required:
 * it can never collide with a real user, and it makes the follower's accounts
 * resolve as theirs rather than the manager's.
 */

export type CopyOutcomeKind = 'copied' | 'skipped' | 'rejected' | 'failed';

export interface CopyOutcome {
  followerId: string;
  accountId: string;
  outcome: CopyOutcomeKind;
  reason: string | null;
  intentId: string | null;
  contractId: number | null;
}

/** A copied signal is only ever usable immediately; it mirrors a live trade. */
const COPY_SIGNAL_TTL_MS = 60_000;

export interface CopyEngineDeps {
  store: Store;
  cfg: ServerConfig;
  gateway: ExecutionGateway;
  auditor: ExecutionAuditor;
  now?: () => number;
}

/** The trade a manager just had accepted, and the sizing to mirror. */
export interface MirrorInput {
  /** The manager who placed the trade. */
  master: UserRecord;
  /** The manager's signal, already consumed by the master's own intent. */
  signal: SignalRecord;
  /** The master's accepted intent; also the idempotency anchor for copies. */
  masterIntentId: string;
  stake: number;
  basis: 'stake' | 'payout';
  currency: string;
  parameters: TradeIntentRecord['parameters'];
}

/**
 * Statuses that permit copying. The record contract says `paused` and
 * `suspended` are the administrative holds a copy engine must consult, so a
 * freshly connected follower (`authorized`) copies unless an admin holds it.
 */
function isHeld(follower: CopyTradingFollowerRecord): boolean {
  const status = follower.status ?? 'authorized';
  return status === 'paused' || status === 'suspended';
}

/** Deriv marks an account unusable for trading when its status is not active. */
function isTradable(account: DerivAccountRef): boolean {
  const status = account.status?.toLowerCase();
  return status === undefined || status === 'active';
}

/**
 * The follower as a gateway principal. Only DEMO accounts are included, so the
 * account guard cannot resolve a REAL account for a copied trade.
 */
export function followerPrincipal(follower: CopyTradingFollowerRecord): UserRecord {
  return {
    id: `copy_follower_${follower.id}`,
    derivSub: follower.derivSub,
    loginId: follower.loginId,
    accounts: follower.accounts.filter((a) => a.type === 'demo'),
    createdAt: follower.createdAt,
    updatedAt: follower.updatedAt,
    preferences: {}
  };
}

export class CopyExecutionEngine {
  private readonly store: Store;
  private readonly cfg: ServerConfig;
  private readonly gateway: ExecutionGateway;
  private readonly auditor: ExecutionAuditor;
  private readonly now: () => number;

  constructor(deps: CopyEngineDeps) {
    this.store = deps.store;
    this.cfg = deps.cfg;
    this.gateway = deps.gateway;
    this.auditor = deps.auditor;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Mirrors one accepted manager trade onto every eligible follower's DEMO
   * accounts. Never throws for a normal skip or rejection, so one refused
   * follower cannot prevent the rest from copying.
   */
  async mirrorMasterTrade(input: MirrorInput): Promise<CopyOutcome[]> {
    // Only a DEMO master trade is mirrored in this build. REAL stays untouched
    // until a separate release approval enables it.
    if (input.signal.accountMode !== 'demo') return [];

    const followers = this.store
      .listAllCopyTradingFollowers()
      .filter((f) => f.ownerUserId === input.master.id);

    const outcomes: CopyOutcome[] = [];
    for (const follower of followers) {
      outcomes.push(...(await this.mirrorForFollower(follower, input)));
    }
    return outcomes;
  }

  private async mirrorForFollower(
    follower: CopyTradingFollowerRecord,
    input: MirrorInput
  ): Promise<CopyOutcome[]> {
    if (isHeld(follower)) {
      return [await this.skip(follower, 'follower_held', input)];
    }

    const demoAccounts = follower.accounts.filter((a) => a.type === 'demo' && isTradable(a));
    if (demoAccounts.length === 0) {
      return [await this.skip(follower, 'no_demo_account', input)];
    }

    const now = this.now();
    if (follower.tokenExpiresAt > 0 && follower.tokenExpiresAt <= now) {
      return [await this.skip(follower, 'token_expired', input)];
    }

    const accessToken = open(follower.tokenSealed, this.cfg.session.secret);
    if (!accessToken) {
      return [await this.skip(follower, 'token_unavailable', input)];
    }

    const principal = followerPrincipal(follower);
    const outcomes: CopyOutcome[] = [];
    for (const account of demoAccounts) {
      outcomes.push(await this.copyToAccount(principal, follower, account, accessToken, input));
    }
    return outcomes;
  }

  private async copyToAccount(
    principal: UserRecord,
    follower: CopyTradingFollowerRecord,
    account: DerivAccountRef,
    accessToken: string,
    input: MirrorInput
  ): Promise<CopyOutcome> {
    const now = this.now();
    const currency = account.currency ?? input.currency;
    const idempotencyKey = `copy:${input.masterIntentId}:${account.accountId}`;

    const signal: SignalRecord = {
      id: `sig_copy_${randomUUID()}`,
      userId: principal.id,
      accountId: account.accountId,
      accountMode: 'demo',
      symbol: input.signal.symbol,
      timeframe: input.signal.timeframe,
      direction: input.signal.direction,
      contractFamily: input.signal.contractFamily,
      ...(input.signal.contractType ? { contractType: input.signal.contractType } : {}),
      analysisId: input.signal.analysisId,
      zone: input.signal.zone,
      entryPrice: input.signal.entryPrice,
      confidence: input.signal.confidence,
      reason: `copy:${input.signal.id}`,
      createdAt: now,
      expiresAt: Math.min(input.signal.expiresAt, now + COPY_SIGNAL_TTL_MS),
      consumedByIntentId: null
    };

    let intentId: string | null = null;
    try {
      // A retried fan-out must not re-submit an intent that already bought.
      // `createIntent` would return the existing one and `submit` would then
      // fail on an illegal transition, so detect the completed copy up front and
      // report it honestly instead of as an error.
      const prior = this.store.findTradeIntentByIdempotencyKey(principal.id, idempotencyKey);
      if (prior) {
        return {
          followerId: follower.id,
          accountId: account.accountId,
          outcome: 'skipped',
          reason: 'already_copied',
          intentId: prior.id,
          contractId: prior.contractId
        };
      }

      await this.store.putSignal(signal);
      const intent = await this.gateway.createIntent({
        user: principal,
        accountId: account.accountId,
        signal,
        contractType: resolveContractType(signal),
        contractFamily: signal.contractFamily,
        stake: input.stake,
        basis: input.basis,
        currency,
        parameters: input.parameters,
        idempotencyKey
      });
      intentId = intent.id;

      const result = await this.gateway.submit(principal, intent.id, accessToken);
      await this.auditor.record({
        userId: principal.id,
        action: 'execution.copy',
        outcome: 'allowed',
        accountId: account.accountId,
        intentId: intent.id,
        detail: {
          followerId: follower.id,
          masterUserId: input.master.id,
          masterIntentId: input.masterIntentId,
          signalId: input.signal.id,
          contractId: result.contractId
        }
      });
      return {
        followerId: follower.id,
        accountId: account.accountId,
        outcome: 'copied',
        reason: null,
        intentId: intent.id,
        contractId: result.contractId
      };
    } catch (err) {
      const reason = err instanceof ExecutionError || err instanceof SignalError ? err.code : 'copy_failed';
      await this.auditor.record({
        userId: principal.id,
        action: 'execution.copy',
        outcome: 'denied',
        accountId: account.accountId,
        intentId,
        detail: { followerId: follower.id, masterIntentId: input.masterIntentId, reason }
      });
      return {
        followerId: follower.id,
        accountId: account.accountId,
        outcome: reason === 'copy_failed' ? 'failed' : 'rejected',
        reason,
        intentId,
        contractId: null
      };
    }
  }

  private async skip(
    follower: CopyTradingFollowerRecord,
    reason: string,
    input: MirrorInput
  ): Promise<CopyOutcome> {
    await this.auditor.record({
      userId: `copy_follower_${follower.id}`,
      action: 'execution.copy',
      outcome: 'denied',
      detail: { followerId: follower.id, masterIntentId: input.masterIntentId, reason }
    });
    return {
      followerId: follower.id,
      accountId: '',
      outcome: 'skipped',
      reason,
      intentId: null,
      contractId: null
    };
  }
}
