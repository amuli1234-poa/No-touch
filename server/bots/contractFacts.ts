/**
 * Builds the interpreter's view of a settled contract from stored records.
 *
 * The interpreter's `read_details`, `contract_check_result` and
 * `total_profit` blocks must report what actually happened. Every field here is
 * copied from a persisted record — nothing is estimated. Where a record does
 * not carry a value, the fact stays `null` so the block reads null instead of a
 * plausible-looking number.
 */

import type { ContractFacts } from './interpreter.js';
import type { ContractRecord, TradeIntentRecord } from '../execution/types.js';

/** Contract statuses that mean the contract is over and its result is final. */
const SETTLED_STATUSES = new Set(['won', 'lost', 'sold', 'cancelled', 'expired']);

/** True when a contract has finished and its profit will not change again. */
export function isSettled(contract: ContractRecord): boolean {
  return SETTLED_STATUSES.has(contract.status) || contract.settlementTime !== null;
}

/**
 * The contract's realised profit.
 *
 * `profit` is preferred because it is the broker's figure. When it is absent the
 * sale proceeds minus the stake is the same quantity, derived rather than
 * invented. `null` means genuinely unknown.
 */
function settledProfit(contract: ContractRecord): number | null {
  if (contract.profit !== null && Number.isFinite(contract.profit)) return contract.profit;
  if (contract.soldFor === null || !Number.isFinite(contract.soldFor)) return null;
  return contract.soldFor - contract.buyPrice;
}

/**
 * Converts a settled contract into the facts `after_purchase` blocks read.
 *
 * `profit` is taken from the record rather than recomputed: the broker's figure
 * is authoritative and already accounts for any early sale. DBot's own result
 * rule is `profit < 0 ? 'loss' : 'win'`, applied here so
 * `contract_check_result` matches the platform a customer came from.
 */
export function contractFacts(
  contract: ContractRecord,
  intent: TradeIntentRecord | null
): ContractFacts {
  const profit = settledProfit(contract);

  // DBot formats the entry/exit *tick* times. `startTime` is the entry moment;
  // the settlement time is when the exit tick was recorded.
  const entryTime = contract.startTime ?? null;
  const exitTime = contract.settlementTime ?? null;

  const barrierRaw = intent?.parameters?.barrier ?? null;
  const barrierNumber = barrierRaw === null ? null : Number(barrierRaw);

  return {
    buyTransactionId: contract.buyTransactionId,
    buyPrice: contract.buyPrice,
    sellPrice: contract.soldFor,
    profit,
    contractType: contract.contractType,
    entryTime,
    entrySpot: contract.entrySpot,
    exitTime,
    exitSpot: contract.exitSpot,
    barrier: barrierNumber !== null && Number.isFinite(barrierNumber) ? barrierNumber : null,
    result: profit === null ? null : profit < 0 ? 'loss' : 'win'
  };
}

/**
 * Sums realised profit across every settled contract in one run.
 *
 * `total_profit` reports the strategy's running result, so only settled
 * contracts count: an open contract's profit is provisional and would make the
 * figure move on every tick.
 */
export function totalProfitOf(contracts: ContractRecord[], runIntentIds: Set<string>): number {
  let total = 0;
  for (const contract of contracts) {
    if (!runIntentIds.has(contract.intentId)) continue;
    const profit = settledProfit(contract);
    if (profit !== null) total += profit;
  }
  return total;
}
