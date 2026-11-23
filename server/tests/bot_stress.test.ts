/**
 * Procedure and loop stress tests.
 *
 * These go past the happy path on purpose. The interesting failures in a
 * tree-walking interpreter are scoping failures: a loop variable that survives
 * its loop, a `break` that escapes two levels instead of one, a parameter that
 * overwrites a global, or a call that loses its arguments when the same
 * procedure is called twice with different values.
 *
 * Each case is written as a real DBot export would write it. The expected
 * results come from the official generators in
 * `packages/bot-skeleton/src/scratch/blocks/Advanced/`, which compile a strategy
 * to plain JavaScript — so a procedure is a JS function, its parameters shadow
 * globals, and `break`/`continue` bind to the nearest enclosing loop.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ExecutionLimitError,
  loadVariables,
  runAfterPurchase,
  runBeforePurchase,
  type TickContext
} from '../bots/interpreter.js';
import { xmlToTree } from '../bots/tree.js';
import type { MarketTick } from '../services/marketData.js';

/* ------------------------------ fixtures ------------------------------- */

function context(overrides: Partial<TickContext> = {}): TickContext {
  return {
    ticks: [
      { symbol: 'R_100', quote: 100, bid: null, ask: null, epoch: 1, pipSize: 2 },
      { symbol: 'R_100', quote: 101, bid: null, ask: null, epoch: 2, pipSize: 2 }
    ] as MarketTick[],
    variables: loadVariables({}),
    totalProfit: 0,
    lastContract: null,
    ...overrides
  };
}

/**
 * Chains blocks into one stack, the way Blockly writes it.
 *
 * Blockly nests each subsequent block inside its predecessor's `<next>`, so
 * writing `<next>` as a sibling of `<block>` produces XML the parser correctly
 * ignores. Every stack here goes through this helper for that reason.
 */
function chain(...blocks: string[]): string {
  if (blocks.length === 0) return '';
  const [head, ...rest] = blocks;
  const tail = chain(...rest);
  if (!tail) return head;
  const close = head.lastIndexOf('</block>');
  if (close === -1) return head;
  return `${head.slice(0, close)}<next>${tail}</next>${head.slice(close)}`;
}

/** Wraps a stack in `before_purchase`, plus any top-level definitions. */
function program(stack: string, definitions = '', variables = ''): string {
  return `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <variables>${variables}</variables>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">${stack}</statement>
  </block>
  ${definitions}
</xml>`;
}

function run(xml: string, ctx: TickContext = context()) {
  return runBeforePurchase(xmlToTree(xml), ctx);
}

function defNoReturn(name: string, args: string[], body: string): string {
  const argXml = args.map((a) => `<arg name="${a}" varid="id_${a}"></arg>`).join('');
  return `<block type="procedures_defnoreturn">
    <mutation>${argXml}</mutation>
    <field name="NAME">${name}</field>
    <statement name="STACK">${body}</statement>
  </block>`;
}

function callNoReturn(name: string, args: string[] = []): string {
  const argXml = args
    .map((a, i) => `<value name="ARG${i}"><shadow type="math_number"><field name="NUM">${a}</field></shadow></value>`)
    .join('');
  return `<block type="procedures_callnoreturn"><mutation name="${name}"></mutation>${argXml}</block>`;
}

function callReturn(name: string, args: string[] = []): string {
  const argXml = args
    .map((a, i) => `<value name="ARG${i}"><shadow type="math_number"><field name="NUM">${a}</field></shadow></value>`)
    .join('');
  return `<block type="procedures_callreturn"><mutation name="${name}"></mutation>${argXml}</block>`;
}

/** A call whose arguments are arbitrary value blocks, not just literals. */
function callNoReturnValues(name: string, argXml: string[] = []): string {
  const values = argXml.map((v, i) => `<value name="ARG${i}">${v}</value>`).join('');
  return `<block type="procedures_callnoreturn"><mutation name="${name}"></mutation>${values}</block>`;
}

const setVar = (id: string, name: string, value: number) =>
  `<block type="variables_set"><field name="VAR" id="${id}">${name}</field><value name="VALUE"><shadow type="math_number"><field name="NUM">${value}</field></shadow></value></block>`;

const getVar = (id: string, name: string) =>
  `<block type="variables_get"><field name="VAR" id="${id}">${name}</field></block>`;

const addTo = (id: string, name: string, delta: string) =>
  `<block type="math_change"><field name="VAR" id="${id}">${name}</field><value name="DELTA">${delta}</value></block>`;

const lit = (n: number) => `<shadow type="math_number"><field name="NUM">${n}</field></shadow>`;

const multiply = (a: string, b: number) =>
  `<block type="math_arithmetic"><field name="OP">MULTIPLY</field><value name="A">${a}</value><value name="B">${lit(b)}</value></block>`;

