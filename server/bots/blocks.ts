/**
 * Deriv DBot block catalogue.
 *
 * Every block type below is taken from the official DBot source
 * (`deriv-com/deriv-app`, `packages/bot-skeleton/src/scratch/blocks`), which
 * registers 133 `Blockly.Blocks.<name>` types. Those names are the literal
 * identifiers DBot writes into an exported XML file.
 *
 * ## Why capability is derived, not declared
 *
 * This module used to carry a hand-maintained `SUPPORTED` list alongside the
 * interpreter's own block tables. The two drifted: the interpreter grew loops,
 * text, list, notify and contract-detail semantics that the list never learned
 * about, so a perfectly executable bot was reported as "34 blocks not
 * recognised". A customer-facing compatibility verdict that disagrees with what
 * the engine can actually run is worse than no verdict at all.
 *
 * Capability is therefore read from the interpreter itself — the single
 * authority on what executes. This file only supplies the *metadata* the
 * interpreter cannot know: display labels, which lifecycle slots a block fills,
 * and why a block we recognise is deliberately not executed.
 *
 * A block is `executable` only when `interpreter.ts` has a runtime handler for
 * it. Parsing or rendering a block is never treated as evidence of execution.
 */

import { isInterpreted } from './interpreter.js';

/** How a block participates in the strategy, for grouping in the preview. */
export type BlockRole =
  | 'trade-definition'
  | 'market'
  | 'contract'
  | 'stake'
  | 'entry'
  | 'exit'
  | 'indicator'
  | 'purchase'
  | 'logic'
  | 'flow'
  | 'variable'
  | 'utility'
  | 'unsupported';

export interface BlockSpec {
  /** Whether No-touch can interpret this block's meaning. */
  supported: boolean;
  role: BlockRole;
  /** Human-readable label for the preview. */
  label: string;
  /** Field names this block writes, so the parser can read them reliably. */
  fields?: readonly string[];
  /** Statement (nested block) inputs this block writes. */
  statements?: readonly string[];
  /** Why it is unsupported, when `supported` is false. */
  reason?: string;
}

const DBOT_PREFIX = 'https://deriv.com/dbot';

/**
 * Metadata for blocks the engine executes, or recognises deliberately.
 *
 * Presence here is *not* what makes a block executable — `interpreter.ts` is.
 * These entries only add labels, roles and lifecycle slots on top of a runtime
 * handler that already exists.
 */
interface BlockMeta {
  role: BlockRole;
  label: string;
  fields?: readonly string[];
  statements?: readonly string[];
}

