/**
 * Blockly block definitions for DBot strategies.
 *
 * Three sources, in this order:
 *
 *   1. Stock Blockly blocks (`blockly/blocks`) — `controls_if`, `logic_*`,
 *      `math_*`, `variables_*`. DBot ships the same blocks, so importing the
 *      real definitions (with their mutators) is more faithful than
 *      re-declaring them.
 *   2. DBot's own blocks, declared below from the server's block registry.
 *      Field names match the registry exactly, so a field the parser reads is
 *      a field the editor writes.
 *   3. Placeholders for blocks No-touch does not understand, generated from
 *      the XML at load time. They render read-only and keep their values, so
 *      an unknown block survives editing instead of being dropped.
 *
 * Dropdown caveat, and why options are computed at load time: a Blockly
 * `FieldDropdown` coerces an unrecognised value to its first option. A DBot
 * file may legitimately contain a market, currency or duration this build has
 * never seen; if the dropdown only knew a fixed list, opening and saving would
 * silently rewrite that value. So every dropdown's options are the defaults
 * below *plus* whatever values the loaded strategy actually uses.
 */




/** Marks the generated definition for a block this build cannot interpret. */
export const UNKNOWN_BLOCK_PREFIX = 'ws_unknown__';

export function isUnknownBlockType(type: string): boolean {
  return type.startsWith(UNKNOWN_BLOCK_PREFIX);
}

/** Stable Blockly block type for an unrecognised DBot block type. */
export function unknownBlockType(dbotType: string, shape: 'stack' | 'value' = 'stack'): string {
  return `${UNKNOWN_BLOCK_PREFIX}${shape}__${dbotType}`;
}

/** Recovers the original DBot type from a generated placeholder type. */
export function originalBlockType(type: string): string {
  if (!isUnknownBlockType(type)) return type;
  const suffix = type.slice(UNKNOWN_BLOCK_PREFIX.length);
  const separator = suffix.indexOf('__');
  return separator < 0 ? suffix : suffix.slice(separator + 2);
}

export type InputKind = 'statement' | 'value';

/** The connection shape and named slots of one block occurrence. */
export interface BlockShape {
  type: string;
  shape: 'stack' | 'value';
  fields: { name: string }[];
  inputs: { name: string; kind: InputKind }[];
}

/**
 * The shapes that have no Blockly definition yet.
 *
 * `Blockly.Xml.domToWorkspace` throws `Invalid block definition for type: X`
 * and abandons the whole load on the first undefined type, so every one of
 * these must be registered as a placeholder before the XML is read. Types are
 * deduplicated by type *and* shape: one type used both as a statement and as a
 * value needs two distinct definitions.
 */
