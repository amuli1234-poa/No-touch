/**
 * Deterministic interpreter for imported DBot strategies.
 *
 * `evaluator.ts` answers "do this strategy's entry conditions hold?" by
 * extracting a fixed plan. That works for the handful of shapes it models, but
 * a real DBot export is a *program*: variables, conditionals, arithmetic, text,
 * timers and post-trade result checks. A plan cannot represent a strategy whose
 * entry condition depends on a value computed three blocks earlier.
 *
 * This module executes the block tree instead. It is a small tree-walking
 * interpreter with JavaScript semantics, because that is what DBot itself
 * compiles its blocks to — each generator in `deriv-com/deriv-app`
 * (`packages/bot-skeleton/src/scratch/blocks`) emits JavaScript, and matching
 * that output is the only way to reproduce a strategy's behaviour rather than
 * approximate it.
 *
 * Design rules:
 *
 *  1. **Purity per tick.** Evaluating a tick reads the ticks, the run's
 *     variables and the settled-contract facts handed in. It performs no I/O
 *     and reads no clock, so the same inputs always produce the same verdict.
 *     That is what makes a purchase reproducible when a customer asks why it
 *     happened.
 *
 *  2. **Variables are run-scoped.** The caller owns the variable map and
 *     persists it per run. Nothing here is module-global, so one run's
 *     variables can never be read by another bot, another user or a later run.
 *
 *  3. **Unknown means unknown.** A block type absent from `VALUE_BLOCKS` /
 *     `STATEMENT_BLOCKS` raises `UnsupportedBlockError` rather than evaluating
 *     to a plausible-looking default. The caller refuses the strategy; it is
 *     never traded on a guess.
 *
 *  4. **Side effects are inert.** `notify` records a message for the caller to
 *     display. It cannot buy, sell or alter variables, so a notification
 *     failure cannot corrupt a decision.
 */

import type { MarketTick } from '../services/marketData.js';
import type { JsonValue } from './runTypes.js';
import type { BlockTree, TreeNode } from './tree.js';
import { fieldValue, findTopLevel, walkTree } from './tree.js';

/* ------------------------------- values --------------------------------- */

/**
 * A value a block can evaluate to.
 *
 * Mirrors the JavaScript values DBot's generators produce: numbers, strings,
 * booleans, arrays (the tick/digit lists) and `null` for an unset variable or
 * an absent contract detail.
 */
export type Value = number | string | boolean | null | Value[];

/* --------------------------- contract facts ----------------------------- */

/**
 * The settled-contract facts an `after_purchase` block may read.
 *
 * Built by the caller from the stored `ContractRecord`, never synthesised. A
 * field the record does not carry stays `null` so `read_details` returns null
 * rather than a fabricated number.
 */
export interface ContractFacts {
  /** Deriv transaction id of the purchase (`read_details` index 1). */
  buyTransactionId: number | string | null;
  buyPrice: number | null;
  /** Settlement value received (`read_details` index 3). */
  sellPrice: number | null;
  profit: number | null;
  contractType: string | null;
  /** Epoch milliseconds of entry; formatted to HH:mm:ss for index 6. */
  entryTime: number | null;
  entrySpot: number | null;
  /** Epoch milliseconds of settlement; formatted to HH:mm:ss for index 8. */
  exitTime: number | null;
  exitSpot: number | null;
  barrier: number | null;
  /** `win` when profit >= 0, `loss` otherwise — DBot's own rule. */
  result: 'win' | 'loss' | null;
}

/**
 * The live state of the contract the strategy currently holds, for
 * `check_sell` and `sell_price`.
 *
 * Mirrors the official engine, where `Bot.isSellAvailable()` reads
 * `is_valid_to_sell` off the streaming `proposal_open_contract` and
 * `getSellPrice()` reads `bid_price - buy_price`. Values are copied from the
 * stored record; nothing here is estimated.
 *
 * `null` fields mean "Deriv did not report this", which the blocks must treat as
 * "cannot decide" rather than as a false/zero answer.
 */
export interface OpenContractFacts {
  contractId: string;
  buyPrice: number | null;
  bidPrice: number | null;
  /** The contract's currency, which decides how the sale price is rounded. */
  currency?: string | null;
  /** True once Deriv reports the contract as sold. */
  isSold?: boolean;
  /** Deriv's own verdict on whether the contract can be sold right now. */
  isValidToSell: boolean | null;
  profit: number | null;
  payout: number | null;
  currentSpot: number | null;
  isExpired: boolean;
}

/** A notification a `notify` block asked to display. */
export interface InterpreterNotification {
  /** DBot's `success` | `info` | `warn` | `error`. */
  type: string;
  sound: string;
  message: string;
}

/**
 * Everything the interpreter may read while evaluating one tick.
 *
 * `variables` and `totalProfit` are owned by the run and passed back out
 * through `ExecutionResult`, so they persist across ticks without any module
 * state.
 */
export interface TickContext {
  ticks: MarketTick[];
  variables: Map<string, Value>;
  /** Realised profit for this run so far, from settled contracts. */
  totalProfit: number;
  /** Facts for the most recently settled contract, or null before the first. */
  lastContract: ContractFacts | null;
  /**
   * Procedure definitions in scope, so a `procedures_callreturn` used inside a
   * value expression can find its body. Populated by `executeStack`; absent when
   * a caller evaluates a bare value block, which has no procedures to reach.
   */
  procedures?: Map<string, ProcedureDef>;
  /** Current call depth, so a value-position call still respects the limit. */
  callDepth?: number;
  /**
   * The contract currently held, for `during_purchase` blocks that sell early.
   * Absent when no contract is open, which makes the sell blocks report
   * "unavailable" instead of acting on a contract that is not there.
   */
  openContract?: OpenContractFacts | null;
}

/** Thrown when a strategy uses a block this interpreter cannot execute. */
export class UnsupportedBlockError extends Error {
  readonly blockType: string;
  constructor(blockType: string) {
    super(`Block type "${blockType}" cannot be executed by this interpreter.`);
    this.name = 'UnsupportedBlockError';
    this.blockType = blockType;
  }
}

/** A timer a `timeout` block asked to schedule. */
export interface ScheduledTimeout {
  /** Milliseconds to wait, as DBot's `sleep(seconds)` would. */
  delayMs: number;
  /** The stack to run once the delay elapses. */
  stack: TreeNode | null;
  /**
   * The rest of the enclosing statement chain, which DBot runs *after* the
   * delayed stack. Kept separate rather than linked onto `stack` so the
   * parsed tree is never mutated.
   */
  continuation: TreeNode | null;
}

/** Outcome of running a stack of statements. */
export interface StackOutcome {
  /** Set when a `purchase` block ran: the contract type to buy. */
  purchase: string | null;
  /** True when `trade_again` ran, i.e. the strategy wants another entry. */
  tradeAgain: boolean;
  /** Timers scheduled during this execution, in the order they were reached. */
  timeouts: ScheduledTimeout[];
  /** Notifications raised during this execution, in order. */
  notifications: InterpreterNotification[];
  /**
   * Set when `sell_at_market` ran: the contract the strategy asked to close.
   *
   * The interpreter does not sell. It records the request and the run service
   * performs the sale through the execution gateway, so the ownership, lock,
   * idempotency and audit checks all still apply.
   */
  sellRequest: { contractId: string } | null;
}

/** Result of executing a lifecycle stack for one tick. */
export interface ExecutionResult extends StackOutcome {
  /** Variable state after execution, to persist on the run. */
  variables: Map<string, Value>;
}

/* --------------------------- block registries --------------------------- */

/**
 * Blocks that evaluate to a value.
 *
 * Each entry is a function of `(node, context)`; none of them may mutate the
 * context. A block absent from this map is unsupported — see rule 3.
 */
