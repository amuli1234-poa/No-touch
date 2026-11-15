/**
 * Durable records for the trading domain.
 *
 * Every record that belongs to a customer carries `userId`, derived from the
 * verified session — never from a request body. Ownership is therefore a
 * property of the stored row, and every accessor in the store is scoped by it.
 *
 * Nothing here submits a purchase. These are the records the execution gateway
 * (Phase 6) will operate on; this phase only defines and isolates them.
 */

/* ------------------------------ account mode ------------------------------ */

export type AccountMode = 'demo' | 'real';

/** Contract families the platform supports. */
export type ContractFamily = 'rise_fall' | 'multipliers';

/**
 * Deriv contract types, verified against the live `contracts_for` catalogue.
 * Rise/Fall is CALL/PUT; Multipliers is MULTUP/MULTDOWN. The brief's
 * "RISE"/"FALL"/"MULT" names do not exist in the API.
 */
export type DerivContractType = 'CALL' | 'PUT' | 'MULTUP' | 'MULTDOWN';

export const CONTRACT_FAMILY_TYPES: Record<ContractFamily, readonly DerivContractType[]> = {
  rise_fall: ['CALL', 'PUT'],
  multipliers: ['MULTUP', 'MULTDOWN']
};

/* --------------------------- execution preferences ------------------------ */

export type ExecutionMode = 'manual' | 'automatic';

/**
 * A customer's execution preferences. This record expresses intent only; it can
 * never grant authority. The gateway re-derives every permission from the
 * session, the account record and the server-side flags on each request.
 */
export interface ExecutionPreferencesRecord {
  userId: string;
  /** Manual approval or fully automatic. Hybrid = the customer may switch. */
  mode: ExecutionMode;
  /** Contract family the customer has chosen. */
  contractFamily: ContractFamily;
  /** Preferred account per mode. Must be an account the user owns. */
  preferredAccountId: Partial<Record<AccountMode, string>>;
  /** Stake sizing configuration (used to *propose*, never to force, a stake). */
  stake: {
    basis: 'stake' | 'payout';
    /** Fixed amount per trade. No martingale, so no escalation field exists. */
    amount: number;
    currency: string | null;
  };
  /** Contract parameters, validated server-side against the live catalogue. */
  parameters: {
    duration: number;
    durationUnit: 's' | 'm' | 'h' | 'd' | 't';
    multiplier: number | null;
    cancellation: string | null;
    stopLoss: number | null;
    takeProfit: number | null;
  };
  /**
   * The customer's explicit authorisation to trade their REAL account. Defaults
   * to false and can only ever be set to true by the customer, on a real
   * account they own. Even then, REAL execution stays off until the global
   * release flag is deliberately enabled.
   */
  realExecutionAuthorised: boolean;
  /** Emergency stop. When true, automatic execution must not run. */
  autoStopped: boolean;
  updatedAt: number;
}

/* ------------------------------- risk profile ----------------------------- */

/**
 * Server-enforced risk limits. Defaults are deliberately conservative and there
 * is no field for loss-based stake escalation (no martingale).
 */
export interface RiskProfileRecord {
  userId: string;
  maxStake: number;
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  maxOpenContracts: number;
  maxTradesPerSession: number;
  /** Maximum total exposure (sum of open stakes). */
  maxAccountExposure: number;
  /** Trading pauses if the balance would drop below this. */
  minAvailableBalance: number;
  /** Minimum seconds between two executions for this user. */
  maxExecutionFrequencySeconds: number;
  /** A signal older than this may not be executed. */
  signalFreshnessSeconds: number;
  updatedAt: number;
}

