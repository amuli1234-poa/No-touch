import { randomUUID } from 'node:crypto';

import type { Store, UserRecord, DerivAccountRef } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import type { ExecutionGateway, BulkExecuteEntry } from '../execution/gateway.js';
import type { BuyResult } from '../execution/broker/types.js';
import type { ExecutionAuditor } from '../execution/audit.js';
import type { SignalRecord, TradeIntentRecord } from '../execution/types.js';
import { open } from '../lib/crypto.js';
import { resolveContractType } from '../services/signals.js';
import { countTradesToday, DAILY_TRADE_LIMIT } from '../execution/autoRunner.js';
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
  buy: BuyResult | null;
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
  /** The manager's Deriv access token (server-side, from the sealed session). */
  masterAccessToken: string;
  /** The manager's signal, used as the template for all copy signals. */
  signal: SignalRecord;
  /** The master's accepted intent; also the idempotency anchor for copies. */
  masterIntentId: string;
  stake: number;
  basis: 'stake' | 'payout';
  currency: string;
  parameters: TradeIntentRecord['parameters'];
  /** When true, the master is included in the bulk alongside followers. Default false; routes set true for coordinated master+follower execution. */
  includeMaster?: boolean;
}

/**
 * Statuses that permit copying. The record contract says `paused` and
 * `suspended` are the administrative holds a copy engine must consult, so a
 * freshly connected follower (`authorized`) copies unless an admin holds it.
 */
export function isHeld(follower: CopyTradingFollowerRecord): boolean {
  const status = follower.status ?? 'authorized';
  return status === 'paused' || status === 'suspended';
}

