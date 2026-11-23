import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseXml, XmlError } from '../bots/xml.js';
import { analyzeDbotXml, MAX_BOT_FILE_BYTES } from '../bots/parser.js';
import { supportedBlockTypes, unsupportedBlockTypes, isKnownBlock } from '../bots/blocks.js';

/**
 * Parser, security and compatibility tests for the bot importer.
 *
 * The fixtures below are modelled on a genuine Deriv DBot export: the root is
 * `<xml is_dbot="true">`, main blocks are `trade_definition`, `before_purchase`,
 * `during_purchase` and `after_purchase`, and field names match the DBot block
 * definitions. Nothing here is executed.
 */

/* ------------------------------ fixtures -------------------------------- */

/** A minimal but genuine-shaped DBot strategy: Rise/Fall on Volatility 100. */
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

/** Same bot, but with a digit trade type the execution layer cannot place. */
const DIGITS_DBOT = VALID_DBOT.replace('>callput<', '>digits<')
  .replace('>callput</field>', '>overunder</field>')
  .replace('>CALL</field>', '>DIGITOVER</field>');

/* ------------------------------ valid XML ------------------------------- */

test('parses a genuine DBot export into the normalized model', () => {
  const result = analyzeDbotXml(VALID_DBOT, { filename: 'rise-fall.xml' });

  // This fixture holds a `check_sell` inside `during_purchase`. Early selling is
  // implemented, so the strategy is fully supported — but only because the
  // block genuinely executes. If that regresses, this assertion is the alarm.
  assert.equal(result.compatibility, 'full');
  assert.equal(result.errors.length, 0);
  assert.ok(result.bot);

  const bot = result.bot;
  assert.equal(bot.sourceFormat, 'deriv-dbot-xml');
  assert.equal(bot.isDbot, true);
  assert.equal(bot.name, 'rise-fall', 'name falls back to the filename without extension');

  assert.equal(bot.market.market, 'synthetic_index');
  assert.equal(bot.market.submarket, 'random_index');
  assert.equal(bot.market.symbol, 'R_100');
  assert.equal(bot.market.candleInterval, '60');

  assert.equal(bot.contract.tradeTypeCategory, 'callput');
  assert.equal(bot.contract.tradeType, 'callput');
  assert.deepEqual(bot.contract.contractTypes, ['CALL']);

  assert.equal(bot.stake.amount, 1);
  assert.equal(bot.stake.currency, 'USD');
  assert.equal(bot.stake.duration, 5);
  assert.equal(bot.stake.durationUnit, 't');

  assert.deepEqual(bot.unsupportedBlocks.map((b) => b.type), []);
  assert.equal(bot.unknownBlocks.length, 0);
});

test('extracts entry and exit conditions', () => {
  const result = analyzeDbotXml(VALID_DBOT);
  const bot = result.bot!;

  assert.ok(bot.exitConditions.some((c) => c.kind === 'check_sell'));
  assert.ok(bot.exitConditions.some((c) => c.kind === 'trade_again'));
});

test('reads a check_direction condition with its literal value', () => {
  const withDirection = VALID_DBOT.replace(
    '<block type="purchase">',
    '<block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block><block type="purchase">'
  );
  const bot = analyzeDbotXml(withDirection).bot!;
  const direction = bot.entryConditions.find((c) => c.kind === 'check_direction');
  assert.ok(direction);
  assert.equal(direction.description, 'Market direction is Rise');
});

test('reads an indicator with its parameters', () => {
  const withSma = VALID_DBOT.replace(
    '<block type="purchase">',
    `<block type="sma_statement">
       <field name="VARIABLE">sma</field>
       <statement name="STATEMENT">
         <block type="math_number"><field name="NUM">14</field></block>
       </statement>
     </block><block type="purchase">`
  );
  const bot = analyzeDbotXml(withSma).bot!;
  assert.equal(bot.indicators.length, 1);
  assert.equal(bot.indicators[0].kind, 'sma');
  assert.equal(bot.indicators[0].params.NUM, 14);
});

test('reports the full block inventory with counts', () => {
  const bot = analyzeDbotXml(VALID_DBOT).bot!;
  const purchase = bot.blockInventory.find((b) => b.type === 'purchase');
  assert.ok(purchase);
  assert.equal(purchase.count, 1);
  assert.ok(bot.blockInventory.some((b) => b.type === 'trade_definition'));
});

