/**
 * Loops, flow control and procedures.
 *
 * These are the constructs that make a DBot program a program rather than a
 * condition list, so each test asserts what the program computes. The expected
 * values come from DBot's own generators in
 * `packages/bot-skeleton/src/scratch/blocks/Advanced/`:
 *
 *  - `controls_repeat_ext` evaluates TIMES once, before the loop.
 *  - `controls_whileUntil` throws "Infinite loop detected" after 10000 passes.
 *  - `controls_for` fixes the direction from `FROM > TO` and steps by |BY|.
 *  - `procedures_def*` hoists definitions, so a call may precede its body.
 *
 * A loop that silently did nothing would still satisfy "no crash", so every
 * case here checks the accumulated result, not just the absence of an error.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ExecutionLimitError,
  isInterpreted,
  loadVariables,
  runBeforePurchase,
  type TickContext
} from '../bots/interpreter.js';
import { xmlToTree } from '../bots/tree.js';
import type { MarketTick } from '../services/marketData.js';

function ticks(...quotes: number[]): MarketTick[] {
  return quotes.map((quote, index) => ({
    symbol: 'R_100',
    quote,
    bid: null,
    ask: null,
    epoch: 1_700_000_000 + index,
    pipSize: 2
  }));
}

function context(overrides: Partial<TickContext> = {}): TickContext {
  return {
    ticks: ticks(100, 101, 102),
    variables: new Map(),
    totalProfit: 0,
    lastContract: null,
    ...overrides
  };
}

/** Wraps a stack in a `before_purchase` block, with any extra top-level blocks. */
function program(stack: string, extra = '', variables = ''): string {
  return `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <variables>${variables}</variables>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">${stack}</statement>
  </block>
  ${extra}
</xml>`;
}

function run(xml: string, ctx: TickContext = context()) {
  return runBeforePurchase(xmlToTree(xml), ctx);
}

/* --------------------------------- loops --------------------------------- */

test('repeat: the body runs exactly the number of times given', () => {
  const xml = program(
    `<block type="controls_repeat_ext">
      <value name="TIMES"><shadow type="math_number"><field name="NUM">4</field></shadow></value>
      <statement name="DO">
        <block type="math_change">
          <field name="VAR" id="v1">count</field>
          <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        </block>
      </statement>
    </block>`,
    '',
    '<variable id="v1">count</variable>'
  );

  const result = run(xml);
  assert.equal(result.variables.get('v1'), 4);
});

test('repeat: a zero count runs the body no times', () => {
  const xml = program(
    `<block type="controls_repeat_ext">
      <value name="TIMES"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
      <statement name="DO">
        <block type="math_change">
          <field name="VAR" id="v1">count</field>
          <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        </block>
      </statement>
    </block>`,
    '',
    '<variable id="v1">count</variable>'
  );

  assert.equal(run(xml).variables.get('v1'), undefined);
});

test('repeat: the count is read once, so a body that changes it cannot extend the loop', () => {
  // DBot caches TIMES into `repeat_end` before the loop starts.
  const xml = program(
    `<block type="controls_repeat_ext">
      <value name="TIMES">
        <block type="variables_get"><field name="VAR" id="v2">limit</field></block>
      </value>
      <statement name="DO">
        <block type="math_change">
          <field name="VAR" id="v1">count</field>
          <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        </block>
        <next>
          <block type="variables_set">
            <field name="VAR" id="v2">limit</field>
            <value name="VALUE"><shadow type="math_number"><field name="NUM">100</field></shadow></value>
          </block>
        </next>
      </statement>
    </block>`,
    '',
    '<variable id="v1">count</variable><variable id="v2">limit</variable>'
  );

  const ctx = context();
  ctx.variables.set('v2', 3);
  assert.equal(run(xml, ctx).variables.get('v1'), 3);
});

test('while: the loop stops when its condition turns false', () => {
  const xml = program(
    `<block type="variables_set">
      <field name="VAR" id="v1">count</field>
      <value name="VALUE"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
      <next>
        <block type="controls_whileUntil">
          <field name="MODE">WHILE</field>
          <value name="BOOL">
            <block type="logic_compare">
              <field name="OP">LT</field>
              <value name="A"><block type="variables_get"><field name="VAR" id="v1">count</field></block></value>
              <value name="B"><shadow type="math_number"><field name="NUM">5</field></shadow></value>
            </block>
          </value>
          <statement name="DO">
            <block type="math_change">
              <field name="VAR" id="v1">count</field>
              <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
            </block>
          </statement>
        </block>
      </next>
    </block>`,
    '',
    '<variable id="v1">count</variable>'
  );

  assert.equal(run(xml).variables.get('v1'), 5);
});

