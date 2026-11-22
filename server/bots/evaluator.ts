/**
 * Deterministic strategy evaluation for imported bots.
 *
 * An imported DBot strategy is a block program. This module reads the *saved
 * canonical* block tree and answers one question per tick: given the ticks that
 * have actually arrived, do the strategy's entry conditions hold right now?
 *
 * Three rules shape the design:
 *
 *  1. Only blocks whose semantics we can state exactly are executed. Anything
 *     else makes the strategy ineligible to run — refused at start, never
 *     silently skipped mid-run. Guessing at an unknown block's meaning would
 *     mean trading on a strategy the customer never wrote.
 *
 *  2. Evaluation is a pure function of the ticks supplied. No clock, no
 *     randomness, no I/O. The same ticks always give the same verdict, so a
 *     decision can be reproduced when a customer asks why a trade happened.
 *
 *  3. A missing or insufficient history is `insufficient`, never a default
 *     `false` or a fabricated value. An indicator that cannot be computed
 *     cannot approve an entry.
 *
 * This module produces a verdict only. It creates no signal and submits no
 * purchase; the caller decides whether to act, and the gateway still applies
 * every safety control.
 */

import type { MarketSnapshot } from '../services/marketData.js';
import type { BlockTree, TreeNode } from './tree.js';
import type { ContractFamily, DerivContractType } from '../execution/types.js';
import { DIGIT_PREDICTION_TYPES } from '../execution/types.js';
import { fieldValue, findTopLevel, walkTree } from './tree.js';

export type EvaluationVerdict =
  /** `NONE` when the strategy's family is chosen by prediction, not direction. */
  | { kind: 'entry'; direction: 'RISE' | 'FALL' | 'NONE'; reason: string }
  | { kind: 'no_entry'; reason: string }
  | { kind: 'insufficient'; reason: string }
  | { kind: 'ineligible'; reason: string };

/** An operand of a comparison, resolved to a number at evaluation time. */
export type Operand =
  | { kind: 'literal'; value: number }
  | { kind: 'tick' }
  | { kind: 'indicator'; variable: string };

export type CompareOp = 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE';

export type PlanCondition =
  | { kind: 'direction'; direction: 'RISE' | 'FALL' }
  | { kind: 'compare'; op: CompareOp; left: Operand; right: Operand };

/** An indicator the strategy computes each tick, keyed by its variable name. */
export interface IndicatorDecl {
  variable: string;
  indicator: 'sma' | 'ema';
  period: number;
}

export interface StrategyPlan {
  symbol: string;
  timeframe: string;
  /** Contract type the strategy's purchase block names. */
  contractType: DerivContractType;
  /** The execution family this contract type belongs to. */
  contractFamily: ContractFamily;
  /** Direction for directional families; `NONE` for prediction families. */
  direction: 'RISE' | 'FALL' | 'NONE';
  /** Predicted digit, when the strategy names one. */
  digit: number | null;
  /** Barrier price as written, for barrier families. */
  barrier: string | null;
  /** Conditions evaluated each tick, in document order; all must hold. */
  conditions: PlanCondition[];
  /** Indicators computed before the conditions are evaluated. */
  indicators: IndicatorDecl[];
  /** Longest tick history any condition needs. */
  historyNeeded: number;
  /** Stake as written in the strategy, when readable. */
  stake: number | null;
  currency: string | null;
  duration: number | null;
  durationUnit: string | null;
}

export interface PlanResult {
  ok: boolean;
  plan: StrategyPlan | null;
  /** Why the strategy cannot run, when `ok` is false. */
  reasons: string[];
  /** Block types present that this evaluator cannot execute. */
  unsupported: string[];
}

/**
 * Blocks the evaluator can execute.
 *
 * Deliberately narrow. `controls_if`, loops, procedures and the OHLC/stat
 * families are absent: their semantics interact with control flow this
 * evaluator does not model, so a strategy using them is refused rather than
 * approximated.
 */
export const EXECUTABLE = new Set([
  'trade_definition',
  'trade_definition_market',
  'trade_definition_tradetype',
  'trade_definition_contracttype',
  'trade_definition_candleinterval',
  'trade_definition_tradeoptions',
  'trade_definition_restartbuysell',
  'trade_definition_restartonerror',
  'before_purchase',
  'purchase',
  'tick_analysis',
  'check_direction',
  'tick',
  'math_number',
  'math_number_positive',
  'logic_compare',
  'sma_statement',
  'ema_statement',
  'variables_get',
  // Structural containers DBot always emits around the entry stack. They carry
  // no entry logic of their own, so they are safe to traverse.
  'during_purchase',
  'after_purchase',
  'trade_again'
]);