const META: Record<string, BlockMeta> = {
  /* ------------------------- trade definition ------------------------- */
  trade: {
    role: 'trade-definition',
    label: 'Trade definition (legacy)',
    fields: [
      'MARKET_LIST',
      'SUBMARKET_LIST',
      'SYMBOL_LIST',
      'TRADETYPECAT_LIST',
      'TRADETYPE_LIST',
      'TYPE_LIST',
      'CANDLEINTERVAL_LIST',
      'TIME_MACHINE_ENABLED',
      'RESTARTONERROR'
    ],
    statements: ['INITIALIZATION', 'SUBMARKET']
  },
  tradeOptions: {
    role: 'stake',
    label: 'Trade options (stake, duration, currency)',
    fields: ['DURATIONTYPE_LIST', 'CURRENCY_LIST']
  },
  trade_definition: {
    role: 'trade-definition',
    label: 'Trade definition',
    fields: ['MARKET_LIST', 'SUBMARKET_LIST', 'SYMBOL_LIST'],
    statements: ['TRADE_OPTIONS', 'SUBMARKET', 'INITIALIZATION']
  },
  trade_definition_market: {
    role: 'market',
    label: 'Market selection',
    fields: ['MARKET_LIST', 'SUBMARKET_LIST', 'SYMBOL_LIST']
  },
  trade_definition_tradetype: {
    role: 'contract',
    label: 'Trade type',
    fields: ['TRADETYPECAT_LIST', 'TRADETYPE_LIST']
  },
  trade_definition_contracttype: {
    role: 'contract',
    label: 'Contract type',
    fields: ['TYPE_LIST']
  },
  trade_definition_candleinterval: {
    role: 'market',
    label: 'Candle interval',
    fields: ['CANDLEINTERVAL_LIST']
  },
  trade_definition_tradeoptions: {
    role: 'stake',
    label: 'Trade options (stake, duration, currency)',
    fields: ['DURATIONTYPE_LIST', 'CURRENCY_LIST', 'AMOUNT_LIMITS']
  },
  /**
   * The oldest trade-definition generation: market, contract and stake in one
   * block, nested inside `trade`'s SUBMARKET statement. DBot converts it to a
   * `trade_definition_tradeoptions` (see `backward-compatibility.js`), so it
   * carries the trade-options fields as well as the market triple.
   */
  market: {
    role: 'market',
    label: 'Market selection (legacy)',
    fields: [
      'MARKET_LIST',
      'SUBMARKET_LIST',
      'SYMBOL_LIST',
      'TRADETYPECAT_LIST',
      'TRADETYPE_LIST',
      'TYPE_LIST',
      'CANDLEINTERVAL_LIST',
      'DURATIONTYPE_LIST',
      'PAYOUTTYPE_LIST',
      'CURRENCY_LIST',
      'RESTARTONERROR'
    ]
  },
  trade_definition_tradeoptions_payout: {
    role: 'stake',
    label: 'Trade options (payout)',
    fields: ['DURATIONTYPE_LIST', 'CURRENCY_LIST']
  },
  trade_definition_restartbuysell: {
    role: 'trade-definition',
    label: 'Restart on buy/sell',
    fields: ['TIME_MACHINE_ENABLED']
  },
  trade_definition_restartonerror: {
    role: 'trade-definition',
    label: 'Restart on error',
    fields: ['RESTARTONERROR']
  },
  trade_definition_multiplier: {
    role: 'contract',
    label: 'Multiplier configuration',
    fields: ['MULTIPLIER_LIST']
  },
  trade_definition_accumulator: {
    role: 'contract',
    label: 'Accumulator configuration',
    fields: ['GROWTHRATE_LIST']
  },

  /* ----------------------------- lifecycle ---------------------------- */
  before_purchase: { role: 'entry', label: 'Before purchase', statements: ['BEFOREPURCHASE_STACK'] },
  purchase: { role: 'purchase', label: 'Purchase contract', fields: ['PURCHASE_LIST'] },
  tick_analysis: { role: 'entry', label: 'Tick analysis', statements: ['TICKANALYSIS_STACK'] },
  during_purchase: { role: 'exit', label: 'During purchase', statements: ['DURING_PURCHASE_STACK'] },
  check_sell: { role: 'exit', label: 'Sell condition' },
  after_purchase: { role: 'exit', label: 'After purchase', statements: ['AFTERPURCHASE_STACK'] },
  trade_again: { role: 'exit', label: 'Trade again' },

  /* ------------------------------ market ------------------------------ */
  tick: { role: 'entry', label: 'Last tick' },
  tick_string: { role: 'entry', label: 'Last tick (formatted)' },
  ticks: { role: 'entry', label: 'Tick list' },
  ticks_string: { role: 'entry', label: 'Tick list (formatted)' },
  last_digit: { role: 'entry', label: 'Last tick digit' },
  lastDigitList: { role: 'entry', label: 'Last-digit list' },
  check_direction: { role: 'entry', label: 'Market direction', fields: ['CHECK_DIRECTION'] },
  ohlc: { role: 'market', label: 'Candle data' },
  ohlc_values: { role: 'market', label: 'Candle values' },
  get_ohlc: { role: 'market', label: 'Get candle' },
  read_ohlc: { role: 'market', label: 'Read candle' },
  read_ohlc_obj: { role: 'market', label: 'Read candle object' },
  is_candle_black: { role: 'market', label: 'Candle is black' },
  ohlc_values_in_list: { role: 'market', label: 'Candle values in list' },

  /* ---------------------------- contract ------------------------------ */
  contract_check_result: { role: 'exit', label: 'Contract result', fields: ['CHECK_RESULT'] },
  read_details: { role: 'exit', label: 'Contract details' },
  total_profit: { role: 'exit', label: 'Total profit' },
  total_profit_string: { role: 'exit', label: 'Total profit (formatted)' },
  total_runs: { role: 'exit', label: 'Total runs' },
  balance: { role: 'exit', label: 'Account balance' },
  payout: { role: 'exit', label: 'Payout' },
  ask_price: { role: 'exit', label: 'Ask price' },
  sell_price: { role: 'exit', label: 'Sell price' },
  sell_at_market: { role: 'exit', label: 'Sell at market' },
  barrier_offset: { role: 'contract', label: 'Barrier offset' },
  epoch: { role: 'market', label: 'Current epoch' },
  todatetime: { role: 'utility', label: 'To date/time' },
  totimestamp: { role: 'utility', label: 'To timestamp' },
  tick_delay: { role: 'utility', label: 'Tick delay' },

  /* ---------------------------- indicators ---------------------------- */
  sma_statement: { role: 'indicator', label: 'Simple moving average', fields: ['VARIABLE'], statements: ['STATEMENT'] },
  smaa_statement: { role: 'indicator', label: 'Simple moving average (array)', fields: ['VARIABLE'] },
  ema_statement: { role: 'indicator', label: 'Exponential moving average', fields: ['VARIABLE'], statements: ['STATEMENT'] },
  emaa_statement: { role: 'indicator', label: 'Exponential moving average (array)', fields: ['VARIABLE'] },
  rsi_statement: { role: 'indicator', label: 'Relative strength index', fields: ['VARIABLE'], statements: ['STATEMENT'] },
  rsia_statement: { role: 'indicator', label: 'RSI (array)', fields: ['VARIABLE'] },
  bb_statement: { role: 'indicator', label: 'Bollinger bands', fields: ['VARIABLE', 'BBRESULT_LIST'], statements: ['STATEMENT'] },
  bba_statement: { role: 'indicator', label: 'Bollinger bands (array)', fields: ['VARIABLE', 'BBRESULT_LIST'] },
  macda_statement: { role: 'indicator', label: 'MACD', fields: ['VARIABLE', 'MACDFIELDS_LIST'], statements: ['STATEMENT'] },
  period: { role: 'indicator', label: 'Indicator period' },
  input_list: { role: 'indicator', label: 'Indicator input list' },
  fast_ema_period: { role: 'indicator', label: 'Fast EMA period' },
  slow_ema_period: { role: 'indicator', label: 'Slow EMA period' },
  signal_ema_period: { role: 'indicator', label: 'Signal EMA period' },
  std_dev_multiplier_up: { role: 'indicator', label: 'Std-dev multiplier up' },
  std_dev_multiplier_down: { role: 'indicator', label: 'Std-dev multiplier down' },

  /* ------------------------------ logic ------------------------------- */
  controls_if: { role: 'logic', label: 'If / else', statements: ['DO0', 'ELSE'] },
  logic_compare: { role: 'logic', label: 'Comparison' },
  logic_operation: { role: 'logic', label: 'And / or' },
  logic_negate: { role: 'logic', label: 'Not' },
  logic_boolean: { role: 'logic', label: 'True / false' },
  logic_null: { role: 'logic', label: 'Null' },
  logic_ternary: { role: 'logic', label: 'Conditional value' },

  /* ------------------------------- math ------------------------------- */
  math_number: { role: 'logic', label: 'Number' },
  math_number_positive: { role: 'logic', label: 'Positive number' },
  math_arithmetic: { role: 'logic', label: 'Arithmetic' },
  math_single: { role: 'logic', label: 'Math function' },
  math_trig: { role: 'logic', label: 'Trigonometry' },
  math_round: { role: 'logic', label: 'Round' },
  math_modulo: { role: 'logic', label: 'Modulo' },
  math_constrain: { role: 'logic', label: 'Constrain' },
  math_constant: { role: 'logic', label: 'Math constant' },
  math_change: { role: 'variable', label: 'Change variable' },
  math_number_property: { role: 'logic', label: 'Number property' },
  math_on_list: { role: 'logic', label: 'Math on list' },
  math_random_int: { role: 'logic', label: 'Random integer' },
  math_random_float: { role: 'logic', label: 'Random fraction' },

  /* ------------------------------- text ------------------------------- */
  text: { role: 'logic', label: 'Text' },
  text_join: { role: 'variable', label: 'Join text' },
  text_length: { role: 'logic', label: 'Text length' },
  text_isEmpty: { role: 'logic', label: 'Text is empty' },
  text_changeCase: { role: 'logic', label: 'Change case' },
  text_trim: { role: 'logic', label: 'Trim text' },
  text_charAt: { role: 'logic', label: 'Letter at' },
  text_indexOf: { role: 'logic', label: 'Text index of' },
  text_getSubstring: { role: 'logic', label: 'Text substring' },
  text_append: { role: 'variable', label: 'Append text' },
  text_print: { role: 'exit', label: 'Print to journal' },
  text_prompt_ext: { role: 'utility', label: 'Prompt' },

  /* ------------------------------- lists ------------------------------ */
  lists_create_with: { role: 'variable', label: 'Create list', fields: ['VARIABLE'] },
  lists_repeat: { role: 'logic', label: 'Repeat item into list' },
  lists_length: { role: 'logic', label: 'List length' },
  lists_isEmpty: { role: 'logic', label: 'List is empty' },
  lists_indexOf: { role: 'logic', label: 'List index of' },
  lists_getIndex: { role: 'logic', label: 'List item' },
  lists_getSublist: { role: 'logic', label: 'List sublist' },
  lists_setIndex: { role: 'variable', label: 'Set list item' },
  lists_sort: { role: 'logic', label: 'Sort list' },
  lists_split: { role: 'logic', label: 'Split text into list' },
  lists_statement: { role: 'variable', label: 'List statement' },
  stat: { role: 'indicator', label: 'Statistic' },
  stat_list: { role: 'indicator', label: 'Statistic on list' },

  /* ------------------------- variables / flow ------------------------- */
  variables_get: { role: 'variable', label: 'Read variable' },
  variables_set: { role: 'variable', label: 'Set variable' },

  /* -------------------------- loops & procs --------------------------- */
  controls_repeat: { role: 'flow', label: 'Repeat N times', statements: ['DO'] },
  controls_repeat_ext: { role: 'flow', label: 'Repeat N times', statements: ['DO'] },
  controls_whileUntil: { role: 'flow', label: 'Repeat while/until', statements: ['DO'] },
  controls_for: { role: 'flow', label: 'Count with variable', fields: ['VAR'], statements: ['DO'] },
  controls_forEach: { role: 'flow', label: 'For each item', fields: ['VAR'], statements: ['DO'] },
  controls_flow_statements: { role: 'flow', label: 'Break / continue', fields: ['FLOW'] },
  procedures_defnoreturn: { role: 'flow', label: 'Define procedure', fields: ['NAME'], statements: ['STACK'] },
  procedures_defreturn: { role: 'flow', label: 'Define procedure with return', fields: ['NAME'], statements: ['STACK'] },
  procedures_callnoreturn: { role: 'flow', label: 'Call procedure', fields: ['NAME'] },
  procedures_callreturn: { role: 'flow', label: 'Call procedure with return', fields: ['NAME'] },
  procedures_ifreturn: { role: 'flow', label: 'Return from procedure' },

  /* ------------------------------- misc ------------------------------- */
  notify: { role: 'exit', label: 'Notify', fields: ['NOTIFICATION_TYPE', 'NOTIFICATION_SOUND'] },
  notify_telegram: { role: 'exit', label: 'Notify via Telegram' },
  timeout: { role: 'flow', label: 'Wait', statements: ['TIMEOUTSTACK'] },
  console: { role: 'exit', label: 'Console output' },
  loader: { role: 'unsupported', label: 'Loader' },
  block_holder: { role: 'unsupported', label: 'Block holder' },
  useless_block: { role: 'unsupported', label: 'Useless block' }
};

