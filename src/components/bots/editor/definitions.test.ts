import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { xmlToTree } from '../../../../server/bots/tree';

import {
  DBOT_DECLS,
  ROLE_CATEGORY,
  ROLE_STYLE,
  UNKNOWN_BLOCK_PREFIX,
  declToJson,
  fieldDefaults,
  isUnknownBlockType,
  originalBlockType,
  unknownBlockType,
  unknownToJson
} from './definitions';

function messageArgs(json: Record<string, unknown>): { type: string; name?: string }[] {
  return Object.keys(json)
    .filter((key) => /^args\d+$/.test(key))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .flatMap((key) => json[key] as { type: string; name?: string }[]);
}

/**
 * Block-definition tests.
 *
 * These cover the pure logic that decides how a DBot strategy renders. The
 * rules that matter:
 *   * every field the server parses has a dropdown, so no value is uneditable;
 *   * a dropdown keeps values the loaded file actually uses, because Blockly
 *     coerces an unknown value to its first option and would otherwise rewrite
 *     the strategy on open;
 *   * an unknown block gets a placeholder that preserves its fields.
 */

test('every DBot declaration has a unique block type', () => {
  const types = DBOT_DECLS.map((d) => d.type);
  assert.equal(new Set(types).size, types.length, 'block types must be unique');
});

test('every declared field is either a dropdown or a variable field', () => {
  for (const decl of DBOT_DECLS) {
    const json = declToJson(decl, new Map());
    const args = messageArgs(json);
    for (const field of decl.fields) {
      const arg = args.find((a) => a.name === field);
      assert.ok(arg, `${decl.type} is missing a field for ${field}`);
      if (field === 'VARIABLE') {
        assert.equal(arg.type, 'field_variable', `${decl.type}.${field} must be a variable field`);
      } else {
        assert.equal(arg.type, 'field_dropdown', `${decl.type}.${field} must be a dropdown`);
      }
    }
  }
});

test('positive-number blocks keep a numeric editor for their literal', () => {
  const json = declToJson(DBOT_DECLS.find((decl) => decl.type === 'math_number_positive')!, new Map());
  const args = json.args0 as { type: string; name?: string; value?: number }[];
  assert.deepEqual(args.find((arg) => arg.name === 'NUM'), {
    type: 'field_number',
    name: 'NUM',
    value: 0
  });
  assert.equal(json.output, 'Number');
});

test('every field has default dropdown options', () => {
  for (const decl of DBOT_DECLS) {
    for (const field of decl.fields) {
      if (field === 'VARIABLE') continue;
      assert.ok(
        fieldDefaults(field).length > 0,
        `${field} has no default options, so its dropdown would render empty`
      );
    }
  }
});

test('a dropdown keeps a value the strategy actually uses', () => {
  // A symbol this build has never seen must survive, not be coerced to R_10.
  const observed = new Map<string, Set<string>>([['SYMBOL_LIST', new Set(['EXOTIC_42'])]]);
  const market = DBOT_DECLS.find((d) => d.type === 'trade_definition_market')!;
  const json = declToJson(market, observed);
  const args = json.args0 as { name?: string; options?: [string, string][] }[];
  const symbol = args.find((a) => a.name === 'SYMBOL_LIST')!;
  const values = (symbol.options ?? []).map(([value]) => value);
  assert.ok(values.includes('EXOTIC_42'), 'an observed value must be offered as an option');
  assert.ok(values.includes('R_100'), 'the defaults must still be present');
});

test('dropdown options are de-duplicated', () => {
  const observed = new Map<string, Set<string>>([['SYMBOL_LIST', new Set(['R_100'])]]);
  const market = DBOT_DECLS.find((d) => d.type === 'trade_definition_market')!;
  const json = declToJson(market, observed);
  const args = json.args0 as { name?: string; options?: [string, string][] }[];
  const values = (args.find((a) => a.name === 'SYMBOL_LIST')!.options ?? []).map(([v]) => v);
  assert.equal(new Set(values).size, values.length, 'R_100 must not appear twice');
});