export function missingDefinitions(
  shapes: readonly BlockShape[],
  isDefined: (type: string) => boolean
): BlockShape[] {
  const seen = new Set<string>();
  const out: BlockShape[] = [];
  for (const shape of shapes) {
    if (!shape.type || isDefined(shape.type)) continue;
    const key = `${shape.type}\0${shape.shape}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(shape);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Dropdown option sets                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Default options for the fields the supported blocks write. These are the
 * values seen in DBot exports; a starting point, never a whitelist.
 */
const FIELD_DEFAULTS: Record<string, string[]> = {
  MARKET_LIST: ['synthetic_index', 'forex', 'indices', 'commodities', 'cryptocurrency'],
  SUBMARKET_LIST: ['random_index', 'continuous_indices', '1s_index', 'major_pairs'],
  SYMBOL_LIST: [
    'R_10',
    'R_25',
    'R_50',
    'R_75',
    'R_100',
    '1HZ10V',
    '1HZ25V',
    '1HZ50V',
    '1HZ75V',
    '1HZ100V'
  ],
  TRADETYPECAT_LIST: ['callput', 'multiplier', 'digits', 'highlowticks'],
  TRADETYPE_LIST: ['callput', 'multiplier', 'digits', 'highlowticks'],
  TYPE_LIST: ['CALL', 'PUT', 'MULTUP', 'MULTDOWN'],
  CANDLEINTERVAL_LIST: ['60', '120', '180', '300', '600', '900', '1800', '3600', '7200', '14400', '28800', '86400'],
  DURATIONTYPE_LIST: ['t', 's', 'm', 'h', 'd'],
  PAYOUTTYPE_LIST: ['stake'],
  CURRENCY_LIST: ['USD', 'EUR', 'GBP', 'AUD', 'JPY'],
  PURCHASE_LIST: ['CALL', 'PUT', 'MULTUP', 'MULTDOWN'],
  CHECK_DIRECTION: ['rise', 'fall'],
  TIME_MACHINE_ENABLED: ['TRUE', 'FALSE'],
  RESTARTONERROR: ['TRUE', 'FALSE'],
  BBRESULT_LIST: ['upper', 'middle', 'lower'],
  MACDFIELDS_LIST: ['MACD', 'SIGNAL', 'HISTOGRAM'],
  // DBot's own `config.lists` values, in its order.
  NOTIFICATION_TYPE: ['success', 'info', 'warn', 'error'],
  NOTIFICATION_SOUND: ['silent', 'announcement', 'earned-money', 'job-done', 'error', 'severe-error'],
  CHECK_RESULT: ['win', 'loss'],
  DETAIL_INDEX: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']
};

/** Default options for a field name, exported so tests can assert coverage. */
export function fieldDefaults(name: string): readonly string[] {
  return FIELD_DEFAULTS[name] ?? [];
}

/* -------------------------------------------------------------------------- */
/*  Role -> Blockly style / category                                           */
/* -------------------------------------------------------------------------- */

export const ROLE_STYLE: Record<string, string> = {
  'trade-definition': 'trade_blocks',
  market: 'market_blocks',
  contract: 'contract_blocks',
  stake: 'stake_blocks',
  entry: 'entry_blocks',
  exit: 'exit_blocks',
  indicator: 'indicator_blocks',
  logic: 'logic_blocks',
  variable: 'variable_blocks',
  purchase: 'entry_blocks',
  flow: 'logic_blocks',
  utility: 'logic_blocks',
  unsupported: 'unknown_blocks'
};

export const ROLE_CATEGORY: Record<string, string> = {
  'trade-definition': 'trade_category',
  market: 'market_category',
  contract: 'contract_category',
  stake: 'contract_category',
  entry: 'entry_category',
  exit: 'exit_category',
  indicator: 'indicator_category',
  logic: 'logic_category',
  variable: 'variable_category',
  purchase: 'entry_category',
  flow: 'logic_category',
  utility: 'logic_category',
  unsupported: 'logic_category'
};

/* -------------------------------------------------------------------------- */
/*  DBot block declarations                                                    */
/* -------------------------------------------------------------------------- */

export interface DbotBlockDecl {
  /** Blockly block type, identical to DBot's. */
  type: string;
  /** Label shown on the block. */
  label: string;
  /** Registry role, which picks the colour. */
  role: string;
  fields: string[];
  /** Numeric fields use Blockly's number editor instead of a dropdown. */
  numberFields?: string[];
  /** Plain text on the block, with no input. */
  text?: string[];
  /** Statement/value inputs, in the order they appear on the block. */
  inputs?: { name: string; kind: InputKind }[];
  /** Optional labelled rows for blocks with many fields. */
  layout?: { label: string; fields?: string[]; inputs?: string[] }[];
  /** False for expression blocks (they emit a value, not a stack). */
  stack?: boolean;
  /**
   * Blockly output type for expression blocks. `null` means "any type", which
   * is what DBot uses for `read_details` — it can yield a number or a string.
   */
  output?: string | null;
}

/**
 * The supported DBot subset, mirroring `SUPPORTED` in `server/bots/blocks.ts`.
 * Stock Blockly blocks are deliberately absent — they come from
 * `blockly/blocks`.
 */
export const DBOT_DECLS: DbotBlockDecl[] = [
  {
    type: 'math_number_positive',
    label: 'Positive number',
    role: 'logic',
    fields: [],
    numberFields: ['NUM'],
    stack: false,
    output: 'Number'
  },
  {
    type: 'trade',
    label: 'Legacy trade definition',
    role: 'trade-definition',
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
    layout: [
      { label: 'Market', fields: ['MARKET_LIST', 'SUBMARKET_LIST', 'SYMBOL_LIST'] },
      {
        label: 'Contract',
        fields: ['TRADETYPECAT_LIST', 'TRADETYPE_LIST', 'TYPE_LIST']
      },
      { label: 'Candle interval', fields: ['CANDLEINTERVAL_LIST'] },
      { label: 'Trade options', fields: ['TIME_MACHINE_ENABLED', 'RESTARTONERROR'] },
      { label: 'Initialization', inputs: ['INITIALIZATION'] },
      { label: 'Submarket settings', inputs: ['SUBMARKET'] }
    ],
    inputs: [
      { name: 'INITIALIZATION', kind: 'statement' },
      { name: 'SUBMARKET', kind: 'statement' }
    ]
  },
  {
    type: 'tradeOptions',
    label: 'Legacy trade options',
    role: 'stake',
    fields: ['DURATIONTYPE_LIST', 'CURRENCY_LIST'],
    inputs: [
      { name: 'DURATION', kind: 'value' },
      { name: 'AMOUNT', kind: 'value' },
      { name: 'PREDICTION', kind: 'value' }
    ]
  },
  {
    type: 'market',
    label: 'Legacy market selection',
    role: 'market',
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
    ],
    layout: [
      { label: 'Market', fields: ['MARKET_LIST', 'SUBMARKET_LIST', 'SYMBOL_LIST'] },
      { label: 'Contract', fields: ['TRADETYPECAT_LIST', 'TRADETYPE_LIST', 'TYPE_LIST'] },
      { label: 'Candle interval', fields: ['CANDLEINTERVAL_LIST'] },
      {
        label: 'Trade options',
        fields: ['DURATIONTYPE_LIST', 'PAYOUTTYPE_LIST', 'CURRENCY_LIST', 'RESTARTONERROR']
      }
    ],
    inputs: [
      { name: 'DURATION', kind: 'value' },
      { name: 'AMOUNT', kind: 'value' }
    ]
  },
  {
    type: 'last_digit',
    label: 'Last tick digit',
    role: 'entry',
    fields: [],
    text: ['last tick digit'],
    stack: false,
    output: 'Number'
  },
  {
    type: 'trade_definition',
    label: 'Trade definition',
    role: 'trade-definition',
    fields: [],
    text: ['When the bot starts'],
    inputs: [
      { name: 'TRADE_OPTIONS', kind: 'statement' },
      { name: 'SUBMARKET', kind: 'statement' },
      { name: 'INITIALIZATION', kind: 'statement' }
    ]
  },
  {
    type: 'trade_definition_market',
    label: 'Market',
    role: 'market',
    fields: ['MARKET_LIST', 'SUBMARKET_LIST', 'SYMBOL_LIST']
  },
  {
    type: 'trade_definition_tradetype',
    label: 'Trade type',
    role: 'contract',
    fields: ['TRADETYPECAT_LIST', 'TRADETYPE_LIST']
  },
  {
    type: 'trade_definition_contracttype',
    label: 'Contract type',
    role: 'contract',
    fields: ['TYPE_LIST']
  },
  {
    type: 'trade_definition_candleinterval',
    label: 'Candle interval',
    role: 'market',
    fields: ['CANDLEINTERVAL_LIST']
  },
  {
    type: 'trade_definition_tradeoptions',
    label: 'Trade options',
    role: 'stake',
    fields: ['DURATIONTYPE_LIST', 'CURRENCY_LIST'],
    inputs: [
      { name: 'DURATION', kind: 'value' },
      { name: 'AMOUNT', kind: 'value' }
    ]
  },
  {
    // DBot defines this as a literal alias of `trade_definition_tradeoptions`,
    // so it has the same slots; only the label differs.
    type: 'trade_definition_tradeoptions_payout',
    label: 'Trade options (payout)',
    role: 'stake',
    fields: ['DURATIONTYPE_LIST', 'CURRENCY_LIST'],
    inputs: [
      { name: 'DURATION', kind: 'value' },
      { name: 'AMOUNT', kind: 'value' }
    ]
  },
  {
    type: 'trade_definition_restartbuysell',
    label: 'Restart on buy/sell',
    role: 'trade-definition',
    fields: ['TIME_MACHINE_ENABLED']
  },
  {
    type: 'trade_definition_restartonerror',
    label: 'Restart on error',
    role: 'trade-definition',
    fields: ['RESTARTONERROR']
  },
  {
    type: 'before_purchase',
    label: 'Before purchase',
    role: 'entry',
    fields: [],
    inputs: [{ name: 'BEFOREPURCHASE_STACK', kind: 'statement' }]
  },
  {
    type: 'purchase',
    label: 'Purchase',
    role: 'purchase',
    fields: ['PURCHASE_LIST']
  },
  {
    type: 'tick_analysis',
    label: 'Tick analysis',
    role: 'entry',
    fields: [],
    inputs: [{ name: 'TICKANALYSIS_STACK', kind: 'statement' }]
  },
  {
    type: 'check_direction',
    label: 'Direction is',
    role: 'entry',
    fields: ['CHECK_DIRECTION'],
    stack: false,
    output: 'Boolean'
  },
  {
    type: 'tick',
    label: 'Last tick',
    role: 'entry',
    fields: [],
    stack: false,
    output: 'Number'
  },
  {
    type: 'tick_string',
    label: 'Last tick (text)',
    role: 'entry',
    fields: [],
    stack: false,
    output: 'String'
  },
  {
    type: 'ticks_string',
    label: 'Ticks list (text)',
    role: 'entry',
    fields: [],
    stack: false,
    output: 'String'
  },
  {
    type: 'during_purchase',
    label: 'During purchase',
    role: 'exit',
    fields: [],
    inputs: [{ name: 'DURING_PURCHASE_STACK', kind: 'statement' }]
  },
  {
    type: 'check_sell',
    label: 'Sell condition',
    role: 'exit',
    fields: [],
    stack: false,
    output: 'Boolean'
  },
  {
    type: 'after_purchase',
    label: 'After purchase',
    role: 'exit',
    fields: [],
    inputs: [{ name: 'AFTERPURCHASE_STACK', kind: 'statement' }]
  },
  {
    type: 'trade_again',
    label: 'Trade again',
    role: 'exit',
    fields: []
  },
  // DBot's after-purchase readers. Their interpreter handlers are faithful, so
  // the editor declares them exactly as DBot does — a dropdown for the one field,
  // and a value output — rather than showing them as unrecognised placeholders.
  {
    type: 'contract_check_result',
    label: 'Last trade result is',
    role: 'exit',
    fields: ['CHECK_RESULT'],
    stack: false,
    output: 'Boolean'
  },
  {
    type: 'read_details',
    label: 'Contract details',
    role: 'exit',
    fields: ['DETAIL_INDEX'],
    stack: false,
    output: null
  },
  // Shape is DBot's own (`Timeout/timeout.js`): a `TIMEOUTSTACK` statement and a
  // `SECONDS` value input — the seconds are an expression, not a fixed field, so
  // a strategy may read the delay from a variable.
  {
    type: 'timeout',
    label: 'Delayed run',
    role: 'flow',
    fields: [],
    inputs: [
      { name: 'TIMEOUTSTACK', kind: 'statement' },
      { name: 'SECONDS', kind: 'value' }
    ],
    layout: [
      { label: 'Run the blocks inside', inputs: ['TIMEOUTSTACK'] },
      { label: 'after (seconds)', inputs: ['SECONDS'] }
    ]
  },
  // Read-only expressions and side-effecting statements the engine executes but
  // that had no declaration. Each shape below is copied from the corresponding
  // block in `deriv-app`'s `bot-skeleton`; without them Blockly refuses to load
  // any strategy that contains one.
  {
    type: 'notify',
    label: 'Notify',
    role: 'exit',
    fields: ['NOTIFICATION_TYPE', 'NOTIFICATION_SOUND'],
    inputs: [{ name: 'MESSAGE', kind: 'value' }],
    layout: [
      {
        label: 'Notify',
        fields: ['NOTIFICATION_TYPE', 'NOTIFICATION_SOUND'],
        inputs: ['MESSAGE']
      }
    ]
  },
  {
    type: 'total_profit',
    label: 'Total profit/loss',
    role: 'exit',
    fields: [],
    stack: false,
    output: 'Number'
  },
  {
    type: 'total_profit_string',
    label: 'Total profit/loss (text)',
    role: 'exit',
    fields: [],
    stack: false,
    output: 'String'
  },
  {
    type: 'lastDigitList',
    label: 'Last digits list',
    role: 'entry',
    fields: [],
    stack: false,
    output: 'Array'
  },
  {
    // DBot's own list block (not stock Blockly): one value per statement slot,
    // stacked to build a list literal.
    type: 'lists_statement',
    label: 'List item',
    role: 'utility',
    fields: [],
    inputs: [{ name: 'VALUE', kind: 'value' }]
  },
  {
    type: 'ticks',
    label: 'Ticks list',
    role: 'entry',
    fields: [],
    stack: false,
    output: 'Array'
  },
  {
    type: 'sell_at_market',
    label: 'Sell at market price',
    role: 'exit',
    fields: []
  },
  {
    type: 'sell_price',
    label: 'Sell profit/loss',
    role: 'exit',
    fields: [],
    stack: false,
    output: 'Number'
  },
  {
    type: 'sma_statement',
    label: 'Simple moving average',
    role: 'indicator',
    fields: ['VARIABLE'],
    inputs: [{ name: 'STATEMENT', kind: 'statement' }]
  },
  {
    type: 'ema_statement',
    label: 'Exponential moving average',
    role: 'indicator',
    fields: ['VARIABLE'],
    inputs: [{ name: 'STATEMENT', kind: 'statement' }]
  },
  {
    type: 'rsi_statement',
    label: 'Relative strength index',
    role: 'indicator',
    fields: ['VARIABLE'],
    inputs: [{ name: 'STATEMENT', kind: 'statement' }]
  },
  {
    type: 'bb_statement',
    label: 'Bollinger bands',
    role: 'indicator',
    fields: ['VARIABLE', 'BBRESULT_LIST'],
    inputs: [{ name: 'STATEMENT', kind: 'statement' }]
  },
  {
    type: 'macda_statement',
    label: 'MACD',
    role: 'indicator',
    fields: ['VARIABLE', 'MACDFIELDS_LIST'],
    inputs: [{ name: 'STATEMENT', kind: 'statement' }]
  }
];

/* -------------------------------------------------------------------------- */
/*  Definition generation                                                      */
/* -------------------------------------------------------------------------- */

function labelArg(text: string): Record<string, unknown> {
  return { type: 'field_label', name: `LBL_${text.replace(/\W+/g, '_')}`, text };
}

function dropdownArg(name: string, extraValues: Iterable<string>): Record<string, unknown> {
  const options = new Set<string>(FIELD_DEFAULTS[name] ?? []);
  for (const value of extraValues) options.add(value);
  return {
    type: 'field_dropdown',
    name,
    options: [...options].map((value) => [value, value])
  };
}

function inputArg(input: { name: string; kind: InputKind }): Record<string, unknown> {
  return {
    type: input.kind === 'value' ? 'input_value' : 'input_statement',
    name: input.name
  };
}

/**
 * Builds the JSON definition for one DBot block.
 *
 * `observed` supplies the field values present in the loaded strategy, so a
 * dropdown never coerces a value the file actually uses.
 */
export function declToJson(decl: DbotBlockDecl, observed: Map<string, Set<string>>): Record<string, unknown> {
  const fieldArgs = new Map<string, Record<string, unknown>>();
  for (const field of decl.fields) {
    if (field === 'VARIABLE') {
      fieldArgs.set(field, { type: 'field_variable', name: 'VARIABLE' });
      continue;
    }
    fieldArgs.set(field, dropdownArg(field, observed.get(field) ?? []));
  }
  for (const field of decl.numberFields ?? []) {
    fieldArgs.set(field, { type: 'field_number', name: field, value: 0 });
  }
  const inputArgs = new Map(
    (decl.inputs ?? []).map((input) => [input.name, inputArg(input)])
  );
  const textArgs = (decl.text ?? []).map(labelArg);

  // `style` alone drives the colour: the theme's `blockStyles` map owns every
  // hue, and Blockly throws if a definition sets both `colour` and `style`.
  const json: Record<string, unknown> = {
    type: decl.type,
    tooltip: decl.label,
    helpUrl: '',
    style: ROLE_STYLE[decl.role] ?? 'trade_blocks',
    category: ROLE_CATEGORY[decl.role] ?? 'trade_category'
  };

  if (decl.layout) {
    for (const [index, row] of decl.layout.entries()) {
      const getField = (name: string) => {
        const arg = fieldArgs.get(name);
        if (!arg) throw new Error(`${decl.type} layout references missing field "${name}".`);
        return arg;
      };
      const getInput = (name: string) => {
        const arg = inputArgs.get(name);
        if (!arg) throw new Error(`${decl.type} layout references missing input "${name}".`);
        return arg;
      };
      const args = [
        labelArg(row.label),
        ...(row.fields ?? []).map(getField),
        ...(row.inputs ?? []).map(getInput)
      ];
      json[`message${index}`] = args.map((_, argIndex) => `%${argIndex + 1}`).join(' ');
      json[`args${index}`] = args;
    }
  } else {
    const args = [
      ...fieldArgs.values(),
      ...textArgs,
      ...inputArgs.values()
    ];
    json.message0 = args.map((_, i) => `%${i + 1}`).join(' ');
    json.args0 = args;
  }

  if (decl.stack === false) {
    json.output = decl.output === undefined ? 'Boolean' : decl.output;
  } else {
    json.previousStatement = null;
    json.nextStatement = null;
  }
  return json;
}

/** Declaration lookup by type, for tests and for the toolbox. */
export function dbotDeclarations(): readonly DbotBlockDecl[] {
  return DBOT_DECLS;
}

/**
 * Builds a read-only placeholder for a block type this build does not know.
 *
 * Every field becomes a disabled text input, so its value is visible and
 * preserved; every input keeps its name, so the block's children stay
 * attached.
 */
export function unknownToJson(
  dbotType: string,
  fields: string[],
  inputs: { name: string; kind: InputKind }[],
  shape: 'stack' | 'value' = 'stack'
): Record<string, unknown> {
  const args: Record<string, unknown>[] = [
    labelArg(`Unknown block: ${dbotType}`),
    ...fields.map((name) => ({ type: 'field_input', name, text: '', disabled: true })),
    ...inputs.map(inputArg)
  ];
  return {
    type: unknownBlockType(dbotType, shape),
    message0: args.map((_, i) => `%${i + 1}`).join(' '),
    args0: args,
    ...(shape === 'stack'
      ? { previousStatement: null, nextStatement: null }
      : { output: null }),
    style: 'unknown_blocks',
    category: 'logic_category',
    tooltip: `No-touch cannot interpret "${dbotType}". It is shown unchanged and blocks execution.`,
    helpUrl: ''
  };
}

