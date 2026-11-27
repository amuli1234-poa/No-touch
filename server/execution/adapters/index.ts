import type { DerivContractType, ContractFamily } from '../types.js';
import { CONTRACT_FAMILY_TYPES, DIGIT_PREDICTION_TYPES } from '../types.js';
import type { ProposalPayload } from '../broker/types.js';

export type { ProposalPayload };

/**
 * Contract adapters.
 *
 * Each adapter turns a family-agnostic intent into the exact `proposal` payload
 * Deriv expects, and validates the parameters against what the contract
 * actually supports. Keeping this per-family means the Rise/Fall rules and the
 * Multipliers rules cannot contaminate each other.
 *
 * The rules below are taken from the live `contracts_for` catalogue and the
 * official proposal schema, not assumed:
 *  - Rise/Fall is CALL/PUT, `expiry_type: "daily"`, one barrier.
 *  - Multipliers is MULTUP/MULTDOWN, `no_expiry`, needs `multiplier`, and its
 *    `limit_order` supports stop_loss / take_profit.
 */

export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export interface AdapterParameters {
  duration: number;
  durationUnit: string;
  multiplier: number | null;
  cancellation: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Predicted digit, for `DIGIT*` contracts only. */
  digit?: number | null;
  /** Price barrier, for `higher_lower` and `touch_no_touch` only. */
  barrier?: string | null;
  /** Growth rate, for `ACCU` only. */
  growthRate?: number | null;
}

export interface ContractAdapter {
  readonly family: ContractFamily;
  readonly contractTypes: readonly DerivContractType[];
  /** Validates parameters and builds the Deriv proposal payload. */
  buildProposal(input: {
    directionContractType: DerivContractType;
    amount: number;
    basis: 'stake' | 'payout';
    currency: string;
    symbol: string;
    parameters: AdapterParameters;
  }): ProposalPayload;
}

const DURATION_UNITS = ['s', 'm', 'h', 'd', 't'] as const;
/** Multipliers cancellation options, from the live catalogue. */
const CANCELLATION_RANGE = ['5m', '10m', '15m', '30m', '60m'];

class RiseFallAdapter implements ContractAdapter {
  readonly family = 'rise_fall' as const;
  readonly contractTypes = CONTRACT_FAMILY_TYPES.rise_fall;

  buildProposal(input: {
    directionContractType: DerivContractType;
    amount: number;
    basis: 'stake' | 'payout';
    currency: string;
    symbol: string;
    parameters: AdapterParameters;
  }): ProposalPayload {
    const { parameters } = input;
    if (!this.contractTypes.includes(input.directionContractType)) {
      throw new AdapterError('wrong_contract_type', `${input.directionContractType} is not a Rise/Fall contract.`);
    }
    if (!Number.isFinite(parameters.duration) || parameters.duration <= 0) {
      throw new AdapterError('invalid_duration', 'Rise/Fall requires a positive duration.');
    }
    if (!(DURATION_UNITS as readonly string[]).includes(parameters.durationUnit)) {
      throw new AdapterError('invalid_duration_unit', `Unsupported duration unit ${parameters.durationUnit}.`);
    }
    // Rise/Fall has no multiplier, cancellation or limit order.
    if (parameters.multiplier !== null) {
      throw new AdapterError('unsupported_parameter', 'Rise/Fall does not take a multiplier.');
    }
    if (parameters.cancellation !== null) {
      throw new AdapterError('unsupported_parameter', 'Rise/Fall does not take a cancellation.');
    }
    if (parameters.stopLoss !== null || parameters.takeProfit !== null) {
      throw new AdapterError('unsupported_parameter', 'Rise/Fall does not take a limit order.');
    }
    return {
      amount: input.amount,
      basis: input.basis,
      contract_type: input.directionContractType,
      currency: input.currency,
      underlying_symbol: input.symbol,
      duration: parameters.duration,
      duration_unit: parameters.durationUnit
    };
  }
}

class MultipliersAdapter implements ContractAdapter {
  readonly family = 'multipliers' as const;
  readonly contractTypes = CONTRACT_FAMILY_TYPES.multipliers;