test('until: the loop stops when its condition turns true', () => {
  const xml = program(
    `<block type="variables_set">
      <field name="VAR" id="v1">count</field>
      <value name="VALUE"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
      <next>
        <block type="controls_whileUntil">
          <field name="MODE">UNTIL</field>
          <value name="BOOL">
            <block type="logic_compare">
              <field name="OP">GTE</field>
              <value name="A"><block type="variables_get"><field name="VAR" id="v1">count</field></block></value>
              <value name="B"><shadow type="math_number"><field name="NUM">3</field></shadow></value>
            </block>
          </value>
          <statement name="DO">
            <block type="math_change">
              <field name="VAR" id="v1">count</field>
              <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
            </block>
          </statement>
        </block>
      </next>
    </block>`,
    '',
    '<variable id="v1">count</variable>'
  );

  assert.equal(run(xml).variables.get('v1'), 3);
});

test('while: a condition that never turns false fails with DBot\'s infinite-loop error', () => {
  const xml = program(
    `<block type="controls_whileUntil">
      <field name="MODE">WHILE</field>
      <value name="BOOL"><block type="logic_boolean"><field name="BOOL">TRUE</field></block></value>
      <statement name="DO">
        <block type="math_change">
          <field name="VAR" id="v1">count</field>
          <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        </block>
      </statement>
    </block>`,
    '',
    '<variable id="v1">count</variable>'
  );

  // Failing is the honest outcome: silently exiting would let a strategy that
  // never settles look like it had decided not to trade.
  assert.throws(() => run(xml), /Infinite loop detected/);
});

test('break: leaves the loop early and keeps the work already done', () => {
  const xml = program(
    `<block type="controls_repeat_ext">
      <value name="TIMES"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
      <statement name="DO">
        <block type="math_change">
          <field name="VAR" id="v1">count</field>
          <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
          <next>
            <block type="controls_if">
              <value name="IF0">
                <block type="logic_compare">
                  <field name="OP">GTE</field>
                  <value name="A"><block type="variables_get"><field name="VAR" id="v1">count</field></block></value>
                  <value name="B"><shadow type="math_number"><field name="NUM">3</field></shadow></value>
                </block>
              </value>
              <statement name="DO0">
                <block type="controls_flow_statements"><field name="FLOW">BREAK</field></block>
              </statement>
            </block>
          </next>
        </block>
      </statement>
    </block>`,
    '',
    '<variable id="v1">count</variable>'
  );

  assert.equal(run(xml).variables.get('v1'), 3);
});

test('continue: skips the rest of the iteration but not the loop', () => {
  const xml = program(
    `<block type="variables_set">
      <field name="VAR" id="v1">count</field>
      <value name="VALUE"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
      <next>
        <block type="controls_repeat_ext">
          <value name="TIMES"><shadow type="math_number"><field name="NUM">5</field></shadow></value>
          <statement name="DO">
            <block type="math_change">
              <field name="VAR" id="v1">count</field>
              <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
              <next>
                <block type="controls_if">
                  <value name="IF0">
                    <block type="logic_compare">
                      <field name="OP">LT</field>
                      <value name="A"><block type="variables_get"><field name="VAR" id="v1">count</field></block></value>
                      <value name="B"><shadow type="math_number"><field name="NUM">3</field></shadow></value>
                    </block>
                  </value>
                  <statement name="DO0">
                    <block type="controls_flow_statements"><field name="FLOW">CONTINUE</field></block>
                  </statement>
                  <next>
                    <block type="math_change">
                      <field name="VAR" id="v2">after</field>
                      <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
                    </block>
                  </next>
                </block>
              </next>
            </block>
          </statement>
        </block>
      </next>
    </block>`,
    '',
    '<variable id="v1">count</variable><variable id="v2">after</variable>'
  );

  const result = run(xml);
  assert.equal(result.variables.get('v1'), 5, 'the loop still ran five times');
  // Only iterations 3, 4 and 5 reach the trailing block.
  assert.equal(result.variables.get('v2'), 3);
});

test('for: counts up and leaves the variable at the final value', () => {
  const xml = program(
    `<block type="controls_for">
      <field name="VAR" id="v3">i</field>
      <value name="FROM"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
      <value name="TO"><shadow type="math_number"><field name="NUM">4</field></shadow></value>
      <value name="BY"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
      <statement name="DO">
        <block type="math_change">
          <field name="VAR" id="v2">total</field>
          <value name="DELTA"><block type="variables_get"><field name="VAR" id="v3">i</field></block></value>
        </block>
      </statement>
    </block>`,
    '',
    '<variable id="v2">total</variable><variable id="v3">i</variable>'
  );

  const result = run(xml);
  assert.equal(result.variables.get('v2'), 10, '1 + 2 + 3 + 4');
  assert.equal(result.variables.get('v3'), 4);
});