test('stack blocks get previous and next connections; expression blocks get output', () => {
  const stack = DBOT_DECLS.find((d) => d.type === 'purchase')!;
  const stackJson = declToJson(stack, new Map());
  assert.equal(stackJson.previousStatement, null);
  assert.equal(stackJson.nextStatement, null);
  assert.equal(stackJson.output, undefined);

  const expression = DBOT_DECLS.find((d) => d.type === 'check_direction')!;
  const exprJson = declToJson(expression, new Map());
  assert.equal(exprJson.output, 'Boolean');
  assert.equal(exprJson.previousStatement, undefined);
});

test('statement inputs become Blockly statement sockets', () => {
  const json = declToJson(DBOT_DECLS.find((d) => d.type === 'before_purchase')!, new Map());
  const args = json.args0 as { type: string; name?: string }[];
  const input = args.find((a) => a.name === 'BEFOREPURCHASE_STACK')!;
  assert.equal(input.type, 'input_statement');
});

test('legacy trade fields render in labeled rows instead of one oversized strip', () => {
  const trade = DBOT_DECLS.find((decl) => decl.type === 'trade')!;
  const json = declToJson(trade, new Map());
  const rows = [0, 1, 2, 3, 4, 5].map(
    (index) => json[`args${index}`] as { name: string; text?: string }[]
  );

  assert.deepEqual(rows.map((args) => args[0].text), [
    'Market',
    'Contract',
    'Candle interval',
    'Trade options',
    'Initialization',
    'Submarket settings'
  ]);
  for (const field of trade.fields) {
    assert.ok(messageArgs(json).some((arg) => arg.name === field), `${field} must stay editable`);
  }
});

test('value inputs become Blockly value sockets', () => {
  const json = declToJson(DBOT_DECLS.find((d) => d.type === 'trade_definition_tradeoptions')!, new Map());
  const args = json.args0 as { type: string; name?: string }[];
  assert.equal(args.find((a) => a.name === 'DURATION')!.type, 'input_value');
  assert.equal(args.find((a) => a.name === 'AMOUNT')!.type, 'input_value');
});

test('unknown block types are namespaced and reversible', () => {
  for (const shape of ['stack', 'value'] as const) {
    const generated = unknownBlockType('future_block', shape);
    assert.ok(generated.startsWith(UNKNOWN_BLOCK_PREFIX));
    assert.equal(isUnknownBlockType(generated), true);
    assert.equal(originalBlockType(generated), 'future_block');
  }
  assert.equal(isUnknownBlockType('purchase'), false);
  assert.equal(originalBlockType('purchase'), 'purchase');
});

test('an unknown block placeholder preserves every field and input', () => {
  const json = unknownToJson('future_block', ['KEEP', 'ALSO'], [
    { name: 'STACK', kind: 'statement' }
  ]);
  const args = json.args0 as { type: string; name?: string }[];
  const fieldNames = args.filter((a) => a.type === 'field_input').map((a) => a.name);
  assert.deepEqual(fieldNames, ['KEEP', 'ALSO']);
  assert.ok(args.some((a) => a.type === 'input_statement' && a.name === 'STACK'));
  // Read-only: an unknown block must not be editable into something else.
  for (const arg of args) {
    if (arg.type === 'field_input') {
      assert.equal((arg as { disabled?: boolean }).disabled, true);
    }
  }
});

test('a stack placeholder keeps its statement children attachable', () => {
  const json = unknownToJson('future_block', [], [{ name: 'BODY', kind: 'statement' }]);
  assert.equal(json.previousStatement, null);
  assert.equal(json.nextStatement, null);
  assert.equal(json.output, undefined);
  const args = json.args0 as { type: string; name?: string }[];
  assert.equal(args.find((arg) => arg.name === 'BODY')?.type, 'input_statement');
});

test('a value placeholder has an output connection, not stack connections', () => {
  const json = unknownToJson('future_value', [], [{ name: 'ARG', kind: 'value' }], 'value');
  assert.equal(json.output, null);
  assert.equal(json.previousStatement, undefined);
  assert.equal(json.nextStatement, undefined);
  const args = json.args0 as { type: string; name?: string }[];
  assert.equal(args.find((arg) => arg.name === 'ARG')?.type, 'input_value');
});

