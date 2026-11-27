import type {
  BrokerAdapter,
  ProposalRequest,
  ProposalResult,
  BuyRequest,
  BuyResult,
  SellRequest,
  SellResult,
  ContractUpdate
} from './types.js';
import { BrokerError } from './types.js';
import type { AccountMode, ContractStatus } from '../types.js';

/**
 * Deterministic in-memory broker. TESTS ONLY.
 *
 * It lets the execution gateway's safety logic — kill switches, risk gating,
 * idempotency, uncertain-outcome handling, locks — be exercised without a live
 * Deriv account or any network. It is deliberately scriptable so a test can
 * force a rejection, a timeout or an uncertain outcome and prove the gateway
 * responds correctly.
 */

export interface FakeBrokerScript {
  /** Ask price returned by a proposal. */
  askPrice?: number;
  payout?: number;
  spot?: number;
  /** When set, `requestProposal` throws this. */
  proposalError?: BrokerError;
  /** When set, `buy` throws this. */
  buyError?: BrokerError;
  /** When set, `sell` throws this. */
  sellError?: BrokerError;
  /** sold_for reported by a successful sale. */
  soldFor?: number | null;
  /** balanceAfter reported by a successful buy. */
  balanceAfter?: number;
  /** Open contracts the fake reports, for reconciliation tests. */
  openContracts?: ContractUpdate[];
}

export class FakeBroker implements BrokerAdapter {
  readonly kind = 'fake' as const;

  private script: FakeBrokerScript;
  private balance: number;
  private nextContractId = 500_000;
  private nextTransactionId = 900_000;

  /** Every proposal/buy the gateway sent, in order, for assertions. */
  readonly proposals: ProposalRequest[] = [];
  readonly buys: BuyRequest[] = [];
  readonly sells: SellRequest[] = [];

  private readonly contractHandlers = new Map<number, Set<(u: ContractUpdate) => void>>();

  constructor(options: { balance?: number; script?: FakeBrokerScript } = {}) {
    this.balance = options.balance ?? 10_000;
    this.script = options.script ?? {};
  }

  setScript(script: FakeBrokerScript): void {
    this.script = script;
  }

  async requestProposal(req: ProposalRequest): Promise<ProposalResult> {
    this.proposals.push(req);
    if (this.script.proposalError) throw this.script.proposalError;
    const spot = this.script.spot ?? 100;
    return {
      proposalId: `fake_prop_${this.proposals.length}`,
      askPrice: this.script.askPrice ?? req.payload.amount,
      payout: this.script.payout ?? req.payload.amount * 1.95,
      spot,
      dateStart: Math.floor(Date.now() / 1000),
      longcode: `Fake ${req.payload.contract_type} on ${req.payload.underlying_symbol}`
    };
  }

  async buy(req: BuyRequest): Promise<BuyResult> {
    this.buys.push(req);
    if (this.script.buyError) throw this.script.buyError;
    const contractId = this.nextContractId++;
    const transactionId = this.nextTransactionId++;
    const balanceAfter = this.script.balanceAfter ?? this.balance - req.price;
    return {
      contractId,
      buyPrice: req.price,
      balanceAfter,
      payout: req.price * 1.95,
      purchaseTime: Math.floor(Date.now() / 1000),
      startTime: Math.floor(Date.now() / 1000),
      transactionId,
      longcode: 'Fake contract',
      shortcode: 'FAKE'
    };
  }

  async sell(req: SellRequest): Promise<SellResult> {
    this.sells.push(req);
    if (this.script.sellError) throw this.script.sellError;
    return {
      contractId: req.contractId,
      soldFor: this.script.soldFor ?? 1.5,
      balanceAfter: this.balance,
      transactionId: this.nextTransactionId++
    };
  }

  subscribeContract(
    _accountId: string,
    _accountMode: AccountMode,
    _accessToken: string,
    contractId: number,
    onUpdate: (u: ContractUpdate) => void
  ): () => void {
    let set = this.contractHandlers.get(contractId);
    if (!set) {
      set = new Set();
      this.contractHandlers.set(contractId, set);
    }
    set.add(onUpdate);
    return () => set!.delete(onUpdate);
  }

  /** Test helper: pushes a lifecycle update to a contract's subscribers. */
  async emitContract(contractId: number, status: ContractStatus, profit: number | null): Promise<void> {
    const update: ContractUpdate = {
      contractId,
      status,
      profit,
      isExpired: status !== 'open',
      entrySpot: 100,
      exitSpot: status === 'open' ? null : 101,
      currentSpot: 101,
      payout: 1.95,
      dateStart: Math.floor(Date.now() / 1000) - 60,
      dateExpiry: Math.floor(Date.now() / 1000),
      dateSettlement: status === 'open' ? null : Math.floor(Date.now() / 1000)
    };
    for (const h of this.contractHandlers.get(contractId) ?? []) await h(update);
  }

  async getBalance(): Promise<number> {
    return this.balance;
  }

  /**
   * Contracts the fake considers open. A test may seed `script.openContracts`
   * to simulate "Deriv has this contract even though the buy response was lost".
   */
  async getOpenContracts(): Promise<ContractUpdate[]> {
    return this.script.openContracts ?? [];
  }

  /**
   * One-shot read of a single contract by id. A test seeds `script.openContracts`
   * with the contract (any status, open or settled) to simulate Deriv knowing it.
   */
  async getContract(
    _accountId: string,
    _accountMode: AccountMode,
    _accessToken: string,
    contractId: number
  ): Promise<ContractUpdate | null> {
    return this.script.openContracts?.find(c => c.contractId === contractId) ?? null;
  }

  close(): void {
    this.contractHandlers.clear();
  }

  /** Test helper: the exact set of contract ids handed out so far. */
  issuedContractIds(): number[] {
    return this.buys.map((_b, i) => 500_000 + i);
  }
}

/** Convenience: an uncertain-outcome error, as a timeout after submission. */
export function uncertainBuyError(): BrokerError {
  return new BrokerError('timeout', 'No confirmation received after submission.', true);
}
