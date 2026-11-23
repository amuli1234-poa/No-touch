import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import {
  ImportError,
  deleteBot,
  duplicateBot,
  importBot,
  previewUpload,
  setBotStatus,
  validateUpload,
  toView
} from '../bots/service.js';
import { MAX_BOT_FILE_BYTES } from '../bots/parser.js';

/**
 * Import service tests: tenant isolation, duplicate handling, lifecycle rules
 * and upload validation. Everything runs against the real Store on a temporary
 * directory. No network, no execution — an imported bot is inert data.
 */

const VALID_DBOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="trade_definition">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMAKET_LIST">x</field>
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

const OTHER_DBOT = VALID_DBOT.replace('R_100', 'R_50');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notouch-bots-'));
}

const USER_A = 'user-a';
const USER_B = 'user-b';

async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();
  try {
    await fn(store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------- isolation ------------------------------- */

test('a user cannot read another user\'s bot by id', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    assert.ok(store.getImportedBot(USER_A, record.id));
    assert.equal(store.getImportedBot(USER_B, record.id), null, 'cross-tenant read must return null');
  });
});

test('listing returns only the caller\'s bots', async () => {
  await withStore(async (store) => {
    await importBot(store, USER_A, 'a.xml', VALID_DBOT);
    await importBot(store, USER_B, 'b.xml', OTHER_DBOT);

    assert.equal(store.listImportedBots(USER_A).length, 1);
    assert.equal(store.listImportedBots(USER_B).length, 1);
    assert.notEqual(store.listImportedBots(USER_A)[0].id, store.listImportedBots(USER_B)[0].id);
  });
});

test('a user cannot delete another user\'s bot', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await assert.rejects(
      () => deleteBot(store, USER_B, record.id),
      (e: unknown) => e instanceof ImportError && e.code === 'not_found'
    );
    assert.ok(store.getImportedBot(USER_A, record.id), 'the owner still has the bot');
  });
});

test('a user cannot change another user\'s bot status', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await assert.rejects(
      () => setBotStatus(store, USER_B, record.id, 'paused'),
      (e: unknown) => e instanceof ImportError && e.code === 'not_found'
    );
    assert.equal(store.getImportedBot(USER_A, record.id)!.status, 'imported');
  });
});

test('duplicate detection is per-tenant, not global', async () => {
  await withStore(async (store) => {
    const a = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    const b = await importBot(store, USER_B, 'bot.xml', VALID_DBOT);
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, false, 'another tenant importing the same file is not a duplicate');
    assert.notEqual(a.record.id, b.record.id);
  });
});

/* ------------------------------ duplicates ------------------------------- */

test('re-importing the same file returns the existing bot', async () => {
  await withStore(async (store) => {
    const first = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    const second = await importBot(store, USER_A, 'renamed.xml', VALID_DBOT);

    assert.equal(second.duplicate, true);
    assert.equal(second.record.id, first.record.id);
    assert.equal(store.listImportedBots(USER_A).length, 1, 'no second copy is stored');
  });
});

/* ------------------------------- lifecycle ------------------------------- */

test('moves a bot through pause, resume and archive', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);

    const paused = await setBotStatus(store, USER_A, record.id, 'paused');
    assert.equal(paused.status, 'paused');

    const resumed = await setBotStatus(store, USER_A, record.id, 'imported');
    assert.equal(resumed.status, 'imported');

    const archived = await setBotStatus(store, USER_A, record.id, 'archived');
    assert.equal(archived.status, 'archived');
  });
});

test('rejects an invalid status transition', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await setBotStatus(store, USER_A, record.id, 'archived');
    await assert.rejects(
      () => setBotStatus(store, USER_A, record.id, 'paused'),
      (e: unknown) => e instanceof ImportError && e.code === 'invalid_transition'
    );
  });
});

test('rejects an unknown status value', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await assert.rejects(
      () => setBotStatus(store, USER_A, record.id, 'running'),
      (e: unknown) => e instanceof ImportError && e.code === 'invalid_transition'
    );
  });
});

