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
 * Blocks the runtime can execute.
 *
 * Mirrors `EXECUTABLE` in `server/bots/evaluator.ts`; `blocks.test.ts` fails if
 * the two drift apart. Imported strategies may still contain excluded types —
 * they render and are preserved — they are simply not offered for new work.
 */
export const EXECUTABLE_BLOCKS: ReadonlySet<string> = new Set([
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
  'logic_compare',
  'sma_statement',
  'ema_statement',
  'variables_get',
  'during_purchase',
  'after_purchase',
  'trade_again'
]);

interface ToolboxCategory {
  kind: 'category';
  name: string;
  categorystyle: string;
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
    types: string[],
    expanded = false
  ): ToolboxCategory => ({
    kind: 'category',
    name,
    categorystyle: style,
    expanded,
    contents: types
      .filter((type) => EXECUTABLE_BLOCKS.has(type))
      .map((type) => ({ kind: 'block' as const, type }))
  });
  const pick = (...roles: string[]) =>
    DBOT_DECLS.filter((decl) => roles.includes(decl.role)).map((decl) => decl.type);

  return {
    kind: 'categoryToolbox',
    contents: [
      category('Trade', 'trade_category', pick('trade-definition'), true),
      category('Market', 'market_category', pick('market'), true),
      category('Trade options', 'stake_category', pick('stake')),
      category('Contract', 'contract_category', pick('contract')),
      category('Entry conditions', 'entry_category', [...pick('entry'), ...pick('purchase')]),
      category('Exit conditions', 'exit_category', pick('exit')),
      category('Indicators', 'indicator_category', pick('indicator')),
      category('Logic', 'logic_category', ['logic_compare']),
      category('Mathematics', 'math_category', ['math_number']),
      category('Variables', 'variable_category', ['variables_get'])
    ].filter((c) => c.contents.length > 0)
  };
}