  buildProposal(input: {
    directionContractType: DerivContractType;
    amount: number;
    basis: 'stake' | 'payout';
    currency: string;
    symbol: string;
    parameters: AdapterParameters;
  }): ProposalPayload {
    const { parameters } = input;
    if (!this.contractTypes.includes(input.directionContractType)) {
      throw new AdapterError('wrong_contract_type', `${input.directionContractType} is not a Multipliers contract.`);
    }
    if (parameters.multiplier === null || !Number.isFinite(parameters.multiplier) || parameters.multiplier <= 0) {
      throw new AdapterError('invalid_multiplier', 'Multipliers requires a positive multiplier.');
    }
    if (parameters.cancellation !== null && !CANCELLATION_RANGE.includes(parameters.cancellation)) {
      throw new AdapterError('invalid_cancellation', `Unsupported cancellation ${parameters.cancellation}.`);
    }
    const payload: ProposalPayload = {
      amount: input.amount,
      // Multipliers are staked, not payout-based.
      basis: 'stake',
      contract_type: input.directionContractType,
      currency: input.currency,
      underlying_symbol: input.symbol,
      multiplier: parameters.multiplier
    };
    if (parameters.cancellation) payload.cancellation = parameters.cancellation;
    if (parameters.stopLoss !== null || parameters.takeProfit !== null) {
      payload.limit_order = {
        ...(parameters.stopLoss !== null ? { stop_loss: parameters.stopLoss } : {}),
        ...(parameters.takeProfit !== null ? { take_profit: parameters.takeProfit } : {})
      };
    }
    return payload;
  }
}

/**
 * Digit contracts (`DIGITEVEN`, `DIGITODD`, `DIGITMATCH`, `DIGITDIFF`,
 * `DIGITOVER`, `DIGITUNDER`).
 *
 * These are tick-duration contracts and carry their prediction in `barrier` as
 * a number. Deriv accepts 0-9 for every digit contract except OVER/UNDER, which
 * additionally reject 0 and 9 respectively — a prediction there can never win.
 */
class DigitsAdapter implements ContractAdapter {
  readonly family = 'digits' as const;
  readonly contractTypes = CONTRACT_FAMILY_TYPES.digits;

  buildProposal(input: {
    directionContractType: DerivContractType;
    amount: number;
    basis: 'stake' | 'payout';
    currency: string;
    symbol: string;
    parameters: AdapterParameters;
  }): ProposalPayload {
    const { parameters } = input;
    if (!this.contractTypes.includes(input.directionContractType)) {
      throw new AdapterError('wrong_contract_type', `${input.directionContractType} is not a digit contract.`);
    }
    if (parameters.multiplier !== null || parameters.cancellation !== null) {
      throw new AdapterError('unsupported_parameter', 'Digit contracts take no multiplier or cancellation.');
    }
    if (parameters.stopLoss !== null || parameters.takeProfit !== null) {
      throw new AdapterError('unsupported_parameter', 'Digit contracts take no limit order.');
    }
    if (parameters.durationUnit !== 't') {
      throw new AdapterError('invalid_duration_unit', 'Digit contracts are tick-duration; the unit must be "t".');
    }
    if (!Number.isInteger(parameters.duration) || parameters.duration < 1) {
      throw new AdapterError('invalid_duration', 'A digit contract needs a whole number of ticks.');
    }
    // Only Match/Diff/Over/Under name a digit. Even/Odd are complete predictions
    // on their own and must be priced with NO barrier — requiring one here would
    // refuse a perfectly valid Even/Odd strategy (and a copy of one).
    let barrier: number | undefined;
    if (DIGIT_PREDICTION_TYPES.has(input.directionContractType)) {
      const digit = parameters.digit ?? null;
      if (digit === null || !Number.isInteger(digit) || digit < 0 || digit > 9) {
        throw new AdapterError('invalid_barrier', 'A digit contract needs a whole-number prediction from 0 to 9.');
      }
      if (input.directionContractType === 'DIGITOVER' && digit === 9) {
        throw new AdapterError('invalid_barrier', 'Digit Over 9 can never win; pick a digit from 0 to 8.');
      }
      if (input.directionContractType === 'DIGITUNDER' && digit === 0) {
        throw new AdapterError('invalid_barrier', 'Digit Under 0 can never win; pick a digit from 1 to 9.');
      }
      barrier = digit;
    }
    return {
      amount: input.amount,
      basis: input.basis,
      contract_type: input.directionContractType,
      currency: input.currency,
      underlying_symbol: input.symbol,
      duration: parameters.duration,
      duration_unit: parameters.durationUnit,
      ...(barrier !== undefined ? { barrier } : {})
    };
  }
}

/**
 * Barrier contracts: Higher/Lower (`CALL`/`PUT` with a price barrier) and
 * Touch/No Touch (`ONETOUCH`/`NOTOUCH`).
 *
 * Deriv takes the barrier as a signed price offset string. The value is passed
 * through unchanged because only the strategy author knows whether they meant a
 * relative offset or an absolute level, and guessing would place a different
 * trade than the one written.
 */
