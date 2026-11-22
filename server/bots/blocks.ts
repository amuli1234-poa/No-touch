/**
 * Deriv DBot block registry.
 *
 * Every entry below is taken from the block definitions in the DBot source
 * (`deriv-com/deriv-app`, `packages/bot-skeleton/src/scratch/blocks`). Block
 * types are the literal `Blockly.Blocks.<name>` identifiers that DBot writes
 * into an exported XML file; field names are the literal `name:` values on the
 * block's `field_*` inputs.
 *
 * Nothing here is guessed. A block that is not in this registry is reported as
 * unknown rather than being assumed to behave in some particular way.
 *
 * Scope note: this phase interprets a deliberately small subset — trade
 * definition, purchase, the tick-analysis entry checks and the built-in
 * indicators. Everything else that DBot can export is listed as recognised but
 * unsupported, so the user is told precisely what could not be interpreted.
 */

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
 * Supported subset. These are the blocks whose semantics No-touch can state
 * with confidence: the trade definition, the purchase action, the direction
 * checks, and the five built-in indicator statements.
 */
const SUPPORTED: Record<string, BlockSpec> = {
  /* ------------------------- trade definition ------------------------- */
  trade_definition: {
    supported: true,
    role: 'trade-definition',
    label: 'Trade definition',
    fields: ['MARKET_LIST', 'SUBMARKET_LIST', 'SYMBOL_LIST'],
    statements: ['TRADE_OPTIONS', 'SUBMARKET', 'INITIALIZATION']
  },
  trade_definition_market: {
    supported: true,
    role: 'market',
    label: 'Market selection',
    fields: ['MARKET_LIST', 'SUBMARKET_LIST', 'SYMBOL_LIST']
  },
  trade_definition_tradetype: {
    supported: true,
    role: 'contract',
    label: 'Trade type',
    fields: ['TRADETYPECAT_LIST', 'TRADETYPE_LIST']
  },
  trade_definition_contracttype: {
    supported: true,
    role: 'contract',
    label: 'Contract type',
    fields: ['TYPE_LIST']
  },
  trade_definition_candleinterval: {
    supported: true,
    role: 'market',
    label: 'Candle interval',
    fields: ['CANDLEINTERVAL_LIST']
  },
  trade_definition_tradeoptions: {
    supported: true,
    role: 'stake',
    label: 'Trade options (stake, duration, currency)',
    fields: ['DURATIONTYPE_LIST', 'CURRENCY_LIST', 'AMOUNT_LIMITS'],
    statements: [],
    // DURATION and AMOUNT arrive as nested value blocks, read by the parser.
  },
  trade_definition_restartbuysell: {
    supported: true,
    role: 'trade-definition',
    label: 'Restart on buy/sell',
    fields: ['TIME_MACHINE_ENABLED']
  },
  trade_definition_restartonerror: {
    supported: true,
    role: 'trade-definition',
    label: 'Restart on error',
    fields: ['RESTARTONERROR']
  },

  /* ---------------------------- purchase ------------------------------ */
  before_purchase: {
    supported: true,
    role: 'entry',
    label: 'Before purchase',
    statements: ['BEFOREPURCHASE_STACK']
  },
  purchase: {
    supported: true,
    role: 'purchase',
    label: 'Purchase contract',
    fields: ['PURCHASE_LIST']
  },
  tick_analysis: {
    supported: true,
    role: 'entry',
    label: 'Tick analysis',
    statements: ['TICKANALYSIS_STACK']
  },
  check_direction: {
    supported: true,
    role: 'entry',
    label: 'Market direction is Rise/Fall',
    fields: ['CHECK_DIRECTION']
  },
  tick: {
    supported: true,
    role: 'entry',
    label: 'Last tick'
  },

  /* ------------------------------ exit -------------------------------- */
  during_purchase: {
    supported: true,
    role: 'exit',
    label: 'During purchase',
    statements: ['DURING_PURCHASE_STACK']
  },
  check_sell: {
    supported: true,
    role: 'exit',
    label: 'Sell condition'
  },
  after_purchase: {
    supported: true,
    role: 'exit',
    label: 'After purchase',
    statements: ['AFTERPURCHASE_STACK']
  },
  trade_again: {
    supported: true,
    role: 'exit',
    label: 'Trade again'
  },

  /* ---------------------------- indicators ---------------------------- */
  sma_statement: {
    supported: true,
    role: 'indicator',
    label: 'Simple moving average',
    fields: ['VARIABLE'],
    statements: ['STATEMENT']
  },
  ema_statement: {
    supported: true,
    role: 'indicator',
    label: 'Exponential moving average',
    fields: ['VARIABLE'],
    statements: ['STATEMENT']
  },
  rsi_statement: {
    supported: true,
    role: 'indicator',
    label: 'Relative strength index',
    fields: ['VARIABLE'],
    statements: ['STATEMENT']
  },
  bb_statement: {
    supported: true,
    role: 'indicator',
    label: 'Bollinger bands',
    fields: ['VARIABLE', 'BBRESULT_LIST'],
    statements: ['STATEMENT']
  },
  macda_statement: {
    supported: true,
    role: 'indicator',
    label: 'MACD',
    fields: ['VARIABLE', 'MACDFIELDS_LIST'],
    statements: ['STATEMENT']
  },

  /* ----------------------- generic Blockly logic ---------------------- */
  // These are stock Blockly blocks DBot ships with. We understand their shape
  // well enough to render them, but they are neutral structure, not trading
  // logic, so they never make a bot executable on their own.
  controls_if: {
    supported: true,
    role: 'logic',
    label: 'If / else',
    statements: ['DO0', 'ELSE']
  },
  logic_compare: {
    supported: true,
    role: 'logic',
    label: 'Comparison'
  },
  logic_operation: {
    supported: true,
    role: 'logic',
    label: 'And / or'
  },
  logic_negate: {
    supported: true,
    role: 'logic',
    label: 'Not'
  },
  logic_boolean: {
    supported: true,
    role: 'logic',
    label: 'True / false'
  },
  math_number: {
    supported: true,
    role: 'logic',
    label: 'Number'
  },
  math_number_positive: {
    supported: true,
    role: 'logic',
    label: 'Positive number'
  },
  math_arithmetic: {
    supported: true,
    role: 'logic',
    label: 'Arithmetic'
  },
  variables_get: {
    supported: true,
    role: 'variable',
    label: 'Read variable'
  },
  variables_set: {
    supported: true,
    role: 'variable',
    label: 'Set variable'
  }
};

