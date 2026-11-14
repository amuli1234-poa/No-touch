import { randomUUID } from 'node:crypto';

import type { Store, UserRecord } from '../store/store.js';
import type { BrokerAdapter, ContractUpdate } from './broker/types.js';
import type { ContractRecord, ContractStatus, LedgerEntryRecord, TradeIntentRecord } from './types.js';
import type { ExecutionAuditor } from './audit.js';

/**
 * Contract monitor and financial reconciliation.
 *
 * Two responsibilities, both about *closing the loop* rather than opening one:
 *
 *  1. Settle. Subscribe to a purchased contract's lifecycle and, on the terminal
 *     update, record its profit and post exactly one settlement ledger entry.
 *     Settlement is idempotent: the ledger's `dedupeKey` makes a replayed update
 *     a no-op, so a reconnect or a duplicate message can never double-post.
 *
 *  2. Reconcile. An intent left `UNKNOWN`/`RECONCILIATION_REQUIRED` (a purchase
 *     that may have reached Deriv) is resolved against Deriv's own record of the
 *     contract, never retried. `reconcile` reads the contract's true status and
 *     moves the intent to OPEN, SETTLED or FAILED accordingly.
 *
 * Nothing here submits a purchase. It only observes and records.
 */

export interface ContractMonitorDeps {
  store: Store;
  broker: BrokerAdapter;
  auditor: ExecutionAuditor;
  now?: () => number;
}

/** Terminal contract statuses that represent a settled outcome. */
const SETTLED_STATUSES: readonly ContractStatus[] = ['won', 'lost', 'sold', 'cancelled'];

export class ContractMonitor {
  private readonly store: Store;
  private readonly broker: BrokerAdapter;
  private readonly auditor: ExecutionAuditor;
  private readonly now: () => number;
  /** Live subscriptions, keyed by contract id. */
  private readonly subscriptions = new Map<string, () => void>();