/**
 * Blocks DBot exports that this build recognises but deliberately does not
 * execute, with the reason a customer needs.
 *
 * Early selling is *not* in this list: `check_sell`, `sell_price` and
 * `sell_at_market` are executed, because the live contract now carries
 * `bid_price` and `is_valid_to_sell`. What remains here is genuinely
 * unimplemented — Multipliers/Accumulator configuration, interactive prompts,
 * and containers with no behaviour.
 */
const DELIBERATELY_UNEXECUTED: Record<string, string> = {
  trade_definition_multiplier: 'Multiplier configuration is not modelled by this build.',
  trade_definition_accumulator: 'Accumulator configuration is not modelled by this build.',
  multiplier_take_profit: 'Multiplier take-profit is not modelled by this build.',
  multiplier_stop_loss: 'Multiplier stop-loss is not modelled by this build.',
  accumulator_take_profit: 'Accumulator take-profit is not modelled by this build.',
  text_prompt_ext: 'Interactive prompts cannot be answered by an automated run.',
  notify_telegram: 'Telegram notifications need credentials this build does not manage.',
  loader: 'Loader blocks carry no strategy logic.',
  block_holder: 'Block holders carry no strategy logic.',
  useless_block: 'Placeholder block with no behaviour.'
};

/**
 * Lifecycle and configuration containers the runtime addresses by name.
 *
 * These never appear in a statement stream. `runBeforePurchase`,
 * `runAfterPurchase`, `runTickAnalysis` and `planStrategy` locate them by block
 * type and read their contents, so they are genuinely honoured — just not via
 * `executeStack`. Treating them as "not implemented" would report every real
 * DBot export as broken.
 *
 * `during_purchase` is included because `runDuringPurchase` executes it on
 * every contract update. An empty one costs nothing and is the standard export
 * shape, so it must never be reported as unsupported.
 */
