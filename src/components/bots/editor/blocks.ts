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
 * Defines one placeholder for a block type Blockly has no definition for,
 * carrying the fields and inputs read from the XML so nothing is lost on save.
 * Idempotent: a type already registered keeps its first definition.
 */
function definePlaceholder(
  type: string,
  shape: 'stack' | 'value',
  fields: { name: string }[],
  inputs: { name: string; kind: InputKind }[]
): void {
  const placeholder = unknownBlockType(type, shape);
  if (Blockly.Blocks[placeholder]) return;
  Blockly.common.defineBlocksWithJsonArray([
    unknownToJson(
      type,
      fields.map((field) => field.name),
      inputs.map((input) => ({ name: input.name, kind: input.kind })),
      shape
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

/**
 * Registers placeholder definitions for the unknown block types the server
 * reported for the file being opened. Each type is defined once.
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
    definePlaceholder(block.type, block.shape, block.fields, block.inputs);
  }
}

/**
 * Registers a placeholder for every block type in `root` that Blockly has no
 * definition for, and returns the `type\0shape` keys that must be renamed to
 * their placeholder type before the XML is handed to Blockly.
 *
 * `Blockly.Xml.domToWorkspace` throws `Invalid block definition for type: X`
 * and abandons the whole load when it meets an undefined type. The server-side
 * seeds only cover types it reports as unsupported, so a type the engine
 * executes but the editor never declared would crash the editor outright. This
 * is the backstop for that gap: reading the shape from the XML means no
 * imported strategy can fail to open, whatever the declaration list says.
 */
export function registerBlocksMissingFromXml(root: Element): Set<string> {
  const renamed = new Set<string>();
  const nodes = [root, ...Array.from(root.querySelectorAll('block, shadow'))];
  for (const node of nodes) {
    const type = node.getAttribute('type');
    if (!type || Blockly.Blocks[type]) continue;
    const shape: 'stack' | 'value' = node.parentElement?.nodeName === 'value' ? 'value' : 'stack';
    const children = Array.from(node.children);
    definePlaceholder(
      type,
      shape,
      children
        .filter((child) => child.nodeName === 'field')
        .map((child) => ({ name: child.getAttribute('name') ?? '' }))
        .filter((field) => field.name !== ''),
      children
        .filter((child) => child.nodeName === 'value' || child.nodeName === 'statement')
        .map((child) => ({
          name: child.getAttribute('name') ?? '',
          kind: (child.nodeName === 'value' ? 'value' : 'statement') as InputKind
        }))
        .filter((input) => input.name !== '')
    );
    renamed.add(`${type}\0${shape}`);
  }
  return renamed;
}

export { strategyTheme };
