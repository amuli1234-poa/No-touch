import { DBOT_DECLS } from './definitions';

/**
 * The toolbox definition.
 *
 * Kept free of Blockly imports so it can be tested under the plain test runner,
 * the same rule `definitions.ts` follows. `blocks.ts` is the only module that
 * touches Blockly's registry.
 *
 * Categories mirror the DBot mental model so someone who has used Deriv Bot
 * finds the blocks where they expect them. Only executable blocks are listed:
 * offering a block the runtime refuses would let someone build a strategy that
 * is guaranteed not to run. A category with nothing executable is omitted
 * rather than shown empty, because an empty drawer implies capability the build
 * does not have.
 */

/**
 * Stock Blockly blocks the runtime executes.
 *
 * These come from `blockly/blocks` rather than from `definitions.ts`, so they
 * carry no `DbotBlockDecl`. They are listed explicitly because the palette must
 * offer them: a strategy that uses a loop or a procedure is ordinary DBot XML,
 * and hiding those blocks made a whole class of real exports unbuildable.
 */
const STOCK_BLOCKS: Readonly<Record<string, readonly string[]>> = {
  Logic: [
    'controls_if',
    'logic_compare',
    'logic_operation',
    'logic_negate',
    'logic_boolean',
    'logic_null',
    'logic_ternary',
    'controls_flow_statements'
  ],
  Loops: [
    'controls_repeat_ext',
    'controls_repeat',
    'controls_whileUntil',
    'controls_for',
    'controls_forEach'
  ],
  Mathematics: [
    'math_number',
    'math_arithmetic',
    'math_single',
    'math_round',
    'math_constant',
    'math_constrain',
    'math_modulo',
    'math_change'
  ],
  Text: ['text', 'text_join', 'text_length', 'text_isEmpty'],
  Lists: ['lists_create_with', 'lists_length', 'lists_isEmpty', 'lists_getIndex', 'lists_indexOf'],
  Variables: ['variables_get', 'variables_set'],
  Functions: [
    'procedures_defnoreturn',
    'procedures_defreturn',
    'procedures_callnoreturn',
    'procedures_callreturn',
    'procedures_ifreturn'
  ]
};

/**
 * Blocks the runtime can execute.
 *
 * Mirrors `EXECUTABLE` in `server/bots/evaluator.ts`; `blocks.test.ts` fails if
 * the two drift apart. Imported strategies may still contain excluded types —
 * they render and are preserved — they are simply not offered for new work.
 *
 * Every type listed here is offered somewhere in the palette: `toolbox.test.ts`
 * asserts the two sets are equal, so a block cannot become runnable without
 * also becoming reachable.
 */
export const EXECUTABLE_BLOCKS: ReadonlySet<string> = new Set([
  // Trade definition
  'trade',
  'tradeOptions',
  'trade_definition',
  'trade_definition_tradetype',
  'trade_definition_contracttype',
  'trade_definition_candleinterval',
  'trade_definition_tradeoptions',
  'trade_definition_restartbuysell',
  'trade_definition_restartonerror',
  // Lifecycle
  'before_purchase',
  'during_purchase',
  'after_purchase',
  'tick_analysis',
  // Entry
  'purchase',
  'check_direction',
  'tick',
  'tick_string',
  'ticks',
  'ticks_string',
  'last_digit',
  'lastDigitList',
  // Exit
  'check_sell',
  'contract_check_result',
  'read_details',
  'sell_at_market',
  'sell_price',
  'total_profit',
  'total_profit_string',
  'trade_again',
  // Indicators
  'sma_statement',
  'ema_statement',
  // Market
  'market',
  'trade_definition_market',
  // Values and utility
  'math_number_positive',
  'lists_statement',
  'notify',
  'timeout',
  // Stock Blockly blocks the runtime also executes. See `STOCK_BLOCKS`.
  ...Object.values(STOCK_BLOCKS).flat()
]);

interface ToolboxCategory {
  kind: 'category';
  name: string;
  categorystyle: string;
  cssconfig: { icon: string };
  expanded: boolean;
  contents: { kind: 'block'; type: string }[];
}

export interface StrategyToolbox {
  kind: 'categoryToolbox';
  contents: ToolboxCategory[];
}

export function strategyToolbox(): StrategyToolbox {
  const category = (
    name: string,
    style: string,
    icon: string,
    types: readonly string[],
    expanded = false
  ): ToolboxCategory => ({
    kind: 'category',
    name,
    categorystyle: style,
    cssconfig: { icon: `ws-blockly-category-icon ws-blockly-category-icon--${icon}` },
    expanded,
    contents: [...new Set(types)]
      .filter((type) => EXECUTABLE_BLOCKS.has(type))
      .map((type) => ({ kind: 'block' as const, type }))
  });
  const pick = (...roles: string[]) =>
    DBOT_DECLS.filter((decl) => roles.includes(decl.role)).map((decl) => decl.type);

  return {
    kind: 'categoryToolbox',
    contents: [
      category('Trade', 'trade_category', 'trade', pick('trade-definition'), true),
      category('Market', 'market_category', 'market', pick('market'), true),
      category('Trade options', 'stake_category', 'options', pick('stake')),
      category('Contract', 'contract_category', 'contract', pick('contract')),
      category(
        'Entry conditions',
        'entry_category',
        'entry',
        [...pick('entry'), ...pick('purchase')]
      ),
      category('Exit conditions', 'exit_category', 'exit', pick('exit')),
      category('Indicators', 'indicator_category', 'indicator', pick('indicator')),
      category('Logic', 'logic_category', 'logic', STOCK_BLOCKS.Logic),
      category('Loops', 'loop_category', 'loop', STOCK_BLOCKS.Loops),
      category('Mathematics', 'math_category', 'math', [
        ...STOCK_BLOCKS.Mathematics,
        ...pick('logic')
      ]),
      category('Text', 'text_category', 'text', STOCK_BLOCKS.Text),
      category('Lists', 'list_category', 'list', [...STOCK_BLOCKS.Lists, ...pick('utility')]),
      category('Variables', 'variable_category', 'variables', STOCK_BLOCKS.Variables),
      category('Functions', 'function_category', 'function', STOCK_BLOCKS.Functions),
      category('Utility', 'utility_category', 'utility', pick('flow'))
    ].filter((c) => c.contents.length > 0)
  };
}

/** Every block type the palette offers, for the coverage test. */
export function toolboxBlockTypes(): string[] {
  return strategyToolbox().contents.flatMap((category) =>
    category.contents.map((block) => block.type)
  );
}

export { STOCK_BLOCKS };