const VALUE_BLOCKS: Record<string, (node: TreeNode, ctx: TickContext) => Value> = {
  /* ------------------------------ literals ------------------------------ */
  math_number: (node) => readNumberField(node, 'NUM') ?? 0,
  math_number_positive: (node) => readNumberField(node, 'NUM') ?? 0,
  math_constant: (node) => MATH_CONSTANTS[fieldValue(node, 'CONSTANT') ?? ''] ?? null,
  logic_boolean: (node) => fieldValue(node, 'BOOL') === 'TRUE',
  logic_null: () => null,
  text: (node) => fieldValue(node, 'TEXT') ?? '',

  /* ------------------------------ variables ----------------------------- */
  variables_get: (node, ctx) => readVariable(node, ctx),

  /* ------------------------------- logic -------------------------------- */
  logic_compare: (node, ctx) => compareValues(node, ctx),
  logic_operation: (node, ctx) => logicalOperation(node, ctx),
  logic_negate: (node, ctx) => !truthy(evaluateInput(node, 'BOOL', ctx)),
  logic_ternary: (node, ctx) =>
    truthy(evaluateInput(node, 'IF', ctx))
      ? evaluateInput(node, 'THEN', ctx)
      : evaluateInput(node, 'ELSE', ctx),

  /* -------------------------------- math -------------------------------- */
  math_arithmetic: (node, ctx) => arithmetic(node, ctx),
  math_single: (node, ctx) => singleOperandMath(node, ctx),
  math_round: (node, ctx) => roundValue(node, ctx),
  math_modulo: (node, ctx) => {
    const dividend = toNumber(evaluateInput(node, 'DIVIDEND', ctx));
    const divisor = toNumber(evaluateInput(node, 'DIVISOR', ctx));
    // JS `%` is a remainder with the dividend's sign; Blockly emits `a % b`.
    return divisor === 0 ? NaN : dividend % divisor;
  },
  math_constrain: (node, ctx) => {
    const value = toNumber(evaluateInput(node, 'VALUE', ctx));
    const low = toNumber(evaluateInput(node, 'LOW', ctx));
    const high = toNumber(evaluateInput(node, 'HIGH', ctx));
    return Math.min(Math.max(value, low), high);
  },

  /* ----------------------------- early selling -------------------------- */
  // DBot: `Bot.getSellPrice()` = `round(bid_price - buy_price)`. Null when
  // either term is missing, because a price computed from a missing bid would
  // be a number the strategy never could have obtained.
  sell_price: (_node, ctx) => {
    const open = ctx.openContract ?? null;
    if (!open || open.bidPrice === null || open.buyPrice === null) return null;
    if (!Number.isFinite(open.bidPrice) || !Number.isFinite(open.buyPrice)) return null;
    const digits = currencyDecimalPlaces(open.currency);
    return Number((open.bidPrice - open.buyPrice).toFixed(digits));
  },
  // DBot: `Bot.isSellAvailable()` = `contractId && !isSold && isSellAvailable
  // && !isExpired`. A missing verdict is *not* availability: refusing to sell is
  // recoverable, selling a contract the platform never approved is not.
  check_sell: (_node, ctx) => {
    const open = ctx.openContract ?? null;
    if (!open) return false;
    // Official: `contractId && !isSold && isSellAvailable && !isExpired`.
    // `isSellAvailable` is `!isSold && is_valid_to_sell`, and a sold contract is
    // reported as such, so both conditions reduce to the two checks below.
    if (open.isSold) return false;
    if (open.isValidToSell !== true) return false;
    if (open.isExpired) return false;
    return open.contractId !== '';
  },

  /* -------------------------------- text -------------------------------- */
  text_join: (node, ctx) => textJoinValue(node, ctx),
  text_length: (node, ctx) => String(evaluateInput(node, 'VALUE', ctx) ?? '').length,
  text_isEmpty: (node, ctx) => String(evaluateInput(node, 'VALUE', ctx) ?? '').length === 0,

  /* -------------------------------- lists ------------------------------- */
  lists_getIndex: (node, ctx) => listGetIndex(node, ctx),
  lists_length: (node, ctx) => toList(evaluateInput(node, 'VALUE', ctx)).length,
  lists_isEmpty: (node, ctx) => toList(evaluateInput(node, 'VALUE', ctx)).length === 0,
  lists_indexOf: (node, ctx) => listIndexOf(node, ctx),

  /* ----------------------------- tick access ---------------------------- */
  last_digit: (node, ctx) => lastDigitOfLatest(ctx),
  lastDigitList: (node, ctx) => lastDigitList(ctx),
  check_direction: (node, ctx) => {
    const wanted = fieldValue(node, 'CHECK_DIRECTION') ?? '';
    return marketDirection(ctx.ticks) === wanted;
  },
  tick: (node, ctx) => {
    const latest = ctx.ticks[ctx.ticks.length - 1];
    return latest ? latest.quote : null;
  },
  tick_string: (node, ctx) => {
    const latest = ctx.ticks[ctx.ticks.length - 1];
    return latest ? formatQuote(latest.quote, latest.pipSize) : null;
  },
  ticks: (node, ctx) => ctx.ticks.map((tick) => tick.quote),
  ticks_string: (node, ctx) =>
    ctx.ticks.map((tick) => formatQuote(tick.quote, tick.pipSize)),

  /* ---------------------------- procedures ------------------------------ */
  // A `procedures_callreturn` yields the procedure's return value. It is
  // evaluated here so it can be used inside a condition, as DBot allows.
  procedures_callreturn: (node, ctx) => callProcedureForValue(node, ctx),

  /* -------------------------- contract details -------------------------- */
  contract_check_result: (node, ctx) => {
    const wanted = fieldValue(node, 'CHECK_RESULT') ?? '';
    return ctx.lastContract?.result === wanted;
  },
  read_details: (node, ctx) => readContractDetail(node, ctx.lastContract),
  total_profit: (node, ctx) => ctx.totalProfit,
  total_profit_string: (node, ctx) => String(ctx.totalProfit)
};

/**
 * Blocks that perform an action and have no value.
 *
 * `executeStack` walks these in `<next>` order. Each may itself schedule
 * timers or raise notifications, which the caller collects.
 */
/**
 * How a stack finished, for the loop and procedure constructs that need to know.
 *
 * `normal` is falling off the end. `break`/`continue`/`return` are the signals
 * `controls_flow_statements` and `procedures_ifreturn` raise. `halt` means a
 * `purchase` or `trade_again` ran: DBot ends the whole strategy there, so every
 * enclosing loop and procedure must stop too.
 */
type FlowSignal = 'normal' | 'break' | 'continue' | 'return' | 'halt' | 'suspend';

interface StatementContext {
  ctx: TickContext;
  outcome: StackOutcome;
  /** Signal raised by the innermost running stack; read by loops. */
  flow: FlowSignal;
  /** Value a `procedures_ifreturn` returned, when `flow` is 'return'. */
  returnValue: Value;
  /** Procedure definitions in scope, keyed by name. */
  procedures: Map<string, ProcedureDef>;
  /** Nesting depth of procedure calls, to bound runaway recursion. */
  callDepth: number;
}

/** A `procedures_def*` block, resolved once per tick. */
interface ProcedureDef {
  name: string;
  /**
   * Parameters in declaration order, from `<mutation><arg>` children.
   *
   * DBot writes both a display name and a `varid`; the id is what a
   * `variables_get` inside the body refers to, so both are kept.
   */
  args: { name: string; varid: string | null }[];
  /** The body, from the `STACK` statement input. */
  body: TreeNode | null;
  /** True when the definition carries a `RETURN` value input. */
  hasReturn: boolean;
  /** The definition block itself, so its `RETURN` input can be evaluated. */
  node: TreeNode;
}

/**
 * DBot's own runaway guards, copied so a strategy behaves here as it does there.
 *
 * `controls_whileUntil` throws after 10000 iterations, and the JS generator
 * traps every loop; using the same numbers means a strategy that loops forever
 * fails here at the same point it fails on Deriv.
 */
const MAX_LOOP_ITERATIONS = 10000;
/** Bound on nested procedure calls, well under any engine stack limit. */
const MAX_CALL_DEPTH = 64;
/** Bound on a single `repeat N times`, so a huge N cannot hang the tick loop. */
const MAX_REPEAT_COUNT = 100000;

/** Thrown when a strategy exceeds a documented execution bound. */
export class ExecutionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionLimitError';
  }
}

