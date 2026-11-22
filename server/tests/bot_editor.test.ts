/**
 * Editor persistence tests: loading a bot's tree, saving edits, reverting.
 *
 * These cover the rules that keep an edit from corrupting a bot:
 *   * saving never touches `sourceXml`, so the imported file stays downloadable;
 *   * the stored XML is the server's canonical form, not whatever the browser
 *     sent, because the server re-parses it first;
 *   * saving an unchanged strategy is a no-op rather than a new revision;
 *   * a save that breaks the structure is rejected and the bot is untouched;
 *   * a bot still belongs to one tenant after it is edited.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Store } from '../store/store.js';
import { ImportError, importBot, loadBotTree, saveBotTree, toView } from '../bots/service.js';
import { collectUnknownBlocks, treeToXml, xmlToTree } from '../bots/tree.js';

const VALID_DBOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="trade_definition">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market">
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
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
  </block>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="purchase"><field name="PURCHASE_LIST">CALL</field></block>
    </statement>
  </block>
  <block type="during_purchase"><statement name="DURING_PURCHASE_STACK"><block type="check_sell"></block></statement></block>
  <block type="after_purchase"><statement name="AFTERPURCHASE_STACK"><block type="trade_again"></block></statement></block>
</xml>`;

const USER_A = 'user-a';
const USER_B = 'user-b';

async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notouch-editor-'));
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();
  try {
    await fn(store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loads a tree from the imported file before any edit', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    const loaded = loadBotTree(record);
    assert.equal(loaded.edited, false);
    assert.equal(loaded.revision, 0);
    assert.equal(loaded.xml, record.sourceXml);
    assert.deepEqual(
      loaded.tree.blocks.map((b) => b.type),
      ['trade_definition', 'before_purchase', 'during_purchase', 'after_purchase']
    );
  });
});

test('saving an edit stores workingXml and leaves sourceXml untouched', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    const original = record.sourceXml;

    const edited = VALID_DBOT.replace('R_100', 'R_75');
    const result = await saveBotTree(store, USER_A, record.id, edited);

    assert.equal(result.changed, true);
    assert.equal(result.revision, 1);
    assert.equal(result.record.sourceXml, original, 'the imported file must never be rewritten');
    assert.match(result.record.workingXml ?? '', /R_75/);
    assert.equal(result.record.revision, 1);
    assert.ok(result.record.editedAt);
  });
});

test('a saved edit is what the tree loads next time', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await saveBotTree(store, USER_A, record.id, VALID_DBOT.replace('R_100', 'R_75'));

    const stored = store.getImportedBot(USER_A, record.id)!;
    const loaded = loadBotTree(stored);
    assert.equal(loaded.edited, true);
    assert.equal(loaded.revision, 1);
    assert.match(loaded.xml, /R_75/);
    assert.doesNotMatch(loaded.xml, /R_100/);
  });
});

test('saving an unchanged strategy is a no-op, not a new revision', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await saveBotTree(store, USER_A, record.id, VALID_DBOT);

    const stored = store.getImportedBot(USER_A, record.id)!;
    const again = await saveBotTree(store, USER_A, record.id, VALID_DBOT);
    assert.equal(again.changed, false);
    assert.equal(again.revision, stored.revision ?? 0);
  });
});

test('a second real edit increments the revision', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await saveBotTree(store, USER_A, record.id, VALID_DBOT.replace('R_100', 'R_75'));
    const second = await saveBotTree(store, USER_A, record.id, VALID_DBOT.replace('R_100', 'R_50'));
    assert.equal(second.changed, true);
    assert.equal(second.revision, 2);
  });
});

test('stores the canonical XML rather than the bytes the client sent', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    // A real edit, sent with sloppy formatting and attribute order.
    const messy = VALID_DBOT.replace('R_100', 'R_75')
      .replace('is_dbot="true"', 'is_dbot="true"    ')
      .replace(/\n/g, '\n\n');
    const result = await saveBotTree(store, USER_A, record.id, messy);
    assert.equal(result.changed, true);
    const stored = result.record.workingXml ?? '';
    assert.equal(stored, treeToXml(xmlToTree(stored)), 'stored XML must be canonical');
    assert.match(stored, /R_75/);
  });
});

test('a whitespace-only difference is not treated as an edit', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    const result = await saveBotTree(store, USER_A, record.id, VALID_DBOT.replace(/\n/g, '\n\n'));
    assert.equal(result.changed, false);
    assert.equal(result.record.workingXml, undefined);
  });
});

test('keeps sibling blocks inside one statement instead of dropping them', async () => {
  await withStore(async (store) => {
    // Two sibling blocks where Blockly would normally write a <next> chain.
    const siblings = VALID_DBOT.replace(
      '<block type="check_sell"></block>',
      '<block type="check_sell"></block><block type="future_block"><field name="KEEP">yes</field></block>'
    );
    const { record } = await importBot(store, USER_A, 'bot.xml', siblings);
    const loaded = loadBotTree(record);
    const during = loaded.tree.blocks.find((b) => b.type === 'during_purchase');
    const stack = during?.inputs.find((i) => i.name === 'DURING_PURCHASE_STACK')?.block;
    assert.equal(stack?.type, 'check_sell');
    assert.equal(stack?.next?.type, 'future_block', 'the second sibling must not be lost');
    assert.equal(stack?.next?.fields[0].value, 'yes');
  });
});

test('rejects a save that is not valid XML and leaves the bot untouched', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await assert.rejects(
      () => saveBotTree(store, USER_A, record.id, '<xml><block type="a"></xml>'),
      (err: unknown) => err instanceof ImportError && err.code === 'parse_failed'
    );
    const stored = store.getImportedBot(USER_A, record.id)!;
    assert.equal(stored.workingXml, undefined);
    assert.equal(stored.revision, undefined);
  });
});

test('rejects an empty save', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await assert.rejects(
      () => saveBotTree(store, USER_A, record.id, '   '),
      (err: unknown) => err instanceof ImportError && err.code === 'empty_body'
    );
  });
});

test('rejects a save with no blocks', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await assert.rejects(
      () => saveBotTree(store, USER_A, record.id, '<xml is_dbot="true"></xml>'),
      (err: unknown) => err instanceof ImportError && err.code === 'parse_failed'
    );
  });
});

test('a user cannot save an edit to another user\'s bot', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await assert.rejects(
      () => saveBotTree(store, USER_B, record.id, VALID_DBOT.replace('R_100', 'R_75')),
      (err: unknown) => err instanceof ImportError && err.code === 'not_found'
    );
    const stored = store.getImportedBot(USER_A, record.id)!;
    assert.equal(stored.workingXml, undefined, 'a cross-tenant save must not write');
  });
});

test('saving keeps the bot readable only by its owner', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await saveBotTree(store, USER_A, record.id, VALID_DBOT.replace('R_100', 'R_75'));
    assert.ok(store.getImportedBot(USER_A, record.id));
    assert.equal(store.getImportedBot(USER_B, record.id), null);
  });
});

test('toView reports edit state without leaking the XML', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    const before = toView(record);
    assert.equal(before.edited, false);
    assert.equal(before.revision, 0);

    const result = await saveBotTree(store, USER_A, record.id, VALID_DBOT.replace('R_100', 'R_75'));
    const after = toView(result.record);
    assert.equal(after.edited, true);
    assert.equal(after.revision, 1);
    assert.equal('workingXml' in after, false, 'the view must not expose raw XML');
    assert.equal('sourceXml' in after, false, 'the view must not expose raw XML');
  });
});

test('an unknown block survives a save round trip through the store', async () => {
  await withStore(async (store) => {
    const withUnknown = VALID_DBOT.replace(
      '<block type="check_sell"></block>',
      '<block type="check_sell"></block><block type="future_block"><field name="KEEP">yes</field></block>'
    );
    const { record } = await importBot(store, USER_A, 'bot.xml', withUnknown);
    const loaded = loadBotTree(record);
    const unknown = collectUnknownBlocks(loaded.tree);
    assert.ok(
      unknown.some((u) => u.type === 'future_block'),
      'the unknown block must be reported to the editor'
    );

    // Edit something real, and check the unknown block came through untouched.
    const result = await saveBotTree(store, USER_A, record.id, loaded.xml.replace('R_100', 'R_75'));
    assert.equal(result.changed, true);
    const saved = result.record.workingXml ?? '';
    assert.match(saved, /future_block/);
    assert.match(saved, /KEEP/);
    assert.match(saved, /R_75/);
  });
});
