import { randomUUID } from 'node:crypto';

import type { Store, UserRecord } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import { open } from '../lib/crypto.js';
import type { ExecutionFlags } from '../config/flags.js';
import { executionPermitted } from '../config/flags.js';
import type {
  TradeIntentRecord,
  ContractRecord,
  DerivContractType,
  AccountMode,
  ContractFamily
} from './types.js';
import { resolveTradableAccountForUser, AccountAccessError } from './accountGuard.js';
import { assertTransition } from './stateMachine.js';
import { ExecutionLocks } from './locks.js';
import { adapterFor } from './adapters/index.js';
import { ExecutionAuditor } from './audit.js';
import type { BrokerAdapter, ProposalResult, BuyResult, ContractUpdate } from './broker/types.js';
import { BrokerError } from './broker/types.js';
import type { SignalRecord } from './types.js';

/**
 * The execution gateway.
 *
 * This is the ONLY component in the system permitted to submit a purchase. Every
 * other module produces analysis, signals, intents or records; none of them may
 * call a broker's `buy`. Keeping submission in one place is what makes the
 * guarantees below checkable.
 *
 * Guarantees enforced here, in order, on every purchase:
 *
 *  1. Kill switches. `ALLOW_EXECUTION` gates everything; DEMO needs
 *     `ALLOW_DEMO_EXECUTION`; REAL needs `ALLOW_REAL_EXECUTION`. All default off.
 *  2. Ownership and mode. The account is resolved from the session user's own
 *     records via the account guard — never from the request.
 *  3. Risk. The risk engine must approve before a proposal is requested.
 *  4. Single use. The driving signal must be unused; it is consumed atomically.
 *  5. Idempotency. A duplicate submission with the same key is a no-op.
 *  6. Serialisation. An account-level lock prevents two concurrent executions.
 *  7. Honest failure. A purchase that may have reached Deriv but was not
 *     confirmed is recorded `UNKNOWN` and moved to `RECONCILIATION_REQUIRED` —
 *     never retried blindly.
 *
 * The access token is read from the sealed session record and passed only to the
 * broker. It never appears in an intent, an audit detail or a return value.
 */

export type ExecutionRejectionCode =
  | 'execution_disabled'
  | 'account_not_authorized'
  | 'account_mode_mismatch'
  | 'account_mode_invalid'
  | 'account_unavailable'
  | 'token_expired'
  | 'signal_invalid'
  | 'signal_consumed'
  | 'risk_rejected'
  | 'duplicate'
  | 'illegal_transition'
  | 'lock_timeout'
  | 'broker_rejected'
  | 'broker_uncertain'
  | 'not_found'
  | 'not_authorized'
  | 'approval_expired';

export class ExecutionError extends Error {
  readonly code: ExecutionRejectionCode;
  readonly reasons: string[];
  constructor(code: ExecutionRejectionCode, message: string, reasons: string[] = []) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
    this.reasons = reasons;
  }
}

export interface CreateIntentInput {
  user: UserRecord;
  accountId: string;
  /** Optional client-asserted mode; rejected if it disagrees with the account. */
  accountMode?: AccountMode;
  signal: SignalRecord;
  contractType: DerivContractType;
  contractFamily: ContractFamily;
  stake: number;
  basis: 'stake' | 'payout';
  currency: string;
  parameters: TradeIntentRecord['parameters'];
  idempotencyKey: string;
  /** Manual intents require a customer approval that is still valid. */
  manualApproval?: { approvedAt: number; expiresAt: number };
}