/**
 * Blocks whose absence from `EXECUTABLE` is deliberate and worth naming.
 *
 * `check_sell` sells a contract before expiry. This build holds every contract
 * to its expiry, so honouring a strategy that relies on an early sale would
 * change its outcome. It is refused instead of ignored.
 */
const UNSUPPORTED_REASONS: Record<string, string> = {
  check_sell: 'Selling before expiry is not supported; contracts are held to expiry.',
  controls_if: 'Conditional branching is not modelled.',
  variables_set: 'Assigning variables outside an indicator block is not modelled.'
};

/**
 * Which family each executable contract type belongs to.
 *
 * This is the bridge between "what the XML says" and "what the gateway can
 * price". It is exhaustive by type, so adding a contract type without deciding
 * its family is a compile error rather than a runtime surprise.
 */
const CONTRACT_TYPE_FAMILY: Record<DerivContractType, ContractFamily> = {
  CALL: 'rise_fall',
  PUT: 'rise_fall',
  MULTUP: 'multipliers',
  MULTDOWN: 'multipliers',
  DIGITEVEN: 'digits',
  DIGITODD: 'digits',
  DIGITMATCH: 'digits',
  DIGITDIFF: 'digits',
  DIGITOVER: 'digits',
  DIGITUNDER: 'digits',
  ONETOUCH: 'touch_no_touch',
  NOTOUCH: 'touch_no_touch',
  ACCU: 'accumulators'
};

/**
 * Contract types whose CALL/PUT shape also serves Higher/Lower. DBot writes
 * CALL/PUT for both, so the barrier's presence is what distinguishes them; the
 * plan keeps `rise_fall` unless a barrier is actually configured.
 */
const CONTRACT_TYPES = new Set<string>(Object.keys(CONTRACT_TYPE_FAMILY));

/**
 * Reads the digit a `DIGIT*` strategy predicts.
 *
 * DBot records the prediction in the trade-options barrier field, as a
 * `math_number` block. Anything that is not a single whole number from 0 to 9
 * is rejected rather than rounded, because a rounded prediction would place a
 * trade the author did not write.
 */
function readDigitPrediction(all: TreeNode[]): number | null {
  const options = all.find((n) => n.type === 'trade_definition_tradeoptions');
  if (!options) return null;
  const input = options.inputs.find((i) => i.name === 'BARRIER' || i.name === 'PREDICTION');
  const block = input?.block;
  if (!block) return null;
  const field = block.fields.find((f) => f.name === 'NUM');
  if (!field) return null;
  const value = Number(field.value);
  if (!Number.isInteger(value) || value < 0 || value > 9) return null;
  return value;
}

/**
 * Reads a barrier price as written, for Higher/Lower and Touch/No Touch.
 *
 * The value is kept as a string: Deriv accepts a signed offset, and converting
 * it to a number here would lose the sign convention the author relied on.
 */
function readBarrier(all: TreeNode[]): string | null {
  const options = all.find((n) => n.type === 'trade_definition_tradeoptions');
  if (!options) return null;
  const input = options.inputs.find((i) => i.name === 'BARRIER');
  const block = input?.block;
  if (!block) return null;
  const field = block.fields.find((f) => f.name === 'NUM' || f.name === 'TEXT');
  if (!field) return null;
  const raw = String(field.value).trim();
  if (!raw || !Number.isFinite(Number(raw))) return null;
  return raw;
}