const STATEMENT_BLOCKS: Record<string, (node: TreeNode, sc: StatementContext) => void> = {
  /* ------------------------------ variables ----------------------------- */
  /**
   * `lists_create_with` builds a list from its `STACK` of `lists_statement`
   * children and assigns it to `VARIABLE`.
   *
   * Deriv models list creation as a statement, not a value expression, so this
   * is the only way a real export produces a list.
   */
  lists_create_with: (node, sc) => {
    const key = variableKey(node);
    if (!key) return;
    const list: Value[] = [];
    let item = inputBlock(node, 'STACK');
    while (item) {
      if (item.type === 'lists_statement') {
        list.push(evaluateInput(item, 'VALUE', sc.ctx));
      }
      item = item.next;
    }
    sc.ctx.variables.set(key, list);
  },

  /**
   * `lists_statement` is a child of `lists_create_with` and carries one element.
   *
   * It is only meaningful inside that container, which collects the elements
   * itself, so reaching one in a plain stack is a no-op rather than an error.
   */
  lists_statement: () => {},

  variables_set: (node, sc) => {
    writeVariable(node, evaluateInput(node, 'VALUE', sc.ctx), sc.ctx);
  },
  math_change: (node, sc) => {
    const delta = toNumber(evaluateInput(node, 'DELTA', sc.ctx));
    const current = readVariable(node, sc.ctx);
    // DBot: `x = (typeof x === 'number' ? x : 0) + delta`
    writeVariable(node, (typeof current === 'number' ? current : 0) + delta, sc.ctx);
  },

  /* -------------------------------- text -------------------------------- */
  // DBot's `text_join` is a *statement* that assigns to a variable, and its
  // generator joins with a single space (`[...].join(" ")`) even though the
  // block's own description says "without spaces". The generator is what runs,
  // so a space is the behaviour being reproduced.
  text_join: (node, sc) => {
    const parts = stackOf(node, 'STACK').map((child) => {
      const value = evaluateInput(child, 'TEXT', sc.ctx);
      return value === null ? '' : String(value);
    });
    writeVariable(node, parts.join(' '), sc.ctx);
  },

  /* -------------------------------- logic ------------------------------- */
  controls_if: (node, sc) => executeIf(node, sc),

  /* -------------------------------- misc -------------------------------- */
  notify: (node, sc) => {
    const message = evaluateInput(node, 'MESSAGE', sc.ctx);
    sc.outcome.notifications.push({
      type: fieldValue(node, 'NOTIFICATION_TYPE') ?? 'info',
      sound: fieldValue(node, 'NOTIFICATION_SOUND') ?? 'silent',
      // DBot falls back to "<empty message>" for a blank input.
      message: message === null || message === '' ? '<empty message>' : String(message)
    });
  },
  /* ----------------------------- indicators ----------------------------- */
  // DBot: `var = Bot.sma(inputList, period)`. The input list is the block's
  // INPUT_LIST child; when it is absent DBot passes `undefined`, so the
  // indicator cannot be computed and the variable is set to null rather than a
  // guessed average.
  sma_statement: (node, sc) => writeIndicator(node, sc, 'sma'),
  ema_statement: (node, sc) => writeIndicator(node, sc, 'ema'),
  timeout: (node, sc) => {
    const seconds = toNumber(evaluateInput(node, 'SECONDS', sc.ctx));
    // DBot's generator defaults a missing SECONDS input to 1.
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 1;
    // DBot compiles this block to `sleep(n); <TIMEOUTSTACK>; <following blocks>`:
    // everything after the timeout waits, not just the nested stack.
    sc.outcome.timeouts.push({
      delayMs: safeSeconds * 1000,
      stack: inputBlock(node, 'TIMEOUTSTACK'),
      continuation: node.next
    });
    // The caller must stop walking this chain — see `executeStack`.
    sc.flow = 'suspend';
  },

  /* -------------------------- loops and flow ---------------------------- */
  controls_repeat: executeRepeat,
  controls_repeat_ext: executeRepeat,
  controls_whileUntil: executeWhileUntil,
  controls_for: executeFor,
  controls_forEach: executeForEach,
  controls_flow_statements: (node, sc) => {
    sc.flow = fieldValue(node, 'FLOW') === 'BREAK' ? 'break' : 'continue';
  },

  /* ---------------------------- procedures ------------------------------ */
  // A definition is hoisted, not executed: `collectProcedures` already recorded
  // it, and running the body inline would call it before it is ever invoked.
  procedures_defnoreturn: () => {},
  procedures_defreturn: () => {},
  procedures_callnoreturn: (node, sc) => {
    executeProcedureCall(node, sc, false);
  },
  procedures_ifreturn: (node, sc) => {
    // DBot's `procedures_ifreturn` runs `return` when its condition holds.
    const condition = inputBlock(node, 'CONDITION');
    if (condition && !truthy(evaluateBlock(condition, sc.ctx))) return;
    const value = inputBlock(node, 'VALUE');
    sc.returnValue = value ? evaluateBlock(value, sc.ctx) : null;
    sc.flow = 'return';
  },

  /* ----------------------------- lifecycle ------------------------------ */
  purchase: (node, sc) => {
    const type = fieldValue(node, 'PURCHASE_LIST');
    if (type) sc.outcome.purchase = type;
  },
  trade_again: (_node, sc) => {
    sc.outcome.tradeAgain = true;
  },
  /**
   * DBot: `Bot.sellAtMarket()` sends `{ sell: contractId, price: 0 }`, where a
   * zero price means "at market".
   *
   * The sale itself is not performed here. The interpreter records the request
   * and the run service routes it through the execution gateway, which owns the
   * ownership check, the account lock, idempotency and the audit trail. A block
   * that sold directly would bypass all of them.
   */
  sell_at_market: (_node, sc) => {
    const open = sc.ctx.openContract ?? null;
    if (!open) {
      sc.outcome.notifications.push({
        type: 'warn',
        sound: 'silent',
        message: 'Sell at market was skipped: no contract is open.'
      });
      return;
    }
    sc.outcome.sellRequest = { contractId: open.contractId };
  }
};

/** Every block type this interpreter can execute, values and statements. */
export const INTERPRETED_BLOCKS: readonly string[] = [
  ...new Set([...Object.keys(VALUE_BLOCKS), ...Object.keys(STATEMENT_BLOCKS)])
].sort();

/** True when `type` has an implemented semantics in this interpreter. */
export function isInterpreted(type: string): boolean {
  return type in VALUE_BLOCKS || type in STATEMENT_BLOCKS;
}

/**
 * True when a block type produces a value rather than an action.
 *
 * DBot never wires a value block into a statement slot. A strategy that does is
 * written in WickSentinel's own simplified dialect, where a bare
 * `check_direction` stands in for "only buy when this holds".
 */
export function isValueBlock(type: string): boolean {
  return type in VALUE_BLOCKS;
}

/**
 * True when the strategy's entry stack is a genuine DBot program.
 *
 * Two conditions, both mechanical:
 *
 *  1. Every block in statement position must be a statement block. A real DBot
 *     export nests its conditions inside `controls_if`; the simplified dialect —
 *     a bare `check_direction` with a `next` block — does not, and stays with the
 *     plan evaluator that already models it.
 *
 *  2. Somewhere in the entry stack there must be a `controls_if`, i.e. an actual
 *     decision. A stack that is only `purchase` buys on every tick. DBot allows
 *     that, but WickSentinel has always refused an unconditional strategy, and
 *     silently starting to trade one would change how existing bots behave.
 *
 * The decision is searched for recursively, not just along the top-level chain:
 * a real strategy may wrap its entry logic in `timeout` or a loop, and refusing
 * those because the `controls_if` sits one level deeper would reject a program
 * the interpreter can genuinely run.
 */
export function isDbProgram(tree: BlockTree): boolean {
  const before = findTopLevel(tree, 'before_purchase');
  const stack = before ? inputBlock(before, 'BEFOREPURCHASE_STACK') : null;
  if (!stack) return false;
  let hasDecision = false;
  for (const node of walkStack(stack)) {
    if (isValueBlock(node.type)) return false;
    if (node.type === 'controls_if') hasDecision = true;
  }
  return hasDecision;
}

/**
 * Every statement block reachable from a stack, following nested statement
 * inputs as well as the `<next>` chain.
 *
 * Value inputs are not descended into: a `controls_if` condition is a value
 * expression, and counting one there would call a strategy "programmatic" for a
 * decision it never actually makes in statement position.
 */