const compare = (op: string, a: string, b: number) =>
  `<block type="logic_compare"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${lit(b)}</value></block>`;

const repeat = (times: number, body: string) =>
  `<block type="controls_repeat_ext"><value name="TIMES">${lit(times)}</value><statement name="DO">${body}</statement></block>`;

const flow = (kind: 'BREAK' | 'CONTINUE') =>
  `<block type="controls_flow_statements"><field name="FLOW">${kind}</field></block>`;

const purchase = (type = 'DIGITDIFF') =>
  `<block type="purchase"><field name="PURCHASE_LIST">${type}</field></block>`;

/* ============================ procedure stress ============================ */

test('procedure: nested calls run innermost first and each keeps its own arguments', () => {
  const xml = program(
    callNoReturn('outer', ['2']),
    defNoReturn('outer', ['n'], chain(callNoReturnValues('inner', [getVar('id_n', 'n')]), addTo('v1', 'total', getVar('id_n', 'n')))) +
      defNoReturn('inner', ['n'], addTo('v1', 'total', multiply(getVar('id_n', 'n'), 10))),
    '<variable id="v1">total</variable>'
  );
  // inner adds 2*10, then outer adds its own 2 -> 22.
  assert.equal(run(xml).variables.get('v1'), 22);
});

test('procedure: three arguments bind positionally, not by name', () => {
  const xml = program(
    callNoReturn('combine', ['1', '2', '3']),
    defNoReturn(
      'combine',
      ['a', 'b', 'c'],
      chain(
        setVar('v1', 'total', 0),
        addTo('v1', 'total', getVar('id_a', 'a')),
        addTo('v1', 'total', multiply(getVar('id_b', 'b'), 10)),
        addTo('v1', 'total', multiply(getVar('id_c', 'c'), 100))
      )
    ),
    '<variable id="v1">total</variable>'
  );
  // 1 + 2*10 + 3*100 = 321 — each argument landed in its own slot.
  assert.equal(run(xml).variables.get('v1'), 321);
});

test('procedure: repeated calls with different arguments do not leak the previous binding', () => {
  const xml = program(
    chain(setVar('v1', 'total', 0), callNoReturn('add', ['5']), callNoReturn('add', ['7'])),
    defNoReturn('add', ['x'], addTo('v1', 'total', getVar('id_x', 'x'))),
    '<variable id="v1">total</variable>'
  );
  assert.equal(run(xml).variables.get('v1'), 12);
});

test('procedure: a parameter shadows a global of the same name and restores it', () => {
  const xml = program(
    chain(
      setVar('v9', 'amount', 99),
      callNoReturn('bump', ['3']),
      `<block type="variables_set"><field name="VAR" id="v2">seenAfter</field><value name="VALUE">${getVar('v9', 'amount')}</value></block>`
    ),
    defNoReturn('bump', ['amount'], addTo('v1', 'count', getVar('id_amount', 'amount'))),
    '<variable id="v1">count</variable><variable id="v2">seenAfter</variable><variable id="v9">amount</variable>'
  );
  const result = run(xml);
  assert.equal(result.variables.get('v1'), 3, 'the body saw the argument');
  assert.equal(result.variables.get('v9'), 99, 'the caller keeps its own value');
  assert.equal(result.variables.get('v2'), 99);
});

test('procedure: a parameter with no varid still binds by name', () => {
  const xml = program(
    callNoReturn('add', ['4']),
    `<block type="procedures_defnoreturn">
      <mutation><arg name="x"></arg></mutation>
      <field name="NAME">add</field>
      <statement name="STACK">${addTo('v1', 'total', getVar('x', 'x'))}</statement>
    </block>`,
    '<variable id="v1">total</variable>'
  );
  assert.equal(run(xml).variables.get('v1'), 4);
});

test('procedure: a varid-less parameter is visible under the declared id the body reads', () => {
  // Blockly resolves a name-only `<arg>` against the workspace variables, so the
  // body's `variables_get` carries that variable's id. Binding only the display
  // name would leave this read unbound.
  const xml = program(
    callNoReturn('add', ['6']),
    `<block type="procedures_defnoreturn">
      <mutation><arg name="x"></arg></mutation>
      <field name="NAME">add</field>
      <statement name="STACK">${addTo('v1', 'total', getVar('id_x_declared', 'x'))}</statement>
    </block>`,
    '<variable id="v1">total</variable><variable id="id_x_declared">x</variable>'
  );
  assert.equal(run(xml).variables.get('v1'), 6);
});

test('procedure: a call inside a loop runs once per iteration', () => {
  const xml = program(
    repeat(4, callNoReturn('tick')),
    defNoReturn('tick', [], addTo('v1', 'count', lit(1))),
    '<variable id="v1">count</variable>'
  );
  assert.equal(run(xml).variables.get('v1'), 4);
});