const COMPARE_OPS = new Set<CompareOp>(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE']);

/** Reads a nested numeric value block, e.g. the amount in trade options. */
function inputNumber(node: TreeNode | null | undefined, inputName: string): number | null {
  if (!node) return null;
  const input = node.inputs.find((i) => i.name === inputName);
  const block = input?.block;
  if (!block) return null;
  const field = block.fields.find((f) => f.name === 'NUM');
  if (!field) return null;
  const num = Number(field.value);
  return Number.isFinite(num) ? num : null;
}

/** The block connected to a statement input, when present. */
function statementBlock(node: TreeNode | null | undefined, name: string): TreeNode | null {
  if (!node) return null;
  return node.inputs.find((i) => i.name === name && i.kind === 'statement')?.block ?? null;
}

/** The block connected to a value input, when present. */
function valueBlock(node: TreeNode, name: string): TreeNode | null {
  return node.inputs.find((i) => i.name === name && i.kind === 'value')?.block ?? null;
}

/** Every block in a stack, following `<next>` links. */
function stackBlocks(head: TreeNode | null | undefined): TreeNode[] {
  const out: TreeNode[] = [];
  let current = head;
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
}

/** Reads an indicator's period from its nested STATEMENT parameter block. */
function indicatorPeriod(node: TreeNode): number | null {
  const inner = statementBlock(node, 'STATEMENT');
  if (!inner) return null;
  for (const field of inner.fields) {
    const num = Number(field.value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return inputNumber(inner, 'NUM');
}

/**
 * Resolves a comparison operand.
 *
 * Returns null when the operand is a shape we do not model, so the caller can
 * refuse the strategy instead of substituting a value.
 */
function resolveOperand(
  node: TreeNode | null | undefined,
  indicators: Map<string, IndicatorDecl>
): Operand | null {
  if (!node) return null;
  if (node.type === 'math_number' || node.type === 'math_number_positive') {
    const raw = fieldValue(node, 'NUM');
    if (raw === null) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? { kind: 'literal', value: num } : null;
  }
  if (node.type === 'tick') return { kind: 'tick' };
  if (node.type === 'variables_get') {
    // DBot writes the variable's display name in the VAR field.
    const name = fieldValue(node, 'VAR');
    if (name && indicators.has(name)) return { kind: 'indicator', variable: name };
    return null;
  }
  return null;
}

/**
 * Builds a plan from a saved strategy, or explains why it cannot run.
 *
 * The plan is derived once at start, so a tick never re-interprets the document
 * and a mid-run edit cannot change the strategy underneath a live run.
 */
export function planStrategy(tree: BlockTree): PlanResult {
  const reasons: string[] = [];

  const unsupported = [
    ...new Set(walkTree(tree).filter((n) => !EXECUTABLE.has(n.type)).map((n) => n.type))
  ];
  if (unsupported.length > 0) {
    const named = unsupported
      .map((type) => (UNSUPPORTED_REASONS[type] ? `${type} (${UNSUPPORTED_REASONS[type]})` : type))
      .join(', ');
    reasons.push(`The strategy uses blocks this build cannot execute: ${named}.`);
  }

  const all = walkTree(tree);

  // Market and contract configuration come from the trade definition.
  const definition = findTopLevel(tree, 'trade_definition');
  const marketBlock = all.find((n) => n.type === 'trade_definition_market');
  const symbol = fieldValue(marketBlock, 'SYMBOL_LIST') ?? fieldValue(definition, 'SYMBOL_LIST');

  const contractBlock = all.find((n) => n.type === 'trade_definition_contracttype');
  const contractTypeRaw = fieldValue(contractBlock, 'TYPE_LIST') ?? '';

  const candleBlock = all.find((n) => n.type === 'trade_definition_candleinterval');
  const candleInterval = fieldValue(candleBlock, 'CANDLEINTERVAL_LIST');

  if (!symbol) reasons.push('The strategy does not name a trading symbol.');
  if (!contractTypeRaw) {
    reasons.push('The strategy does not name a contract type.');
  } else if (!CONTRACT_TYPES.has(contractTypeRaw)) {
    reasons.push(
      `The strategy's contract type "${contractTypeRaw}" cannot be placed by this build.`
    );
  }

  // Trade options: stake, currency, duration.
  const options = all.find((n) => n.type === 'trade_definition_tradeoptions');
  const stake = options ? inputNumber(options, 'AMOUNT') : null;
  const duration = options ? inputNumber(options, 'DURATION') : null;
  const currency = options ? fieldValue(options, 'CURRENCY_LIST') : null;
  const durationUnit = options ? fieldValue(options, 'DURATIONTYPE_LIST') : null;

  // Indicator declarations, so a variables_get in a comparison can be resolved.
  const indicators = new Map<string, IndicatorDecl>();
  for (const node of all) {
    if (node.type !== 'sma_statement' && node.type !== 'ema_statement') continue;
    const variable = fieldValue(node, 'VARIABLE');
    const period = indicatorPeriod(node);
    if (!variable) {
      reasons.push(
        `An ${node.type === 'sma_statement' ? 'SMA' : 'EMA'} block has no variable name.`
      );
      continue;
    }
    if (period === null) {
      reasons.push(`The ${variable} indicator block has no readable period.`);
      continue;
    }
    indicators.set(variable, {
      variable,
      indicator: node.type === 'sma_statement' ? 'sma' : 'ema',
      period
    });
  }

  // Entry conditions: everything inside the before-purchase stack, plus a
  // top-level tick_analysis stack when DBot wrote one. `purchase` is the action,
  // not a condition, so it is excluded here.
  const beforePurchase = findTopLevel(tree, 'before_purchase');
  const entryStack = statementBlock(beforePurchase, 'BEFOREPURCHASE_STACK');
  const analysisStack = statementBlock(findTopLevel(tree, 'tick_analysis'), 'TICKANALYSIS_STACK');

  const conditionNodes = [...stackBlocks(entryStack), ...stackBlocks(analysisStack)].filter(
    (n) => n.type !== 'purchase'
  );

  const conditions: PlanCondition[] = [];

  for (const node of conditionNodes) {
    if (node.type === 'sma_statement' || node.type === 'ema_statement') continue;

    if (node.type === 'check_direction') {
      const raw = fieldValue(node, 'CHECK_DIRECTION') ?? '';
      if (raw !== 'rise' && raw !== 'fall') {
        reasons.push(`The direction check "${raw || 'empty'}" is not understood.`);
        continue;
      }
      conditions.push({ kind: 'direction', direction: raw === 'rise' ? 'RISE' : 'FALL' });
      continue;
    }

    if (node.type === 'logic_compare') {
      const opRaw = fieldValue(node, 'OP') ?? '';
      if (!COMPARE_OPS.has(opRaw as CompareOp)) {
        reasons.push(`The comparison operator "${opRaw || 'empty'}" is not understood.`);
        continue;
      }
      const left = resolveOperand(valueBlock(node, 'A'), indicators);
      const right = resolveOperand(valueBlock(node, 'B'), indicators);
      if (!left || !right) {
        reasons.push('A comparison compares something this build cannot evaluate.');
        continue;
      }
      conditions.push({ kind: 'compare', op: opRaw as CompareOp, left, right });
      continue;
    }
  }

  // A strategy with no entry condition cannot decide when to trade. Refusing is
  // the honest answer: "always trade" is not what an empty stack means.
  if (conditions.length === 0) {
    reasons.push('The strategy has no entry condition that this build can evaluate.');
  }

  if (!beforePurchase) reasons.push('The strategy has no before-purchase block.');

  // The purchase block must name the contract the trade definition configures,
  // or the two disagree and the trade would be meaningless.
  const purchaseBlock = all.find((n) => n.type === 'purchase');
  const purchaseType = fieldValue(purchaseBlock, 'PURCHASE_LIST');
  if (purchaseType && contractTypeRaw && purchaseType !== contractTypeRaw) {
    reasons.push(
      `The purchase block buys ${purchaseType} but the trade definition configures ${contractTypeRaw}.`
    );
  }

  if (reasons.length > 0) {
    return { ok: false, plan: null, reasons, unsupported };
  }

  const contractType = contractTypeRaw as DerivContractType;
  const baseFamily = CONTRACT_TYPE_FAMILY[contractType];
  const digit = DIGIT_PREDICTION_TYPES.has(contractType) ? readDigitPrediction(all) : null;
  const barrier = readBarrier(all);

  // A CALL/PUT strategy that configures a barrier is a Higher/Lower strategy:
  // DBot writes the same contract types for both and distinguishes them only by
  // the barrier. Reinterpreting it as Rise/Fall would silently place a
  // different trade than the author wrote, so the family follows the barrier.
  const contractFamily: ContractFamily =
    baseFamily === 'rise_fall' && barrier !== null ? 'higher_lower' : baseFamily;

  if (DIGIT_PREDICTION_TYPES.has(contractType) && digit === null) {
    reasons.push('The strategy buys a digit contract but names no digit prediction.');
  }
  if (contractFamily === 'higher_lower' && barrier === null) {
    reasons.push('The strategy buys a barrier contract but names no barrier.');
  }
  if (reasons.length > 0) {
    return { ok: false, plan: null, reasons, unsupported };
  }

  const direction: 'RISE' | 'FALL' | 'NONE' =
    contractType === 'CALL' || contractType === 'MULTUP' || contractType === 'DIGITEVEN'
      ? 'RISE'
      : contractType === 'PUT' || contractType === 'MULTDOWN' || contractType === 'DIGITODD'
        ? 'FALL'
        : 'NONE';
  const historyNeeded = Math.max(2, ...[...indicators.values()].map((i) => i.period));

  return {
    ok: true,
    plan: {
      symbol: symbol!,
      timeframe: candleInterval ? `${candleInterval}s` : '1t',
      contractType,
      contractFamily,
      direction,
      digit,
      barrier,
      conditions,
      indicators: [...indicators.values()],
      historyNeeded,
      stake,
      currency,
      duration,
      durationUnit
    },
    reasons: [],
    unsupported: []
  };
}

/* --------------------------------- math ---------------------------------- */

/**
 * EMA warm-up, as a multiple of the period.
 *
 * A seeded EMA's value depends on where the series starts, so evaluating it over
 * "whatever happens to be in the tick buffer" would make the same market produce
 * different signals depending on how long the server had been up. A fixed,
 * bounded tail window makes the result a function of the last N ticks only, so a
 * decision is reproducible and a long-lived process cannot drift from a fresh one.
 */
export const EMA_WARMUP_MULTIPLE = 3;

export function simpleMovingAverage(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const window = values.slice(values.length - period);
  return window.reduce((sum, v) => sum + v, 0) / period;
}

export function exponentialMovingAverage(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const warmup = Math.max(period, period * EMA_WARMUP_MULTIPLE);
  const window = values.slice(Math.max(0, values.length - warmup));
  const seed = window.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  const k = 2 / (period + 1);
  let ema = seed;
  for (let i = period; i < window.length; i += 1) {
    ema = window[i] * k + ema * (1 - k);
  }
  return ema;
}

function compare(left: number, op: CompareOp, right: number): boolean {
  switch (op) {
    case 'EQ':
      return left === right;
    case 'NEQ':
      return left !== right;
    case 'LT':
      return left < right;
    case 'LTE':
      return left <= right;
    case 'GT':
      return left > right;
    case 'GTE':
      return left >= right;
    default:
      return false;
  }
}

/* ------------------------------- evaluation ------------------------------- */

export interface EvaluateInput {
  plan: StrategyPlan;
  /** Ticks for the plan's symbol, oldest first. */
  ticks: MarketSnapshot[];
}

/**
 * Evaluates the plan against the supplied ticks.
 *
 * Returns `entry` only when every condition holds. Any condition that cannot be
 * computed yields `insufficient`, which never becomes an entry.
 */
export function evaluateStrategy(input: EvaluateInput): EvaluationVerdict {
  const { plan, ticks } = input;

  if (ticks.length === 0) {
    return { kind: 'insufficient', reason: 'No ticks have arrived for this symbol.' };
  }

  const quotes = ticks.map((t) => t.quote);
  const last = quotes[quotes.length - 1];
  const previous = quotes.length >= 2 ? quotes[quotes.length - 2] : null;

  // Indicators are computed once per tick, then read by any comparison that
  // references them.
  const computed = new Map<string, number>();
  for (const decl of plan.indicators) {
    const value =
      decl.indicator === 'sma'
        ? simpleMovingAverage(quotes, decl.period)
        : exponentialMovingAverage(quotes, decl.period);
    if (value === null) {
      return {
        kind: 'insufficient',
        reason: `${decl.indicator.toUpperCase()}(${decl.period}) needs ${decl.period} ticks; ${quotes.length} available.`
      };
    }
    computed.set(decl.variable, value);
  }

  const valueOf = (operand: Operand): number | null => {
    switch (operand.kind) {
      case 'literal':
        return operand.value;
      case 'tick':
        return last;
      case 'indicator':
        return computed.get(operand.variable) ?? null;
    }
  };

  const failures: string[] = [];

  for (const condition of plan.conditions) {
    if (condition.kind === 'direction') {
      // DBot's direction check compares the last two ticks.
      if (previous === null) {
        return { kind: 'insufficient', reason: 'Two ticks are needed to read a direction.' };
      }
      const rising = last > previous;
      const falling = last < previous;
      const wanted = condition.direction === 'RISE';
      if (wanted ? !rising : !falling) {
        failures.push(`direction is not ${condition.direction.toLowerCase()}`);
      }
      continue;
    }

    const left = valueOf(condition.left);
    const right = valueOf(condition.right);
    if (left === null || right === null) {
      return { kind: 'insufficient', reason: 'A comparison operand could not be resolved.' };
    }
    if (!compare(left, condition.op, right)) {
      failures.push(`comparison ${condition.op} not met`);
    }
  }

  if (failures.length > 0) {
    return { kind: 'no_entry', reason: failures.join('; ') };
  }
  return {
    kind: 'entry',
    direction: plan.direction,
    reason: `All ${plan.conditions.length} entry condition(s) satisfied.`
  };
}