function* walkStack(stack: TreeNode | null): Generator<TreeNode> {
  let node = stack;
  while (node) {
    yield node;
    for (const input of node.inputs) {
      if (input.kind === 'statement') yield* walkStack(input.block);
    }
    node = node.next;
  }
}

/* --------------------------- run state bridge --------------------------- */

/** Upper bound on distinct variables one run may hold. */
const MAX_VARIABLES = 200;

/** Upper bound on elements retained in a list-valued variable. */
const MAX_LIST_LENGTH = 1000;

/**
 * Converts a persisted variable map into interpreter scope.
 *
 * Values come back from JSON, so a list stays a list and a number stays a
 * number; anything that is not a recognised shape is dropped rather than
 * coerced, so a corrupted record cannot become a number the strategy acts on.
 */
export function loadVariables(raw: Record<string, unknown> | null | undefined): Map<string, Value> {
  const variables = new Map<string, Value>();
  if (!raw) return variables;
  for (const [key, value] of Object.entries(raw)) {
    const normalised = normaliseValue(value);
    if (normalised !== undefined) variables.set(key, normalised);
  }
  return variables;
}

/**
 * Serialises interpreter scope for persistence.
 *
 * Non-finite numbers become `null`: JSON has no NaN/Infinity, and silently
 * writing `null` keeps the record honest — the strategy sees a value that is
 * absent rather than one that is wrong.
 */
export function saveVariables(variables: Map<string, Value>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  let count = 0;
  for (const [key, value] of variables) {
    if (count >= MAX_VARIABLES) break;
    out[key] = toJsonValue(value);
    count += 1;
  }
  return out;
}

function normaliseValue(value: unknown): Value | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const list: Value[] = [];
    for (const item of value.slice(0, MAX_LIST_LENGTH)) {
      const normalised = normaliseValue(item);
      if (normalised !== undefined) list.push(normalised);
    }
    return list;
  }
  return undefined;
}

function toJsonValue(value: Value): JsonValue {
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LIST_LENGTH).map((item) => {
      const inner = toJsonValue(item);
      return Array.isArray(inner) ? null : inner;
    });
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value;
}

/* ----------------------------- entry points ----------------------------- */

/**
 * Runs the strategy's `before_purchase` stack for one tick.
 *
 * This is the entry decision: if the stack reaches a `purchase` block, the
 * returned `purchase` names the contract type to buy. A strategy that does not
 * reach `purchase` returns `purchase: null`, which the caller treats as "no
 * entry" — never as a default buy.
 */
export function runBeforePurchase(tree: BlockTree, ctx: TickContext): ExecutionResult {
  const before = findTopLevel(tree, 'before_purchase');
  const stack = before ? inputBlock(before, 'BEFOREPURCHASE_STACK') : null;
  return executeStack(stack, ctx, tree);
}

/**
 * Runs the strategy's `INITIALIZATION` stack, which DBot executes once before
 * the tick loop starts.
 *
 * Declarations such as stake, session limits and loop counters live here, so a
 * run that skipped it would evaluate every later comparison against an unset
 * variable. That is not a conservative failure: `undefined < 100` is false, so
 * the strategy's own entry gate would silently never open.
 *
 * A legacy export has no `INITIALIZATION`: its declarations sit in the `trade`
 * block's `SUBMARKET` statement, which DBot's own loader migrates on import
 * (`naivelyFixLegacyStrategyAfterConversion`). It moves everything in
 * `SUBMARKET` except the trade-options block into `INITIALIZATION`, because
 * `SUBMARKET` is re-run before every trade and a martingale counter kept there
 * would be reset each time. Skipping that migration would run a martingale at a
 * flat stake, so the same rule is applied here, at the point the stack is read.
 */
export function runInitialization(tree: BlockTree, ctx: TickContext): ExecutionResult {
  const trade = findTopLevel(tree, 'trade') ?? findTopLevel(tree, 'trade_definition');
  const stack = trade ? initializationStack(tree, trade) : null;
  return executeStack(stack, ctx, tree);
}

/** Trade-options blocks, which stay in `SUBMARKET` when legacy XML is migrated. */
const TRADE_OPTIONS_BLOCKS = new Set(['market', 'tradeOptions', 'trade_definition_tradeoptions']);

/**
 * The stack DBot would initialise from, for either trade-definition generation.
 *
 * When a strategy already has an `INITIALIZATION` stack that is the whole
 * answer — DBot only migrates into an empty one. Otherwise a legacy `SUBMARKET`
 * chain is split: the trade-options block stays behind (it is the trade
 * definition, not a declaration) and every other block is initialisation.
 *
 * The migration is gated on the legacy `market` block, as DBot's is: only that
 * generation put declarations in `SUBMARKET`. A `trade`-rooted export without
 * one keeps its trade options there and has nothing to initialise, so reading
 * `SUBMARKET` as declarations would run the trade definition as if it were a
 * statement.
 */
function initializationStack(tree: BlockTree, trade: TreeNode): TreeNode | null {
  const explicit = inputBlock(trade, 'INITIALIZATION');
  if (explicit) return explicit;

  if (!walkTree(tree).some((node) => node.type === 'market')) return null;

  const submarket = inputBlock(trade, 'SUBMARKET');
  if (!submarket) return null;

  const kept: TreeNode[] = [];
  for (const node of stackChain(submarket)) {
    if (!TRADE_OPTIONS_BLOCKS.has(node.type)) kept.push(node);
  }
  // The migration is a no-op when `SUBMARKET` holds only the trade definition.
  if (kept.length === 0) return null;
  return chain(kept);
}

/** Every block along a stack, in order. */
function* stackChain(start: TreeNode): Generator<TreeNode> {
  let node: TreeNode | null = start;
  while (node) {
    yield node;
    node = node.next;
  }
}

/** Links copies of `nodes` into a stack, returning its head. */
function chain(nodes: TreeNode[]): TreeNode | null {
  // The nodes are copied so re-linking them does not rewrite the strategy tree:
  // `SUBMARKET` is read again on every later trade, and a mutated `next` chain
  // would drop the trade-options block out of it permanently.
  const copies = nodes.map((node) => ({ ...node, next: null as TreeNode | null }));
  for (let i = 0; i < copies.length; i += 1) {
    copies[i].next = copies[i + 1] ?? null;
  }
  return copies[0] ?? null;
}

/**
 * Runs the strategy's `tick_analysis` stack for the current tick.
 *
 * DBot runs every registered tick-analysis function before the entry decision,
 * which is how a program derives per-tick state (the digit it will predict, a
 * detected pair) that `before_purchase` then reads. Running it after the entry
 * decision would act on the previous tick's analysis.
 */
export function runTickAnalysis(tree: BlockTree, ctx: TickContext): ExecutionResult {
  const analysis = findTopLevel(tree, 'tick_analysis');
  const stack = analysis ? inputBlock(analysis, 'TICKANALYSIS_STACK') : null;
  return executeStack(stack, ctx, tree);
}

/**
 * Resolves the digit a strategy will predict, by evaluating its trade options'
 * prediction input against the run's current variables.
 *
 * A DBot export commonly writes the prediction as `variables_get`, deriving it
 * from the tick analysis, so the digit only exists at run time. Reading the
 * literal field instead would either find nothing or, worse, act on a stale
 * default the author never intended to trade.
 *
 * Returns `null` when the strategy names no prediction, or when the value it
 * names is not a digit — the caller must treat that as "cannot place", never as
 * a substitute digit.
 */
export function resolveDigitPrediction(tree: BlockTree, ctx: TickContext): number | null {
  const options = walkTree(tree).find(
    (node) => node.type === 'tradeOptions' || node.type === 'trade_definition_tradeoptions'
  );
  if (!options) return null;
  const input = options.inputs.find((item) => item.name === 'PREDICTION' || item.name === 'BARRIER');
  const value = evaluateBlock(input?.block ?? null, ctx);
  const digit = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof digit !== 'number' || !Number.isInteger(digit) || digit < 0 || digit > 9) return null;
  return digit;
}

/**
 * Runs the strategy's `during_purchase` stack for the contract currently held.
 *
 * DBot evaluates this stack on every `proposal_open_contract` update, which is
 * how a strategy decides to sell early: the stack calls `check_sell`, compares
 * `sell_price` against its own threshold, then calls `sell_at_market`.
 *
 * `ctx.openContract` must carry the live contract, because every sell decision
 * is a read of it. With no contract open the stack is not run at all — DBot
 * only enters the during-purchase phase once a contract exists.
 */
