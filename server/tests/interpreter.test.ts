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
  resolveDigitPrediction,
  runAfterPurchase,
  runBeforePurchase,
  runInitialization,
  runTickAnalysis,
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

/* ------------------------------ lifecycle -------------------------------- */

/** A full program: declarations, a per-tick analysis, and a gated purchase. */
function lifecycleProgram(): string {
  return `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="trade">
    <field name="SYMBOL_LIST">R_100</field>
    <field name="TYPE_LIST">DIGITDIFF</field>
    <statement name="INITIALIZATION">
      <block type="variables_set">
        <field name="VAR" id="limit">Max Entries</field>
        <value name="VALUE"><block type="math_number"><field name="NUM">1</field></block></value>
        <next><block type="variables_set">
          <field name="VAR" id="seen">Entries Seen</field>
          <value name="VALUE"><block type="math_number"><field name="NUM">0</field></block></value>
        </block></next>
      </block>
    </statement>
    <statement name="SUBMARKET">
      <block type="tradeOptions">
        <field name="DURATIONTYPE_LIST">t</field>
        <field name="CURRENCY_LIST">USD</field>
        <value name="DURATION"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
        <value name="AMOUNT"><shadow type="math_number"><field name="NUM">0.35</field></shadow></value>
        <value name="PREDICTION">
          <block type="variables_get"><field name="VAR" id="prediction">Prediction</field></block>
        </value>
      </block>
    </statement>
  </block>
  <block type="tick_analysis">
    <statement name="TICKANALYSIS_STACK">
      <block type="variables_set">
        <field name="VAR" id="prediction">Prediction</field>
        <value name="VALUE"><block type="last_digit"/></value>
      </block>
    </statement>
  </block>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="logic_compare">
          <field name="OP">LT</field>
          <value name="A"><block type="variables_get"><field name="VAR" id="seen">Entries Seen</field></block></value>
          <value name="B"><block type="variables_get"><field name="VAR" id="limit">Max Entries</field></block></value>
        </block></value>
        <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">DIGITDIFF</field></block></statement>
      </block>
    </statement>
  </block>
</xml>`;
}

test('INITIALIZATION runs once and its variables gate the entry stack', () => {
  const tree = xmlToTree(lifecycleProgram());
  const ctx = context();

  // Before initialization the gate compares against unset variables, which is
  // why running it is not optional: `undefined < undefined` is false.
  assert.equal(runBeforePurchase(tree, ctx).purchase, null);

  runInitialization(tree, ctx);
  assert.equal(ctx.variables.get('limit'), 1);
  assert.equal(ctx.variables.get('seen'), 0);
  assert.equal(runBeforePurchase(tree, ctx).purchase, 'DIGITDIFF');
});

test('tick_analysis derives per-tick state that the entry stack reads', () => {
  const tree = xmlToTree(lifecycleProgram());
  const ctx = context({ ticks: ticks(123.47) });

  runInitialization(tree, ctx);
  // The prediction is only set by tick analysis, never by initialization.
  assert.equal(ctx.variables.get('prediction'), undefined);

  runTickAnalysis(tree, ctx);
  assert.equal(ctx.variables.get('prediction'), 7);
});

test('resolveDigitPrediction reads a prediction held in a variable', () => {
  const tree = xmlToTree(lifecycleProgram());
  const ctx = context({ ticks: ticks(123.47) });

  runInitialization(tree, ctx);
  runTickAnalysis(tree, ctx);
  assert.equal(resolveDigitPrediction(tree, ctx), 7);
});

test('resolveDigitPrediction refuses a value that is not a digit', () => {
  const tree = xmlToTree(lifecycleProgram());
  const ctx = context();
  runInitialization(tree, ctx);
  // No tick analysis has run, so the variable is unset rather than a number.
  assert.equal(resolveDigitPrediction(tree, ctx), null);
});

/* ------------------- legacy SUBMARKET -> INITIALIZATION ------------------- */

/**
 * A legacy export has no `INITIALIZATION` statement: its declarations live in
 * the `trade` block's `SUBMARKET` chain, before the `market` block. DBot's own
 * loader moves them to "Run once at start" on import, because `SUBMARKET` runs
 * before every trade and a martingale counter kept there would reset each time.
 * The shape below matches `xml-examples/misc/Alternate Even-Odd.xml`.
 */
function legacySubmarketProgram(): string {
  return `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <variables>
    <variable id="stake">stake</variable>
    <variable id="runs">runs</variable>
  </variables>
  <block type="trade">
    <statement name="SUBMARKET">
      <block type="variables_set">
        <field name="VAR" id="stake">stake</field>
        <value name="VALUE"><block type="math_number"><field name="NUM">1</field></block></value>
        <next>
          <block type="variables_set">
            <field name="VAR" id="runs">runs</field>
            <value name="VALUE"><block type="math_number"><field name="NUM">0</field></block></value>
            <next>
              <block type="market">
                <field name="MARKET_LIST">volidx</field>
                <field name="SUBMARKET_LIST">random_index</field>
                <field name="SYMBOL_LIST">R_100</field>
                <field name="TRADETYPECAT_LIST">digits</field>
                <field name="TRADETYPE_LIST">evenodd</field>
                <field name="TYPE_LIST">both</field>
                <value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
  </block>
</xml>`;
}

test('legacy SUBMARKET declarations are initialised, as DBot migrates them', () => {
  const tree = xmlToTree(legacySubmarketProgram());
  const ctx = context();

  runInitialization(tree, ctx);

  assert.equal(ctx.variables.get('stake'), 1);
  assert.equal(ctx.variables.get('runs'), 0);
});

test('the legacy market block is not executed as an initialisation statement', () => {
  const tree = xmlToTree(legacySubmarketProgram());
  const ctx = context();

  // `market` configures the trade; running it as a statement would either throw
  // or invent variables. It must stay behind in SUBMARKET, as DBot leaves it.
  runInitialization(tree, ctx);
  assert.equal(ctx.variables.size, 2);
});

test('an explicit INITIALIZATION stack is never replaced by SUBMARKET contents', () => {
  const xml = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <variables><variable id="a">a</variable><variable id="b">b</variable></variables>
  <block type="trade_definition">
    <statement name="INITIALIZATION">
      <block type="variables_set">
        <field name="VAR" id="a">a</field>
        <value name="VALUE"><block type="math_number"><field name="NUM">7</field></block></value>
      </block>
    </statement>
    <statement name="SUBMARKET">
      <block type="variables_set">
        <field name="VAR" id="b">b</field>
        <value name="VALUE"><block type="math_number"><field name="NUM">9</field></block></value>
      </block>
    </statement>
  </block>
</xml>`;
  const ctx = context();
  runInitialization(xmlToTree(xml), ctx);

  assert.equal(ctx.variables.get('a'), 7);
  assert.equal(ctx.variables.get('b'), undefined);
});

test('a trade_definition with no legacy market block keeps SUBMARKET unexecuted', () => {
  const xml = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <variables><variable id="b">b</variable></variables>
  <block type="trade_definition">
    <statement name="SUBMARKET">
      <block type="variables_set">
        <field name="VAR" id="b">b</field>
        <value name="VALUE"><block type="math_number"><field name="NUM">9</field></block></value>
      </block>
    </statement>
  </block>
</xml>`;
  const ctx = context();
  runInitialization(xmlToTree(xml), ctx);

  // Only the oldest generation put declarations in SUBMARKET; migrating a
  // newer export would execute its trade options as statements.
  assert.equal(ctx.variables.get('b'), undefined);
});