test('duplicating a bot creates a separate record', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    const copy = await duplicateBot(store, USER_A, record.id);

    assert.notEqual(copy.id, record.id);
    assert.match(copy.name, /\(copy\)$/);
    assert.equal(store.listImportedBots(USER_A).length, 2);
    assert.equal(store.getImportedBot(USER_A, record.id)!.name, record.name, 'original is unchanged');
  });
});

test('deleting a bot removes it for the owner only', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    await deleteBot(store, USER_A, record.id);
    assert.equal(store.getImportedBot(USER_A, record.id), null);
  });
});

/* --------------------------- upload validation --------------------------- */

test('rejects a non-XML extension', () => {
  assert.throws(
    () => validateUpload('strategy.json', '<xml/>'),
    (e: unknown) => e instanceof ImportError && e.code === 'wrong_extension'
  );
});

test('rejects a missing filename', () => {
  assert.throws(
    () => validateUpload(undefined, '<xml/>'),
    (e: unknown) => e instanceof ImportError && e.code === 'missing_filename'
  );
});

test('rejects a non-string body', () => {
  assert.throws(
    () => validateUpload('bot.xml', 42),
    (e: unknown) => e instanceof ImportError && e.code === 'not_text'
  );
});

test('rejects an empty body', () => {
  assert.throws(
    () => validateUpload('bot.xml', ''),
    (e: unknown) => e instanceof ImportError && e.code === 'empty_body'
  );
});

test('rejects a file beyond the size limit', () => {
  const huge = 'a'.repeat(MAX_BOT_FILE_BYTES + 1);
  assert.throws(
    () => validateUpload('bot.xml', huge),
    (e: unknown) => e instanceof ImportError && e.code === 'file_too_large'
  );
});

test('rejects an invalid strategy at import time', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => importBot(store, USER_A, 'bad.xml', '<xml is_dbot="true"><variables/></xml>'),
      (e: unknown) => e instanceof ImportError && e.code === 'parse_failed'
    );
    assert.equal(store.listImportedBots(USER_A).length, 0, 'nothing invalid is stored');
  });
});

test('preview does not store anything', async () => {
  await withStore(async (store) => {
    const preview = previewUpload('bot.xml', VALID_DBOT);
    // The fixture carries a `check_sell` inside `during_purchase`. Early selling
    // is implemented, so the strategy is fully supported.
    assert.equal(preview.compatibility, 'full');
    assert.equal(store.listImportedBots(USER_A).length, 0, 'a preview is not persisted');
  });
});

/* ---------------------------- record contents ---------------------------- */

test('stores the original file verbatim so it can be re-downloaded', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    assert.equal(record.sourceXml, VALID_DBOT, 'the exact bytes are preserved');
    assert.equal(record.originalFilename, 'bot.xml');
    assert.equal(record.sourceHash.length, 64);
  });
});

test('records that execution is not authorised', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    assert.match(record.executionNote, /not been authorised/i);
    assert.match(record.executionNote, /REAL execution is disabled/i);
  });
});

test('the client view never exposes the stored XML', async () => {
  await withStore(async (store) => {
    const { record } = await importBot(store, USER_A, 'bot.xml', VALID_DBOT);
    const view = toView(record);
    assert.equal('sourceXml' in view, false, 'the raw XML is served only by the download route');
    assert.equal('sourceHash' in view, false);
  });
});

test('bots persist across a store reload', async () => {
  const dir = tmpDir();
  try {
    const first = new Store(dir, { unsafeDisableLock: true });
    await first.load();
    const { record } = await importBot(first, USER_A, 'bot.xml', VALID_DBOT);
    await first.close();

    const second = new Store(dir, { unsafeDisableLock: true });
    await second.load();
    const reloaded = second.getImportedBot(USER_A, record.id);
    assert.ok(reloaded, 'the bot survives a process restart');
    assert.equal(reloaded!.name, record.name);
    await second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
