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
import { INTERPRETED_BLOCKS, isDbProgram, isValueBlock } from './interpreter.js';
import type { ContractFamily, DerivContractType } from '../execution/types.js';
import { DIGIT_PREDICTION_TYPES } from '../execution/types.js';
import { fieldValue, findTopLevel, walkTree } from './tree.js';

export type EvaluationVerdict =
  /** `NONE` when the strategy's family is chosen by prediction, not direction. */
  | {
      kind: 'entry';
      direction: 'RISE' | 'FALL' | 'NONE';
      reason: string;
      digit?: number;
      /**
       * Contract the strategy chose for *this* entry.
       *
       * A DBot program may branch between contract types at runtime, so the
       * purchase block's choice overrides the trade definition's default. Absent
       * means "use the plan's contract type".
       */
      contractType?: DerivContractType;
    }
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
  | { kind: 'digit_prediction'; contractType: DerivContractType }
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
  /** True for legacy digit strategies whose prediction is resolved from the latest tick. */
  dynamicDigit: boolean;
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
  /**
   * Which engine decides entries for this strategy.
   *
   * `plan` means the fixed condition list below fully describes the entry rule.
   * `interpreter` means the strategy is a genuine DBot program whose entry
   * decision is made by walking its block tree, so `conditions` is empty and
   * must not be read as "always trade".
   */
  engine: 'plan' | 'interpreter';
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
 * Blocks the *plan* engine can execute.
 *
 * Deliberately narrow: these are the structural blocks `planStrategy` reads and
 * the flat condition/value blocks `evaluateStrategy` compares. `controls_if`,
 * loops and procedures are absent because the plan engine reduces a strategy to
 * a condition list and cannot branch.
 */
