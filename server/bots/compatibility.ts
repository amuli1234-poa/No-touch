import type { AvailableContract } from '../services/marketData.js';
import type { ContractFamily, DerivContractType } from '../execution/types.js';
import { DIGIT_PREDICTION_TYPES } from '../execution/types.js';
import type { StrategyPlan } from './evaluator.js';

/**
 * Bot-to-market compatibility.
 *
 * This answers a different question from `parser.ts`'s `classify()`. That one
 * asks "can No-touch *interpret* this XML at all", and its answer is a property
 * of the document alone. This asks "can this strategy run on *this symbol with
 * this contract, right now*", and its answer depends on the document, the
 * symbol, Deriv's live catalogue and what the execution layer implements.
 *
 * Keeping them apart is the point. A bot can be perfectly importable and still
 * have no compatible market, and it can have a compatible market while the
 * execution layer cannot place the contract. Collapsing the two would produce
 * exactly the failure the brief forbids: a bot shown as runnable because its
 * XML imported.
 */

/**
 * - `compatible`   the strategy can execute correctly here
 * - `incompatible` the symbol or contract cannot satisfy the strategy
 * - `unsupported`  No-touch has not implemented what the strategy needs
 * - `unavailable`  Deriv does not currently offer it
 * - `invalid`      the strategy configuration is malformed
 */
export const COMPATIBILITY_STATES = [
  'compatible',
  'incompatible',
  'unsupported',
  'unavailable',
  'invalid'
] as const;

export type CompatibilityState = (typeof COMPATIBILITY_STATES)[number];

export interface CompatibilityVerdict {
  state: CompatibilityState;
  /** One sentence a customer can act on. Never empty. */
  reason: string;
  /** Every reason found, most specific first. */
  details: string[];
}

/**
 * Families the execution layer can actually price and place.
 *
 * `multipliers` and `accumulators` are deliberately absent: Multipliers are
 * gated off platform-wide (`MULTIPLIERS_ENABLED`), and Accumulators need a
 * growth rate the strategy model does not read yet. Listing them as supported
 * would mean promising a purchase the gateway would refuse.
 */
const IMPLEMENTED_FAMILIES: ReadonlySet<ContractFamily> = new Set<ContractFamily>([
  'rise_fall',
  'higher_lower',
  'digits',
  'touch_no_touch'
]);

/** Why an unimplemented family cannot run, in customer-facing words. */
const FAMILY_UNSUPPORTED_REASONS: Partial<Record<ContractFamily, string>> = {
  multipliers: 'Multiplier contracts are not enabled on this platform.',
  accumulators: 'Accumulator contracts are not implemented yet; growth-rate configuration is not modelled.'
};

/**
 * Deriv's contract type for each (family, contract) pair the planner can emit.
 *
 * A plan already names its contract type, so this exists to verify the pair is
 * coherent rather than to derive it: a `DIGITEVEN` plan that somehow claims the
 * `rise_fall` family must be refused, not quietly corrected.
 */
function familyOwnsContract(family: ContractFamily, contractType: DerivContractType): boolean {
  switch (family) {
    case 'rise_fall':
      return contractType === 'CALL' || contractType === 'PUT';
    case 'higher_lower':
      return contractType === 'CALL' || contractType === 'PUT';
    case 'multipliers':
      return contractType === 'MULTUP' || contractType === 'MULTDOWN';
    case 'digits':
      return contractType.startsWith('DIGIT');
    case 'touch_no_touch':
      return contractType === 'ONETOUCH' || contractType === 'NOTOUCH';
    case 'accumulators':
      return contractType === 'ACCU';
    default:
      return false;
  }
}

/**
 * Judges one (plan, symbol) pair against the symbol's live contract catalogue.
 *
 * `contracts` is Deriv's answer to `contracts_for` for that symbol. Passing an
 * empty list is treated as `unavailable`, never as `compatible`, because "Deriv
 * told us nothing" is not evidence that a trade will work.
 */
