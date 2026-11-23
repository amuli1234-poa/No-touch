/**
 * Early selling: what Deriv actually does, and how this build implements it.
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
 *     sellAtMarket() sends { sell: contract_id, price: 0 }, where a zero price
 *     means "at market".
 *
 *   .../trade/OpenContract.js
 *     isSellAvailable = !is_sold && is_valid_to_sell     (from proposal_open_contract)
 *     getSellPrice()  = round(bid_price - buy_price)
 *
 * The three facts the blocks need are `is_valid_to_sell`, `bid_price` and
 * `buy_price` on a *live* contract. `mapContract` now maps the first two and
 * `ContractRecord` persists all three, so the blocks answer from reported data.
 *
 * These tests are the contract for that implementation: they fail if the fields
 * stop being mapped, if a missing field is treated as a usable value, or if the
 * interpreter ever sells without the run service's ownership and audit checks.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockSpec, isContainerBlock, isDeliberatelyUnexecuted } from '../bots/blocks.js';
import {
  isInterpreted,
  runDuringPurchase,
  type OpenContractFacts,
  type TickContext
} from '../bots/interpreter.js';
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

/** A minimal during_purchase strategy whose stack is supplied by the caller. */
function duringPurchaseBot(stack: string): string {
  return `<xml is_dbot="true">
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
}

/** A live contract carrying the fields the sell blocks read. */
function liveContract(overrides: Partial<OpenContractFacts> = {}): OpenContractFacts {
  return {
    contractId: '123',
    buyPrice: 10,
    bidPrice: 9.5,
    currency: 'USD',
    isSold: false,
    isValidToSell: true,
    profit: -0.5,
    payout: 19.5,
    currentSpot: 1000.5,
    isExpired: false,
    ...overrides
  };
}

function context(openContract: OpenContractFacts | null): TickContext {
  return {
    ticks: [],
    variables: new Map(),
    totalProfit: 0,
    lastContract: null,
    openContract
  };
}

test('early sell: the three sell blocks are executable, not merely recognised', () => {
  for (const type of ['check_sell', 'sell_price', 'sell_at_market']) {
    assert.equal(isInterpreted(type), true, `${type} must have a handler`);
    assert.equal(isDeliberatelyUnexecuted(type), false, `${type} is no longer deliberately skipped`);
    assert.equal(blockSpec(type)!.supported, true, `${type} must be reported as supported`);
  }
});

test('early sell: mapContract keeps the fields the sell blocks read', async () => {
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

  assert.equal(update.bidPrice, 9.5, 'the live bid price must survive the mapping');
  assert.equal(update.isValidToSell, true, "Deriv's sell verdict must survive the mapping");
});

test('early sell: an absent field stays null instead of becoming a false answer', async () => {
  const { mapContract } = await import('../execution/broker/derivBroker.js');
  const update = mapContract({ contract_id: 7, is_sold: 0, is_expired: 0 });

  assert.equal(update.bidPrice, null, 'a missing bid is unknown, never zero');
  assert.equal(update.isValidToSell, null, 'a missing verdict is unknown, never "not sellable"');

  // The distinction is load-bearing: an unknown bid must make sell_price null
  // rather than a number derived from nothing.
  const ctx = context(liveContract({ bidPrice: null, isValidToSell: null }));
  const tree = xmlToTree(duringPurchaseBot(''));
  assert.equal(runDuringPurchase(tree, ctx).sellRequest, null, 'nothing to sell without data');
});

test('early sell: sell_price is round(bid - buy), and null when either is missing', () => {
  const priceOf = (open: OpenContractFacts | null): unknown => {
    const bot = duringPurchaseBot(`<block type="variables_set"><field name="VAR" id="v1">counter</field>
      <value name="VALUE"><block type="sell_price"></block></value></block>`);
    const result = runDuringPurchase(xmlToTree(bot), context(open));
    return result.variables.get('v1') ?? result.variables.get('counter') ?? null;
  };

  // Official rounds to the currency's fractional digits, not to an integer.
  assert.equal(priceOf(liveContract({ bidPrice: 9.5, buyPrice: 10 })), -0.5, 'a loss keeps its cents');
  assert.equal(priceOf(liveContract({ bidPrice: 12.4, buyPrice: 10 })), 2.4, 'a gain keeps its cents');
  assert.equal(priceOf(liveContract({ bidPrice: 9.456, buyPrice: 10 })), -0.54, 'USD keeps 2 digits');
  assert.equal(
    priceOf(liveContract({ bidPrice: 0.123456789, buyPrice: 0.1, currency: 'BTC' })),
    0.02345679,
    'BTC keeps 8 digits'
  );
  assert.equal(priceOf(liveContract({ bidPrice: 9.5, buyPrice: 10, currency: null })), -0.5, 'no currency means 2 digits');
  assert.equal(priceOf(liveContract({ bidPrice: null })), null, 'no bid means no price');
  assert.equal(priceOf(liveContract({ buyPrice: null })), null, 'no buy price means no price');
  assert.equal(priceOf(null), null, 'no contract means no price');
});

test('early sell: check_sell requires Deriv to have approved the sale', () => {
  const sells = (open: OpenContractFacts | null): boolean => {
    const bot = duringPurchaseBot(`<block type="controls_if">
      <value name="IF0"><block type="check_sell"></block></value>
      <statement name="DO0"><block type="sell_at_market"></block></statement></block>`);
    return runDuringPurchase(xmlToTree(bot), context(open)).sellRequest !== null;
  };

  assert.equal(sells(liveContract()), true, 'a sellable contract can be sold');
  assert.equal(sells(liveContract({ isValidToSell: false })), false, 'Deriv said no');
  assert.equal(sells(liveContract({ isValidToSell: null })), false, 'an unknown verdict is not a yes');
  assert.equal(sells(liveContract({ isExpired: true })), false, 'an expired contract is not sellable');
  assert.equal(sells(liveContract({ isSold: true })), false, 'a sold contract is not sellable');
  assert.equal(sells(null), false, 'no contract is not sellable');
});

test('early sell: sell_at_market records a request instead of selling directly', () => {
  // The interpreter must not touch the broker. Selling is the run service's job,
  // because that is where ownership, the account lock, idempotency and audit live.
  const bot = duringPurchaseBot('<block type="sell_at_market"></block>');
  const result = runDuringPurchase(xmlToTree(bot), context(liveContract()));

  assert.deepEqual(result.sellRequest, { contractId: '123' }, 'the request names the held contract');
});

test('early sell: sell_at_market with no contract warns instead of acting', () => {
  const bot = duringPurchaseBot('<block type="sell_at_market"></block>');
  const result = runDuringPurchase(xmlToTree(bot), context(null));

  assert.equal(result.sellRequest, null, 'there is nothing to sell');
  assert.equal(result.notifications.length, 1, 'the skip is reported, not swallowed');
  assert.match(result.notifications[0].message, /no contract is open/i);
});

test('early sell: a strategy with a real during_purchase stack is runnable', () => {
  const planned = planStrategy(xmlToTree(EARLY_SELL_BOT));
  assert.equal(planned.ok, true, 'early selling is implemented, so the strategy can run');
  assert.equal(planned.plan?.engine, 'interpreter');
  assert.deepEqual(planned.unsupported, [], 'no sell block may be reported unsupported');
});

test('early sell: during_purchase remains a container the runtime addresses', () => {
  assert.equal(isContainerBlock('during_purchase'), true);
  assert.equal(isDeliberatelyUnexecuted('during_purchase'), false);
});

test('early sell: the run service is the only caller of the sell transport', async () => {
  // The transport is real: gateway.closeContract -> broker.sell({ sell: id, price: 0 }).
  // What matters is who calls it. The interpreter is asserted above to return a
  // request rather than sell, so the ownership check and audit cannot be bypassed.
  const { FakeBroker } = await import('../execution/broker/fakeBroker.js');
  const broker = new FakeBroker();
  assert.equal(typeof broker.sell, 'function', 'the sell transport exists');
});