test('recognizes a legacy Deriv trade block and legacy tradeOptions block', () => {
  const legacy = `<xml xmlns="http://www.w3.org/1999/xhtml" collection="false">
  <variables></variables>
  <block type="trade" id="trade" x="0" y="0">
    <field name="MARKET_LIST">volidx</field>
    <field name="SUBMARKET_LIST">random_index</field>
    <field name="SYMBOL_LIST">R_50</field>
    <field name="TRADETYPECAT_LIST">digits</field>
    <field name="TRADETYPE_LIST">matchesdiffers</field>
    <field name="TYPE_LIST">DIGITDIFF</field>
    <field name="CANDLEINTERVAL_LIST">60</field>
    <statement name="SUBMARKET">
      <block type="tradeOptions">
        <field name="DURATIONTYPE_LIST">t</field>
        <field name="CURRENCY_LIST">USD</field>
        <value name="DURATION">
          <shadow type="math_number"><field name="NUM">1</field></shadow>
        </value>
      </block>
    </statement>
  </block>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="purchase"><field name="PURCHASE_LIST">DIGITDIFF</field></block>
    </statement>
  </block>
  <block type="after_purchase">
    <statement name="AFTERPURCHASE_STACK"><block type="trade_again"></block></statement>
  </block>
</xml>`;

  const result = analyzeDbotXml(legacy, { filename: 'digit-differs.xml' });
  assert.notEqual(result.compatibility, 'invalid');
  assert.ok(result.bot);
  assert.equal(result.bot.isDbot, true);
  assert.equal(result.bot.market.symbol, 'R_50');
  assert.equal(result.bot.market.candleInterval, '60');
  assert.equal(result.bot.contract.tradeTypeCategory, 'digits');
  assert.deepEqual(result.bot.contract.contractTypes, ['DIGITDIFF']);
  assert.equal(result.bot.stake.currency, 'USD');
  assert.equal(result.bot.stake.duration, 1);
  assert.equal(result.bot.stake.durationUnit, 't');
});

/* ----------------------------- invalid XML ------------------------------ */

test('rejects malformed XML', () => {
  const result = analyzeDbotXml('<xml is_dbot="true"><block type="purchase"></xml>');
  assert.equal(result.compatibility, 'invalid');
  assert.equal(result.bot, null);
  assert.ok(result.errors[0].code.startsWith('xml_'));
});

test('rejects an empty document', () => {
  const result = analyzeDbotXml('   ');
  assert.equal(result.compatibility, 'invalid');
  assert.equal(result.errors[0].code, 'xml_no_root');
});

test('rejects a non-DBot root element', () => {
  const result = analyzeDbotXml('<strategy><block type="purchase"/></strategy>');
  assert.equal(result.compatibility, 'invalid');
  assert.equal(result.errors[0].code, 'not_dbot_document');
});

test('rejects a document with no blocks', () => {
  const result = analyzeDbotXml('<xml is_dbot="true"><variables></variables></xml>');
  assert.equal(result.compatibility, 'invalid');
  assert.equal(result.errors[0].code, 'no_blocks');
});

test('classifies a strategy missing mandatory blocks as invalid', () => {
  const noPurchase = VALID_DBOT.replace(/<block type="purchase">[\s\S]*?<\/block>/, '');
  const result = analyzeDbotXml(noPurchase);
  assert.equal(result.compatibility, 'invalid');
  assert.match(result.compatibilityReason, /missing/i);
  assert.ok(result.bot, 'the normalized model is still produced for inspection');
});

/* --------------------------- unsafe XML features ------------------------ */

test('rejects a DOCTYPE declaration (blocks XXE and entity expansion)', () => {
  const evil = `<?xml version="1.0"?>
<!DOCTYPE xml [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<xml is_dbot="true"><block type="purchase"><field name="PURCHASE_LIST">&xxe;</field></block></xml>`;
  const result = analyzeDbotXml(evil);
  assert.equal(result.compatibility, 'invalid');
  assert.equal(result.errors[0].code, 'xml_doctype_forbidden');
});