test('procedure: a call inside the untaken branch of an if does not run', () => {
  const xml = program(
    `<block type="controls_if">
      <value name="IF0"><block type="logic_boolean"><field name="BOOL">FALSE</field></block></value>
      <statement name="DO0">${callNoReturn('never')}</statement>
      <statement name="ELSE">${callNoReturn('always')}</statement>
    </block>`,
    defNoReturn('never', [], setVar('v1', 'total', 1)) +
      defNoReturn('always', [], setVar('v1', 'total', 2)),
    '<variable id="v1">total</variable>'
  );
  assert.equal(run(xml).variables.get('v1'), 2);
});

test('procedure: unbounded recursion fails at the documented depth instead of hanging', () => {
  const xml = program(callNoReturn('forever'), defNoReturn('forever', [], callNoReturn('forever')));
  assert.throws(() => run(xml), ExecutionLimitError);
});

test('procedure: recursion that never shrinks its argument is still bounded', () => {
  const xml = program(
    chain(
      setVar('v1', 'total', 0),
      `<block type="variables_set"><field name="VAR" id="v1">total</field><value name="VALUE">${callReturn('sum', ['4'])}</value></block>`
    ),
    `<block type="procedures_defreturn">
      <mutation><arg name="n" varid="id_n"></arg></mutation>
      <field name="NAME">sum</field>
      <statement name="STACK">
        <block type="procedures_ifreturn">
          <mutation value="1"></mutation>
          <value name="CONDITION">${compare('LTE', getVar('id_n', 'n'), 0)}</value>
          <value name="VALUE">${lit(0)}</value>
        </block>
      </statement>
      <value name="RETURN">
        <block type="math_arithmetic"><field name="OP">ADD</field>
          <value name="A">${getVar('id_n', 'n')}</value>
          <value name="B">${callReturn('sum', ['2'])}</value>
        </block>
      </value>
    </block>`,
    '<variable id="v1">total</variable>'
  );
  // The recursive argument is a literal, so it never reaches the base case.
  assert.throws(() => run(xml), ExecutionLimitError);
});

test('procedure: a terminating recursion returns the right value', () => {
  // sum(n) = n + sum(n-1) with the argument computed, so depth shrinks to zero.
  const xml = program(
    `<block type="variables_set"><field name="VAR" id="v1">total</field><value name="VALUE">${callReturn('sum', ['3'])}</value></block>`,
    `<block type="procedures_defreturn">
      <mutation><arg name="n" varid="id_n"></arg></mutation>
      <field name="NAME">sum</field>
      <statement name="STACK">
        <block type="procedures_ifreturn">
          <mutation value="1"></mutation>
          <value name="CONDITION">${compare('LTE', getVar('id_n', 'n'), 0)}</value>
          <value name="VALUE">${lit(0)}</value>
        </block>
      </statement>
      <value name="RETURN">
        <block type="math_arithmetic"><field name="OP">ADD</field>
          <value name="A">${getVar('id_n', 'n')}</value>
          <value name="B">
            <block type="procedures_callreturn"><mutation name="sum"></mutation>
              <value name="ARG0">
                <block type="math_arithmetic"><field name="OP">MINUS</field>
                  <value name="A">${getVar('id_n', 'n')}</value>
                  <value name="B">${lit(1)}</value>
                </block>
              </value>
            </block>
          </value>
        </block>
      </value>
    </block>`,
    '<variable id="v1">total</variable>'
  );
  // 3 + 2 + 1 + 0
  assert.equal(run(xml).variables.get('v1'), 6);
});

/* ============================== loop stress ============================= */

test('loop: nested loops run inner fully for each outer iteration', () => {
  const xml = program(repeat(3, repeat(2, addTo('v1', 'total', lit(1)))), '', '<variable id="v1">total</variable>');
  assert.equal(run(xml).variables.get('v1'), 6, '3 outer x 2 inner');
});

test('loop: break in the inner loop leaves only the inner loop', () => {
  const xml = program(
    repeat(3, chain(addTo('v1', 'outer', lit(1)), repeat(10, chain(addTo('v2', 'inner', lit(1)), flow('BREAK'))))),
    '',
    '<variable id="v1">outer</variable><variable id="v2">inner</variable>'
  );
  const result = run(xml);
  assert.equal(result.variables.get('v1'), 3, 'the outer loop still ran three times');
  assert.equal(result.variables.get('v2'), 3, 'the inner loop broke after one pass each time');
});