const CONTAINER_BLOCKS: ReadonlySet<string> = new Set<string>([
  'trade',
  'tradeOptions',
  'market',
  'trade_definition',
  'trade_definition_market',
  'trade_definition_tradetype',
  'trade_definition_contracttype',
  'trade_definition_candleinterval',
  'trade_definition_tradeoptions',
  'trade_definition_tradeoptions_payout',
  'trade_definition_restartbuysell',
  'trade_definition_restartonerror',
  'before_purchase',
  'after_purchase',
  'tick_analysis',
  'during_purchase'
]);

/** True when the runtime consumes this block by name rather than executing it. */
export function isContainerBlock(type: string): boolean {
  return CONTAINER_BLOCKS.has(type);
}

/**
 * True when this build refuses the block on purpose and can say why.
 *
 * Distinct from "not implemented": a deliberately unexecuted block has a known
 * semantics this build cannot honour, so it is reported as unsupported with a
 * reason rather than as an unknown block.
 */
export function isDeliberatelyUnexecuted(type: string): boolean {
  return type in DELIBERATELY_UNEXECUTED;
}

/** Returns the metadata for a block type, synthesising a label when absent. */
function metaFor(type: string): BlockMeta {
  return META[type] ?? { role: 'logic', label: type };
}

/**
 * The spec for a block type, or null when the type is not a DBot block.
 *
 * `supported` means "the interpreter has a runtime handler for this block". It
 * is read from `interpreter.ts`, so it cannot drift from what actually runs.
 */