test('rejects the billion-laughs entity expansion pattern', () => {
  const laughs = `<!DOCTYPE lolz [
    <!ENTITY lol "lol">
    <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
    <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
  ]>
  <xml is_dbot="true"><block type="purchase"><field name="PURCHASE_LIST">&lol2;</field></block></xml>`;
  const result = analyzeDbotXml(laughs);
  assert.equal(result.compatibility, 'invalid');
  assert.equal(result.errors[0].code, 'xml_doctype_forbidden');
});

test('rejects an unknown entity reference', () => {
  assert.throws(() => parseXml('<xml><field>&custom;</field></xml>'), (e: unknown) => {
    assert.ok(e instanceof XmlError);
    assert.equal(e.code, 'unknown_entity');
    return true;
  });
});

test('rejects a processing instruction inside the document', () => {
  assert.throws(
    () => parseXml('<xml><?php echo "x"; ?><block/></xml>'),
    (e: unknown) => e instanceof XmlError && e.code === 'processing_instruction_forbidden'
  );
});

test('rejects deeply nested input at the depth cap', () => {
  const deep = '<xml>' + '<block>'.repeat(200) + '</block>'.repeat(200) + '</xml>';
  assert.throws(() => parseXml(deep), (e: unknown) => e instanceof XmlError && e.code === 'too_deep');
});

test('rejects input beyond the size cap', () => {
  const huge = '<xml>' + 'a'.repeat(MAX_BOT_FILE_BYTES + 10) + '</xml>';
  const result = analyzeDbotXml(huge);
  assert.equal(result.compatibility, 'invalid');
  assert.equal(result.errors[0].code, 'file_too_large');
});

test('rejects mismatched closing tags', () => {
  assert.throws(
    () => parseXml('<xml><block></field></xml>'),
    (e: unknown) => e instanceof XmlError && e.code === 'malformed'
  );
});

test('rejects multiple root elements', () => {
  assert.throws(
    () => parseXml('<xml></xml><xml></xml>'),
    (e: unknown) => e instanceof XmlError && e.code === 'multiple_roots'
  );
});

test('accepts the five predefined entities and numeric references', () => {
  const root = parseXml('<xml><field>&lt;&amp;&gt;&#65;&#x42;</field></xml>');
  const field = root.children.find((c) => c.type === 'element' && c.name === 'field');
  assert.ok(field && field.type === 'element');
  const text = field.children.map((c) => (c.type === 'text' ? c.text : '')).join('');
  assert.equal(text, '<&>AB');
});

/* ------------------------ unsupported / unknown blocks ------------------- */

test('marks recognised-but-uninterpreted blocks as unsupported with reasons', () => {
  // `notify_telegram` needs credentials this build does not manage, so it is
  // recognised and refused rather than silently ignored.
  const withUnsupported = VALID_DBOT.replace(
    '<block type="purchase">',
    '<block type="notify_telegram"></block><block type="purchase">'
  );
  const result = analyzeDbotXml(withUnsupported);
  const bot = result.bot!;

  assert.equal(result.compatibility, 'partial');
  const entry = bot.unsupportedBlocks.find((b) => b.type === 'notify_telegram');
  assert.ok(entry, 'notify_telegram should be reported as unsupported');
  assert.ok(entry.reason.length > 0);
  assert.match(result.compatibilityReason, /could not be interpreted/i);
});

test('does not silently drop unsupported blocks', () => {
  const withSeveral = VALID_DBOT.replace(
    '<block type="purchase">',
    '<block type="notify_telegram"></block><block type="trade_definition_multiplier"></block><block type="purchase">'
  );
  const bot = analyzeDbotXml(withSeveral).bot!;
  const types = bot.unsupportedBlocks.map((b) => b.type).sort();
  assert.deepEqual(types, ['notify_telegram', 'trade_definition_multiplier']);
});

test('reports unknown block types separately from unsupported ones', () => {
  const withUnknown = VALID_DBOT.replace(
    '<block type="purchase">',
    '<block type="totally_made_up_block"></block><block type="purchase">'
  );
  const result = analyzeDbotXml(withUnknown);
  const bot = result.bot!;

  assert.equal(result.compatibility, 'unsupported');
  assert.equal(bot.unknownBlocks.length, 1);
  assert.equal(bot.unknownBlocks[0].type, 'totally_made_up_block');
});