test('for: counts down when the start is above the end, despite a positive step', () => {
  // DBot fixes the direction from FROM > TO and steps by |BY|.
  const xml = program(
    `<block type="controls_for">
      <field name="VAR" id="v3">i</field>
      <value name="FROM"><shadow type="math_number"><field name="NUM">4</field></shadow></value>
      <value name="TO"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
      <value name="BY"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
      <statement name="DO">
        <block type="math_change">
          <field name="VAR" id="v2">total</field>
          <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        </block>
      </statement>
    </block>`,
    '',
    '<variable id="v2">total</variable><variable id="v3">i</variable>'
  );

  const result = run(xml);
  assert.equal(result.variables.get('v2'), 4, 'four iterations, not zero');
  assert.equal(result.variables.get('v3'), 1);
});

test('for: a step of two halves the number of iterations', () => {
  const xml = program(
    `<block type="controls_for">
      <field name="VAR" id="v3">i</field>
      <value name="FROM"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
      <value name="TO"><shadow type="math_number"><field name="NUM">6</field></shadow></value>
      <value name="BY"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
      <statement name="DO">
        <block type="math_change">
          <field name="VAR" id="v2">total</field>
          <value name="DELTA"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        </block>
      </statement>
    </block>`,
    '',
    '<variable id="v2">total</variable><variable id="v3">i</variable>'
  );

  assert.equal(run(xml).variables.get('v2'), 4, '0, 2, 4, 6');
});

test('for each: visits every element of the list', () => {
  // DBot's `lists_create_with` is a statement block that writes a list variable,
  // so the fixture builds the list the way a real export would.
  const xml = program(
    `<block type="lists_create_with">
      <field name="VARIABLE" id="v5">items</field>
      <statement name="STACK">
        <block type="lists_statement">
          <value name="VALUE"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
          <next>
            <block type="lists_statement">
              <value name="VALUE"><shadow type="math_number"><field name="NUM">20</field></shadow></value>
              <next>
                <block type="lists_statement">
                  <value name="VALUE"><shadow type="math_number"><field name="NUM">30</field></shadow></value>
                </block>
              </next>
            </block>
          </next>
        </block>
      </statement>
      <next>
        <block type="controls_forEach">
          <field name="VAR" id="v4">item</field>
          <value name="LIST"><block type="variables_get"><field name="VAR" id="v5">items</field></block></value>
          <statement name="DO">
            <block type="math_change">
              <field name="VAR" id="v2">total</field>
              <value name="DELTA"><block type="variables_get"><field name="VAR" id="v4">item</field></block></value>
            </block>
          </statement>
        </block>
      </next>
    </block>`,
    '',
    '<variable id="v2">total</variable><variable id="v4">item</variable><variable id="v5">items</variable>'
  );

  assert.equal(run(xml).variables.get('v2'), 60, '10 + 20 + 30');
});

/* ------------------------------- procedures ------------------------------ */

test('procedure: a no-return call runs its body and binds its arguments', () => {
  const xml = program(
    `<block type="procedures_callnoreturn">
      <mutation name="bump"></mutation>
      <value name="ARG0"><shadow type="math_number"><field name="NUM">3</field></shadow></value>
    </block>`,
    `<block type="procedures_defnoreturn">
      <mutation><arg name="amount" varid="v9"></arg></mutation>
      <field name="NAME">bump</field>
      <statement name="STACK">
        <block type="math_change">
          <field name="VAR" id="v1">count</field>
          <value name="DELTA"><block type="variables_get"><field name="VAR" id="v9">amount</field></block></value>
        </block>
      </statement>
    </block>`,
    '<variable id="v1">count</variable><variable id="v9">amount</variable>'
  );

  assert.equal(run(xml).variables.get('v1'), 3);
});

test('procedure: a call may appear before its definition, as DBot hoists them', () => {
  const xml = program(
    `<block type="procedures_callnoreturn"><mutation name="later"></mutation></block>`,
    `<block type="procedures_defnoreturn">
      <mutation></mutation>
      <field name="NAME">later</field>
      <statement name="STACK">
        <block type="variables_set">
          <field name="VAR" id="v1">count</field>
          <value name="VALUE"><shadow type="math_number"><field name="NUM">42</field></shadow></value>
        </block>
      </statement>
    </block>`,
    '<variable id="v1">count</variable>'
  );

  assert.equal(run(xml).variables.get('v1'), 42);
});