export function blockSpec(type: string): BlockSpec | null {
  const reason = DELIBERATELY_UNEXECUTED[type];
  if (reason !== undefined) {
    return { supported: false, ...metaFor(type), role: 'unsupported', reason };
  }
  if (isInterpreted(type) || CONTAINER_BLOCKS.has(type)) {
    return { supported: true, ...metaFor(type) };
  }
  if (type in META) {
    return {
      supported: false,
      ...metaFor(type),
      role: 'unsupported',
      reason: 'Recognised DBot block with no runtime implementation in this build.'
    };
  }
  return null;
}

/** True when the block type is a DBot block we recognise at all. */
export function isKnownBlock(type: string): boolean {
  return type in DELIBERATELY_UNEXECUTED || type in META || isInterpreted(type);
}

/** Every block this build can execute, for documentation and the UI. */
export function supportedBlockTypes(): string[] {
  return [...Object.keys(META), ...Object.keys(DELIBERATELY_UNEXECUTED)]
    .filter((type) => isInterpreted(type) || CONTAINER_BLOCKS.has(type))
    .sort();
}

/** Blocks recognised but not executable, with reasons. */
export function unsupportedBlockTypes(): { type: string; reason: string }[] {
  const types = new Set([...Object.keys(META), ...Object.keys(DELIBERATELY_UNEXECUTED)]);
  return [...types]
    .filter((type) => !isInterpreted(type) && !CONTAINER_BLOCKS.has(type))
    .map((type) => ({ type, reason: blockSpec(type)?.reason ?? 'Not executed by this build.' }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * DBot's own list of the blocks that must be present for a strategy to run.
 * Taken from `config.mainBlocks` / `config.mandatoryMainBlocks` in the DBot
 * source, so the check matches what DBot itself requires.
 */
export const DBOT_MAIN_BLOCKS = ['trade_definition', 'before_purchase', 'during_purchase', 'after_purchase'];
export const DBOT_MANDATORY_BLOCKS = ['trade_definition', 'purchase', 'before_purchase'];

/**
 * Contract types the No-touch execution layer can actually place, mirroring
 * `CONTRACT_FAMILY_TYPES` in the execution types. Kept here as data so the
 * compatibility classifier does not import execution modules.
 */
export const EXECUTABLE_CONTRACT_TYPES = [
  'CALL',
  'PUT',
  'MULTUP',
  'MULTDOWN',
  'DIGITEVEN',
  'DIGITODD',
  'DIGITMATCH',
  'DIGITDIFF',
  'DIGITOVER',
  'DIGITUNDER',
  'ONETOUCH',
  'NOTOUCH',
  'ACCU'
];

/** DBot trade-type categories that map onto the executable contract types. */
export const EXECUTABLE_TRADE_TYPE_CATEGORIES = [
  'callput',
  'callputequal',
  'digits',
  'highlowticks',
  'touch',
  'multiplier',
  'accumulator'
];

export { DBOT_PREFIX };

/**
 * Field values DBot renamed between generations.
 *
 * `backward-compatibility.js` rewrites these before converting a legacy export,
 * so a strategy authored as `volidx`/`risefall` means the same thing as one
 * authored as `synthetic_index`/`callput`. Normalising keeps every consumer —
 * parser, planner, UI — comparing one vocabulary instead of two.
 */
export const LEGACY_FIELD_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  MARKET_LIST: { volidx: 'synthetic_index' },
  TRADETYPECAT_LIST: { endsinout: 'inout', staysinout: 'inout', callputequal: 'callput' },
  TRADETYPE_LIST: { risefall: 'callput', risefallequals: 'callputequal' }
};

/**
 * DBot's `config.opposites`, restricted to the pairs a legacy export can name.
 *
 * A legacy `TYPE_LIST` of `both` resolves to exactly these two contracts, and
 * the author's `purchase` block then picks one of them per entry.
 */
export const OPPOSITE_CONTRACTS: Readonly<Record<string, readonly [string, string]>> = {
  CALLPUT: ['CALL', 'PUT'],
  CALLPUTEQUAL: ['CALLE', 'PUTE'],
  HIGHERLOWER: ['CALL', 'PUT'],
  TOUCHNOTOUCH: ['ONETOUCH', 'NOTOUCH'],
  MATCHESDIFFERS: ['DIGITMATCH', 'DIGITDIFF'],
  EVENODD: ['DIGITEVEN', 'DIGITODD'],
  OVERUNDER: ['DIGITOVER', 'DIGITUNDER'],
  HIGHLOWTICKS: ['TICKHIGH', 'TICKLOW']
};

/** `value` with any legacy spelling of `field` mapped forward. */
export function normaliseLegacyValue(field: string, value: string): string {
  return LEGACY_FIELD_VALUES[field]?.[value] ?? value;
}