/**
 * Conservative defaults, raised for the Trade panel.
 *
 * These are the caps a customer starts with; they are still hard limits the
 * risk engine enforces on every purchase, and REAL execution remains behind its
 * own kill switch regardless. The figures support the documented ticket —
 * a $20 stake with a ~$38 payout — and a scanner that watches several markets:
 *
 *  - `maxStake` 25          allows the $20 example with headroom.
 *  - `maxOpenContracts` 10  enough to hold a position per watched market.
 *  - `maxAccountExposure` 200  ten stakes at the cap cannot exceed this.
 *  - `maxExecutionFrequencySeconds` 3  a burst throttle; still not free rein.
 *
 * There is still no martingale: no limit can be raised automatically after a
 * loss, and there is deliberately no stake-escalation field.
 */
export const DEFAULT_RISK_PROFILE: Omit<RiskProfileRecord, 'userId' | 'updatedAt'> = {
  maxStake: 25,
  maxDailyLoss: 100,
  maxConsecutiveLosses: 3,
  maxOpenContracts: 10,
  maxTradesPerSession: 200,
  maxAccountExposure: 200,
  minAvailableBalance: 5,
  maxExecutionFrequencySeconds: 3,
  signalFreshnessSeconds: 60
};

/* --------------------------------- signals -------------------------------- */

export type SignalDirection = 'RISE' | 'FALL' | 'NONE';

/** A validated signal. Unique id; carries an expiry so it cannot be replayed. */
export interface SignalRecord {
  id: string;
  userId: string;
  accountId: string;
  accountMode: AccountMode;
  symbol: string;
  timeframe: string;
  direction: SignalDirection;
  contractFamily: ContractFamily;
  /** The engine analysis this signal derives from. */
  analysisId: string;
  /** Zone/entry the strategy validated, when one exists. */
  zone: { low: number; high: number } | null;
  entryPrice: number | null;
  confidence: number | null;
  reason: string;
  createdAt: number;
  expiresAt: number;
  /** Set once a trade intent references this signal, to prevent reuse. */
  consumedByIntentId: string | null;
}

/* ------------------------------ trade intents ----------------------------- */

/**
 * The durable execution state machine. Every intent moves through these states;
 * every transition is recorded. `UNKNOWN`/`RECONCILIATION_REQUIRED` exist so a
 * network timeout after submission is never blindly retried.
 */
export const INTENT_STATES = [
  'CREATED',
  'VALIDATING',
  'RISK_APPROVED',
  'PROPOSAL_REQUESTED',
  'PROPOSAL_VALIDATED',
  'PURCHASE_PENDING',
  'OPEN',
  'CLOSE_PENDING',
  'SETTLED',
  'REJECTED',
  'FAILED',
  'UNKNOWN',
  'RECONCILIATION_REQUIRED'
] as const;

export type IntentState = (typeof INTENT_STATES)[number];

/** Terminal states: no further transitions are permitted. */
export const TERMINAL_INTENT_STATES: readonly IntentState[] = ['SETTLED', 'REJECTED', 'FAILED'];

export interface TradeIntentRecord {
  id: string;
  userId: string;
  accountId: string;
  accountMode: AccountMode;
  contractFamily: ContractFamily;
  contractType: DerivContractType;
  symbol: string;
  timeframe: string;
  /** Exact signal this intent was created from. */
  signalId: string;
  /** Set when a human approved a manual intent; null for automatic. */
  approvedBy: 'customer' | null;
  approvedAt: number | null;
  /** Approval expiry for manual mode; an expired approval is not executable. */
  approvalExpiresAt: number | null;
  /** Stake/basis actually submitted, frozen at validation time. */
  stake: number;
  basis: 'stake' | 'payout';
  currency: string;
  /** Contract parameters submitted, frozen at validation time. */
  parameters: {
    duration: number;
    durationUnit: string;
    multiplier: number | null;
    cancellation: string | null;
    stopLoss: number | null;
    takeProfit: number | null;
  };
  state: IntentState;
  /** Deriv contract id, once the purchase succeeded. */
  contractId: number | null;
  /** Human-readable rejection/failure reason, when applicable. */
  reason: string | null;
  /** Idempotency key: a duplicate submission with the same key is a no-op. */
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}