export interface GatewayDeps {
  store: Store;
  cfg: ServerConfig;
  flags: ExecutionFlags;
  broker: BrokerAdapter;
  /**
   * Called after a contract is successfully opened, so the contract monitor can
   * subscribe to its lifecycle. Optional; a no-op in tests that do not monitor.
   */
  onContractOpened?: (user: UserRecord, contract: ContractRecord, accessToken: string) => void;
  /** Balance reader, used by the risk engine. Null when unavailable. */
  balanceProvider?: (user: UserRecord, accountId: string, accessToken: string) => Promise<number | null>;
  /** Risk evaluation, injected so the gateway does not hard-depend on it. */
  riskEvaluator: (
    user: UserRecord,
    accountId: string,
    stake: number,
    signal: SignalRecord,
    balance: number | null,
    now: number
  ) => { approved: boolean; reasons: string[] };
  locks?: ExecutionLocks;
  auditor?: ExecutionAuditor;
  now?: () => number;
}

export interface ExecutionResult {
  intent: TradeIntentRecord;
  contractId: number | null;
  buy: BuyResult | null;
}

export class ExecutionGateway {
  private readonly store: Store;
  private readonly cfg: ServerConfig;
  private readonly flags: ExecutionFlags;
  private readonly broker: BrokerAdapter;
  private readonly balanceProvider: GatewayDeps['balanceProvider'];
  private readonly riskEvaluator: GatewayDeps['riskEvaluator'];
  private readonly onContractOpened: GatewayDeps['onContractOpened'];
  private readonly locks: ExecutionLocks;
  private readonly auditor: ExecutionAuditor;
  private readonly now: () => number;

