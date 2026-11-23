import type { AccountMode, DerivContractType, ContractStatus } from '../types.js';

/**
 * Broker abstraction.
 *
 * The execution gateway talks to Deriv only through this interface. Two
 * implementations exist:
 *
 *  - `DerivBroker` — the real adapter, using the documented OTP-URL WebSocket
 *    flow against `api.derivws.com`.
 *  - `FakeBroker`  — a deterministic in-memory double, used ONLY by tests, so
 *    the gateway's safety logic can be exercised without a live account.
 *
 * Nothing outside `server/execution/` may import a broker directly. The gateway
 * is the single caller, so every purchase in the system flows through one place.
 */

/**
 * The exact `proposal` payload Deriv expects, built and validated by the
 * family adapter. Keeping this shape in one place means the broker never has to
 * know Rise/Fall from Multipliers rules.
 */
export interface ProposalPayload {
  amount: number;
  basis: 'stake' | 'payout';
  contract_type: DerivContractType;
  currency: string;
  underlying_symbol: string;
  duration?: number;
  duration_unit?: string;
  multiplier?: number;
  cancellation?: string;
  /**
   * Barrier. For `DIGIT*` contracts this is the predicted digit (a number); for
   * `higher_lower` and `touch_no_touch` it is a price offset (a string, as
   * Deriv expects, e.g. `+0.1234`).
   */
  barrier?: number | string;
  /** Growth rate for `ACCU`. */
  growth_rate?: number;
  limit_order?: { stop_loss?: number; take_profit?: number };
}

export interface ProposalRequest {
  accountId: string;
  /** The account-scoped Deriv access token, resolved from the sealed store. */
  accessToken: string;
  accountMode: AccountMode;
  /** The validated, family-specific proposal payload. */
  payload: ProposalPayload;
  reqId: number;
  /** Keep the streaming proposal's socket open so its id can be bought. */
  retainForBuy?: boolean;
}

export interface ProposalResult {
  /** Per-connection id. Only a streaming proposal's id may be bought. */
  proposalId: string;
  askPrice: number;
  payout: number;
  spot: number;
  dateStart: number;
  longcode: string;
}

export interface BuyRequest {
  accountId: string;
  /** The account-scoped Deriv access token, resolved from the sealed store. */
  accessToken: string;
  accountMode: AccountMode;
  proposalId: string;
  /** Maximum price to pay. */
  price: number;
  reqId: number;
}

export interface BuyResult {
  contractId: number;
  buyPrice: number;
  balanceAfter: number;
  payout: number;
  purchaseTime: number;
  startTime: number;
  transactionId: number;
  longcode: string;
  shortcode: string;
}

export interface SellRequest {
  accountId: string;
  accessToken: string;
  accountMode: AccountMode;
  contractId: number;
  /** Zero means sell at the current market price. */
  price: 0;
  reqId: number;
}

export interface SellResult {
  contractId: number;
  soldFor: number | null;
  balanceAfter: number | null;
  transactionId: number | null;
}

export interface ContractUpdate {
  contractId: number;
  status: ContractStatus;
  profit: number | null;
  isExpired: boolean;
  entrySpot: number | null;
  exitSpot: number | null;
  currentSpot: number | null;
  payout: number | null;
  dateStart: number | null;
  dateExpiry: number | null;
  dateSettlement: number | null;
  soldFor?: number | null;
  derivTransactionId?: number | null;
  /**
   * The price Deriv would pay to close this contract right now, and whether it
   * would accept a sale at all.
   *
   * `sell_price` and `check_sell` are defined in terms of these two values, so
   * they must survive the mapping from the Deriv payload. `undefined` means the
   * update did not carry the field — never treat that as "not sellable", which
   * would silently refuse every sale.
   */
  bidPrice?: number | null;
  isValidToSell?: boolean | null;
}

export type BrokerErrorCode =
  | 'otp_failed'
  | 'socket_failed'
  | 'rejected'
  | 'timeout'
  | 'unknown'
  | 'not_connected';

/**
 * A broker failure. `uncertain` is the critical field: it is true when the
 * request may have reached Deriv but no confirmed response came back (a timeout
 * or a dropped socket). An uncertain purchase must never be blindly retried.
 */
export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly uncertain: boolean;
  readonly derivCode: string | null;
  constructor(code: BrokerErrorCode, message: string, uncertain = false, derivCode: string | null = null) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.uncertain = uncertain;
    this.derivCode = derivCode;
  }
}

export interface BrokerAdapter {
  /** Identifies the implementation, for audit and diagnostics. */
  readonly kind: 'deriv' | 'fake';

  requestProposal(req: ProposalRequest): Promise<ProposalResult>;

  buy(req: BuyRequest): Promise<BuyResult>;

  sell(req: SellRequest): Promise<SellResult>;

  /**
   * Subscribes to a contract's lifecycle updates. Returns an unsubscribe
   * function. Used by the contract monitor (Phase 8).
   */
  subscribeContract(
    accountId: string,
    accountMode: AccountMode,
    accessToken: string,
    contractId: number,
    onUpdate: (update: ContractUpdate) => void
  ): () => void;

  /** Current balance for an account, used by the risk engine. */
  getBalance(accountId: string, accountMode: AccountMode, accessToken: string): Promise<number>;

  /**
   * The account's currently open contracts. Used to reconcile a purchase whose
   * confirmation was lost: the contract exists on Deriv even though we never
   * received its id, so we look it up rather than retry.
   */
  getOpenContracts(
    accountId: string,
    accountMode: AccountMode,
    accessToken: string
  ): Promise<ContractUpdate[]>;

  /** Releases all sockets. Called on shutdown. */
  close(): void;
}