/* --------------------------- execution attempts --------------------------- */

/**
 * One submission attempt. Kept separate from the intent so a purchase that
 * timed out is provably recorded as uncertain, not silently retried.
 */
export interface ExecutionAttemptRecord {
  id: string;
  intentId: string;
  userId: string;
  /** Monotonic per intent, so duplicate attempts are detectable. */
  attemptNumber: number;
  phase: 'proposal' | 'purchase' | 'close';
  outcome: 'ok' | 'rejected' | 'timeout' | 'unknown' | 'error';
  /** Deriv request id, when one was sent. */
  reqId: number | null;
  /** Redacted request summary — never a token, never a full credential. */
  requestSummary: Record<string, unknown>;
  /** Redacted response summary. */
  responseSummary: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number;
}

/* -------------------------------- contracts ------------------------------- */

export type ContractStatus = 'open' | 'sold' | 'won' | 'lost' | 'cancelled' | 'unknown';

/** A Deriv contract the customer owns, tracked to settlement. */
export interface ContractRecord {
  /** Deriv contract id (as a string; Deriv returns an integer). */
  id: string;
  userId: string;
  accountId: string;
  accountMode: AccountMode;
  intentId: string;
  contractFamily: ContractFamily;
  contractType: DerivContractType;
  symbol: string;
  buyPrice: number;
  stake: number;
  currency: string;
  payout: number;
  entrySpot: number | null;
  exitSpot: number | null;
  purchaseTime: number;
  startTime: number;
  expiryTime: number | null;
  settlementTime: number | null;
  status: ContractStatus;
  /** Latest profit/loss reported by Deriv; null when unavailable. */
  profit: number | null;
  soldFor: number | null;
  /** Deriv transaction id of the purchase, for reconciliation. */
  buyTransactionId: number | null;
  updatedAt: number;
}

/* --------------------------------- ledger --------------------------------- */

export type LedgerEntryKind = 'stake' | 'settlement' | 'fee' | 'adjustment';

/**
 * Append-style financial ledger. DEMO and REAL are separated by `accountMode`,
 * and every entry reconciles to a Deriv contract/transaction. Settled entries
 * are immutable: a correction is a new `adjustment` entry, never an edit.
 */
export interface LedgerEntryRecord {
  id: string;
  userId: string;
  accountId: string;
  accountMode: AccountMode;
  contractId: string | null;
  intentId: string | null;
  kind: LedgerEntryKind;
  /** Signed amount: negative for a stake, positive/negative for settlement. */
  amount: number;
  currency: string;
  /** Deriv transaction id this entry reconciles to, when applicable. */
  derivTransactionId: number | null;
  /** Deduplication key so a replayed settlement cannot double-post. */
  dedupeKey: string;
  /** True once the entry is confirmed against Deriv data and must not change. */
  settled: boolean;
  createdAt: number;
}

/* ------------------------------ notifications ----------------------------- */

export type NotificationKind =
  | 'trade_proposed'
  | 'trade_executed'
  | 'trade_rejected'
  | 'contract_settled'
  | 'risk_lockout'
  | 'account_unavailable'
  | 'emergency_stop';

export interface NotificationRecord {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Related records, for drill-down. */
  intentId: string | null;
  contractId: string | null;
  readAt: number | null;
  createdAt: number;
}

/* -------------------------------- audit ----------------------------------- */

/**
 * Append-only execution audit. Mirrors the admin audit contract: sensitive
 * values are redacted before they reach this record.
 */
export interface ExecutionAuditRecord {
  id: string;
  timestamp: number;
  /** The acting customer, or null for a system action. */
  userId: string | null;
  action: string;
  /** Outcome is explicit so a refused action is auditable, not invisible. */
  outcome: 'allowed' | 'denied' | 'error';
  accountId: string | null;
  intentId: string | null;
  detail: Record<string, unknown>;
}
