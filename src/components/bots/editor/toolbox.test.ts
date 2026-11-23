import test from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTABLE_BLOCKS, strategyToolbox, toolboxBlockTypes } from './toolbox';
import { DBOT_DECLS } from './definitions';
import { EXECUTABLE } from '../../../../server/bots/evaluator';

/**
 * Toolbox/runtime agreement.
 *
 * The palette must not offer a block the runtime refuses: a strategy built from
 * an unrunnable block is guaranteed to fail, and the person who built it has no
 * way to know until they try to run it. These tests fail if the two lists drift.
 */

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
const STOCK_BLOCKS = new Set([
  'controls_flow_statements',
  'controls_for',
  'controls_forEach',
  'controls_if',
  'controls_repeat',
  'controls_repeat_ext',
  'controls_whileUntil',
  'lists_create_with',
  'lists_getIndex',
  'lists_indexOf',
  'lists_isEmpty',
  'lists_length',
  'logic_boolean',
  'logic_compare',
  'logic_negate',
  'logic_null',
  'logic_operation',
  'logic_ternary',
  'math_arithmetic',
  'math_change',
  'math_constant',
  'math_constrain',
  'math_modulo',
  'math_number',
  'math_round',
  'math_single',
  'procedures_callnoreturn',
  'procedures_callreturn',
  'procedures_defnoreturn',
  'procedures_defreturn',
  'procedures_ifreturn',
  'text',
  'text_isEmpty',
  'text_join',
  'text_length',
  'variables_get',
  'variables_set'
]);

test('every palette block is either declared here or a stock Blockly block', () => {
  const declared = new Set(DBOT_DECLS.map((decl) => decl.type));
  const offending = toolboxBlockTypes().filter(
    (type) => !declared.has(type) && !STOCK_BLOCKS.has(type)
  );
  assert.deepEqual(offending, [], `palette references undefined blocks: ${offending.join(', ')}`);
});

test('every executable block is reachable from the palette', () => {
  // The inverse of the first test: a block the runtime can run but the palette
  // never offers is capability the UI silently withholds.
  const offered = new Set(toolboxBlockTypes());
  const missing = [...EXECUTABLE].filter((type) => !offered.has(type)).sort();
  assert.deepEqual(missing, [], `runtime can run these blocks but the palette hides them: ${missing.join(', ')}`);
});

test('no toolbox category is empty', () => {
  const toolbox = strategyToolbox() as { contents: { name: string; contents: unknown[] }[] };
  const empty = toolbox.contents.filter((c) => c.contents.length === 0).map((c) => c.name);
  assert.deepEqual(empty, []);
});

test('toolbox exposes the requested categories with category icons', () => {
  const toolbox = strategyToolbox() as {
    contents: { name: string; cssconfig: { icon: string } }[];
  };
  assert.deepEqual(
    toolbox.contents.map((category) => category.name),
    [
      'Trade',
      'Market',
      'Trade options',
      'Contract',
      'Entry conditions',
      'Exit conditions',
      'Indicators',
      'Logic',
      'Loops',
      'Mathematics',
      'Text',
      'Lists',
      'Variables',
      'Functions',
      'Utility'
    ]
  );
  assert.ok(
    toolbox.contents.every((category) => category.cssconfig.icon.startsWith('ws-blockly-category-icon')),
    'category icons must be styled without adding placeholder blocks'
  );
});