export function runDuringPurchase(tree: BlockTree, ctx: TickContext): ExecutionResult {
  const during = findTopLevel(tree, 'during_purchase');
  const stack = during ? inputBlock(during, 'DURING_PURCHASE_STACK') : null;
  return executeStack(stack, ctx, tree);
}

/**
 * Runs the strategy's `after_purchase` stack against a settled contract.
 *
 * DBot runs this once per settled contract to inspect the result and decide
 * whether to trade again. `lastContract` must carry the real settled facts.
 */
export function runAfterPurchase(tree: BlockTree, ctx: TickContext): ExecutionResult {
  const after = findTopLevel(tree, 'after_purchase');
  const stack = after ? inputBlock(after, 'AFTERPURCHASE_STACK') : null;
  return executeStack(stack, ctx, tree);
}

/**
 * Executes a stack of statements in `<next>` order.
 *
 * Stops at the first `purchase` or `trade_again`, matching DBot: `purchase` is
 * terminal for the before-purchase stack, and `trade_again` returns out of the
 * after-purchase function.
 */
export function executeStack(
  stack: TreeNode | null,
  ctx: TickContext,
  tree: BlockTree | null = null
): ExecutionResult {
  const outcome: StackOutcome = {
    purchase: null,
    tradeAgain: false,
    timeouts: [],
    notifications: [],
    sellRequest: null
  };
  const sc: StatementContext = {
    ctx,
    outcome,
    flow: 'normal',
    returnValue: null,
    procedures: collectProcedures(tree),
    callDepth: 0
  };
  ctx.procedures = sc.procedures;

  runNestedStack(stack, sc);
  return { ...outcome, variables: ctx.variables };
}

/**
 * Runs a `timeout` block's delayed work once its delay has elapsed.
 *
 * DBot compiles `timeout` to `sleep(n); <TIMEOUTSTACK>; <rest of the chain>`, so
 * the strategy is paused for the delay and then resumes from inside the block.
 * The caller owns the waiting; this only replays what was captured.
 *
 * A second `timeout` reached in either part simply queues another deferral on
 * the returned outcome, and the caller schedules that in turn.
 */
export function runDeferredTimeout(
  timeout: ScheduledTimeout,
  ctx: TickContext,
  tree: BlockTree | null = null
): ExecutionResult {
  const outcome: StackOutcome = {
    purchase: null,
    tradeAgain: false,
    timeouts: [],
    notifications: [],
    sellRequest: null
  };
  const sc: StatementContext = {
    ctx,
    outcome,
    flow: 'normal',
    returnValue: null,
    procedures: collectProcedures(tree),
    callDepth: 0
  };
  ctx.procedures = sc.procedures;

  runNestedStack(timeout.stack, sc);
  // A nested timeout inside the delayed stack owns the continuation itself.
  if (sc.flow === 'normal' && outcome.purchase === null && !outcome.tradeAgain) {
    runNestedStack(timeout.continuation, sc);
  }
  return { ...outcome, variables: ctx.variables };
}

/**
 * Procedures reachable from a stack.
 *
 * DBot hoists every `procedures_def*` block before running, so a call may appear
 * above its definition. Definitions live at the top level of the workspace, so
 * the caller passes the tree rather than the stack.
 */
function collectProcedures(tree: BlockTree | null): Map<string, ProcedureDef> {
  const procedures = new Map<string, ProcedureDef>();
  if (!tree) return procedures;
  // Blockly keys variables by id; a parameter declared only by name still has
  // an id in `<variables>`, and the body reads it through that id.
  const declared = new Map<string, string>();
  for (const variable of tree.variables) declared.set(variable.name, variable.id);
  for (const node of walkTree(tree)) {
    if (
      node.type !== 'procedures_defnoreturn' &&
      node.type !== 'procedures_defreturn'
    ) {
      continue;
    }
    const name = procedureName(node);
    if (!name) continue;
    procedures.set(name, {
      name,
      args: procedureArgs(node, declared),
      body: inputBlock(node, 'STACK'),
      hasReturn: node.type === 'procedures_defreturn',
      node
    });
  }
  return procedures;
}

/**
 * Parameter names from a definition's mutation, in declaration order.
 *
 * Blockly stores them as `<mutation><arg name="x"/></mutation>`; the order is
 * the call-site argument order, so it must not be sorted or de-duplicated.
 */
function procedureArgs(
  node: TreeNode,
  declared: Map<string, string>
): { name: string; varid: string | null }[] {
  const args: { name: string; varid: string | null }[] = [];
  for (const child of node.mutationChildren ?? []) {
    if (child.name !== 'arg') continue;
    const name = child.attrs.name;
    if (typeof name !== 'string' || name === '') continue;
    // A mutation normally carries `varid`, but older exports omit it. Blockly
    // resolves such a parameter by name against the workspace's variables, so
    // the body's `variables_get` ends up holding the declared id. Falling back
    // to the name alone would leave those reads unbound.
    const varid = child.attrs.varid ?? child.attrs.varId ?? declared.get(name) ?? null;
    args.push({ name, varid });
  }
  return args;
}

/**
 * The procedure a call block targets.
 *
 * Blockly stores it on the `<mutation name="...">` attribute for a call, and in
 * the `NAME` field for a definition. A hand-written export may use either, so
 * both are consulted.
 */
function procedureName(node: TreeNode): string | null {
  const fromField = fieldValue(node, 'NAME');
  if (fromField) return fromField;
  const fromMutation = node.mutation?.name;
  if (typeof fromMutation === 'string' && fromMutation !== '') return fromMutation;
  return null;
}

/**
 * Evaluates a block to a value.
 *
 * A `shadow` literal is read from its fields directly, because DBot stores
 * numeric defaults as shadows rather than real blocks.
 */
export function evaluateBlock(node: TreeNode | null, ctx: TickContext): Value {
  if (!node) return null;
  if (node.shadow) return evaluateShadow(node);
  const handler = VALUE_BLOCKS[node.type];
  if (!handler) throw new UnsupportedBlockError(node.type);
  return handler(node, ctx);
}

/* ------------------------------ internals ------------------------------- */

function evaluateShadow(node: TreeNode): Value {
  if (node.type === 'math_number' || node.type === 'math_number_positive') {
    return readNumberField(node, 'NUM') ?? 0;
  }
  if (node.type === 'text') return fieldValue(node, 'TEXT') ?? '';
  if (node.type === 'logic_boolean') return fieldValue(node, 'BOOL') === 'TRUE';
  return null;
}

/** Evaluates the block wired into `name`, or null when the input is empty. */
function evaluateInput(node: TreeNode, name: string, ctx: TickContext): Value {
  return evaluateBlock(inputBlock(node, name), ctx);
}

/** Returns the block connected to a named input, if any. */
function inputBlock(node: TreeNode, name: string): TreeNode | null {
  const input = node.inputs.find((item) => item.name === name);
  return input?.block ?? null;
}

/** Walks a `<statement>` input as a flat array, for order-sensitive joins. */
function stackOf(node: TreeNode, name: string): TreeNode[] {
  const out: TreeNode[] = [];
  let current = inputBlock(node, name);
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
}