class BarrierAdapter implements ContractAdapter {
  readonly family: ContractFamily;
  readonly contractTypes: readonly DerivContractType[];

  constructor(family: 'higher_lower' | 'touch_no_touch') {
    this.family = family;
    this.contractTypes = CONTRACT_FAMILY_TYPES[family];
  }

  buildProposal(input: {
    directionContractType: DerivContractType;
    amount: number;
    basis: 'stake' | 'payout';
    currency: string;
    symbol: string;
    parameters: AdapterParameters;
  }): ProposalPayload {
    const { parameters } = input;
    if (!this.contractTypes.includes(input.directionContractType)) {
      throw new AdapterError('wrong_contract_type', `${input.directionContractType} is not a ${this.family} contract.`);
    }
    if (parameters.multiplier !== null || parameters.cancellation !== null) {
      throw new AdapterError('unsupported_parameter', `${this.family} takes no multiplier or cancellation.`);
    }
    if (parameters.stopLoss !== null || parameters.takeProfit !== null) {
      throw new AdapterError('unsupported_parameter', `${this.family} takes no limit order.`);
    }
    const barrier = (parameters.barrier ?? '').trim();
    if (!barrier) {
      throw new AdapterError('invalid_barrier', `${this.family} requires a barrier price.`);
    }
    if (!Number.isFinite(Number(barrier))) {
      throw new AdapterError('invalid_barrier', `Barrier "${barrier}" is not a number.`);
    }
    if (!Number.isFinite(parameters.duration) || parameters.duration <= 0) {
      throw new AdapterError('invalid_duration', `${this.family} requires a positive duration.`);
    }
    if (!(DURATION_UNITS as readonly string[]).includes(parameters.durationUnit)) {
      throw new AdapterError('invalid_duration_unit', `Unsupported duration unit ${parameters.durationUnit}.`);
    }
    return {
      amount: input.amount,
      basis: input.basis,
      contract_type: input.directionContractType,
      currency: input.currency,
      underlying_symbol: input.symbol,
      duration: parameters.duration,
      duration_unit: parameters.durationUnit,
      barrier
    };
  }
}

/**
 * Accumulators (`ACCU`). Growth rate is a percentage; Deriv bounds it per
 * symbol, and the proposal is refused upstream if the value is outside that
 * range, so only the shape is validated here.
 */
class AccumulatorsAdapter implements ContractAdapter {
  readonly family = 'accumulators' as const;
  readonly contractTypes = CONTRACT_FAMILY_TYPES.accumulators;

  buildProposal(input: {
    directionContractType: DerivContractType;
    amount: number;
    basis: 'stake' | 'payout';
    currency: string;
    symbol: string;
    parameters: AdapterParameters;
  }): ProposalPayload {
    const { parameters } = input;
    if (!this.contractTypes.includes(input.directionContractType)) {
      throw new AdapterError('wrong_contract_type', `${input.directionContractType} is not an Accumulator contract.`);
    }
    const growthRate = parameters.growthRate ?? null;
    if (growthRate === null || !Number.isFinite(growthRate) || growthRate <= 0 || growthRate >= 1) {
      throw new AdapterError('invalid_growth_rate', 'Accumulators need a growth rate between 0 and 1.');
    }
    return {
      amount: input.amount,
      basis: 'stake',
      contract_type: input.directionContractType,
      currency: input.currency,
      underlying_symbol: input.symbol,
      growth_rate: growthRate
    };
  }
}

export const RISE_FALL_ADAPTER = new RiseFallAdapter();
export const MULTIPLIERS_ADAPTER = new MultipliersAdapter();
export const DIGITS_ADAPTER = new DigitsAdapter();
export const HIGHER_LOWER_ADAPTER = new BarrierAdapter('higher_lower');
export const TOUCH_NO_TOUCH_ADAPTER = new BarrierAdapter('touch_no_touch');
export const ACCUMULATORS_ADAPTER = new AccumulatorsAdapter();

const ADAPTERS: Record<ContractFamily, ContractAdapter> = {
  rise_fall: RISE_FALL_ADAPTER,
  multipliers: MULTIPLIERS_ADAPTER,
  higher_lower: HIGHER_LOWER_ADAPTER,
  digits: DIGITS_ADAPTER,
  touch_no_touch: TOUCH_NO_TOUCH_ADAPTER,
  accumulators: ACCUMULATORS_ADAPTER
};

export function adapterFor(family: ContractFamily): ContractAdapter {
  return ADAPTERS[family];
}