test('every declaration carries a tooltip and a style', () => {
  for (const decl of DBOT_DECLS) {
    const json = declToJson(decl, new Map());
    assert.ok(typeof json.tooltip === 'string' && json.tooltip.length > 0, `${decl.type} needs a tooltip`);
    assert.ok(typeof json.style === 'string', `${decl.type} needs a style`);
  }
});

test('no definition sets both colour and style, which Blockly rejects', () => {
  // Blockly throws "Must not have both a colour and a style" during inject,
  // which takes the whole editor down. The theme owns every hue.
  const definitions = [...DBOT_DECLS.map((decl) => declToJson(decl, new Map())), unknownToJson('future_block', [], [])];
  for (const json of definitions) {
    assert.equal(json.colour, undefined, `${String(json.type)} must not set colour alongside style`);
  }
});

test('every message row references each argument exactly once, in order', () => {
  // Blockly throws "Message index %1 duplicated" during inject when a message
  // repeats an index, which takes the whole editor down.
  for (const json of [...DBOT_DECLS.map((decl) => declToJson(decl, new Map())), unknownToJson('future_block', ['A'], [])]) {
    const messageKeys = Object.keys(json)
      .filter((key) => /^message\d+$/.test(key))
      .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
    for (const key of messageKeys) {
      const suffix = key.slice(7);
      const args = json[`args${suffix}`] as unknown[];
      const indices = [...String(json[key]).matchAll(/%(\d+)/g)].map((m) => Number(m[1]));
      assert.deepEqual(indices, args.map((_, i) => i + 1), `${String(json.type)} ${key} indices`);
    }
  }
});

test('every declaration role maps explicitly to a style and a category', () => {
  // A missing entry silently falls back to the trade colours, so a mis-typed
  // role would be invisible rather than loud.
  for (const decl of DBOT_DECLS) {
    assert.ok(decl.role in ROLE_STYLE, `${decl.type} has role "${decl.role}" with no ROLE_STYLE entry`);
    assert.ok(decl.role in ROLE_CATEGORY, `${decl.type} has role "${decl.role}" with no ROLE_CATEGORY entry`);
  }
});

/**
 * A block the engine executes but the editor never declares has no placeholder
 * either: `collectUnknownBlocks` only seeds types the server reports as
 * unsupported, so Blockly met an undefined type and threw
 * `Invalid block definition for type: timeout`, abandoning the whole load.
 *
 * These lock the two halves of the fix: the declarations exist, and the shape
 * check that finds such gaps stays honest.
 */
test('declares every block the interpreter executes and DBot can export', () => {
  const declared = new Set(DBOT_DECLS.map((decl) => decl.type));
  // Types that used to crash an import. Each is executed by the engine, so it
  // must be declared rather than left to the placeholder path.
  for (const type of [
    'timeout',
    'notify',
    'total_profit',
    'lastDigitList',
    'ticks',
    'sell_at_market',
    'sell_price',
    'contract_check_result',
    'read_details'
  ]) {
    assert.ok(declared.has(type), `${type} is executed but not declared, so it would crash the editor`);
  }
});

test('a delayed run keeps its statement and its expression-shaped delay', () => {
  // DBot's `timeout` takes `SECONDS` as an input_value, not a field: a strategy
  // may read the delay from a variable, as the shipped Digit_Differs_AI export
  // does. Declaring it as a field would drop that connection.
  const timeout = DBOT_DECLS.find((decl) => decl.type === 'timeout')!;
  const json = declToJson(timeout, new Map());
  const args = messageArgs(json as Record<string, unknown>);

  assert.deepEqual(
    args
      .filter((arg) => arg.type === 'input_statement' || arg.type === 'input_value')
      .map((arg) => ({ type: arg.type, name: arg.name })),
    [
      { type: 'input_statement', name: 'TIMEOUTSTACK' },
      { type: 'input_value', name: 'SECONDS' }
    ]
  );
  assert.equal(json.previousStatement, null);
  assert.equal(json.nextStatement, null);
  assert.equal(json.output, undefined);
});