function readNumberField(node: TreeNode, name: string): number | null {
  const raw = fieldValue(node, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The key a variable block refers to.
 *
 * The id is preferred because two variables may share a display name, and the
 * id is what Blockly itself keys on. Exports from some DBot versions omit ids,
 * so the display name is the fallback.
 *
 * DBot is inconsistent about the *field* name: `variables_set`, `variables_get`,
 * `math_change` and `text_append` use `VAR`, while `text_join`, indicators and
 * `lists_create_with` use `VARIABLE`. Reading only one would silently drop
 * every write made by the other half of the library.
 */
function variableKey(node: TreeNode): string | null {
  const field =
    node.fields.find((item) => item.name === 'VAR') ??
    node.fields.find((item) => item.name === 'VARIABLE');
  if (!field) return null;
  return field.id ?? field.value;
}

/**
 * Binds a loop variable or procedure parameter under both its id and its name.
 *
 * `variableKey` prefers a block's `id`, falling back to the display name. DBot
 * normally writes ids everywhere, but exports exist where a `variables_get`
 * omits one while the declaring block keeps it. Writing both keys means either
 * style of reference resolves to the value the loop or procedure just bound,
 * instead of reading an unrelated variable that happens to share the name.
 */
function bindScopedVariable(
  variables: Map<string, Value>,
  id: string | undefined,
  name: string,
  value: Value
): void {
  if (id !== undefined && id !== name) variables.set(id, value);
  variables.set(name, value);
}

function readVariable(node: TreeNode, ctx: TickContext): Value {
  const key = variableKey(node);
  if (key === null) return null;
  // An unset variable reads as null, matching an undefined JS binding used
  // before assignment rather than inventing a 0.
  return ctx.variables.get(key) ?? null;
}

function writeVariable(node: TreeNode, value: Value, ctx: TickContext): void {
  const key = variableKey(node);
  if (key === null) return;
  ctx.variables.set(key, value);
}

/**
 * Fractional digits Deriv uses when it rounds a money amount, transcribed from
 * the official client (`packages/shared/src/utils/currency/currency.ts`).
 *
 * `getSellPrice()` is `getRoundedNumber(bid - buy, currency)`, i.e.
 * `Number(diff.toFixed(digits))`. Rounding to an integer would be a different
 * number for every non-zero decimal, and the strategy compares against its own
 * threshold, so the digits matter.
 *
 * Only currencies with a non-default value are listed: everything else is a fiat
 * currency with 2 digits, which is the official fallback in `calcDecimalPlaces`.
 */
const CURRENCY_FRACTIONAL_DIGITS: Record<string, number> = {
  BTC: 8,
  BCH: 8,
  ETH: 8,
  ETC: 8,
  LTC: 8,
  XRP: 6,
  IDK: 0
};

/** Decimal places for a currency, matching the official `getDecimalPlaces`. */
function currencyDecimalPlaces(currency: string | null | undefined): number {
  if (!currency) return 2;
  const digits = CURRENCY_FRACTIONAL_DIGITS[currency];
  return typeof digits === 'number' ? digits : 2;
}

const MATH_CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
  GOLDEN_RATIO: (1 + Math.sqrt(5)) / 2,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
  INFINITY: Infinity
};

const COMPARE_OPS = new Set(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE']);

function compareValues(node: TreeNode, ctx: TickContext): boolean {
  const op = fieldValue(node, 'OP') ?? '';
  if (!COMPARE_OPS.has(op)) return false;
  const left = evaluateInput(node, 'A', ctx);
  const right = evaluateInput(node, 'B', ctx);

  // Blockly emits `==`/`!=` (loose), and `<`/`>` for ordering. Loose equality
  // coerces, so a `variables_set` storing "5" compares equal to the literal 5 —
  // reproducing the generated code matters more than the tidier `===`.
  switch (op) {
    case 'EQ':
      return looseEquals(left, right);
    case 'NEQ':
      return !looseEquals(left, right);
    default:
      break;
  }

  const a = comparable(left);
  const b = comparable(right);
  switch (op) {
    case 'LT':
      return a < b;
    case 'LTE':
      return a <= b;
    case 'GT':
      return a > b;
    case 'GTE':
      return a >= b;
    default:
      return false;
  }
}

/** JS `===` for our value types, including structural equality for arrays. */
function strictEquals(left: Value, right: Value): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => strictEquals(item, right[index]));
  }
  return left === right;
}

/**
 * JS `==`, which is what Blockly emits for `EQ`.
 *
 * Arrays are compared structurally: `[] == []` is false in JS, but a strategy
 * comparing two tick lists means "the same list", and treating every such
 * comparison as false would make a loop condition silently never hold.
 */
function looseEquals(left: Value, right: Value): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return strictEquals(left, right);
  }
  // eslint-disable-next-line
  return left == right;
}

/**
 * Coerces an operand for an ordering comparison.
 *
 * Blockly emits bare `<`/`>` between the two operands, so JS decides: two
 * strings compare lexicographically, anything else compares numerically. A
 * non-numeric string in a numeric comparison yields NaN, making every ordering
 * test false — the same outcome the generated code has.
 */
function comparable(value: Value): number | string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null) return 0;
  return NaN;
}

function truthy(value: Value): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function toNumber(value: Value): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null) return 0;
  if (Array.isArray(value)) return NaN;
  const parsed = Number(value);
  return parsed;
}

function toList(value: Value): Value[] {
  return Array.isArray(value) ? value : [];
}

function arithmetic(node: TreeNode, ctx: TickContext): Value {
  const op = fieldValue(node, 'OP') ?? '';
  const a = toNumber(evaluateInput(node, 'A', ctx));
  const b = toNumber(evaluateInput(node, 'B', ctx));
  switch (op) {
    case 'ADD':
      return a + b;
    case 'MINUS':
      return a - b;
    case 'MULTIPLY':
      return a * b;
    // JS division by zero yields Infinity/NaN rather than throwing; the caller
    // treats a non-finite operand as "no signal", so this cannot buy.
    case 'DIVIDE':
      return a / b;
    case 'POWER':
      return Math.pow(a, b);
    default:
      return NaN;
  }
}

function singleOperandMath(node: TreeNode, ctx: TickContext): Value {
  const op = fieldValue(node, 'OP') ?? '';
  const value = toNumber(evaluateInput(node, 'NUM', ctx));
  switch (op) {
    case 'ROOT':
      return Math.sqrt(value);
    case 'ABS':
      return Math.abs(value);
    case 'NEG':
      return -value;
    case 'LN':
      return Math.log(value);
    case 'LOG10':
      return Math.log(value) / Math.log(10);
    case 'EXP':
      return Math.pow(Math.E, value);
    case 'POW10':
      return Math.pow(10, value);
    case 'ROUND':
      return Math.round(value);
    case 'ROUNDUP':
      return Math.ceil(value);
    case 'ROUNDDOWN':
      return Math.floor(value);
    case 'SIN':
      return Math.sin((value / 180) * Math.PI);
    case 'COS':
      return Math.cos((value / 180) * Math.PI);
    case 'TAN':
      return Math.tan((value / 180) * Math.PI);
    case 'ASIN':
      return (Math.asin(value) / Math.PI) * 180;
    case 'ACOS':
      return (Math.acos(value) / Math.PI) * 180;
    case 'ATAN':
      return (Math.atan(value) / Math.PI) * 180;
    default:
      return NaN;
  }
}

function roundValue(node: TreeNode, ctx: TickContext): Value {
  const op = fieldValue(node, 'OP') ?? 'ROUND';
  const value = toNumber(evaluateInput(node, 'NUM', ctx));
  if (op === 'ROUNDUP') return Math.ceil(value);
  if (op === 'ROUNDDOWN') return Math.floor(value);
  return Math.round(value);
}

function logicalOperation(node: TreeNode, ctx: TickContext): Value {
  const op = fieldValue(node, 'OP') ?? '';
  const left = evaluateInput(node, 'A', ctx);
  if (op === 'AND') {
    // JS `&&` short-circuits and returns the operand, not a coerced boolean.
    return truthy(left) ? evaluateInput(node, 'B', ctx) : left;
  }
  if (op === 'OR') {
    return truthy(left) ? left : evaluateInput(node, 'B', ctx);
  }
  return false;
}

/**
 * DBot's `text_join` in value position.
 *
 * The statement form assigns to a variable; when a `text_join` appears in a
 * value slot (some exports place it there) the joined text is returned instead
 * of assigned.
 */
function textJoinValue(node: TreeNode, ctx: TickContext): Value {
  return stackOf(node, 'STACK')
    .map((child) => {
      const value = evaluateInput(child, 'TEXT', ctx);
      return value === null ? '' : String(value);
    })
    .join(' ');
}