/** Deriv marks an account unusable for trading when its status is not active. */
export function isTradable(account: DerivAccountRef): boolean {
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
   * account, executing the master and all followers in a coordinated bulk:
   * proposals are fetched for every account in parallel, then all buys fire
   * simultaneously. This replaces the old master-first-then-followers sequence,
   * so followers no longer lag behind the master's entry price.
   *
   * Never throws for a normal skip or rejection, so one refused follower cannot
   * prevent the rest from copying.
   */
  async mirrorMasterTrade(input: MirrorInput): Promise<CopyOutcome[]> {
    // Only a DEMO master trade is mirrored in this build. REAL stays untouched
    // until a separate release approval enables it.
    if (input.signal.accountMode !== 'demo') return [];

    // Copying is opt-in per master. Until an administrator presses Start, a
    // manager's trade is theirs alone, so nothing fans out.
    const control = this.store.getCopyTradingControl(input.master.id);
    if (!control?.enabled) return [];

    const followers = this.store
      .listAllCopyTradingFollowers()
      .filter((f) => f.ownerUserId === input.master.id);

    const now = this.now();
    const entries: BulkExecuteEntry[] = [];
    const skipped: CopyOutcome[] = [];
    const includeMaster = input.includeMaster ?? false;

    // Master entry: create a fresh signal copy (the original is already consumed
    // by the master's intent, so we clone it with a new id).
    if (includeMaster) {
      const masterAccount = input.master.accounts.find((a) => a.accountId === input.signal.accountId);
      if (masterAccount && masterAccount.type === 'demo' && isTradable(masterAccount)) {
        const masterSignal: SignalRecord = {
          ...input.signal,
          id: `sig_copy_${randomUUID()}`,
          userId: input.master.id,
          consumedByIntentId: null
        };
        await this.store.putSignal(masterSignal);
        entries.push({
          user: input.master,
          accountId: input.signal.accountId,
          signal: masterSignal,
          contractType: resolveContractType({ ...input.signal, contractFamily: input.signal.contractFamily }),
          contractFamily: input.signal.contractFamily,
          stake: input.stake,
          basis: input.basis,
          currency: input.currency,
          parameters: input.parameters,
          idempotencyKey: `copy:${input.masterIntentId}:${input.signal.accountId}`,
          asCopy: true,
          manualApproval: { approvedAt: now, expiresAt: now + 15_000 },
          accessToken: input.masterAccessToken
        });
      }
    }

    // Follower entries: one per demo account, all in the same bulk.
    for (const follower of followers) {
      if (isHeld(follower)) {
        await this.skip(follower, 'follower_held', input);
        skipped.push({
          followerId: follower.id,
          accountId: '',
          outcome: 'skipped',
          reason: 'follower_held',
          intentId: null,
          contractId: null,
          buy: null
        });
        continue;
      }

      const demoAccounts = follower.accounts.filter((a) => a.type === 'demo' && isTradable(a));
      if (demoAccounts.length === 0) {
        await this.skip(follower, 'no_demo_account', input);
        skipped.push({
          followerId: follower.id,
          accountId: '',
          outcome: 'skipped',
          reason: 'no_demo_account',
          intentId: null,
          contractId: null,
          buy: null
        });
        continue;
      }

      if (follower.tokenExpiresAt > 0 && follower.tokenExpiresAt <= now) {
        await this.skip(follower, 'token_expired', input);
        skipped.push({
          followerId: follower.id,
          accountId: '',
          outcome: 'skipped',
          reason: 'token_expired',
          intentId: null,
          contractId: null,
          buy: null
        });
        continue;
      }

      const accessToken = open(follower.tokenSealed, this.cfg.session.secret);
      if (!accessToken) {
        await this.skip(follower, 'token_unavailable', input);
        skipped.push({
          followerId: follower.id,
          accountId: '',
          outcome: 'skipped',
          reason: 'token_unavailable',
          intentId: null,
          contractId: null,
          buy: null
        });
        continue;
      }

      const principal = followerPrincipal(follower);
      for (const account of demoAccounts) {
        // Daily trade cap: each follower account gets at most 24 trades per
        // UTC day (copies count toward the follower's own cap).
        const followerTradesToday = countTradesToday(this.store, principal.id, account.accountId, now);
        if (followerTradesToday >= DAILY_TRADE_LIMIT) {
          await this.skip(follower, `daily_limit_reached (${followerTradesToday}/${DAILY_TRADE_LIMIT})`, input);
          skipped.push({
            followerId: follower.id,
            accountId: account.accountId,
            outcome: 'skipped',
            reason: 'daily_limit_reached',
            intentId: null,
            contractId: null,
            buy: null
          });
          continue;
        }

        const followerSignal: SignalRecord = {
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
        await this.store.putSignal(followerSignal);
        entries.push({
          user: principal,
          accountId: account.accountId,
          signal: followerSignal,
          contractType: resolveContractType({ ...input.signal, contractFamily: input.signal.contractFamily }),
          contractFamily: input.signal.contractFamily,
          stake: input.stake,
          basis: input.basis,
          currency: account.currency ?? input.currency,
          parameters: input.parameters,
          idempotencyKey: `copy:${input.masterIntentId}:${account.accountId}`,
          asCopy: true,
          accessToken
        });
      }
    }

    // Coordinated bulk: proposals for all accounts in parallel, then all buys
    // fire simultaneously.
    const results = await this.gateway.bulkExecute(entries);

    const outcomes: CopyOutcome[] = [...skipped];
    for (const r of results) {
      outcomes.push({
        followerId: '',
        accountId: r.accountId,
        outcome: r.outcome as CopyOutcomeKind,
        reason: r.reason,
        intentId: r.intentId,
        contractId: r.contractId,
        buy: r.buy ?? null
      });
      if (r.outcome === 'copied' && r.contractId !== null) {
        await this.auditor.record({
          userId: `copy_follower_${r.accountId}`,
          action: 'execution.copy',
          outcome: 'allowed',
          accountId: r.accountId,
          intentId: r.intentId ?? null,
          detail: { followerId: '', masterUserId: input.master.id, masterIntentId: input.masterIntentId, signalId: input.signal.id, contractId: r.contractId }
        });
      } else if (r.outcome !== 'copied') {
        await this.auditor.record({
          userId: `copy_follower_${r.accountId}`,
          action: 'execution.copy',
          outcome: 'denied',
          accountId: r.accountId,
          intentId: r.intentId ?? null,
          detail: { followerId: '', masterUserId: input.master.id, masterIntentId: input.masterIntentId, reason: r.reason }
        });
      }
    }
    return outcomes;
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
      contractId: null,
      buy: null
    };
  }
}