const PLAN_EXECUTABLE = new Set<string>([
  'trade',
  'tradeOptions',
  'last_digit',
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
 * Blocks this build can execute, as the union of both engines.
 *
 * The plan engine's set plus everything the interpreter implements. Which set
 * actually applies to a strategy depends on the engine chosen for it, so
 * `planStrategy` checks against the narrower of the two it will really use.
 */
export const EXECUTABLE = new Set<string>([...PLAN_EXECUTABLE, ...INTERPRETED_BLOCKS]);

/**
 * Blocks whose absence from `EXECUTABLE` is deliberate and worth naming.
 *
 * `check_sell` sells a contract before expiry. This build holds every contract
 * to its expiry, so honouring a strategy that relies on an early sale would
 * change its outcome. It is refused instead of ignored.
 */
const UNSUPPORTED_REASONS: Record<string, string> = {
  check_sell: 'Selling before expiry is not supported; contracts are held to expiry.'
};

/**
 * Which family each executable contract type belongs to.
 *
 * This is the bridge between "what the XML says" and "what the gateway can
 * price". It is exhaustive by type, so adding a contract type without deciding
 * its family is a compile error rather than a runtime surprise.
 */
export const CONTRACT_TYPE_FAMILY: Record<DerivContractType, ContractFamily> = {
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
 * The direction a contract type buys in, for the signal it produces.
 *
 * Prediction families have no direction of their own, so they report `NONE`:
 * their outcome is decided by the digit, not by which way the market moved.
 */
export function directionForContract(type: DerivContractType): 'RISE' | 'FALL' | 'NONE' {
  if (type === 'CALL' || type === 'MULTUP') return 'RISE';
  if (type === 'PUT' || type === 'MULTDOWN') return 'FALL';
  return 'NONE';
}

/**
 * Reads the digit a `DIGIT*` strategy predicts.
 *
 * DBot records the prediction in the trade-options barrier field, as a
 * `math_number` block. Anything that is not a single whole number from 0 to 9
 * is rejected rather than rounded, because a rounded prediction would place a
 * trade the author did not write.
 */
function readDigitPrediction(all: TreeNode[]): number | null {
  const options = all.find((n) =>
    n.type === 'tradeOptions' || n.type === 'trade_definition_tradeoptions'
  );
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
  const options = all.find((n) =>
    n.type === 'tradeOptions' || n.type === 'trade_definition_tradeoptions'
  );
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
  if (block) {
    const field = block.fields.find((f) => f.name === 'NUM');
    if (field) {
      const num = Number(field.value);
      if (Number.isFinite(num)) return num;
    }
  }
  // Legacy exports keep the configured value in a shadow beside a variables_get.
  // It is a real fallback, not an invented default.
  const shadowField = input?.shadow?.fields.find((f) => f.name === 'NUM');
  if (shadowField) {
    const num = Number(shadowField.value);
    if (Number.isFinite(num)) return num;
  }
  return null;
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
 * Value blocks found in statement position.
 *
 * `TreeInput.kind` distinguishes the two, so this is a structural question, not
 * a guess: a `statement` input holds a stack, and every block in that stack must
 * be executable as a statement.
 */
function misplacedValueStatements(tree: BlockTree): string[] {
  const found: string[] = [];
  for (const node of walkTree(tree)) {
    for (const input of node.inputs) {
      if (input.kind !== 'statement') continue;
      let child = input.block;
      while (child) {
        if (isValueBlock(child.type)) found.push(child.type);
        child = child.next ?? null;
      }
    }
  }
  return found;
}

/**
 * Builds a plan from a saved strategy, or explains why it cannot run.
 *
 * The plan is derived once at start, so a tick never re-interprets the document
 * and a mid-run edit cannot change the strategy underneath a live run.
 */
export function planStrategy(tree: BlockTree): PlanResult {
  const reasons: string[] = [];
  const all = walkTree(tree);
  const legacyTrade = findTopLevel(tree, 'trade');
  const legacyDigit = legacyTrade !== null && all.some((n) =>
    n.type === 'trade' && (
      fieldValue(n, 'TYPE_LIST')?.startsWith('DIGIT') === true
    )
  );
  // A genuine DBot export runs its own program. The simplified dialect — a bare
  // value block in statement position — is modelled by the condition list below
  // instead, so existing bots keep trading exactly as before.
  //
  // A `trade`-rooted digit strategy is the one case where the two overlap: the
  // older flat export is a single `purchase` with a literal prediction, while a
  // real program gates its purchase behind control flow and derives the digit at
  // run time. `isDbProgram` tells them apart by structure, so the interpreter
  // takes the program and the plan engine keeps the flat export.
  const useInterpreter = isDbProgram(tree);
  // The plan engine's legacy digit path reads the prediction statically. A
  // program that derives it from a variable has no static prediction to read, so
  // it stays on the interpreter even though its root block is `trade`.
  const legacyDigitPlan = legacyDigit && !useInterpreter;

  // Check against the set for the engine that will actually run this strategy.
  // A branching program is fine for the interpreter and impossible for the plan
  // engine, so judging it by the plan engine's narrow set would refuse a
  // strategy this build can genuinely execute.
  const runnable = useInterpreter ? EXECUTABLE : PLAN_EXECUTABLE;
  const unsupportedTypes = all.filter((n) => !runnable.has(n.type)).map((n) => n.type);
  // The legacy digit path reads its prediction from a `last_digit` block. A
  // `variables_get` there would stand in for the prediction, and that path does
  // not resolve variables, so it is refused rather than guessed at.
  if (legacyDigitPlan && all.some((node) => node.type === 'variables_get')) {
    unsupportedTypes.push('variables_get');
  }
  const unsupported = [...new Set(unsupportedTypes)];

  // A value block can only produce a value; it has no effect as a statement.
  // The interpreter throws `UnsupportedBlockError` when it reaches one, which
  // would happen on the first tick *after* a contract was bought — the strategy
  // would never reach its `sell_at_market`, so the contract would sit open until
  // expiry with no further decision. Refuse it at plan time instead, before any
  // money moves.
  //
  // This applies only to the interpreter. The simplified dialect deliberately
  // puts a bare `check_direction` in statement position and the plan engine
  // models that shape, so its programs are exempt.
  if (useInterpreter) {
    const misplaced = misplacedValueStatements(tree);
    if (misplaced.length > 0) {
      reasons.push(
        `The strategy places a value block (${[...new Set(misplaced)].join(', ')}) where a statement is required.`
      );
    }
  }

  if (unsupported.length > 0) {
    const named = unsupported
      .map((type) => (UNSUPPORTED_REASONS[type] ? `${type} (${UNSUPPORTED_REASONS[type]})` : type))
      .join(', ');
    reasons.push(`The strategy uses blocks this build cannot execute: ${named}.`);
  }

  // Market and contract configuration come from the trade definition. A program
  // rooted at `trade` carries them as fields on that block instead of in child
  // definition blocks, so both shapes are read here.
  const definition =
    findTopLevel(tree, legacyDigitPlan ? 'trade' : 'trade_definition') ??
    legacyTrade ??
    findTopLevel(tree, 'trade_definition');
  const marketBlock = all.find((n) => n.type === 'trade_definition_market');
  const symbol =
    fieldValue(marketBlock, 'SYMBOL_LIST') ??
    fieldValue(definition, 'SYMBOL_LIST') ??
    null;

  const contractBlock = all.find((n) => n.type === 'trade_definition_contracttype');
  const contractTypeRaw =
    fieldValue(contractBlock, 'TYPE_LIST') ??
    fieldValue(legacyTrade, 'TYPE_LIST') ??
    fieldValue(definition, 'TYPE_LIST') ??
    '';

  const candleBlock = all.find((n) => n.type === 'trade_definition_candleinterval');
  const candleInterval =
    fieldValue(candleBlock, 'CANDLEINTERVAL_LIST') ??
    fieldValue(legacyTrade, 'CANDLEINTERVAL_LIST') ??
    null;

  if (!symbol) reasons.push('The strategy does not name a trading symbol.');
  if (!contractTypeRaw) {
    reasons.push('The strategy does not name a contract type.');
  } else if (!CONTRACT_TYPES.has(contractTypeRaw)) {
    reasons.push(
      `The strategy's contract type "${contractTypeRaw}" cannot be placed by this build.`
    );
  }

  // Trade options: stake, currency, duration. Both shapes are accepted, because
  // a `trade`-rooted program keeps them in a `tradeOptions` block.
  const options = all.find(
    (n) => n.type === 'tradeOptions' || n.type === 'trade_definition_tradeoptions'
  );
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
  // not a condition, so it is excluded here. A genuine DBot program is not
  // reduced to conditions at all — the interpreter decides — so this walk is
  // skipped rather than run and discarded.
  const beforePurchase = findTopLevel(tree, 'before_purchase');
  const entryStack = statementBlock(beforePurchase, 'BEFOREPURCHASE_STACK');
  const analysisStack = statementBlock(findTopLevel(tree, 'tick_analysis'), 'TICKANALYSIS_STACK');

  const conditionNodes = useInterpreter
    ? []
    : [...stackBlocks(entryStack), ...stackBlocks(analysisStack)].filter(
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

  // Legacy digit exports resolve their prediction through a variable or from
  // the latest digit. WickSentinel supports the deterministic tick-path here;
  // control-flow and martingale branches are not silently interpreted.
  if (legacyDigitPlan) {
    const contractType = contractTypeRaw as DerivContractType;
    if (CONTRACT_TYPES.has(contractType)) {
      conditions.push({ kind: 'digit_prediction', contractType });
    }
  }

  // A strategy with no entry condition cannot decide when to trade. Refusing is
  // the honest answer: "always trade" is not what an empty stack means. An
  // interpreted program carries its rule in the block tree, so it is exempt.
  if (conditions.length === 0 && !useInterpreter) {
    reasons.push('The strategy has no entry condition that this build can evaluate.');
  }

  if (!beforePurchase) reasons.push('The strategy has no before-purchase block.');

  // The purchase block must name the contract the trade definition configures,
  // or the two disagree and the trade would be meaningless. A program may choose
  // between contract types at run time, so the mismatch only binds the plan
  // engine, which places the trade definition's type unconditionally.
  const purchaseBlocks = all.filter((n) => n.type === 'purchase');
  const purchaseType = fieldValue(purchaseBlocks[0], 'PURCHASE_LIST');
  if (!useInterpreter && purchaseType && contractTypeRaw && purchaseType !== contractTypeRaw) {
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
  const predictionOptions = all.find(
    (n) => n.type === 'tradeOptions' || n.type === 'trade_definition_tradeoptions'
  );
  // A program may derive its prediction at run time, from tick analysis or a
  // martingale variable. That digit cannot be read statically, so it is marked
  // dynamic and resolved per entry by the interpreter rather than refused here.
  const dynamicDigit =
    DIGIT_PREDICTION_TYPES.has(contractType) &&
    (useInterpreter ||
      predictionOptions?.inputs.find((input) => input.name === 'PREDICTION')?.block?.type ===
        'last_digit');
  const barrier = readBarrier(all);

  // A CALL/PUT strategy that configures a barrier is a Higher/Lower strategy:
  // DBot writes the same contract types for both and distinguishes them only by
  // the barrier. Reinterpreting it as Rise/Fall would silently place a
  // different trade than the author wrote, so the family follows the barrier.
  const contractFamily: ContractFamily =
    baseFamily === 'rise_fall' && barrier !== null ? 'higher_lower' : baseFamily;

  // A program supplies its digit and barrier per entry, so a missing static one
  // is not a defect: refusing here would reject a strategy that names them in a
  // variable. The plan engine reads them statically and must find them.
  //
  // "Resolved at run time" still requires somewhere to resolve it *from*. A digit
  // contract with no prediction input at all can never produce a digit, so it is
  // refused here rather than declining every entry for the life of the run.
  const hasPredictionInput = predictionOptions?.inputs.some(
    (input) => input.name === 'PREDICTION' && input.block !== null
  );
  if (
    useInterpreter &&
    DIGIT_PREDICTION_TYPES.has(contractType) &&
    !hasPredictionInput
  ) {
    reasons.push('The strategy buys a digit contract but names no digit prediction.');
  }
  if (!useInterpreter && DIGIT_PREDICTION_TYPES.has(contractType) && digit === null && !dynamicDigit) {
    reasons.push('The strategy buys a digit contract but names no digit prediction.');
  }
  if (!useInterpreter && contractFamily === 'higher_lower' && barrier === null) {
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
      dynamicDigit,
      barrier,
      conditions,
      indicators: [...indicators.values()],
      historyNeeded,
      stake,
      currency,
      duration,
      durationUnit,
      engine: useInterpreter ? 'interpreter' : 'plan'
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

function lastQuoteDigit(quote: number, pipSize: number): number {
  const scale = 10 ** pipSize;
  return Math.round(Math.abs(quote) * scale) % 10;
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

  // An interpreter plan carries no condition list: its entry rule lives in the
  // block tree. Evaluating it here would read "no conditions" as "always trade",
  // so it is refused rather than allowed to fall through to a vacuous entry.
  if (plan.engine === 'interpreter') {
    return {
      kind: 'ineligible',
      reason: 'This strategy is decided by its block program, not by plan conditions.'
    };
  }

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

    if (condition.kind === 'digit_prediction') {
      // Legacy digit strategies name the predicted digit through their trade
      // options. WickSentinel resolves it from the latest tick and returns it
      // with the entry verdict so the adapter builds the exact barrier.
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
  if (plan.dynamicDigit) {
    const pipSize = ticks[ticks.length - 1].pipSize;
    if (pipSize === null || !Number.isInteger(pipSize) || pipSize < 0) {
      return {
        kind: 'insufficient',
        reason: 'The latest tick has no valid pip size, so its last digit cannot be resolved.'
      };
    }
    return {
      kind: 'entry',
      direction: plan.direction,
      digit: lastQuoteDigit(last, pipSize),
      reason: `All ${plan.conditions.length} entry condition(s) satisfied; dynamic digit resolved from the latest tick.`
    };
  }
  return {
    kind: 'entry',
    direction: plan.direction,
    reason: `All ${plan.conditions.length} entry condition(s) satisfied.`
  };
}