function listGetIndex(node: TreeNode, ctx: TickContext): Value {
  const mode = fieldValue(node, 'MODE') ?? 'GET';
  const where = fieldValue(node, 'WHERE') ?? 'FIRST';
  const list = [...toList(evaluateInput(node, 'VALUE', ctx))];
  if (list.length === 0) return null;

  const atIndex = (): number => {
    // Blockly's `getAdjusted` treats FROM_START as 1-based and FROM_END as
    // offset from the end, so the stored `AT` is converted before use.
    const raw = toNumber(evaluateInput(node, 'AT', ctx));
    if (where === 'FROM_END') return list.length - 1 - (raw - 1);
    return raw - 1;
  };

  let index: number;
  if (where === 'FIRST') index = 0;
  else if (where === 'LAST') index = list.length - 1;
  else index = atIndex();

  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;

  if (mode === 'GET') return list[index];
  // GET_REMOVE and REMOVE both consume the element; the interpreter has no
  // shared list identity across blocks, so a removal is reported as its value.
  return list[index];
}

function listIndexOf(node: TreeNode, ctx: TickContext): Value {
  const list = toList(evaluateInput(node, 'VALUE', ctx));
  const target = evaluateInput(node, 'FIND', ctx);
  const index = list.findIndex((item) => strictEquals(item, target));
  if (index === -1) return 0;
  return fieldValue(node, 'END') === 'LAST' ? list.length - index : index + 1;
}

/**
 * Writes an indicator result into the block's variable.
 *
 * The indicator's parameters live in a nested `STATEMENT` stack of
 * `input_list`/`period` child blocks. Both are required: with either missing,
 * DBot's generated call passes `undefined` and the indicator yields NaN. That
 * is recorded as `null` here so a comparison against it fails to resolve rather
 * than comparing against a number that was never computed.
 */
function writeIndicator(node: TreeNode, sc: StatementContext, kind: 'sma' | 'ema'): void {
  const params = inputBlock(node, 'STATEMENT');
  const listBlock = params ? inputBlock(params, 'INPUT_LIST') : null;
  const periodBlock = params ? inputBlock(params, 'PERIOD') : null;

  const series = listBlock ? numericSeries(evaluateBlock(listBlock, sc.ctx)) : [];
  const period = periodBlock ? toNumber(evaluateBlock(periodBlock, sc.ctx)) : NaN;

  let result: number | null = null;
  if (Number.isInteger(period) && period > 0 && series.length >= period) {
    result =
      kind === 'sma' ? simpleAverage(series, period) : exponentialAverage(series, period);
  }
  writeVariable(node, result, sc.ctx);
}

/** A list of numbers, or the raw quotes when the input is a tick list. */
function numericSeries(value: Value): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const num = toNumber(item);
    if (Number.isFinite(num)) out.push(num);
  }
  return out;
}

