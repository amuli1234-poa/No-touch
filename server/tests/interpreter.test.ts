/**
 * Interpreter tests.
 *
 * These exercise the block tree directly, the way DBot compiles it to
 * JavaScript: a strategy is a program, so the assertions are about what the
 * program computes, not about a condition list. Each fixture is written as a
 * real DBot export would write it — statement blocks in statement slots, value
 * blocks only inside inputs.
 *
 * The fixtures deliberately differ from one another (variables, branching,
 * arithmetic, lists, text, contract results) so a single happy path cannot make
 * the suite look green.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isDbProgram,
  loadVariables,
  runAfterPurchase,
  runBeforePurchase,
  saveVariables,
  UnsupportedBlockError,
  type ContractFacts,
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

/** Wraps a before-purchase stack in the lifecycle block a real export has. */
function beforePurchase(stack: string): string {
  return `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">${stack}</statement>
  </block>
</xml>`;
}

/* ------------------------------ dialect ---------------------------------- */

test('isDbProgram: a nested controls_if strategy is a DBot program', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="logic_boolean"><field name="BOOL">TRUE</field></block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  assert.equal(isDbProgram(tree), true);
});

test('isDbProgram: a bare value block in statement position is the simplified dialect', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="check_direction">
      <field name="CHECK_DIRECTION">rise</field>
      <next><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></next>
    </block>`)
  );
  assert.equal(isDbProgram(tree), false);
});

/* ---------------------------- entry decisions ---------------------------- */

test('before_purchase: an if whose condition holds reaches purchase', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="logic_boolean"><field name="BOOL">TRUE</field></block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  const result = runBeforePurchase(tree, context());
  assert.equal(result.purchase, 'CALL');
});

test('before_purchase: an if whose condition fails buys nothing', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="logic_boolean"><field name="BOOL">FALSE</field></block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context()).purchase, null);
});

test('before_purchase: else-if branches run in order and only the match acts', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if" mutation="1">
      <value name="IF0"><block type="logic_boolean"><field name="BOOL">FALSE</field></block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
      <value name="IF1"><block type="logic_boolean"><field name="BOOL">TRUE</field></block></value>
      <statement name="DO1"><block type="purchase"><field name="PURCHASE_LIST">PUT</field></block></statement>
      <statement name="ELSE"><block type="purchase"><field name="PURCHASE_LIST">DIGITDIFF</field></block></statement>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context()).purchase, 'PUT');
});

test('before_purchase: else runs when no branch matches', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="logic_boolean"><field name="BOOL">FALSE</field></block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
      <statement name="ELSE"><block type="purchase"><field name="PURCHASE_LIST">PUT</field></block></statement>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context()).purchase, 'PUT');
});

/* ------------------------------ variables -------------------------------- */

test('variables: set then get in a later comparison', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="variables_set">
      <field name="VAR" id="v1">threshold</field>
      <value name="VALUE"><block type="math_number"><field name="NUM">100</field></block></value>
      <next>
        <block type="controls_if">
          <value name="IF0"><block type="logic_compare">
            <field name="OP">LT</field>
            <value name="A"><block type="tick"/></value>
            <value name="B"><block type="variables_get"><field name="VAR" id="v1">threshold</field></block></value>
          </block></value>
          <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
        </block>
      </next>
    </block>`)
  );
  // Latest tick is 102, which is not below 100.
  assert.equal(runBeforePurchase(tree, context()).purchase, null);

  const rising = xmlToTree(
    beforePurchase(`<block type="variables_set">
      <field name="VAR" id="v1">threshold</field>
      <value name="VALUE"><block type="math_number"><field name="NUM">100</field></block></value>
      <next>
        <block type="controls_if">
          <value name="IF0"><block type="logic_compare">
            <field name="OP">GT</field>
            <value name="A"><block type="tick"/></value>
            <value name="B"><block type="variables_get"><field name="VAR" id="v1">threshold</field></block></value>
          </block></value>
          <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
        </block>
      </next>
    </block>`)
  );
  assert.equal(runBeforePurchase(rising, context()).purchase, 'CALL');
});