test('loop: continue in the inner loop does not skip the outer body', () => {
  const xml = program(
    repeat(
      2,
      chain(
        addTo('v1', 'outer', lit(1)),
        repeat(3, chain(flow('CONTINUE'), addTo('v2', 'inner', lit(1)))),
        addTo('v3', 'afterInner', lit(1))
      )
    ),
    '',
    '<variable id="v1">outer</variable><variable id="v2">inner</variable><variable id="v3">afterInner</variable>'
  );
  const result = run(xml);
  assert.equal(result.variables.get('v1'), 2, 'outer ran twice');
  assert.equal(result.variables.get('v2'), undefined, 'continue skipped the inner body');
  assert.equal(result.variables.get('v3'), 2, 'the outer body continued past the inner loop');
});

test('loop: break in the outer loop stops everything', () => {
  const xml = program(
    repeat(10, chain(addTo('v1', 'outer', lit(1)), repeat(3, addTo('v2', 'inner', lit(1))), flow('BREAK'))),
    '',
    '<variable id="v1">outer</variable><variable id="v2">inner</variable>'
  );
  const result = run(xml);
  assert.equal(result.variables.get('v1'), 1, 'the outer loop broke on its first pass');
  assert.equal(result.variables.get('v2'), 3, 'the inner loop had already completed once');
});

test('loop: a return inside a procedure called from a loop ends only the procedure', () => {
  const xml = program(
    repeat(3, chain(addTo('v1', 'iterations', lit(1)), callNoReturn('earlyExit'))),
    defNoReturn(
      'earlyExit',
      [],
      chain(
        addTo('v2', 'calls', lit(1)),
        '<block type="procedures_ifreturn"><mutation value="0"></mutation><value name="CONDITION"><block type="logic_boolean"><field name="BOOL">TRUE</field></block></value></block>',
        addTo('v3', 'afterReturn', lit(1))
      )
    ),
    '<variable id="v1">iterations</variable><variable id="v2">calls</variable><variable id="v3">afterReturn</variable>'
  );
  const result = run(xml);
  assert.equal(result.variables.get('v1'), 3, 'the loop ran to completion');
  assert.equal(result.variables.get('v2'), 3, 'the procedure was entered each time');
  assert.equal(result.variables.get('v3'), undefined, 'the return skipped the tail of the procedure');
});

test('loop: a purchase inside a loop stops the strategy and the loop', () => {
  const xml = program(
    repeat(5, chain(addTo('v1', 'count', lit(1)), purchase())),
    '',
    '<variable id="v1">count</variable>'
  );
  const result = run(xml);
  assert.equal(result.purchase, 'DIGITDIFF');
  assert.equal(result.variables.get('v1'), 1, 'the loop stopped at the purchase');
});

test('loop: while with a runaway body fails rather than hanging', () => {
  const xml = program(
    `<block type="controls_whileUntil">
      <field name="MODE">WHILE</field>
      <value name="BOOL"><block type="logic_boolean"><field name="BOOL">TRUE</field></block></value>
      <statement name="DO">${addTo('v1', 'count', lit(1))}</statement>
    </block>`,
    '',
    '<variable id="v1">count</variable>'
  );
  assert.throws(() => run(xml), /Infinite loop detected/);
});

test('loop: for with a step of zero does not spin forever', () => {
  const xml = program(
    `<block type="controls_for">
      <field name="VAR" id="v3">i</field>
      <value name="FROM">${lit(1)}</value>
      <value name="TO">${lit(3)}</value>
      <value name="BY">${lit(0)}</value>
      <statement name="DO">${addTo('v1', 'count', lit(1))}</statement>
    </block>`,
    '',
    '<variable id="v1">count</variable><variable id="v3">i</variable>'
  );
  assert.equal(run(xml).variables.get('v1'), 3);
});

test('loop: a for loop variable does not disturb an unrelated variable', () => {
  const xml = program(
    chain(
      setVar('v9', 'unrelated', 42),
      `<block type="controls_for">
        <field name="VAR" id="v3">i</field>
        <value name="FROM">${lit(1)}</value>
        <value name="TO">${lit(2)}</value>
        <value name="BY">${lit(1)}</value>
        <statement name="DO">${addTo('v1', 'count', lit(1))}</statement>
      </block>`
    ),
    '',
    '<variable id="v1">count</variable><variable id="v3">i</variable><variable id="v9">unrelated</variable>'
  );
  const result = run(xml);
  assert.equal(result.variables.get('v1'), 2);
  assert.equal(result.variables.get('v9'), 42);
});

test('loop: after_purchase stacks run loops too', () => {
  const xml = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
    <variables><variable id="v1">count</variable></variables>
    <block type="after_purchase">
      <statement name="AFTERPURCHASE_STACK">${repeat(3, addTo('v1', 'count', lit(1)))}</statement>
    </block>
  </xml>`;
  assert.equal(runAfterPurchase(xmlToTree(xml), context()).variables.get('v1'), 3);
});
