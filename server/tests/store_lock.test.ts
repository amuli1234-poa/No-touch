import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { Store } from '../store/store.js';
import { StoreConflictError, StoreLockedError } from '../store/errors.js';
import { StoreLock } from '../store/lock.js';
import { SqliteBackend } from '../store/sqlite_backend.js';

/**
 * Phase 0A: cross-process data-protection tests.
 *
 * These cover the corruption that was reproduced against the live server: two
 * processes holding the same data directory, the second silently overwriting
 * the first's records. Both defences are exercised here — the exclusive lock,
 * and the foreign-write detection in `persist()`.
 */

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-store-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Phase 0A: data-directory lock', () => {
  it('refuses a second writer on the same data directory', async () => {
    const dir = tmpDir();
    const first = new Store(dir);
    await first.load();

    const second = new Store(dir);
    await assert.rejects(
      () => second.load(),
      (err: unknown) => {
        assert.ok(err instanceof StoreLockedError, `expected StoreLockedError, got ${err}`);
        assert.equal(err.code, 'STORE_LOCKED');
        // The message must name the holder so an operator can act on it.
        assert.match(err.message, /locked by another process/i);
        assert.equal(err.holder?.pid, process.pid);
        return true;
      }
    );

    await first.close();
  });

  it('releases the lock on close so the next process can take it', async () => {
    const dir = tmpDir();
    const first = new Store(dir);
    await first.load();
    await first.close();

    const second = new Store(dir);
    await second.load(); // Must not throw.
    await second.close();
  });

  it('reclaims a lock left behind by a dead process', async () => {
    const dir = tmpDir();
    // Simulate a crashed holder: a lock whose PID no longer exists. PID 2^22 is
    // above the default pid_max on Linux, so ESRCH is effectively guaranteed.
    await fsp.writeFile(
      path.join(dir, 'wicksentinel.lock'),
      JSON.stringify({ pid: 4194304, hostname: os.hostname(), startedAt: Date.now() - 60_000 }),
      'utf8'
    );

    const store = new Store(dir);
    await store.load(); // Reclaims the stale lock rather than wedging.
    await store.close();
  });

  it('never steals a lock held by a live process', async () => {
    const dir = tmpDir();
    const lock = new StoreLock(dir);
    await lock.acquire();

    // A second acquisition attempt in-process must fail; the holder is alive.
    const other = new StoreLock(dir);
    await assert.rejects(() => other.acquire(), StoreLockedError);

    await lock.release();
  });
});

describe('Phase 0A: foreign-write detection', () => {
  it('refuses to overwrite records written by another process', async () => {
    const dir = tmpDir();
    const store = new Store(dir);
    await store.load();

    // Commit an initial record so the file exists and mtime is tracked.
    await store.upsertUser({
      id: 'user-a',
      derivSub: 'sub-a',
      accounts: [],
      createdAt: 1,
      updatedAt: 1,
      preferences: {}
    });

    // Simulate the clobbering scenario: an external process rewrites the file.
    // The in-memory snapshot no longer reflects disk, so persisting it would
    // silently destroy whatever the other writer stored.
    await sleep(5);
    const foreign = { ...JSON.parse(await fsp.readFile(path.join(dir, 'wicksentinel.json'), 'utf8')), users: { 'user-b': { id: 'user-b' } } };
    await fsp.writeFile(path.join(dir, 'wicksentinel.json'), JSON.stringify(foreign, null, 2), 'utf8');

    await assert.rejects(
      () =>
        store.upsertUser({
          id: 'user-c',
          derivSub: 'sub-c',
          accounts: [],
          createdAt: 2,
          updatedAt: 2,
          preferences: {}
        }),
      (err: unknown) => {
        assert.ok(err instanceof StoreConflictError, `expected StoreConflictError, got ${err}`);
        assert.equal(err.code, 'STORE_CONFLICT');
        return true;
      }
    );

    // The foreign records must be intact — the whole point of refusing.
    const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'wicksentinel.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk.users), ['user-b']);

    await store.close();
  });

  it('stays poisoned after a conflict so no later write slips through', async () => {
    const dir = tmpDir();
    const store = new Store(dir);
    await store.load();
    await store.upsertUser({ id: 'a', derivSub: 'a', accounts: [], createdAt: 1, updatedAt: 1, preferences: {} });

    await sleep(5);
    await fsp.writeFile(path.join(dir, 'wicksentinel.json'), '{"users":{"x":{}}}', 'utf8');

    await assert.rejects(() => store.upsertUser({ id: 'b', derivSub: 'b', accounts: [], createdAt: 2, updatedAt: 2, preferences: {} }), StoreConflictError);
    // A subsequent, unrelated write must also fail — the store cannot recover
    // by simply writing the next snapshot.
    await assert.rejects(
      () => store.setPlatformConfig({ maintenanceMode: true, registrationOpen: false, supportEmail: null, updatedBy: 'test', updatedAt: 3 }),
      StoreConflictError
    );

    await store.close();
  });

  it('allows normal writes when this process owns the file', async () => {
    const dir = tmpDir();
    const store = new Store(dir);
    await store.load();
    for (let i = 0; i < 5; i++) {
      await store.upsertUser({ id: `u${i}`, derivSub: `s${i}`, accounts: [], createdAt: i, updatedAt: i, preferences: {} });
    }
    assert.equal(store.listUsers().length, 5);
    await store.close();
  });
});

describe('Phase 0B: the lock protects the SQLite engine too', () => {
  it('refuses a second SQLite writer on the same data directory', async () => {
    const dir = tmpDir();
    const first = new SqliteBackend(dir);
    await first.open();

    const second = new SqliteBackend(dir);
    await assert.rejects(() => second.open(), StoreLockedError);

    await first.close();
  });

  it('releases the lock on close so the next process can open it', async () => {
    const dir = tmpDir();
    const first = new SqliteBackend(dir);
    await first.open();
    await first.close();

    const second = new SqliteBackend(dir);
    await second.open();
    await second.close();
  });

  it('rejects a second writer regardless of which engine holds the lock', async () => {
    const dir = tmpDir();
    // A JSON store holding the lock must block a SQLite backend, since both
    // write to the same data directory.
    const jsonStore = new Store(dir, { engine: 'json' });
    await jsonStore.load();

    const sqlite = new SqliteBackend(dir);
    await assert.rejects(() => sqlite.open(), StoreLockedError);

    await jsonStore.close();
  });
});