test('variables: math_change accumulates across ticks through the run variable map', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="math_change">
      <field name="VAR" id="v1">count</field>
      <value name="DELTA"><block type="math_number"><field name="NUM">1</field></block></value>
    </block>`)
  );
  const first = runBeforePurchase(tree, context());
  assert.equal(first.variables.get('v1'), 1);
  const second = runBeforePurchase(tree, context({ variables: first.variables }));
  assert.equal(second.variables.get('v1'), 2);
});

test('variables: survive a save/load round trip', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="variables_set">
      <field name="VAR" id="v1">label</field>
      <value name="VALUE"><block type="text"><field name="TEXT">hello</field></block></value>
    </block>`)
  );
  const result = runBeforePurchase(tree, context());
  const persisted = saveVariables(result.variables);
  const reloaded = loadVariables(persisted);
  assert.equal(reloaded.get('v1'), 'hello');
});

test('variables: a non-finite value persists as null rather than becoming wrong', () => {
  const persisted = saveVariables(new Map([['x', Number.POSITIVE_INFINITY]]));
  assert.equal(persisted.x, null);
});

/* -------------------------------- math ----------------------------------- */

test('math: arithmetic feeds a comparison', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="logic_compare">
        <field name="OP">EQ</field>
        <value name="A"><block type="math_arithmetic">
          <field name="OP">ADD</field>
          <value name="A"><block type="math_number"><field name="NUM">2</field></block></value>
          <value name="B"><block type="math_number"><field name="NUM">3</field></block></value>
        </block></value>
        <value name="B"><block type="math_number"><field name="NUM">5</field></block></value>
      </block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context()).purchase, 'CALL');
});

test('math: loose equality matches the vendored generator', () => {
  // Blockly's generator emits `a == b`, so the string "5" equals the number 5.
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="logic_compare">
        <field name="OP">EQ</field>
        <value name="A"><block type="text"><field name="TEXT">5</field></block></value>
        <value name="B"><block type="math_number"><field name="NUM">5</field></block></value>
      </block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context()).purchase, 'CALL');
});

/* -------------------------------- ticks ---------------------------------- */

test('ticks: check_direction reads the last two quotes', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context({ ticks: ticks(100, 101) })).purchase, 'CALL');
  assert.equal(runBeforePurchase(tree, context({ ticks: ticks(101, 100) })).purchase, null);
});

test('ticks: a flat market has no direction', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context({ ticks: ticks(100, 100) })).purchase, null);
});

test('ticks: last_digit resolves the final pip digit', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="logic_compare">
        <field name="OP">EQ</field>
        <value name="A"><block type="last_digit"/></value>
        <value name="B"><block type="math_number"><field name="NUM">7</field></block></value>
      </block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">DIGITMATCH</field></block></statement>
    </block>`)
  );
  assert.equal(
    runBeforePurchase(tree, context({ ticks: ticks(100.07) })).purchase,
    'DIGITMATCH'
  );
});

/* -------------------------------- lists ---------------------------------- */

test('lists: length of a tick list', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="logic_compare">
        <field name="OP">EQ</field>
        <value name="A"><block type="lists_length">
          <value name="VALUE"><block type="ticks"/></value>
        </block></value>
        <value name="B"><block type="math_number"><field name="NUM">3</field></block></value>
      </block></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context({ ticks: ticks(1, 2, 3) })).purchase, 'CALL');
});

/* -------------------------------- text ----------------------------------- */

test('text: join is a statement that writes the variable', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="text_join">
      <field name="VAR" id="v1">message</field>
      <statement name="STACK">
        <block type="text_statement"><value name="TEXT"><block type="text"><field name="TEXT">a</field></block></value></block>
      </statement>
    </block>`)
  );
  const result = runBeforePurchase(tree, context());
  assert.equal(result.variables.get('v1'), 'a');
});

/* ------------------------------ notifications ---------------------------- */