function simpleAverage(values: number[], period: number): number {
  const window = values.slice(values.length - period);
  return window.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * EMA over a bounded tail, seeded with an SMA.
 *
 * The tail is capped at a multiple of the period for the same reason the plan
 * evaluator caps it: a seeded EMA depends on where the series starts, so an
 * unbounded window would make the same market produce different values
 * depending on buffer length. A fixed tail keeps a decision reproducible.
 */
function exponentialAverage(values: number[], period: number): number {
  const warmup = Math.max(period, period * 3);
  const window = values.slice(Math.max(0, values.length - warmup));
  let ema = simpleAverage(window.slice(0, period), period);
  const k = 2 / (period + 1);
  for (let i = period; i < window.length; i += 1) {
    ema = window[i] * k + ema * (1 - k);
  }
  return ema;
}

/** `rise` / `fall` / '' from the last two ticks, as DBot's `getDirection`. */
function marketDirection(ticks: MarketTick[]): string {
  if (ticks.length < 2) return '';
  const previous = ticks[ticks.length - 2].quote;
  const latest = ticks[ticks.length - 1].quote;
  if (previous < latest) return 'rise';
  if (previous > latest) return 'fall';
  return '';
}

/** Digits of the last ticks, as DBot's `getLastDigitList` computes them. */
function lastDigitList(ctx: TickContext): Value[] {
  return ctx.ticks.slice(-1000).map((tick) => {
    const text = formatQuote(tick.quote, tick.pipSize);
    return Number(text[text.length - 1]);
  });
}

function lastDigitOfLatest(ctx: TickContext): Value {
  const latest = ctx.ticks[ctx.ticks.length - 1];
  if (!latest) return null;
  const text = formatQuote(latest.quote, latest.pipSize);
  return Number(text[text.length - 1]);
}

/** Formats a quote to the symbol's pip size, as DBot's `toFixed(pipSize)`. */
function formatQuote(quote: number, pipSize: number | null): string {
  const size = typeof pipSize === 'number' && Number.isInteger(pipSize) && pipSize >= 0 ? pipSize : 0;
  return quote.toFixed(size);
}

/**
 * Maps DBot's `DETAIL_INDEX` dropdown onto the settled contract.
 *
 * DBot's `read_details` calls `Bot.readDetails(i)` which is
 * `createDetails(contract)[i - 1]`, so the dropdown's 1-based index addresses
 * the 0-based array below. The mapping is taken verbatim from
 * `createDetails` in `bot-skeleton/src/services/tradeEngine/utils/helpers.js`.
 */
function readContractDetail(node: TreeNode, facts: ContractFacts | null): Value {
  const raw = fieldValue(node, 'DETAIL_INDEX');
  if (facts === null) return null;
  switch (raw) {
    case '1':
      return facts.buyTransactionId;
    case '2':
      return facts.buyPrice;
    case '3':
      return facts.sellPrice;
    case '4':
      return facts.profit;
    case '5':
      return facts.contractType;
    case '6':
      return formatClock(facts.entryTime);
    case '7':
      return facts.entrySpot;
    case '8':
      return formatClock(facts.exitTime);
    case '9':
      return facts.exitSpot;
    case '10':
      // DBot writes 0 when the contract has no barrier.
      return facts.barrier ?? 0;
    case '11':
      return facts.result;
    default:
      return null;
  }
}

/** `HH:mm:ss` in UTC, matching DBot's `formatTime(..., 'HH:mm:ss')`. */
function formatClock(epochMs: number | null): string | null {
  if (epochMs === null || !Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * Runs a `controls_if` chain.
 *
 * `IF0`/`DO0` is the first branch and each `IF<n>`/`DO<n>` pair is an
 * else-if; `ELSE` runs when none matched. Branches are tested in order and only
 * the matching one executes, so a later condition's side effects never happen
 * when an earlier branch already matched.
 */
function executeIf(node: TreeNode, sc: StatementContext): void {
  let index = 0;
  while (true) {
    const condition = inputBlock(node, `IF${index}`);
    if (!condition) break;
    if (truthy(evaluateBlock(condition, sc.ctx))) {
      runNestedStack(inputBlock(node, `DO${index}`), sc);
      return;
    }
    index += 1;
  }
  runNestedStack(inputBlock(node, 'ELSE'), sc);
}

/**
 * Runs a nested stack inside a block.
 *
 * A nested `purchase`/`trade_again` must terminate the *whole* strategy run,
 * not just the nested stack, so the flags are propagated through the shared
 * outcome rather than kept local.
 */
function runNestedStack(stack: TreeNode | null, sc: StatementContext): void {
  let node = stack;
  while (node) {
    const handler = STATEMENT_BLOCKS[node.type];
    if (!handler) throw new UnsupportedBlockError(node.type);
    handler(node, sc);
    // A purchase ends the strategy; break/continue/return unwind to the loop or
    // procedure that owns them. Either way this stack stops walking.
    if (sc.outcome.purchase !== null || sc.outcome.tradeAgain) {
      sc.flow = 'halt';
      return;
    }
    if (sc.flow !== 'normal') return;
    node = node.next;
  }
}

/**
 * Runs a loop body one iteration and reports what the loop should do next.
 *
 * The body runs on a nested context so a `break` inside it cannot leak into an
 * enclosing loop: the signal is consumed here and the caller decides.
 */
function runLoopBody(body: TreeNode | null, sc: StatementContext): FlowSignal {
  const inner: StatementContext = { ...sc, flow: 'normal' };
  runNestedStack(body, inner);
  // `break` and `continue` belong to this loop and are consumed here, so the
  // outer context stays `normal`. Only `halt`, `return` and `suspend` outlive
  // the loop — a `timeout` inside the body pauses the whole strategy, not one
  // iteration.
  if (inner.flow === 'halt' || inner.flow === 'return' || inner.flow === 'suspend') {
    sc.flow = inner.flow;
    sc.returnValue = inner.returnValue;
  } else {
    sc.flow = 'normal';
  }
  return inner.flow;
}

/**
 * `controls_repeat` / `controls_repeat_ext`: run the body N times.
 *
 * DBot's generator evaluates TIMES once into `repeat_end` before the loop, so a
 * body that changes the count does not extend the loop. `TIMES` is a value input
 * on `_ext` and a field on the legacy `controls_repeat`.
 */
function executeRepeat(node: TreeNode, sc: StatementContext): void {
  const raw =
    readNumberField(node, 'TIMES') ?? toNumber(evaluateInput(node, 'TIMES', sc.ctx));
  const times = Number.isFinite(raw) ? Math.floor(raw) : 0;
  if (times <= 0) return;
  if (times > MAX_REPEAT_COUNT) {
    throw new ExecutionLimitError(
      `A repeat block asked for ${times} iterations, above the limit of ${MAX_REPEAT_COUNT}.`
    );
  }
  const body = inputBlock(node, 'DO');
  for (let i = 0; i < times; i += 1) {
    const signal = runLoopBody(body, sc);
    if (signal === 'break') {
      sc.flow = 'normal';
      return;
    }
    if (signal === 'halt' || signal === 'return' || signal === 'suspend') return;
  }
}

/**
 * `controls_whileUntil`: repeat while (or until) a condition holds.
 *
 * The 10000-iteration ceiling and the "Infinite loop detected" failure are
 * DBot's own, from its `controls_whileUntil` generator. A strategy that spins
 * here would spin there too, so this fails at the same point rather than
 * hanging the tick loop.
 */
function executeWhileUntil(node: TreeNode, sc: StatementContext): void {
  const until = fieldValue(node, 'MODE') === 'UNTIL';
  const body = inputBlock(node, 'DO');
  let iterations = 0;
  while (true) {
    const condition = truthy(evaluateInput(node, 'BOOL', sc.ctx));
    if (until ? condition : !condition) return;
    if (iterations > MAX_LOOP_ITERATIONS) {
      throw new ExecutionLimitError('Infinite loop detected');
    }
    iterations += 1;
    const signal = runLoopBody(body, sc);
    if (signal === 'break') {
      sc.flow = 'normal';
      return;
    }
    if (signal === 'halt' || signal === 'return' || signal === 'suspend') return;
  }
}

/**
 * `controls_for`: count a variable from FROM to TO by BY.
 *
 * DBot decides the direction once, from whether the start is above the end, and
 * steps by `Math.abs(BY)` in that direction. Reproducing that matters because a
 * descending range with a positive step still counts down.
 */
function executeFor(node: TreeNode, sc: StatementContext): void {
  const from = toNumber(evaluateInput(node, 'FROM', sc.ctx));
  const to = toNumber(evaluateInput(node, 'TO', sc.ctx));
  const byRaw = toNumber(evaluateInput(node, 'BY', sc.ctx));
  const by = Number.isFinite(byRaw) && byRaw !== 0 ? Math.abs(byRaw) : 1;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return;

  const variable = node.fields.find((item) => item.name === 'VAR');
  if (!variable) return;
  const descending = from > to;
  const body = inputBlock(node, 'DO');

  let iterations = 0;
  for (let i = from; descending ? i >= to : i <= to; i += descending ? -by : by) {
    if (iterations > MAX_LOOP_ITERATIONS) {
      throw new ExecutionLimitError('Infinite loop detected');
    }
    iterations += 1;
    bindScopedVariable(sc.ctx.variables, variable.id, variable.value, i);
    const signal = runLoopBody(body, sc);
    if (signal === 'break') {
      sc.flow = 'normal';
      return;
    }
    if (signal === 'halt' || signal === 'return' || signal === 'suspend') return;
    // Guard against a step that cannot make progress (by rounds to 0 at i).
    if (!Number.isFinite(i)) return;
  }
}

/**
 * `controls_forEach`: run the body once per element of a list.
 *
 * DBot binds the item to the loop variable, so the body sees the element rather
 * than its index.
 */
function executeForEach(node: TreeNode, sc: StatementContext): void {
  const list = toList(evaluateInput(node, 'LIST', sc.ctx));
  const variable = node.fields.find((item) => item.name === 'VAR');
  if (!variable) return;
  const body = inputBlock(node, 'DO');

  let iterations = 0;
  for (const item of list) {
    if (iterations > MAX_LOOP_ITERATIONS) {
      throw new ExecutionLimitError('Infinite loop detected');
    }
    iterations += 1;
    bindScopedVariable(sc.ctx.variables, variable.id, variable.value, item);
    const signal = runLoopBody(body, sc);
    if (signal === 'break') {
      sc.flow = 'normal';
      return;
    }
    if (signal === 'halt' || signal === 'return' || signal === 'suspend') return;
  }
}

/**
 * Calls a `procedures_def*` block.
 *
 * Parameters are bound into the run's variable map, which is what DBot's
 * generator does too — it emits a plain JS function whose parameters shadow the
 * globals. They are restored afterwards so a call cannot permanently overwrite a
 * variable of the same name, matching JS parameter scoping.
 */
function executeProcedureCall(node: TreeNode, sc: StatementContext, wantsReturn: boolean): Value {
  const name = procedureName(node);
  if (!name) return null;
  const def = sc.procedures.get(name);
  if (!def) {
    // DBot would throw a ReferenceError for an undefined function. Returning a
    // value here would let a strategy trade on a call that never happened.
    throw new ExecutionLimitError(`Procedure "${name}" is called but never defined.`);
  }
  if (sc.callDepth >= MAX_CALL_DEPTH) {
    throw new ExecutionLimitError(
      `Procedure calls nested deeper than ${MAX_CALL_DEPTH}; the strategy may recurse forever.`
    );
  }

  // Bind arguments. A missing argument is null, as DBot's `|| 'null'` fallback.
  const saved = new Map<string, Value | undefined>();
  def.args.forEach((arg, index) => {
    const value = evaluateInput(node, `ARG${index}`, sc.ctx);
    for (const key of [arg.varid, arg.name]) {
      if (key === null) continue;
      if (!saved.has(key)) saved.set(key, sc.ctx.variables.get(key));
      sc.ctx.variables.set(key, value);
    }
  });

  const inner: StatementContext = { ...sc, flow: 'normal', returnValue: null, callDepth: sc.callDepth + 1 };
  runNestedStack(def.body, inner);

  let result: Value = null;
  if (inner.flow === 'return') result = inner.returnValue;
  else if (def.hasReturn) result = evaluateInput(def.node, 'RETURN', sc.ctx);

  // A purchase inside a procedure still ends the strategy; a timeout pauses it.
  if (inner.flow === 'halt' || inner.flow === 'suspend') sc.flow = inner.flow;

  for (const [key, value] of saved) {
    if (value === undefined) sc.ctx.variables.delete(key);
    else sc.ctx.variables.set(key, value);
  }

  if (!wantsReturn) return null;
  return result;
}

/**
 * Evaluates a `procedures_callreturn` block to its procedure's return value.
 *
 * Value blocks are pure by rule 1, so this builds a throwaway statement context
 * that shares the run's variable map and procedure table. A call that would
 * `purchase` cannot do so from a value position — DBot's generator returns a
 * value, not a trade — so a `halt` raised inside is discarded.
 */
function callProcedureForValue(node: TreeNode, ctx: TickContext): Value {
  // The depth has to live on the shared context: a procedure that recurses
  // through its RETURN expression re-enters here, and a local counter would
  // start from zero every time, overflowing the JS stack instead of failing at
  // the documented bound.
  const depth = (ctx.callDepth ?? 0) + 1;
  if (depth > MAX_CALL_DEPTH) {
    throw new ExecutionLimitError(
      `Procedure calls nested deeper than ${MAX_CALL_DEPTH}; the strategy may recurse forever.`
    );
  }
  const sc: StatementContext = {
    ctx,
    outcome: { purchase: null, tradeAgain: false, timeouts: [], notifications: [], sellRequest: null },
    flow: 'normal',
    returnValue: null,
    procedures: ctx.procedures ?? new Map(),
    callDepth: depth
  };
  const previous = ctx.callDepth;
  ctx.callDepth = depth;
  try {
    return executeProcedureCall(node, sc, true);
  } finally {
    ctx.callDepth = previous;
  }
}


