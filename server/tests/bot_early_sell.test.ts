/**
 * Early selling: what Deriv actually does, and why this build refuses it.
 *
 * The behaviour below is transcribed from the official DBot engine, not guessed:
 *
 *   packages/bot-skeleton/src/scratch/blocks/Binary/During Purchase/check_sell.js
 *     `check_sell` compiles to `Bot.isSellAvailable()`.
 *   .../sell_at_market.js      compiles to `Bot.sellAtMarket();`
 *   .../sell_price.js          compiles to `Bot.getSellPrice()`
 *
 *   packages/bot-skeleton/src/services/tradeEngine/trade/Sell.js
 *     isSellAtMarketAvailable() => contractId && !isSold && isSellAvailable && !isExpired
 *     sellAtMarket() sends { sell: contract_id, price: 0 }, treats
 *     "InvalidOfferings" (too close to expiry) as "let it expire", and on any
 *     other error re-reads `proposal_open_contract` to detect a race where the
 *     contract was in fact sold.
 *
 *   .../trade/OpenContract.js
 *     isSellAvailable = !is_sold && is_valid_to_sell     (from proposal_open_contract)
 *     getSellPrice()  = round(bid_price - buy_price)
 *
 * The three facts this build cannot supply are `is_valid_to_sell`, `bid_price`
 * and `buy_price` on a *live* contract. `ContractRecord` stores none of them and
 * `mapContract` does not map them, so `check_sell` would have to answer from
 * nothing — and `sell_price` would have to invent a number. Both are refused.
 *
 * These tests exist so that refusal stays deliberate: if someone later wires up
 * early selling, these assertions fail and force the work to be done properly
 * rather than by guessing at the API.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockSpec, isContainerBlock, isDeliberatelyUnexecuted } from '../bots/blocks.js';
import { isInterpreted } from '../bots/interpreter.js';
import { planStrategy } from '../bots/evaluator.js';
import { xmlToTree } from '../bots/tree.js';

const EARLY_SELL_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <variables><variable id="v1">total</variable></variables>
  <block type="trade_definition">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <next><block type="trade_definition_tradetype">
          <field name="TRADETYPECAT_LIST">callput</field>
          <field name="TRADETYPE_LIST">callput</field>
          <next><block type="trade_definition_contracttype">
            <field name="TYPE_LIST">CALL</field>
            <next><block type="trade_definition_candleinterval">
              <field name="CANDLEINTERVAL_LIST">60</field>
              <next><block type="trade_definition_tradeoptions">
                <field name="DURATIONTYPE_LIST">m</field>
                <field name="CURRENCY_LIST">USD</field>
                <value name="DURATION"><shadow type="math_number"><field name="NUM">5</field></shadow></value>
                <value name="AMOUNT"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
              </block></next>
            </block></next>
          </block></next>
        </block></next>
      </block>
    </statement>
  </block>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
        <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
      </block>
    </statement>
  </block>
  <block type="during_purchase">
    <statement name="DURING_PURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="check_sell"></block></value>
        <statement name="DO0"><block type="sell_at_market"></block></statement>
      </block>
    </statement>
  </block>
</xml>`;

test('early sell: check_sell is recognised but not executable', () => {
  assert.equal(isInterpreted('check_sell'), false, 'there is no handler for check_sell');
  assert.equal(isDeliberatelyUnexecuted('check_sell'), true, 'its absence is deliberate, not an oversight');

  const spec = blockSpec('check_sell')!;
  assert.equal(spec.supported, false);
  assert.match(spec.reason ?? '', /expiry/i, 'the reason must name the actual limitation');
});

test('early sell: sell_at_market and sell_price are refused with a stated reason', () => {
  for (const type of ['sell_at_market', 'sell_price']) {
    assert.equal(isInterpreted(type), false, `${type} has no handler`);
    assert.equal(isDeliberatelyUnexecuted(type), true, `${type} is deliberately unexecuted`);
    assert.match(blockSpec(type)!.reason ?? '', /expir|sell/i, `${type} must explain itself`);
  }
});

test('early sell: a strategy that sells early is classified partial, never full', () => {
  const planned = planStrategy(xmlToTree(EARLY_SELL_BOT));
  assert.equal(planned.ok, false, 'a strategy relying on an early sale cannot run as-is');
  assert.ok(
    planned.unsupported.includes('check_sell') || planned.unsupported.includes('sell_at_market'),
    `expected the sell blocks to be reported unsupported, got ${JSON.stringify(planned.unsupported)}`
  );
  assert.match(planned.reasons.join(' '), /expiry|sell/i);
});

test('early sell: during_purchase is still a container the runtime addresses', () => {
  // The *container* is fine — an empty during_purchase costs nothing, and
  // refusing it would reject every real export. Only the sell logic inside it is
  // refused. Keeping this distinction is what stops the report from being
  // uselessly pessimistic.
  assert.equal(isContainerBlock('during_purchase'), true);
  assert.equal(isDeliberatelyUnexecuted('during_purchase'), false);
});

test('early sell: the eligibility data Deriv needs is not modelled, so selling cannot be faked', async () => {
  // This is the load-bearing assertion. Deriv decides sellability from
  // `is_valid_to_sell` on a live `proposal_open_contract`, and computes the sale
  // price from `bid_price - buy_price`. Neither reaches ContractRecord, so a
  // "supported" verdict here would be a guess dressed as a feature.
  const { mapContract } = await import('../execution/broker/derivBroker.js');
  const update = mapContract({
    contract_id: 123,
    is_sold: 0,
    is_expired: 0,
    is_valid_to_sell: 1,
    bid_price: 9.5,
    buy_price: 10,
    profit: -0.5,
    current_spot: 1000.5
  });

  assert.equal(
    'isValidToSell' in update,
    false,
    'sell eligibility is dropped when the contract is mapped, so check_sell has nothing to read'
  );
  assert.equal(
    'bidPrice' in update,
    false,
    'the live bid price is dropped, so sell_price could only be invented'
  );
});

test('early sell: a during_purchase stack with real logic is refused, not silently ignored', () => {
  // The interpreter runs before_purchase and after_purchase only. A populated
  // during_purchase stack is therefore logic that would never execute, and
  // accepting it would mean reporting a runnable bot whose rules are ignored.
  // An *empty* during_purchase is harmless and must stay accepted, because every
  // real DBot export emits one.
  const withDuring = (stack: string) => `<xml is_dbot="true">
    <variables><variable id="v1">counter</variable></variables>
    <block type="trade_definition"><statement name="TRADE_OPTIONS">
      <block type="trade_definition_market">
        <field name="MARKET_LIST">synthetic_index</field><field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <next><block type="trade_definition_tradetype">
          <field name="TRADETYPECAT_LIST">callput</field><field name="TRADETYPE_LIST">callput</field>
          <next><block type="trade_definition_contracttype"><field name="TYPE_LIST">CALL</field>
            <next><block type="trade_definition_candleinterval"><field name="CANDLEINTERVAL_LIST">60</field>
              <next><block type="trade_definition_tradeoptions">
                <field name="DURATIONTYPE_LIST">m</field><field name="CURRENCY_LIST">USD</field>
                <value name="DURATION"><shadow type="math_number"><field name="NUM">5</field></shadow></value>
                <value name="AMOUNT"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
              </block></next>
            </block></next>
          </block></next>
        </block></next>
      </block>
    </statement></block>
    <block type="before_purchase"><statement name="BEFOREPURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
        <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
      </block>
    </statement></block>
    <block type="during_purchase"><statement name="DURING_PURCHASE_STACK">${stack}</statement></block>
  </xml>`;

  const empty = planStrategy(xmlToTree(withDuring('')));
  assert.equal(empty.ok, true, 'an empty during_purchase must not block an otherwise runnable bot');
  assert.equal(empty.plan?.engine, 'interpreter');

  const withLogic = planStrategy(
    xmlToTree(
      withDuring(`<block type="variables_set"><field name="VAR" id="v1">counter</field>
        <value name="VALUE"><block type="math_number"><field name="NUM">99</field></block></value></block>`)
    )
  );
  assert.equal(withLogic.ok, false, 'logic that never runs must not be reported as runnable');
  assert.match(
    withLogic.reasons.join(' '),
    /during purchase/i,
    'the refusal must name during-purchase, not blame an unrelated block'
  );
});

test('early sell: the broker can already place a sell, but nothing calls it from a strategy', async () => {
  // The transport is real: gateway.closeContract -> broker.sell({ sell: id, price: 0 }).
  // What is missing is a *strategy-driven* path that decides when to call it,
  // because the decision needs the eligibility data above. Recording that split
  // prevents the mistake of thinking selling is entirely absent.
  const { FakeBroker } = await import('../execution/broker/fakeBroker.js');
  const broker = new FakeBroker();
  assert.equal(typeof broker.sell, 'function', 'the sell transport exists');
});
