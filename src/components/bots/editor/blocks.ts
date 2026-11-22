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

export { EXECUTABLE_BLOCKS, strategyToolbox } from './toolbox';

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

export { strategyTheme };