test('procedure: a return value is usable in an expression', () => {
  const xml = program(
    `<block type="variables_set">
      <field name="VAR" id="v1">count</field>
      <value name="VALUE">
        <block type="procedures_callreturn">
          <mutation name="double"></mutation>
          <value name="ARG0"><shadow type="math_number"><field name="NUM">5</field></shadow></value>
        </block>
      </value>
    </block>`,
    `<block type="procedures_defreturn">
      <mutation><arg name="a" varid="v8"></arg></mutation>
      <field name="NAME">double</field>
      <statement name="STACK"></statement>
      <value name="RETURN">
        <block type="math_arithmetic">
          <field name="OP">MULTIPLY</field>
          <value name="A"><block type="variables_get"><field name="VAR" id="v8">a</field></block></value>
          <value name="B"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
        </block>
      </value>
    </block>`,
    '<variable id="v1">count</variable><variable id="v8">a</variable>'
  );

  assert.equal(run(xml).variables.get('v1'), 10);
});

test('procedure: arguments are restored, so a call cannot overwrite a variable of the same name', () => {
  const xml = program(
    `<block type="variables_set">
      <field name="VAR" id="v9">amount</field>
      <value name="VALUE"><shadow type="math_number"><field name="NUM">99</field></shadow></value>
      <next>
        <block type="procedures_callnoreturn">
          <mutation name="bump"></mutation>
          <value name="ARG0"><shadow type="math_number"><field name="NUM">3</field></shadow></value>
        </block>
      </next>
    </block>`,
    `<block type="procedures_defnoreturn">
      <mutation><arg name="amount" varid="v9"></arg></mutation>
      <field name="NAME">bump</field>
      <statement name="STACK"></statement>
    </block>`,
    '<variable id="v9">amount</variable>'
  );

  assert.equal(run(xml).variables.get('v9'), 99);
});

test('procedure: an undefined call fails instead of quietly doing nothing', () => {
  const xml = program(
    `<block type="procedures_callnoreturn"><mutation name="missing"></mutation></block>`
  );

  // Returning quietly would let a strategy trade on a step that never ran.
  assert.throws(() => run(xml), /"missing" is called but never defined/);
});

test('procedure: runaway recursion stops at the documented depth', () => {
  const xml = program(
    `<block type="procedures_callnoreturn"><mutation name="forever"></mutation></block>`,
    `<block type="procedures_defnoreturn">
      <mutation></mutation>
      <field name="NAME">forever</field>
      <statement name="STACK">
        <block type="procedures_callnoreturn"><mutation name="forever"></mutation></block>
      </statement>
    </block>`
  );

  assert.throws(() => run(xml), ExecutionLimitError);
});

/* ---------------------------- capability drift --------------------------- */

test('every block the catalogue calls executable really has an interpreter handler', () => {
  // The registry used to be a hand-maintained list that drifted from the
  // interpreter, so a runnable bot was reported as unsupported. These are the
  // blocks that drift proved were missing; each must stay executable.
  for (const type of [
    'controls_repeat_ext',
    'controls_whileUntil',
    'controls_for',
    'controls_forEach',
    'controls_flow_statements',
    'procedures_defnoreturn',
    'procedures_callnoreturn',
    'procedures_callreturn',
    'text_join',
    'math_change',
    'lists_getIndex',
    'lastDigitList',
    'read_details',
    'total_profit',
    'notify',
    'timeout'
  ]) {
    assert.equal(isInterpreted(type), true, `${type} should be interpreted`);
  }
});

test('a loop inside a procedure still ends the strategy when it buys', () => {
  // A purchase must stop everything, not just the innermost loop.
  const xml = program(
    `<block type="procedures_callnoreturn"><mutation name="buyer"></mutation></block>
     <next>
       <block type="purchase"><field name="PURCHASE_LIST">CALL</field></block>
     </next>`,
    `<block type="procedures_defnoreturn">
      <mutation></mutation>
      <field name="NAME">buyer</field>
      <statement name="STACK">
        <block type="controls_repeat_ext">
          <value name="TIMES"><shadow type="math_number"><field name="NUM">5</field></shadow></value>
          <statement name="DO">
            <block type="purchase"><field name="PURCHASE_LIST">DIGITDIFF</field></block>
          </statement>
        </block>
      </statement>
    </block>`
  );

  const result = run(xml);
  assert.equal(result.purchase, 'DIGITDIFF');
  // The trailing purchase must not have run.
  assert.notEqual(result.purchase, 'CALL');
});