  constructor(deps: GatewayDeps) {
    this.store = deps.store;
    this.cfg = deps.cfg;
    this.flags = deps.flags;
    this.broker = deps.broker;
    this.balanceProvider = deps.balanceProvider;
    this.riskEvaluator = deps.riskEvaluator;
    this.onContractOpened = deps.onContractOpened;
    this.locks = deps.locks ?? new ExecutionLocks();
    this.auditor = deps.auditor ?? new ExecutionAuditor(deps.store, { now: deps.now });
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Creates and persists a trade intent in CREATED, without submitting anything.
   * The submission is a separate, explicit step (`submit`), so creating an
   * intent is never the same action as buying.
   */
  async createIntent(input: CreateIntentInput): Promise<TradeIntentRecord> {
    // Idempotency: an existing intent with this key is returned as-is.
    const existing = this.store.findTradeIntentByIdempotencyKey(input.user.id, input.idempotencyKey);
    if (existing) return existing;

    const now = this.now();
    const intent: TradeIntentRecord = {
      id: `int_${randomUUID()}`,
      userId: input.user.id,
      accountId: input.accountId,
      accountMode: input.signal.accountMode,
      contractFamily: input.contractFamily,
      contractType: input.contractType,
      symbol: input.signal.symbol,
      timeframe: input.signal.timeframe,
      signalId: input.signal.id,
      approvedBy: input.manualApproval ? 'customer' : null,
      approvedAt: input.manualApproval?.approvedAt ?? null,
      approvalExpiresAt: input.manualApproval?.expiresAt ?? null,
      stake: input.stake,
      basis: input.basis,
      currency: input.currency,
      parameters: input.parameters,
      state: 'CREATED',
      contractId: null,
      reason: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now
    };
    await this.store.putTradeIntent(intent);
    return intent;
  }

  /**
   * Submits a previously created intent. This is the single purchase path.
   * Resolves with the intent and, on success, the Deriv contract.
   */
  async submit(user: UserRecord, intentId: string, accessToken: string | null): Promise<ExecutionResult> {
    const now = this.now();

    // (1) Kill switches — evaluated before anything else, for the mode we will
    // resolve. The mode is taken from the stored intent/account, never the body.
    const intent = this.store.getTradeIntent(user.id, intentId);
    if (!intent) {
      await this.auditor.record({ userId: user.id, action: 'execution.submit', outcome: 'denied', detail: { reason: 'not_found', intentId } });
      throw new ExecutionError('not_found', 'Trade intent not found.');
    }

    const permitted = executionPermitted(this.flags, intent.accountMode);
    if (!permitted.permitted) {
      await this.transition(intent, 'REJECTED', permitted.reason ?? 'execution_disabled');
      await this.auditor.record({
        userId: user.id,
        action: 'execution.submit',
        outcome: 'denied',
        accountId: intent.accountId,
        intentId: intent.id,
        detail: { reason: permitted.reason }
      });
      throw new ExecutionError('execution_disabled', 'Execution is disabled.', [permitted.reason ?? 'execution_disabled']);
    }

    // (2) Ownership and mode, resolved from the user's own records.
    let account;
    try {
      account = resolveTradableAccountForUser(user, intent.accountId, intent.accountMode);
    } catch (err) {
      const code = err instanceof AccountAccessError ? (err.code as ExecutionRejectionCode) : 'account_not_authorized';
      await this.transition(intent, 'REJECTED', code);
      await this.auditor.record({
        userId: user.id,
        action: 'execution.submit',
        outcome: 'denied',
        accountId: intent.accountId,
        intentId: intent.id,
        detail: { reason: code }
      });
      throw new ExecutionError(code, 'Account is not authorized for this user.');
    }

    // REAL always requires the customer's explicit authorisation, independent of
    // the kill switch. A REAL intent without it is refused.
    if (account.mode === 'real') {
      const prefs = this.store.getExecutionPreferences(user.id);
      if (!prefs?.realExecutionAuthorised) {
        await this.transition(intent, 'REJECTED', 'real_not_authorised');
        await this.auditor.record({
          userId: user.id,
          action: 'execution.submit',
          outcome: 'denied',
          accountId: intent.accountId,
          intentId: intent.id,
          detail: { reason: 'real_not_authorised' }
        });
        throw new ExecutionError('not_authorized', 'REAL execution is not authorised.', ['real_not_authorised']);
      }
    }

    // Manual approval must still be valid.
    if (intent.approvedBy === 'customer') {
      if (intent.approvalExpiresAt !== null && intent.approvalExpiresAt <= now) {
        await this.transition(intent, 'REJECTED', 'approval_expired');
        await this.auditor.record({
          userId: user.id,
          action: 'execution.submit',
          outcome: 'denied',
          accountId: intent.accountId,
          intentId: intent.id,
          detail: { reason: 'approval_expired' }
        });
        throw new ExecutionError('approval_expired', 'The manual approval has expired.');
      }
    }

    // The access token comes from the caller's signed session, never the body.
    if (!accessToken) {
      await this.transition(intent, 'REJECTED', 'token_expired');
      await this.auditor.record({
        userId: user.id,
        action: 'execution.submit',
        outcome: 'denied',
        accountId: intent.accountId,
        intentId: intent.id,
        detail: { reason: 'token_expired' }
      });
      throw new ExecutionError('token_expired', 'The Deriv authorization has expired.');
    }

    // (6) Serialise on the account.
    try {
      return await this.locks.withLock(intent.accountId, () =>
        this.runLocked(user, intent, accessToken, now)
      );
    } catch (err) {
      if (err instanceof ExecutionError) throw err;
      throw err;
    }
  }

  /** The locked critical section: validate, propose, risk-check, buy. */
  private async runLocked(
    user: UserRecord,
    intent: TradeIntentRecord,
    accessToken: string,
    now: number
  ): Promise<ExecutionResult> {
    // (4) Signal must exist, belong to the user, be unused and unexpired.
    const signal = this.store.getSignal(user.id, intent.signalId);
    if (!signal) {
      await this.transition(intent, 'REJECTED', 'signal_invalid');
      throw new ExecutionError('signal_invalid', 'The signal is not available.');
    }
    if (signal.consumedByIntentId) {
      await this.transition(intent, 'REJECTED', 'signal_consumed');
      throw new ExecutionError('signal_consumed', 'The signal has already been used.');
    }
    if (signal.expiresAt <= now) {
      await this.transition(intent, 'REJECTED', 'signal_invalid');
      throw new ExecutionError('signal_invalid', 'The signal has expired.');
    }

    // VALIDATING
    await this.transition(intent, 'VALIDATING', null);

    // (3) Risk.
    let balance: number | null = null;
    if (this.balanceProvider) {
      try {
        balance = await this.balanceProvider(user, intent.accountId, accessToken);
      } catch {
        balance = null;
      }
    }
    const risk = this.riskEvaluator(user, intent.accountId, intent.stake, signal, balance, now);
    if (!risk.approved) {
      await this.transition(intent, 'REJECTED', `risk:${risk.reasons.join(',')}`);
      await this.auditor.record({
        userId: user.id,
        action: 'execution.risk',
        outcome: 'denied',
        accountId: intent.accountId,
        intentId: intent.id,
        detail: { reasons: risk.reasons, balance }
      });
      throw new ExecutionError('risk_rejected', 'The trade was rejected by risk controls.', risk.reasons);
    }
    await this.transition(intent, 'RISK_APPROVED', null);

    // Consume the signal now, atomically with the risk approval: after this
    // point the signal can never drive a second trade.
    await this.store.putSignal({ ...signal, consumedByIntentId: intent.id });

    // PROPOSAL_REQUESTED
    await this.transition(intent, 'PROPOSAL_REQUESTED', null);
    const reqId = 1;
    let proposal: ProposalResult;
    try {
      const payload = adapterFor(intent.contractFamily).buildProposal({
        directionContractType: intent.contractType,
        amount: intent.stake,
        basis: intent.basis,
        currency: intent.currency,
        symbol: intent.symbol,
        parameters: intent.parameters
      });
      proposal = await this.broker.requestProposal({
        accountId: intent.accountId,
        accessToken,
        accountMode: intent.accountMode,
        payload,
        reqId
      });
      await this.recordAttempt(intent, 'proposal', 'ok', reqId, null, null);
    } catch (err) {
      const uncertain = err instanceof BrokerError && err.uncertain;
      const state = uncertain ? 'UNKNOWN' : 'FAILED';
      await this.transition(intent, state as any, 'proposal_failed');
      if (uncertain) await this.transition(intent, 'RECONCILIATION_REQUIRED', 'proposal_uncertain');
      await this.recordAttempt(intent, 'proposal', uncertain ? 'unknown' : 'error', reqId, null, err);
      throw new ExecutionError(uncertain ? 'broker_uncertain' : 'broker_rejected', 'The proposal request failed.');
    }

    // Guard the returned price: never buy at an unbounded price.
    if (!Number.isFinite(proposal.askPrice) || proposal.askPrice <= 0) {
      await this.transition(intent, 'REJECTED', 'invalid_price');
      throw new ExecutionError('broker_rejected', 'Deriv returned an unusable proposal price.');
    }
    await this.transition(intent, 'PROPOSAL_VALIDATED', null);

    // PURCHASE_PENDING
    await this.transition(intent, 'PURCHASE_PENDING', null);
    const buyReqId = 2;
    let buy: BuyResult;
    try {
      buy = await this.broker.buy({
        accountId: intent.accountId,
        accessToken,
        accountMode: intent.accountMode,
        proposalId: proposal.proposalId,
        price: proposal.askPrice,
        reqId: buyReqId
      });
    } catch (err) {
      const uncertain = err instanceof BrokerError && err.uncertain;
      await this.recordAttempt(intent, 'purchase', uncertain ? 'unknown' : 'error', buyReqId, proposal.proposalId, err);
      // A purchase that may have reached Deriv must never be retried blindly.
      await this.transition(intent, uncertain ? 'UNKNOWN' : 'FAILED', uncertain ? 'purchase_uncertain' : 'purchase_failed');
      if (uncertain) {
        await this.transition(intent, 'RECONCILIATION_REQUIRED', 'purchase_uncertain');
        await this.auditor.record({
          userId: user.id,
          action: 'execution.purchase',
          outcome: 'error',
          accountId: intent.accountId,
          intentId: intent.id,
          detail: { reason: 'uncertain', proposalId: proposal.proposalId }
        });
        throw new ExecutionError('broker_uncertain', 'The purchase outcome is unknown and needs reconciliation.');
      }
      throw new ExecutionError('broker_rejected', 'The purchase was rejected by Deriv.');
    }

    await this.recordAttempt(intent, 'purchase', 'ok', buyReqId, proposal.proposalId, null);

    // Persist the contract and move to OPEN.
    const openedAt = this.now();
    await this.store.putContract({
      id: String(buy.contractId),
      userId: user.id,
      accountId: intent.accountId,
      accountMode: intent.accountMode,
      intentId: intent.id,
      contractFamily: intent.contractFamily,
      contractType: intent.contractType,
      symbol: intent.symbol,
      buyPrice: buy.buyPrice,
      stake: intent.stake,
      currency: intent.currency,
      payout: buy.payout,
      entrySpot: proposal.spot ?? null,
      exitSpot: null,
      purchaseTime: buy.purchaseTime,
      startTime: buy.startTime,
      expiryTime: null,
      settlementTime: null,
      status: 'open',
      profit: null,
      soldFor: null,
      buyTransactionId: buy.transactionId,
      updatedAt: openedAt
    });

    // Ledger: the stake leaves the account at purchase time.
    await this.store.putLedgerEntry({
      id: `led_${randomUUID()}`,
      userId: user.id,
      accountId: intent.accountId,
      accountMode: intent.accountMode,
      contractId: String(buy.contractId),
      intentId: intent.id,
      kind: 'stake',
      amount: -buy.buyPrice,
      currency: intent.currency,
      derivTransactionId: buy.transactionId,
      dedupeKey: `stake:${buy.transactionId}`,
      settled: true,
      createdAt: openedAt
    });

    intent.contractId = buy.contractId;
    await this.transition(intent, 'OPEN', null);
    // Hand the opened contract to the monitor so its lifecycle is tracked. A
    // failure here must not undo a purchase that has already happened.
    try {
      this.onContractOpened?.(user, this.store.getContract(user.id, String(buy.contractId))!, accessToken);
    } catch {
      /* monitoring is best-effort; the contract and ledger rows already exist */
    }
    await this.auditor.record({
      userId: user.id,
      action: 'execution.purchase',
      outcome: 'allowed',
      accountId: intent.accountId,
      intentId: intent.id,
      detail: { contractId: buy.contractId, transactionId: buy.transactionId, price: buy.buyPrice }
    });

    return { intent: this.store.getTradeIntent(user.id, intent.id)!, contractId: buy.contractId, buy };
  }

  /** Records one attempt with a redacted summary. Never stores a token. */
  private async recordAttempt(
    intent: TradeIntentRecord,
    phase: 'proposal' | 'purchase' | 'close',
    outcome: 'ok' | 'rejected' | 'timeout' | 'unknown' | 'error',
    reqId: number | null,
    proposalId: string | null,
    err: unknown
  ): Promise<void> {
    const attempts = this.store.listExecutionAttempts(intent.userId, intent.id);
    await this.store.putExecutionAttempt({
      id: `att_${randomUUID()}`,
      intentId: intent.id,
      userId: intent.userId,
      attemptNumber: attempts.length + 1,
      phase,
      outcome,
      reqId,
      requestSummary: {
        accountId: intent.accountId,
        symbol: intent.symbol,
        contractType: intent.contractType,
        stake: intent.stake,
        proposalId
      },
      responseSummary: null,
      errorCode: err instanceof BrokerError ? err.code : err instanceof Error ? err.name : null,
      errorMessage: err instanceof Error ? err.message : null,
      startedAt: this.now(),
      finishedAt: this.now()
    });
  }

  /** Applies a state transition, asserting it is legal first. */
  private async transition(intent: TradeIntentRecord, to: TradeIntentRecord['state'], reason: string | null): Promise<void> {
    assertTransition(intent.state, to);
    intent.state = to;
    intent.reason = reason;
    await this.store.putTradeIntent(intent);
  }

  /** Exposes the account lock state, for diagnostics. */
  isAccountLocked(accountId: string): boolean {
    return this.locks.isLocked(accountId);
  }
}
