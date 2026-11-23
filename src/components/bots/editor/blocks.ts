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
const registeredFieldValues = new Map<string, Set<string>>();
const placeholderMutations = new WeakMap<Blockly.Block, Element>();

/**
 * Registers every block definition. Idempotent: Blockly throws on a duplicate
 * type and React can mount the editor more than once.
 */
export function registerStrategyBlocks(observed = new Map<string, Set<string>>()): void {
  let changed = !registered;
  for (const [field, values] of observed) {
    let known = registeredFieldValues.get(field);
    if (!known) {
      known = new Set<string>();
      registeredFieldValues.set(field, known);
    }
    for (const value of values) {
      if (known.has(value)) continue;
      known.add(value);
      changed = true;
    }
  }
  if (!changed) return;
  Blockly.common.defineBlocksWithJsonArray(
    DBOT_DECLS.map((decl) => declToJson(decl, registeredFieldValues))
  );
  registered = true;
}

/**
 * Registers placeholder definitions for the unknown block types in a tree.
 *
 * Called on every load, because the set of unknown types depends on the file
 * being opened. Each type is defined once.
 */
export function registerUnknownBlocks(
  blocks: {
    type: string;
    shape: 'stack' | 'value';
    fields: { name: string }[];
    inputs: { name: string; kind: InputKind }[];
  }[]
): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    const key = `${block.type}\0${block.shape}`;
    if (!block.type || seen.has(key)) continue;
    seen.add(key);
    const placeholder = unknownBlockType(block.type, block.shape);
    if (Blockly.Blocks[placeholder]) continue;
    Blockly.common.defineBlocksWithJsonArray([
      unknownToJson(
        block.type,
        block.fields.map((f) => f.name),
        block.inputs.map((i) => ({ name: i.name, kind: i.kind })),
        block.shape
      )
    ]);
    const definition = Blockly.Blocks[placeholder];
    definition.domToMutation = function (this: Blockly.Block, mutation: Element): void {
      placeholderMutations.set(this, mutation.cloneNode(true) as Element);
    };
    definition.mutationToDom = function (this: Blockly.Block): Element {
      const mutation = placeholderMutations.get(this);
      return mutation
        ? (mutation.cloneNode(true) as Element)
        : Blockly.utils.xml.createElement('mutation');
    };
  }
}

export { strategyTheme };
