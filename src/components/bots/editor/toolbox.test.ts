import test from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTABLE_BLOCKS, strategyToolbox } from './toolbox';
import { DBOT_DECLS } from './definitions';
import { EXECUTABLE } from '../../../../server/bots/evaluator';

/**
 * Toolbox/runtime agreement.
 *
 * The palette must not offer a block the runtime refuses: a strategy built from
 * an unrunnable block is guaranteed to fail, and the person who built it has no
 * way to know until they try to run it. These tests fail if the two lists drift.
 */

function toolboxBlockTypes(): string[] {
  const toolbox = strategyToolbox() as {
    contents: { name: string; contents: { type: string }[] }[];
  };
  return toolbox.contents.flatMap((category) => category.contents.map((b) => b.type));
}

test('every block in the palette is executable by the runtime', () => {
  const offending = toolboxBlockTypes().filter((type) => !EXECUTABLE.has(type));
  assert.deepEqual(offending, [], `palette offers blocks the runtime cannot run: ${offending.join(', ')}`);
});

test('the palette is a subset of the runtime executable set', () => {
  // The palette need not offer every executable block — one may be executable
  // but have no Blockly definition here — but it must never offer more.
  const extra = [...EXECUTABLE_BLOCKS].filter((type) => !EXECUTABLE.has(type));
  assert.deepEqual(extra, [], `client claims blocks the runtime cannot run: ${extra.join(', ')}`);
});

test('the palette lists no duplicate block types', () => {
  const types = toolboxBlockTypes();
  assert.equal(new Set(types).size, types.length);
});

/** Stock Blockly blocks, registered by the `blockly/blocks` import rather than by us. */
const STOCK_BLOCKS = new Set(['logic_compare', 'math_number', 'variables_get']);

test('every palette block is either declared here or a stock Blockly block', () => {
  const declared = new Set(DBOT_DECLS.map((decl) => decl.type));
  const offending = toolboxBlockTypes().filter(
    (type) => !declared.has(type) && !STOCK_BLOCKS.has(type)
  );
  assert.deepEqual(offending, [], `palette references undefined blocks: ${offending.join(', ')}`);
});

test('no toolbox category is empty', () => {
  const toolbox = strategyToolbox() as { contents: { name: string; contents: unknown[] }[] };
  const empty = toolbox.contents.filter((c) => c.contents.length === 0).map((c) => c.name);
  assert.deepEqual(empty, []);
});
