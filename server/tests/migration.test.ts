import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { JsonBackend } from '../store/json_backend.js';
import { SqliteBackend } from '../store/sqlite_backend.js';
import { StoreLock } from '../store/lock.js';
import { COLLECTION_SPECS } from '../store/backend.js';
import { Store } from '../store/store.js';
import type { StoredRecord } from '../store/backend.js';

/**
 * Phase 0B: JSON -> SQLite migration safety.
 *
 * These tests exercise the migration's guarantees directly rather than through
 * the CLI, so a failure names the broken invariant:
 *   - every record survives, with its identity and relationships intact;
 *   - the original JSON file is never modified or deleted;
 *   - a failure mid-migration leaves no partial database;
 *   - the store runs on SQLite and reads back what was migrated.
 */

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-migrate-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A representative JSON database covering keyed, append and singleton data. */
function seedJson(dir: string): Record<string, unknown> {
  const now = Date.now();
  const data: Record<string, unknown> = {
    users: {
      u1: { id: 'u1', derivSub: 'sub-1', accounts: [{ accountId: 'CR1', type: 'demo' }], createdAt: 1, updatedAt: 1, preferences: { defaultTimeframe: '5m' } },
      u2: { id: 'u2', derivSub: 'sub-2', accounts: [{ accountId: 'CR2', type: 'real' }], createdAt: 2, updatedAt: 2, preferences: {} }
    },
    sessions: {
      s1: { id: 's1', userId: 'u1', createdAt: 1, expiresAt: now + 1e7, lastSeenAt: 1, revoked: false, derivTokenSealed: 'sealed', derivTokenExpiresAt: now + 1e6, derivSub: 'sub-1' }
    },
    oauthTransactions: {
      st1: { state: 'st1', codeVerifier: 'v', redirectUri: 'r', mode: 'login', createdAt: now, consumedAt: null }
    },
    adminUsers: {
      a1: { id: 'a1', email: 'admin@test.local', displayName: 'Admin', passwordHash: 'scrypt$x', role: 'SUPER_ADMIN', extraPermissions: [], status: 'active', mfa: { enrolled: true, secretSealed: 's', enrolledAt: 1, recoveryCodeHashes: [] }, createdAt: 1, updatedAt: 1, lastLoginAt: null, createdBy: null }
    },
    adminSessions: {
      as1: { id: 'as1', adminId: 'a1', createdAt: 1, expiresAt: now + 1e7, lastSeenAt: 1, revoked: false, mfaPending: false, csrfToken: 'c', ip: null, userAgent: null }
    },
    adminInvitations: { i1: { id: 'i1', email: 'x@y.z', role: 'ANALYST', extraPermissions: [], tokenHash: 'h', invitedBy: 'a1', createdAt: 1, expiresAt: now + 1e7, consumedAt: null } },
    adminPasswordResets: { p1: { id: 'p1', adminId: 'a1', tokenHash: 'ph', createdAt: 1, expiresAt: now + 1e7, consumedAt: null } },
    auditLogs: [
      { id: 'l1', timestamp: 1, actorAdminId: 'a1', actorEmail: 'admin@test.local', action: 'a.one', targetType: null, targetId: null, previousState: null, newState: null, reason: null, correlationId: 'c1', sourceIp: null, metadata: {} },
      { id: 'l2', timestamp: 2, actorAdminId: 'a1', actorEmail: 'admin@test.local', action: 'a.two', targetType: null, targetId: null, previousState: null, newState: null, reason: null, correlationId: 'c2', sourceIp: null, metadata: { k: 'v' } }
    ],
    supportTickets: { t1: { id: 't1', subject: 'S', description: 'D', priority: 'normal', status: 'open', userId: 'u1', requesterRef: null, assignedAdminId: null, createdAt: 1, updatedAt: 1, createdByAdminId: null } },
    supportTicketMessages: { m1: { id: 'm1', ticketId: 't1', internal: false, body: 'hello', authorAdminId: null, authorKind: 'user', createdAt: 1 } },
    announcements: { an1: { id: 'an1', title: 'T', body: 'B', kind: 'platform', audience: 'all', status: 'published', publishAt: null, publishedAt: 1, publishedBy: 'a1', createdBy: 'a1', createdAt: 1, updatedAt: 1 } },
    featureFlags: { ff1: { key: 'ff1', label: 'L', description: 'D', enabled: true, updatedBy: 'a1', updatedAt: 1 } },
    adminNotes: { n1: { id: 'n1', userId: 'u1', body: 'note', authorAdminId: 'a1', createdAt: 1 } },
    platformConfig: { maintenanceMode: false, registrationOpen: true, supportEmail: 'help@test.local', updatedBy: 'a1', updatedAt: 1 }
  };
  fs.writeFileSync(path.join(dir, 'wicksentinel.json'), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/** Runs the same migration steps the CLI runs, without the process.exit calls. */
async function migrate(dir: string): Promise<{ json: JsonBackend; sqlite: SqliteBackend; lock: StoreLock }> {
  const lock = new StoreLock(dir);
  await lock.acquire();
  const json = new JsonBackend(dir, { lock });
  const sqlite = new SqliteBackend(dir, { lock });
  await json.open();
  await sqlite.open();
  await sqlite.transaction(async () => {
    for (const spec of COLLECTION_SPECS) {
      if (spec.kind === 'append') {
        for (const row of await json.loadAppend(spec.name)) await sqlite.appendRecord(spec.name, row);
      } else {
        for (const [key, record] of Object.entries(await json.loadKeyed(spec.name))) {
          await sqlite.putKeyed(spec.name, key, record);
        }
      }
    }
    const cfg = await json.loadSingleton('platformConfig');
    if (cfg) await sqlite.putSingleton('platformConfig', cfg);
  });
  return { json, sqlite, lock };
}

describe('Phase 0B: migration preserves data', () => {
  it('copies every record of every collection, verified by count', async () => {
    const dir = tmpDir();
    const source = seedJson(dir);
    const { json, sqlite, lock } = await migrate(dir);

    try {
      for (const spec of COLLECTION_SPECS) {
        const expected =
          spec.kind === 'append'
            ? ((source[spec.name] as unknown[]) ?? []).length
            : Object.keys((source[spec.name] as object) ?? {}).length;
        const actual =
          spec.kind === 'append'
            ? (await sqlite.loadAppend(spec.name)).length
            : Object.keys(await sqlite.loadKeyed(spec.name)).length;
        assert.equal(actual, expected, `${spec.name}: expected ${expected}, got ${actual}`);
      }
      assert.ok(await sqlite.loadSingleton('platformConfig'), 'platformConfig singleton must migrate');
    } finally {
      await sqlite.close();
      await json.close();
      await lock.release();
    }
  });

  it('preserves record contents byte-for-byte, not just counts', async () => {
    const dir = tmpDir();
    const source = seedJson(dir);
    const { json, sqlite, lock } = await migrate(dir);

    try {
      // Users carry nested arrays/objects; a lossy migration would show here.
      const users = await sqlite.loadKeyed('users');
      assert.deepEqual(users.u1, (source.users as Record<string, StoredRecord>).u1);
      assert.deepEqual(users.u2, (source.users as Record<string, StoredRecord>).u2);

      // Append-only ordering must survive: audit order is meaningful.
      const audit = await sqlite.loadAppend('auditLogs');
      assert.deepEqual(audit.map((r) => (r as { id: string }).id), ['l1', 'l2']);

      const cfg = await sqlite.loadSingleton('platformConfig');
      assert.deepEqual(cfg, source.platformConfig);
    } finally {
      await sqlite.close();
      await json.close();
      await lock.release();
    }
  });

  it('keeps relationships intact (no orphaned sessions/messages/admin sessions)', async () => {
    const dir = tmpDir();
    seedJson(dir);
    const { json, sqlite, lock } = await migrate(dir);

    try {
      const users = new Set(Object.keys(await sqlite.loadKeyed('users')));
      const tickets = new Set(Object.keys(await sqlite.loadKeyed('supportTickets')));
      const admins = new Set(Object.keys(await sqlite.loadKeyed('adminUsers')));

      for (const s of Object.values(await sqlite.loadKeyed('sessions'))) {
        assert.ok(users.has((s as { userId: string }).userId), 'session must reference a real user');
      }
      for (const m of Object.values(await sqlite.loadKeyed('supportTicketMessages'))) {
        assert.ok(tickets.has((m as { ticketId: string }).ticketId), 'message must reference a real ticket');
      }
      for (const s of Object.values(await sqlite.loadKeyed('adminSessions'))) {
        assert.ok(admins.has((s as { adminId: string }).adminId), 'admin session must reference a real admin');
      }
    } finally {
      await sqlite.close();
      await json.close();
      await lock.release();
    }
  });

  it('never modifies or deletes the original JSON file', async () => {
    const dir = tmpDir();
    seedJson(dir);
    const jsonPath = path.join(dir, 'wicksentinel.json');
    const before = fs.readFileSync(jsonPath, 'utf8');
    const beforeStat = fs.statSync(jsonPath);

    const { json, sqlite, lock } = await migrate(dir);
    await sqlite.close();
    await json.close();
    await lock.release();

    const after = fs.readFileSync(jsonPath, 'utf8');
    assert.equal(after, before, 'JSON content must be unchanged');
    assert.equal(fs.statSync(jsonPath).size, beforeStat.size, 'JSON size must be unchanged');
  });

  it('reports a passing SQLite integrity_check', async () => {
    const dir = tmpDir();
    seedJson(dir);
    const { json, sqlite, lock } = await migrate(dir);
    try {
      assert.equal(sqlite.integrityCheck(), 'ok');
    } finally {
      await sqlite.close();
      await json.close();
      await lock.release();
    }
  });

  it('rolls back every write if the migration fails part-way', async () => {
    const dir = tmpDir();
    seedJson(dir);
    const lock = new StoreLock(dir);
    await lock.acquire();
    const json = new JsonBackend(dir, { lock });
    const sqlite = new SqliteBackend(dir, { lock });
    await json.open();
    await sqlite.open();

    try {
      await assert.rejects(
        () =>
          sqlite.transaction(async () => {
            await sqlite.putKeyed('users', 'u1', { id: 'u1' });
            await sqlite.putKeyed('users', 'u2', { id: 'u2' });
            throw new Error('simulated failure mid-migration');
          }),
        /simulated failure/
      );

      // Nothing from the aborted transaction may remain.
      const users = await sqlite.loadKeyed('users');
      assert.equal(Object.keys(users).length, 0, 'aborted transaction must leave no records');
      assert.equal(sqlite.integrityCheck(), 'ok');
    } finally {
      await sqlite.close();
      await json.close();
      await lock.release();
    }
  });
});

describe('Phase 0B: store runs on SQLite', () => {
  it('reads back migrated data through the real Store API', async () => {
    const dir = tmpDir();
    seedJson(dir);
    const { json, sqlite, lock } = await migrate(dir);
    await sqlite.close();
    await json.close();
    await lock.release();

    // `auto` must now pick SQLite because the database file exists.
    const store = new Store(dir);
    await store.load();
    try {
      assert.equal(store.storage.kind, 'sqlite');
      assert.equal(store.countUsers(), 2);
      assert.equal(store.getUserById('u1')?.derivSub, 'sub-1');
      assert.equal(store.getUserByDerivSub('sub-2')?.id, 'u2');
      assert.equal(store.listAudit().length, 2);
      assert.equal(store.getPlatformConfig().supportEmail, 'help@test.local');
      assert.ok(store.getAdminByEmail('admin@test.local'));
    } finally {
      await store.close();
    }
  });

  it('still selects JSON when no database file exists', async () => {
    const dir = tmpDir();
    seedJson(dir);
    const store = new Store(dir);
    await store.load();
    try {
      assert.equal(store.storage.kind, 'json');
      assert.equal(store.countUsers(), 2);
    } finally {
      await store.close();
    }
  });
});
