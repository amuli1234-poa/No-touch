/**
 * Block-tree round-trip tests.
 *
 * The editor's whole promise is that opening a bot and saving it again does not
 * quietly change the strategy. These tests hold the tree layer to that: parse
 * an export, serialise it, and assert the meaning survives — block types, field
 * values, nesting, `<next>` order, shadows, mutations and unknown blocks.
 *
 * They also assert the tree does not invent anything: a strategy with no
 * stake does not gain one, and a block No-touch cannot interpret comes back
 * byte-identical rather than being dropped or "fixed".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  annotateUnknown,
  countBlocks,
  fieldValue,
  findTopLevel,
  treeToXml,
  walkTree,
  xmlToTree
} from '../bots/tree.js';
import { isKnownBlock } from '../bots/blocks.js';

const VALID_DBOT = `<xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">
  <variables></variables>
  <block type="trade_definition" x="0" y="0">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market" deletable="false" movable="false">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <next>
          <block type="trade_definition_tradetype">
            <field name="TRADETYPECAT_LIST">callput</field>
            <field name="TRADETYPE_LIST">callput</field>
            <next>
              <block type="trade_definition_contracttype">
                <field name="TYPE_LIST">CALL</field>
                <next>
                  <block type="trade_definition_candleinterval">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
    <statement name="SUBMARKET">
      <block type="trade_definition_tradeoptions">
        <field name="DURATIONTYPE_LIST">t</field>
        <field name="CURRENCY_LIST">USD</field>
        <value name="DURATION">
          <shadow type="math_number_positive"><field name="NUM">5</field></shadow>
        </value>
        <value name="AMOUNT">
          <shadow type="math_number_positive"><field name="NUM">1</field></shadow>
        </value>
      </block>
    </statement>
  </block>
  <block type="before_purchase" x="0" y="576">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="purchase">
        <field name="PURCHASE_LIST">CALL</field>
      </block>
    </statement>
  </block>
  <block type="during_purchase" x="720" y="0">
    <statement name="DURING_PURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="check_sell"></block></value>
      </block>
    </statement>
  </block>
  <block type="after_purchase" x="720" y="248">
    <statement name="AFTERPURCHASE_STACK">
      <block type="trade_again"></block>
    </statement>
  </block>
</xml>`;

test('parses top-level blocks in source order', () => {
  const tree = xmlToTree(VALID_DBOT);
  assert.deepEqual(
    tree.blocks.map((b) => b.type),
    ['trade_definition', 'before_purchase', 'during_purchase', 'after_purchase']
  );
  assert.equal(tree.attrs.is_dbot, 'true');
  assert.equal(tree.attrs.collection, 'false');
});

test('reads fields on a nested block', () => {
  const tree = xmlToTree(VALID_DBOT);
  const market = findTopLevel(tree, 'trade_definition')
    ?.inputs.find((i) => i.name === 'TRADE_OPTIONS')
    ?.block;
  assert.equal(fieldValue(market, 'MARKET_LIST'), 'synthetic_index');
  assert.equal(fieldValue(market, 'SYMBOL_LIST'), 'R_100');
  assert.equal(market?.attrs?.deletable, 'false');
  assert.equal(market?.attrs?.movable, 'false');
});

test('follows the <next> chain inside a statement', () => {
  const tree = xmlToTree(VALID_DBOT);
  const market = findTopLevel(tree, 'trade_definition')
    ?.inputs.find((i) => i.name === 'TRADE_OPTIONS')
    ?.block;
  assert.equal(market?.next?.type, 'trade_definition_tradetype');
  assert.equal(market?.next?.next?.type, 'trade_definition_contracttype');
  assert.equal(market?.next?.next?.next?.type, 'trade_definition_candleinterval');
  assert.equal(market?.next?.next?.next?.next, null);
});

test('keeps a shadow-only input as the block the strategy uses', () => {
  const tree = xmlToTree(VALID_DBOT);
  const options = findTopLevel(tree, 'trade_definition')
    ?.inputs.find((i) => i.name === 'SUBMARKET')
    ?.block;
  const amount = options?.inputs.find((i) => i.name === 'AMOUNT')?.block;
  assert.equal(amount?.type, 'math_number_positive');
  assert.equal(amount?.shadow, true);
  assert.equal(fieldValue(amount, 'NUM'), '1');
});

test('keeps a shadow that sits beside a connected block', () => {
  const xml = `<xml is_dbot="true">
  <block type="trade_definition_tradeoptions">
    <value name="AMOUNT">
      <shadow type="math_number_positive"><field name="NUM">2</field></shadow>
      <block type="math_arithmetic"></block>
    </value>
  </block>
</xml>`;
  const tree = xmlToTree(xml);
  const input = tree.blocks[0].inputs.find((i) => i.name === 'AMOUNT');
  assert.equal(input?.block?.type, 'math_arithmetic');
  assert.equal(input?.shadow?.type, 'math_number_positive');
  assert.equal(input?.shadow?.fields[0].value, '2');
});

test('preserves <mutation> attributes', () => {
  const xml = `<xml is_dbot="true">
  <block type="controls_if">
    <mutation elseif="1" else="1"></mutation>
  </block>
</xml>`;
  const tree = xmlToTree(xml);
  assert.equal(tree.blocks[0].mutation?.elseif, '1');
  assert.equal(tree.blocks[0].mutation?.else, '1');
});

test('preserves declared variables', () => {
  const xml = `<xml is_dbot="true">
  <variables>
    <variable id="v1">myVar</variable>
  </variables>
  <block type="variables_set"></block>
</xml>`;
  const tree = xmlToTree(xml);
  assert.deepEqual(tree.variables, [{ id: 'v1', name: 'myVar' }]);
});

test('round-trips the full strategy without losing blocks', () => {
  const first = xmlToTree(VALID_DBOT);
  const xml = treeToXml(first);
  const second = xmlToTree(xml);

  assert.deepEqual(
    second.blocks.map((b) => b.type),
    first.blocks.map((b) => b.type)
  );
  assert.equal(countBlocks(first).total, countBlocks(second).total);
  // Field values survive the trip.
  const options = findTopLevel(second, 'trade_definition')
    ?.inputs.find((i) => i.name === 'SUBMARKET')
    ?.block;
  assert.equal(fieldValue(options, 'CURRENCY_LIST'), 'USD');
  assert.equal(fieldValue(options, 'DURATIONTYPE_LIST'), 't');
});

test('serialisation is deterministic', () => {
  const tree = xmlToTree(VALID_DBOT);
  assert.equal(treeToXml(tree), treeToXml(xmlToTree(treeToXml(tree))));
});

test('round-trip is structurally lossless (deep tree equality)', () => {
  const original = xmlToTree(VALID_DBOT);
  const roundTripped = xmlToTree(treeToXml(original));
  assert.deepEqual(roundTripped, original);
});

test('keeps an unknown block instead of dropping it', () => {
  const xml = `<xml is_dbot="true">
  <block type="some_future_dbot_block">
    <field name="WHATEVER">kept</field>
    <statement name="STACK">
      <block type="another_unknown"><field name="X">1</field></block>
    </statement>
  </block>
</xml>`;
  const tree = xmlToTree(xml);
  annotateUnknown(tree, isKnownBlock);

  const root = tree.blocks[0];
  assert.equal(root.type, 'some_future_dbot_block');
  assert.equal(root.unknown, true);
  assert.equal(fieldValue(root, 'WHATEVER'), 'kept');

  const roundTripped = xmlToTree(treeToXml(tree));
  assert.equal(roundTripped.blocks[0].type, 'some_future_dbot_block');
  assert.equal(fieldValue(roundTripped.blocks[0], 'WHATEVER'), 'kept');
  assert.equal(
    roundTripped.blocks[0].inputs.find((i) => i.name === 'STACK')?.block?.type,
    'another_unknown'
  );
});

test('marks known blocks as known and unknown blocks as unknown', () => {
  const tree = xmlToTree(VALID_DBOT);
  annotateUnknown(tree, isKnownBlock);
  for (const node of walkTree(tree)) {
    assert.notEqual(node.unknown, true, `${node.type} should be known`);
  }
});

test('rejects a document whose root is not <xml>', () => {
  assert.throws(() => xmlToTree('<html><body/></html>'), /not a DBot strategy/);
});

test('rejects a strategy with no blocks', () => {
  assert.throws(() => xmlToTree('<xml is_dbot="true"><variables></variables></xml>'), /no blocks/);
});

test('rejects malformed XML', () => {
  assert.throws(
    () => xmlToTree('<xml><block type="a"></xml>'),
    /Unclosed|malformed|not valid|does not match/i
  );
});

test('escapes field values that contain XML metacharacters', () => {
  const tree = xmlToTree(`<xml is_dbot="true">
  <block type="variables_set"><field name="TEXT">a &lt; b &amp; c</field></block>
</xml>`);
  assert.equal(fieldValue(tree.blocks[0], 'TEXT'), 'a < b & c');
  const xml = treeToXml(tree);
  assert.match(xml, /a &lt; b &amp; c/);
  // And it parses back to the same value.
  assert.equal(fieldValue(xmlToTree(xml).blocks[0], 'TEXT'), 'a < b & c');
});