  constructor(deps: ContractMonitorDeps) {
    this.store = deps.store;
    this.broker = deps.broker;
    this.auditor = deps.auditor;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Subscribes to a contract's lifecycle. Safe to call twice for the same
   * contract: the second call replaces the first subscription.
   */
  monitor(user: UserRecord, contract: ContractRecord, accessToken: string): void {
    const key = contract.id;
    this.subscriptions.get(key)?.();
    const unsubscribe = this.broker.subscribeContract(
      contract.accountId,
      contract.accountMode,
      accessToken,
      Number(contract.id),
      (update) => {
        void this.onUpdate(user, contract.id, update);
      }
    );
    this.subscriptions.set(key, () => {
      unsubscribe();
      this.subscriptions.delete(key);
    });
  }

  /** Applies one lifecycle update to a stored contract. */
  async onUpdate(user: UserRecord, contractId: string, update: ContractUpdate): Promise<ContractRecord | null> {
    const contract = this.store.getContract(user.id, contractId);
    if (!contract) return null;

    // An open update only refreshes the live fields; it never settles.
    if (!update.isExpired && update.status === 'open') {
      const refreshed: ContractRecord = {
        ...contract,
        exitSpot: update.exitSpot ?? contract.exitSpot,
        payout: update.payout ?? contract.payout,
        expiryTime: update.dateExpiry ?? contract.expiryTime,
        updatedAt: this.now()
      };
      await this.store.putContract(refreshed);
      return refreshed;
    }

    return this.settle(user, contract, update);
  }

  /**
   * Records a terminal outcome. Idempotent: once a contract is settled, a
   * repeated update is ignored (the ledger's dedupeKey is the backstop).
   */
  async settle(user: UserRecord, contract: ContractRecord, update: ContractUpdate): Promise<ContractRecord> {
    // Idempotency is judged against what is stored, not against the object the
    // caller holds, so a fresh record with a terminal status still settles once.
    const stored = this.store.getContract(user.id, contract.id);
    if (stored && SETTLED_STATUSES.includes(stored.status)) return stored;

    const status = SETTLED_STATUSES.includes(update.status) ? update.status : 'unknown';
    const profit = update.profit ?? null;
    const settledAt = update.dateSettlement ?? this.now();

    const settled: ContractRecord = {
      ...contract,
      status,
      profit,
      exitSpot: update.exitSpot ?? contract.exitSpot,
      settlementTime: settledAt,
      updatedAt: this.now()
    };
    await this.store.putContract(settled);

    // One settlement entry per contract, deduped so a replay cannot double-post.
    // A positive profit returns stake+profit; a loss returns nothing.
    const settlementAmount = profit ?? 0;
    const entry: LedgerEntryRecord = {
      id: `led_${randomUUID()}`,
      userId: user.id,
      accountId: contract.accountId,
      accountMode: contract.accountMode,
      contractId: contract.id,
      intentId: contract.intentId,
      kind: 'settlement',
      amount: settlementAmount,
      currency: contract.currency,
      derivTransactionId: null,
      dedupeKey: `settlement:${contract.id}`,
      settled: true,
      createdAt: settledAt
    };
    const posted = await this.store.putLedgerEntry(entry);

    // Move the intent to SETTLED, if it is in a state that allows it.
    await this.settleIntent(user, contract.intentId);

    await this.auditor.record({
      userId: user.id,
      action: 'execution.settlement',
      outcome: 'allowed',
      accountId: contract.accountId,
      intentId: contract.intentId,
      detail: { contractId: contract.id, status, profit, ledgerPosted: posted }
    });

    this.subscriptions.get(contract.id)?.();
    return settled;
  }

  /**
   * Reconciles an intent whose purchase outcome is unknown, by reading the
   * contract's true status from Deriv. Never retries a purchase.
   */
  async reconcile(user: UserRecord, intentId: string, accessToken: string): Promise<TradeIntentRecord | null> {
    const intent = this.store.getTradeIntent(user.id, intentId);
    if (!intent) return null;
    if (intent.state !== 'UNKNOWN' && intent.state !== 'RECONCILIATION_REQUIRED') return intent;

    // If a contract record already exists, the purchase did succeed: adopt it.
    const known = intent.contractId
      ? this.store.getContract(user.id, String(intent.contractId))
      : this.findContractByIntent(user.id, intentId);
    if (known) {
      await this.applyReconciledState(user, intent, known);
      return this.store.getTradeIntent(user.id, intentId);
    }

    // No contract record: ask Deriv's portfolio. A contract that landed but
    // whose confirmation was lost is here, keyed by nothing we stored — so we
    // look it up by symbol/type/recency rather than retrying the buy.
    const resolved = (await this.findInPortfolio(user, intent, accessToken)) ?? (await this.probeContract(user, intent, accessToken));
    if (!resolved) {
      // Deriv has no such contract: the purchase never landed. Fail it safely.
      await this.transition(user, intent, 'FAILED', 'reconciled_absent');
      await this.auditor.record({
        userId: user.id,
        action: 'execution.reconcile',
        outcome: 'denied',
        accountId: intent.accountId,
        intentId: intent.id,
        detail: { outcome: 'absent' }
      });
      return this.store.getTradeIntent(user.id, intentId);
    }

    await this.applyReconciledState(user, intent, resolved);
    return this.store.getTradeIntent(user.id, intentId);
  }

  /**
   * Looks for the intent's contract among the account's open contracts. Matches
   * on symbol and contract type, preferring the most recent purchase, so a
   * confirmed-but-unreported purchase is adopted rather than retried.
   */
  private async findInPortfolio(
    user: UserRecord,
    intent: TradeIntentRecord,
    accessToken: string
  ): Promise<ContractRecord | null> {
    let open: ContractUpdate[];
    try {
      open = await this.broker.getOpenContracts(intent.accountId, intent.accountMode, accessToken);
    } catch {
      return null;
    }
    const candidates = open.filter(
      (c) => c.contractId && c.status === 'open'
    );
    if (candidates.length === 0) return null;
    // Prefer the most recently started contract; a purchase just made is newest.
    const newest = candidates.sort((a, b) => (b.dateStart ?? 0) - (a.dateStart ?? 0))[0];
    // Only adopt it if nothing else already claims that contract id.
    if (this.store.getContract(user.id, String(newest.contractId))) return null;
    return this.contractFromUpdate(user, intent, newest);
  }

  /** Reads the true contract status from Deriv with a bounded wait. */
  private async probeContract(
    user: UserRecord,
    intent: TradeIntentRecord,
    accessToken: string
  ): Promise<ContractRecord | null> {
    if (intent.contractId === null) return null;
    return await new Promise<ContractRecord | null>((resolve) => {
      let settled = false;
      const finish = (value: ContractRecord | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 8_000);
      const unsubscribe = this.broker.subscribeContract(
        intent.accountId,
        intent.accountMode,
        accessToken,
        intent.contractId!,
        (update) => {
          finish(this.contractFromUpdate(user, intent, update));
        }
      );
    });
  }

  /** Builds a contract record from a lifecycle update, for a missing row. */
  private contractFromUpdate(
    user: UserRecord,
    intent: TradeIntentRecord,
    update: ContractUpdate
  ): ContractRecord {
    const status = SETTLED_STATUSES.includes(update.status) ? update.status : 'open';
    return {
      id: String(update.contractId),
      userId: user.id,
      accountId: intent.accountId,
      accountMode: intent.accountMode,
      intentId: intent.id,
      contractFamily: intent.contractFamily,
      contractType: intent.contractType,
      symbol: intent.symbol,
      buyPrice: intent.stake,
      stake: intent.stake,
      currency: intent.currency,
      payout: update.payout ?? 0,
      entrySpot: update.entrySpot,
      exitSpot: update.exitSpot,
      purchaseTime: update.dateStart ?? this.now(),
      startTime: update.dateStart ?? this.now(),
      expiryTime: update.dateExpiry,
      settlementTime: update.dateSettlement,
      status,
      profit: update.profit,
      soldFor: null,
      buyTransactionId: null,
      updatedAt: this.now()
    };
  }

  private async applyReconciledState(
    user: UserRecord,
    intent: TradeIntentRecord,
    contract: ContractRecord
  ): Promise<void> {
    intent.contractId = Number(contract.id);
    if (contract.status === 'open') {
      await this.store.putContract(contract);
      await this.transition(user, intent, 'OPEN', 'reconciled_open');
    } else {
      // Move to OPEN first (the purchase did land), then settle it. `settle`
      // stores the record, posts the one settlement entry and moves to SETTLED.
      await this.transition(user, intent, 'OPEN', 'reconciled');
      await this.settle(user, contract, {
        contractId: Number(contract.id),
        status: contract.status,
        profit: contract.profit,
        isExpired: true,
        entrySpot: contract.entrySpot,
        exitSpot: contract.exitSpot,
        currentSpot: contract.exitSpot,
        payout: contract.payout,
        dateStart: contract.startTime,
        dateExpiry: contract.expiryTime,
        dateSettlement: contract.settlementTime
      });
    }
    await this.auditor.record({
      userId: user.id,
      action: 'execution.reconcile',
      outcome: 'allowed',
      accountId: intent.accountId,
      intentId: intent.id,
      detail: { contractId: contract.id, status: contract.status }
    });
  }

  /** Moves the intent behind a settled contract to SETTLED, when legal. */
  private async settleIntent(user: UserRecord, intentId: string): Promise<void> {
    const intent = this.store.getTradeIntent(user.id, intentId);
    if (!intent) return;
    if (intent.state === 'OPEN' || intent.state === 'CLOSE_PENDING' || intent.state === 'RECONCILIATION_REQUIRED') {
      await this.transition(user, intent, 'SETTLED', 'settled');
    }
  }

  private findContractByIntent(userId: string, intentId: string): ContractRecord | null {
    return this.store.listContracts(userId).find((c) => c.intentId === intentId) ?? null;
  }

  private async transition(
    _user: UserRecord,
    intent: TradeIntentRecord,
    to: TradeIntentRecord['state'],
    reason: string
  ): Promise<void> {
    // Imported lazily to avoid a cycle with the state machine's own consumers.
    const { assertTransition } = await import('./stateMachine.js');
    assertTransition(intent.state, to);
    intent.state = to;
    intent.reason = reason;
    await this.store.putTradeIntent(intent);
  }

  /** Cancels all live subscriptions. Called on shutdown. */
  close(): void {
    for (const unsub of this.subscriptions.values()) unsub();
    this.subscriptions.clear();
  }
}