test('expressions that emit any type are declared with a null output', () => {
  // `read_details` can yield a number or a string, and Blockly encodes "any
  // type" as `output: null`. Treating null as "absent" would make the block a
  // statement, so it could not be plugged into a value socket.
  const details = DBOT_DECLS.find((decl) => decl.type === 'read_details')!;
  assert.equal(declToJson(details, new Map()).output, null);

  const profit = DBOT_DECLS.find((decl) => decl.type === 'total_profit')!;
  assert.equal(declToJson(profit, new Map()).output, 'Number');
});

test('notify carries both of DBot dropdowns plus its message input', () => {
  const notify = DBOT_DECLS.find((decl) => decl.type === 'notify')!;
  const args = messageArgs(declToJson(notify, new Map()) as Record<string, unknown>);
  const fields = args.filter((arg) => arg.type === 'field_dropdown').map((arg) => arg.name);
  assert.deepEqual(fields, ['NOTIFICATION_TYPE', 'NOTIFICATION_SOUND']);
  assert.ok(args.some((arg) => arg.type === 'input_value' && arg.name === 'MESSAGE'));

  // The options must be DBot's own values, or an imported file's value would be
  // rewritten the first time the block is edited.
  assert.deepEqual(fieldDefaults('NOTIFICATION_TYPE'), ['success', 'info', 'warn', 'error']);
  assert.ok(fieldDefaults('NOTIFICATION_SOUND').includes('silent'));
});

/**
 * The end-to-end shape of the reported bug.
 *
 * The shipped `Digit_Differs_AI.xml` is a real DBot export. Importing it threw
 * `Invalid block definition for type: ...` because it uses blocks the engine
 * executes but the editor never declared, so no placeholder was registered for
 * them either. Reading the actual file keeps this test honest: if the export
 * gains a block type, the failure names it instead of drifting.
 */
test('the shipped Digit_Differs_AI export declares every block it uses', () => {
  const xmlPath = path.join(import.meta.dirname, '..', '..', '..', '..', 'Digit_Differs_AI.xml');
  const tree = xmlToTree(fs.readFileSync(xmlPath, 'utf8'));
  const declared = new Set(DBOT_DECLS.map((decl) => decl.type));

  const used = new Set<string>();
  const visit = (node: typeof tree.blocks[number] | null) => {
    if (!node) return;
    used.add(node.type);
    visit(node.next);
    for (const input of node.inputs) visit(input.block ?? null);
  };
  for (const block of tree.blocks) visit(block);

  // Blocks that come from `blockly/blocks` rather than from our declarations.
  const stock = new Set([
    'controls_if',
    'lists_getIndex',
    'logic_boolean',
    'logic_compare',
    'logic_operation',
    'math_arithmetic',
    'math_change',
    'math_number',
    'math_single',
    'text',
    'text_join',
    'variables_get',
    'variables_set'
  ]);

  const undeclared = [...used].filter((type) => !declared.has(type) && !stock.has(type));
  assert.deepEqual(
    undeclared,
    [],
    'these blocks are executed but undeclared, so Blockly would throw "Invalid block definition"'
  );
});

/**
 * The general form of the same bug, checked against the server itself.
 *
 * The test above pins one file. This one asks the server which blocks it can
 * execute, then requires the editor to declare every one of them (or to get it
 * from stock Blockly). That makes the two registries a single source of truth: a
 * block added to the interpreter without a matching declaration fails here,
 * instead of throwing `Invalid block definition` on a customer's import.
 *
 * The stock list is kept small and explicit because Blockly cannot be loaded
 * under Node (it needs a DOM), so the real registry is not available here. It
 * only has to cover the standard blocks the server actually executes; anything
 * else it misses is a DBot block, which must be declared anyway.
 */
test('every block the server can execute is declared or is a stock Blockly block', async () => {
  const { supportedBlockTypes } = await import('../../../../server/bots/blocks');
  const declared = new Set(DBOT_DECLS.map((decl) => decl.type));
  const stock = new Set([
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

  const missing = supportedBlockTypes()
    .filter((type) => !declared.has(type) && !stock.has(type))
    .sort();

  assert.deepEqual(
    missing,
    [],
    'the server can execute these blocks but the editor would throw "Invalid block definition" for them'
  );
});
