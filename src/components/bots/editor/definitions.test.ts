import test from 'node:test';
import assert from 'node:assert/strict';

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
    const args = json.args0 as { type: string; name?: string }[];
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
  assert.equal(stackJson.output, null);

  const expression = DBOT_DECLS.find((d) => d.type === 'check_direction')!;
  const exprJson = declToJson(expression, new Map());
  assert.equal(exprJson.output, 'Boolean');
  assert.equal(exprJson.previousStatement, undefined);
});

test('statement inputs become statement sockets', () => {
  const json = declToJson(DBOT_DECLS.find((d) => d.type === 'before_purchase')!, new Map());
  const args = json.args0 as { type: string; name?: string }[];
  const input = args.find((a) => a.name === 'BEFOREPURCHASE_STACK')!;
  assert.equal(input.type, 'statement');
});

test('value inputs become value sockets', () => {
  const json = declToJson(DBOT_DECLS.find((d) => d.type === 'trade_definition_tradeoptions')!, new Map());
  const args = json.args0 as { type: string; name?: string }[];
  assert.equal(args.find((a) => a.name === 'DURATION')!.type, 'value');
  assert.equal(args.find((a) => a.name === 'AMOUNT')!.type, 'value');
});

test('unknown block types are namespaced and reversible', () => {
  const generated = unknownBlockType('future_block');
  assert.ok(generated.startsWith(UNKNOWN_BLOCK_PREFIX));
  assert.equal(isUnknownBlockType(generated), true);
  assert.equal(originalBlockType(generated), 'future_block');
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
  assert.ok(args.some((a) => a.type === 'statement' && a.name === 'STACK'));
  // Read-only: an unknown block must not be editable into something else.
  for (const arg of args) {
    if (arg.type === 'field_input') {
      assert.equal((arg as { disabled?: boolean }).disabled, true);
    }
  }
});

test('an unknown block placeholder keeps its children attachable', () => {
  const json = unknownToJson('future_block', [], [{ name: 'BODY', kind: 'statement' }]);
  assert.equal(json.previousStatement, null);
  assert.equal(json.nextStatement, null);
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

test('message0 references each arg exactly once, in order', () => {
  // Blockly throws "Message index %1 duplicated" during inject when message0
  // repeats an index, which takes the whole editor down.
  for (const json of [...DBOT_DECLS.map((decl) => declToJson(decl, new Map())), unknownToJson('future_block', ['A'], [])]) {
    const message = String(json.message0);
    const args = json.args0 as unknown[];
    const indices = [...message.matchAll(/%(\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(indices, args.map((_, i) => i + 1), `${String(json.type)} message indices`);
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
