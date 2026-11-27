import type { ContractRecord } from '../execution/types.js';
import type { Store } from '../store/store.js';
import { roundMoney } from './money.js';

/**
 * Immutable settlement adjustments.
 *
 * A corrected or reversed settlement NEVER overwrites the original contract or
 * its settlement ledger entry. It appends a separate, auditable adjustment
 * record; the effective profit is the original profit plus the sum of deltas.
 * Commission is recomputed from the effective profit, so a correction flows
 * through without rewriting history. Each adjustment is idempotent by
 * `adjustment:<contractId>:<key>`.
 */

export interface ContractAdjustmentRecord {
  id: string;
  contractId: string;
  ownerUserId: string;
  followerId: string | null;
  principal: string;
  /** Signed change to the contract's realised profit. */
  deltaProfit: number;
  currency: string;
  reason: string;
  /** Where the correction came from (e.g. 'deriv_reconciliation', 'admin'). */
  source: string;
  dedupeKey: string;
  createdAt: number;
}

export interface AdjustmentInput {
  contractId: string;
  deltaProfit: number;
  reason: string;
  source: string;
  /** Caller-supplied idempotency token; a repeat is a no-op. */
  key: string;
  now?: number;
}

export interface AdjustmentResult {
  applied: boolean;
  adjustment?: ContractAdjustmentRecord;
  effectiveProfit?: number;
}

function ownerOf(store: Store, contract: ContractRecord): { ownerUserId: string; followerId: string | null } {
  const principal = contract.userId;
  if (principal.startsWith('copy_follower_')) {
    const followerId = principal.slice('copy_follower_'.length);
    const follower = store.listAllCopyTradingFollowers().find((f) => f.id === followerId);
    return { ownerUserId: follower?.ownerUserId ?? principal, followerId };
  }
  return { ownerUserId: contract.userId, followerId: null };
}

/** Appends an adjustment (idempotent) and returns the new effective profit. */
export async function applyContractAdjustment(store: Store, input: AdjustmentInput): Promise<AdjustmentResult> {
  const contract = store.findContractById(input.contractId);
  if (!contract) return { applied: false };

  const now = input.now ?? Date.now();
  const { ownerUserId, followerId } = ownerOf(store, contract);
  const adjustment: ContractAdjustmentRecord = {
    id: `adj_${contract.id}_${input.key}`,
    contractId: contract.id,
    ownerUserId,
    followerId,
    principal: contract.userId,
    deltaProfit: roundMoney(input.deltaProfit, contract.currency),
    currency: contract.currency,
    reason: input.reason,
    source: input.source,
    dedupeKey: `adjustment:${contract.id}:${input.key}`,
    createdAt: now
  };

  const inserted = await store.putContractAdjustment(adjustment);
  if (!inserted) {
    // Duplicate event: recompute from what is already stored, never double-apply.
    return { applied: false, effectiveProfit: effectiveProfit(contract, store.listContractAdjustments(contract.id)) };
  }

  await store.appendExecutionAudit({
    id: `audit_adj_${adjustment.id}`,
    timestamp: now,
    userId: ownerUserId,
    action: 'copy.settlement_adjustment',
    outcome: 'allowed',
    accountId: contract.accountId,
    intentId: contract.intentId,
    detail: {
      contractId: contract.id,
      deltaProfit: adjustment.deltaProfit,
      currency: adjustment.currency,
      reason: adjustment.reason,
      source: adjustment.source
    }
  });

  return { applied: true, adjustment, effectiveProfit: effectiveProfit(contract, store.listContractAdjustments(contract.id)) };
}

export function listContractAdjustments(store: Store, contractId: string): ContractAdjustmentRecord[] {
  return store.listContractAdjustments(contractId);
}

/** Original profit plus every adjustment delta, rounded to the contract currency. */
export function effectiveProfit(contract: ContractRecord, adjustments: readonly ContractAdjustmentRecord[]): number {
  const base = contract.profit ?? 0;
  const delta = adjustments.reduce((sum, a) => sum + a.deltaProfit, 0);
  return roundMoney(base + delta, contract.currency);
}