test('notify: a blank message becomes the platform placeholder', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="notify">
      <field name="NOTIFICATION_TYPE">info</field>
      <field name="NOTIFICATION_SOUND">silent</field>
    </block>`)
  );
  const result = runBeforePurchase(tree, context());
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].message, '<empty message>');
});

test('notify: a message is rendered from its input', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="notify">
      <field name="NOTIFICATION_TYPE">info</field>
      <field name="NOTIFICATION_SOUND">silent</field>
      <value name="MESSAGE"><block type="text"><field name="TEXT">waiting</field></block></value>
    </block>`)
  );
  assert.equal(runBeforePurchase(tree, context()).notifications[0].message, 'waiting');
});

/* --------------------------- contract results ---------------------------- */

const WINNING_FACTS: ContractFacts = {
  buyTransactionId: 42,
  buyPrice: 10,
  sellPrice: 19.5,
  profit: 9.5,
  contractType: 'CALL',
  entryTime: 1_700_000_000_000,
  entrySpot: 100.1,
  exitTime: 1_700_000_300_000,
  exitSpot: 100.9,
  barrier: null,
  result: 'win'
};

function afterPurchase(stack: string): ReturnType<typeof xmlToTree> {
  return xmlToTree(`<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="after_purchase">
    <statement name="AFTERPURCHASE_STACK">${stack}</statement>
  </block>
</xml>`);
}

test('after_purchase: contract_check_result reads the settled result', () => {
  const tree = afterPurchase(`<block type="controls_if">
    <value name="IF0"><block type="contract_check_result"><field name="CHECK_RESULT">win</field></block></value>
    <statement name="DO0"><block type="trade_again"/></statement>
  </block>`);
  const result = runAfterPurchase(tree, context({ lastContract: WINNING_FACTS }));
  assert.equal(result.tradeAgain, true);
});

test('after_purchase: a losing contract does not trade again on a win check', () => {
  const tree = afterPurchase(`<block type="controls_if">
    <value name="IF0"><block type="contract_check_result"><field name="CHECK_RESULT">win</field></block></value>
    <statement name="DO0"><block type="trade_again"/></statement>
  </block>`);
  const losing: ContractFacts = { ...WINNING_FACTS, profit: -10, result: 'loss' };
  assert.equal(runAfterPurchase(tree, context({ lastContract: losing })).tradeAgain, false);
});

test('after_purchase: read_details returns the profit at index 4', () => {
  const tree = afterPurchase(`<block type="controls_if">
    <value name="IF0"><block type="logic_compare">
      <field name="OP">GT</field>
      <value name="A"><block type="read_details"><field name="DETAIL_INDEX">4</field></block></value>
      <value name="B"><block type="math_number"><field name="NUM">0</field></block></value>
    </block></value>
    <statement name="DO0"><block type="trade_again"/></statement>
  </block>`);
  const result = runAfterPurchase(tree, context({ lastContract: WINNING_FACTS }));
  assert.equal(result.tradeAgain, true);
});

test('after_purchase: total_profit reflects the run, not the contract', () => {
  const tree = afterPurchase(`<block type="controls_if">
    <value name="IF0"><block type="logic_compare">
      <field name="OP">GT</field>
      <value name="A"><block type="total_profit"/></value>
      <value name="B"><block type="math_number"><field name="NUM">0</field></block></value>
    </block></value>
    <statement name="DO0"><block type="trade_again"/></statement>
  </block>`);
  assert.equal(
    runAfterPurchase(tree, context({ lastContract: WINNING_FACTS, totalProfit: 5 })).tradeAgain,
    true
  );
  assert.equal(
    runAfterPurchase(tree, context({ lastContract: WINNING_FACTS, totalProfit: -5 })).tradeAgain,
    false
  );
});

/* ----------------------------- unsupported ------------------------------- */

test('an unknown block raises instead of evaluating to a default', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="not_a_dbot_block">
      <next><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></next>
    </block>`)
  );
  assert.throws(() => runBeforePurchase(tree, context()), UnsupportedBlockError);
});

test('an unknown value block raises rather than comparing against null', () => {
  const tree = xmlToTree(
    beforePurchase(`<block type="controls_if">
      <value name="IF0"><block type="mystery_value"/></value>
      <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
    </block>`)
  );
  assert.throws(() => runBeforePurchase(tree, context()), UnsupportedBlockError);
});