export function evaluateCompatibility(
  plan: StrategyPlan,
  symbol: string,
  contracts: readonly AvailableContract[]
): CompatibilityVerdict {
  // 1. Malformed strategy: the plan must be internally coherent first.
  if (!plan.contractType) {
    return {
      state: 'invalid',
      reason: 'The strategy does not name a contract type.',
      details: ['No contract type was found in the trade definition.']
    };
  }
  if (!familyOwnsContract(plan.contractFamily, plan.contractType)) {
    return {
      state: 'invalid',
      reason: `Contract ${plan.contractType} does not belong to the ${plan.contractFamily} family.`,
      details: ['The strategy configures a contract type that contradicts its own trade definition.']
    };
  }
  // An interpreter plan resolves its digit and barrier per entry, so their
  // absence here says nothing about whether the strategy can run.
  if (
    plan.engine !== 'interpreter' &&
    DIGIT_PREDICTION_TYPES.has(plan.contractType) &&
    plan.digit === null &&
    !plan.dynamicDigit
  ) {
    return {
      state: 'invalid',
      reason: 'The strategy buys a digit contract but names no digit.',
      details: ['Add a digit prediction between 0 and 9 to the trade options.']
    };
  }
  if (plan.engine !== 'interpreter' && plan.contractFamily === 'higher_lower' && plan.barrier === null) {
    return {
      state: 'invalid',
      reason: 'The strategy buys a barrier contract but names no barrier.',
      details: ['Add a barrier price to the trade options.']
    };
  }

  // 2. Not implemented: say so before blaming Deriv.
  if (!IMPLEMENTED_FAMILIES.has(plan.contractFamily)) {
    return {
      state: 'unsupported',
      reason:
        FAMILY_UNSUPPORTED_REASONS[plan.contractFamily] ??
        `The ${plan.contractFamily} contract family is not implemented.`,
      details: [`No execution adapter exists for ${plan.contractFamily}.`]
    };
  }

  // 3. Deriv availability for this symbol.
  const available = contracts.find((c) => c.contractType === plan.contractType);
  if (!available) {
    const offered = contracts.map((c) => c.contractType).sort();
    return {
      state: 'unavailable',
      reason: `Deriv does not offer ${plan.contractType} on ${symbol}.`,
      details: [
        offered.length > 0
          ? `${symbol} offers: ${offered.join(', ')}.`
          : `Deriv returned no contracts for ${symbol}.`
      ]
    };
  }

  // 4. Duration and barrier shape must match what this contract variant accepts.
  const details: string[] = [];
  if (plan.duration !== null && available.minDuration !== null && plan.duration < available.minDuration) {
    details.push(
      `Duration ${plan.duration}${plan.durationUnit ?? ''} is below the minimum of ${available.minDuration}${available.durationUnit ?? ''} for ${plan.contractType}.`
    );
  }
  if (plan.duration !== null && available.maxDuration !== null && plan.duration > available.maxDuration) {
    details.push(
      `Duration ${plan.duration}${plan.durationUnit ?? ''} exceeds the maximum of ${available.maxDuration}${available.durationUnit ?? ''} for ${plan.contractType}.`
    );
  }
  if (plan.durationUnit && available.durationUnit && plan.durationUnit !== available.durationUnit) {
    details.push(
      `${plan.contractType} is measured in "${available.durationUnit}", but the strategy uses "${plan.durationUnit}".`
    );
  }
  if (available.barriers > 0 && plan.barrier === null && plan.contractFamily !== 'digits') {
    details.push(`${plan.contractType} on ${symbol} requires a barrier.`);
  }
  if (available.barriers === 0 && plan.contractFamily === 'higher_lower') {
    details.push(`${plan.contractType} on ${symbol} takes no barrier, so it cannot be Higher/Lower.`);
  }
  if (details.length > 0) {
    return {
      state: 'incompatible',
      reason: `${symbol} cannot satisfy this strategy's ${plan.contractType} configuration.`,
      details
    };
  }

  return {
    state: 'compatible',
    reason: `${plan.contractType} on ${symbol} is available and matches the strategy.`,
    details: []
  };
}

/**
 * Judges every symbol in a catalogue, so the UI can show which markets work
 * without the customer opening each one.
 *
 * `contractsBySymbol` is a lookup the caller fills lazily; a symbol with no
 * entry is reported `unavailable` rather than skipped, so the list is complete
 * and every row has an explanation.
 */
export function matchPlanToMarkets(
  plan: StrategyPlan,
  symbols: readonly string[],
  contractsBySymbol: ReadonlyMap<string, readonly AvailableContract[]>
): Array<{ symbol: string } & CompatibilityVerdict> {
  return symbols.map((symbol) => {
    const contracts = contractsBySymbol.get(symbol);
    if (!contracts) {
      return {
        symbol,
        state: 'unavailable' as const,
        reason: `Contract availability for ${symbol} has not been loaded.`,
        details: ['Refresh the market catalogue to check this symbol.']
      };
    }
    return { symbol, ...evaluateCompatibility(plan, symbol, contracts) };
  });
}

/** True only for the one state that may proceed to execution. */
export function isExecutable(verdict: CompatibilityVerdict): boolean {
  return verdict.state === 'compatible';
}