/* --------------------------- missing / bad values ----------------------- */

test('leaves an unreadable stake null instead of inventing a default', () => {
  const noAmount = VALID_DBOT.replace(
    /<value name="AMOUNT">[\s\S]*?<\/value>/,
    ''
  );
  const bot = analyzeDbotXml(noAmount).bot!;
  assert.equal(bot.stake.amount, null, 'a missing stake must not become 0 or 1');
  assert.ok(bot.warnings.some((w) => w.code === 'stake_unreadable'));
});

test('leaves a non-numeric stake null', () => {
  const badAmount = VALID_DBOT.replace(
    '<field name="NUM">1</field>',
    '<field name="NUM">not-a-number</field>'
  );
  const bot = analyzeDbotXml(badAmount).bot!;
  assert.equal(bot.stake.amount, null);
});

test('warns when the contract type is absent', () => {
  const noType = VALID_DBOT.replace(
    '<field name="TYPE_LIST">CALL</field>',
    '<field name="TYPE_LIST"></field>'
  );
  const result = analyzeDbotXml(noType);
  assert.ok(result.bot!.warnings.some((w) => w.code === 'contract_type_missing'));
  assert.equal(result.compatibility, 'partial');
});

test('warns when the DBot marker is missing', () => {
  const noMarker = VALID_DBOT.replace(' is_dbot="true"', '');
  const result = analyzeDbotXml(noMarker);
  assert.equal(result.bot!.isDbot, false);
  assert.ok(result.bot!.warnings.some((w) => w.code === 'no_dbot_marker'));
});

/* --------------------------- compatibility rules ------------------------ */

test('classifies a placeable contract type as fully supported', () => {
  // Strip the refused `check_sell` so only contract placeability is under test.
  const withoutSell = VALID_DBOT.replace(
    '<block type="controls_if">\n        <value name="IF0"><block type="check_sell"></block></value>\n      </block>',
    ''
  );
  const result = analyzeDbotXml(withoutSell);
  assert.equal(result.compatibility, 'full');
  assert.match(result.compatibilityReason, /does not authorise execution/i);
});

test('classifies a non-placeable contract type as partial', () => {
  // A contract type outside the executable catalogue is refused even when every
  // block in the file is interpreted.
  const exotic = VALID_DBOT.replace('>CALL</field>', '>RANGE</field>').replace(
    '<block type="controls_if">\n        <value name="IF0"><block type="check_sell"></block></value>\n      </block>',
    ''
  );
  const result = analyzeDbotXml(exotic);
  assert.equal(result.compatibility, 'partial');
  assert.match(result.compatibilityReason, /not one No-touch can place/i);
});

test('compatibility "full" never claims the bot is authorised to execute', () => {
  const withoutSell = VALID_DBOT.replace(
    '<block type="controls_if">\n        <value name="IF0"><block type="check_sell"></block></value>\n      </block>',
    ''
  );
  const result = analyzeDbotXml(withoutSell);
  assert.equal(result.compatibility, 'full');
  assert.match(result.compatibilityReason, /does not authorise execution/i);
});

/* ------------------------------ duplicates ------------------------------ */

test('produces a stable hash so identical files can be de-duplicated', () => {
  const a = analyzeDbotXml(VALID_DBOT, { filename: 'a.xml' });
  const b = analyzeDbotXml(VALID_DBOT, { filename: 'b.xml' });
  assert.equal(a.sourceHash, b.sourceHash, 'same content must hash identically regardless of name');
  assert.equal(a.sourceHash.length, 64);
});

test('different content produces a different hash', () => {
  const a = analyzeDbotXml(VALID_DBOT);
  const b = analyzeDbotXml(DIGITS_DBOT);
  assert.notEqual(a.sourceHash, b.sourceHash);
});

/* ------------------------------- registry ------------------------------- */

test('every supported block type is also reported as known', () => {
  for (const type of supportedBlockTypes()) {
    assert.equal(isKnownBlock(type), true, `${type} should be known`);
  }
});

test('every unsupported block type carries a reason', () => {
  for (const entry of unsupportedBlockTypes()) {
    assert.ok(entry.reason.length > 0, `${entry.type} needs a reason`);
  }
});
