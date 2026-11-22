/**
 * Blockly registration for the strategy editor.
 *
 * The block *declarations* live in `definitions.ts`, which imports nothing from
 * Blockly and is therefore testable under the plain test runner. This module is
 * the only place that touches Blockly's registry, so the browser is the only
 * consumer of the Blockly dependency.
 */

import * as Blockly from 'blockly/core';
import 'blockly/blocks';

import {
  DBOT_DECLS,
  declToJson,
  unknownBlockType,
  unknownToJson,
  type InputKind
} from './definitions';
import { strategyTheme } from './theme';

export {
  DBOT_DECLS,
  UNKNOWN_BLOCK_PREFIX,
  dbotDeclarations,
  declToJson,
  fieldDefaults,
  isUnknownBlockType,
  originalBlockType,
  unknownBlockType,
  unknownToJson
} from './definitions';
export type { DbotBlockDecl, InputKind } from './definitions';

let registered = false;

/**
 * Registers every block definition. Idempotent: Blockly throws on a duplicate
 * type and React can mount the editor more than once.
 */
export function registerStrategyBlocks(): void {
  if (registered) return;
  registered = true;
  Blockly.common.defineBlocksWithJsonArray(DBOT_DECLS.map((decl) => declToJson(decl, new Map())));
}

/**
 * Registers placeholder definitions for the unknown block types in a tree.
 *
 * Called on every load, because the set of unknown types depends on the file
 * being opened. Each type is defined once.
 */
export function registerUnknownBlocks(
  blocks: { type: string; fields: { name: string }[]; inputs: { name: string; kind: InputKind }[] }[]
): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (!block.type || seen.has(block.type)) continue;
    seen.add(block.type);
    const placeholder = unknownBlockType(block.type);
    if (Blockly.Blocks[placeholder]) continue;
    Blockly.common.defineBlocksWithJsonArray([
      unknownToJson(
        block.type,
        block.fields.map((f) => f.name),
        block.inputs.map((i) => ({ name: i.name, kind: i.kind }))
      )
    ]);
  }
}

/** The toolbox definition, grouped by role. */
export function strategyToolbox(): Record<string, unknown> {
  const category = (name: string, style: string, types: string[]) => ({
    kind: 'category',
    name,
    categorystyle: style,
    contents: types.map((type) => ({ kind: 'block', type }))
  });
  const pick = (...roles: string[]) =>
    DBOT_DECLS.filter((decl) => roles.includes(decl.role)).map((decl) => decl.type);

  return {
    kind: 'categoryToolbox',
    contents: [
      category('Trade', 'trade_category', pick('trade-definition')),
      category('Market', 'market_category', [...pick('market'), ...pick('contract')]),
      category('Entry', 'entry_category', [...pick('entry'), ...pick('purchase')]),
      category('Exit', 'exit_category', pick('exit')),
      category('Indicators', 'indicator_category', pick('indicator')),
      category('Logic', 'logic_category', [
        'controls_if',
        'logic_compare',
        'logic_operation',
        'logic_negate',
        'logic_boolean',
        'math_number',
        'math_arithmetic'
      ]),
      category('Variables', 'variable_category', ['variables_get', 'variables_set'])
    ]
  };
}

export { strategyTheme };