/**
 * DBot blocks that exist and are recognised, but whose behaviour No-touch does
 * not currently model. They are reported individually rather than dropped.
 */
const RECOGNISED_UNSUPPORTED: Record<string, string> = {
  trade_definition_multiplier: 'Multiplier contract configuration is not modelled.',
  trade_definition_accumulator: 'Accumulator configuration is not modelled.',
  multiplier_take_profit: 'Multiplier take-profit is not modelled.',
  multiplier_stop_loss: 'Multiplier stop-loss is not modelled.',
  accumulator_take_profit: 'Accumulator take-profit is not modelled.',
  check_result: 'Result branching is not modelled.',
  read_details: 'Contract detail reads are not modelled.',
  sell_at_market: 'Selling at market is not modelled.',
  sell_price: 'Sell-price reads are not modelled.',
  ask_price: 'Ask-price reads are not modelled.',
  payout: 'Payout reads are not modelled.',
  get_ohlc: 'OHLC accessors are not modelled.',
  ohlc: 'OHLC accessors are not modelled.',
  ohlc_values: 'OHLC accessors are not modelled.',
  readOhlc: 'OHLC accessors are not modelled.',
  last_digit: 'Last-digit analysis is not modelled.',
  lastDigitList: 'Last-digit analysis is not modelled.',
  stat: 'Statistical blocks are not modelled.',
  stat_list: 'Statistical blocks are not modelled.',
  ticks: 'Tick-history blocks are not modelled.',
  tick_string: 'Tick-string blocks are not modelled.',
  check_direction_string: 'String direction checks are not modelled.',
  bba_statement: 'Bollinger-band arrays are not modelled.',
  rsia_statement: 'RSI arrays are not modelled.',
  smaa_statement: 'SMA arrays are not modelled.',
  emaa_statement: 'EMA arrays are not modelled.',
  macda_statement_array: 'MACD arrays are not modelled.',
  procedures_defnoreturn: 'Custom procedures are not modelled.',
  procedures_defreturn: 'Custom procedures are not modelled.',
  procedures_callnoreturn: 'Custom procedures are not modelled.',
  procedures_callreturn: 'Custom procedures are not modelled.',
  controls_repeat_ext: 'Loops are not modelled.',
  controls_whileUntil: 'Loops are not modelled.',
  controls_for: 'Loops are not modelled.',
  controls_flow_statements: 'Loop flow control is not modelled.',
  text_print: 'Journal output is not modelled.',
  text_join: 'Text manipulation is not modelled.',
  text_prompt_ext: 'Prompts are not modelled.',
  loader: 'Loader blocks are not modelled.',
  block_holder: 'Block holders are not modelled.'
};

/** Returns the spec for a block type, or null when we have never seen it. */
export function blockSpec(type: string): BlockSpec | null {
  const supported = SUPPORTED[type];
  if (supported) return supported;
  const reason = RECOGNISED_UNSUPPORTED[type];
  if (reason) {
    return { supported: false, role: 'unsupported', label: type, reason };
  }
  return null;
}

/** True when the block type is a DBot block we recognise at all. */
export function isKnownBlock(type: string): boolean {
  return type in SUPPORTED || type in RECOGNISED_UNSUPPORTED;
}

/** The blocks this phase can interpret, for documentation and the UI. */
export function supportedBlockTypes(): string[] {
  return Object.keys(SUPPORTED).sort();
}

/** Blocks recognised but not interpretable, with reasons. */
export function unsupportedBlockTypes(): { type: string; reason: string }[] {
  return Object.entries(RECOGNISED_UNSUPPORTED)
    .map(([type, reason]) => ({ type, reason }))
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
export const EXECUTABLE_CONTRACT_TYPES = ['CALL', 'PUT', 'MULTUP', 'MULTDOWN'];

/** DBot trade-type categories that map onto the executable contract types. */
export const EXECUTABLE_TRADE_TYPE_CATEGORIES = ['callput', 'multiplier'];

export { DBOT_PREFIX };
