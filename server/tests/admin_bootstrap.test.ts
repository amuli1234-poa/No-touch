import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { Store, resolveBackend, storeOptionsFromConfig } from '../store/store.js';
import { JsonBackend } from '../store/json_backend.js';
import { SqliteBackend } from '../store/sqlite_backend.js';
import { PostgresBackend } from '../store/postgres_backend.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../admin/passwords.js';
import { generateTotpSecret, currentTotp, verifyTotp, totpUri, generateRecoveryCodes, hashCode } from '../admin/totp.js';
import { seal, open } from '../lib/crypto.js';
import { writeAudit } from '../services/admin/audit.js';
import type { AdminUserRecord } from '../admin/types.js';
import type { StorageBackend } from '../store/backend.js';

/**
 * Bootstrap storage-selection and admin-credential tests.
 *
 * The defect these lock down: `admin:bootstrap` opened the store with no engine
 * options, so it always resolved to JSON or SQLite while the server ran on
 * PostgreSQL. The account was written somewhere the server never read.
 *
 * These tests exercise the real `resolveBackend`, the real crypto and the real
 * store. No PostgreSQL server is available in this environment, so the tests
 * that need a live database are limited to asserting the backend is *selected*
 * correctly and that a failure is loud — they do not round-trip rows.
 */

const SESSION_SECRET = 'test_session_secret_at_least_32_characters_long_000';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bootstrap-'));
}

function makeAdmin(overrides: Partial<AdminUserRecord> = {}): AdminUserRecord {
  const now = Date.now();
  return {
    id: `adm_${Math.random().toString(36).slice(2, 14)}`,
    email: `admin-${Math.random().toString(36).slice(2, 8)}@example.com`,
    displayName: 'Test Admin',
    passwordHash: 'scrypt$16384$8$1$c2FsdA$aGFzaA',
    role: 'SUPER_ADMIN',
    extraPermissions: [],
    status: 'active',
    mfa: { enrolled: false, secretSealed: null, enrolledAt: null, recoveryCodeHashes: [] },
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    createdBy: null,
    ...overrides
  };
}

/* ------------------------- backend selection ------------------------- */

test('storeOptionsFromConfig forwards engine, connection string and ssl', () => {
  const opts = storeOptionsFromConfig({
    storageEngine: 'postgres',
    database: { url: 'postgresql://user:pass@host:5432/db', ssl: true }
  });
  assert.equal(opts.engine, 'postgres');
  assert.equal(opts.connectionString, 'postgresql://user:pass@host:5432/db');
  assert.equal(opts.ssl, true);
});

test('storeOptionsFromConfig tolerates a missing database block', () => {
  const opts = storeOptionsFromConfig({ storageEngine: 'json' });
  assert.equal(opts.engine, 'json');
  assert.equal(opts.connectionString, undefined);
  assert.equal(opts.ssl, undefined);
});

test('production-shaped config selects the PostgreSQL backend, not JSON or SQLite', () => {
  // This is the regression: the old bootstrap passed no options, so this call
  // resolved to json. It must now resolve to postgres.
  const dir = tmpDir();
  const opts = storeOptionsFromConfig({
    storageEngine: 'postgres',
    database: { url: 'postgresql://user:pass@host:5432/db', ssl: true }
  });
  const backend = resolveBackend(dir, opts);
  assert.equal(backend.kind, 'postgres');
  assert.ok(backend instanceof PostgresBackend);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bare data directory (old bootstrap behaviour) does NOT select postgres', () => {
  // Documents the defect explicitly: with no options, resolveBackend picks a
  // filesystem backend even when DATABASE_URL is set. Guard against a future
  // change that "fixes" this by making `auto` prefer postgres silently.
  const dir = tmpDir();
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db';
  try {
    assert.equal(resolveBackend(dir, {}).kind, 'json');
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('postgres engine without DATABASE_URL throws instead of falling back', () => {
  const dir = tmpDir();
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => resolveBackend(dir, { engine: 'postgres' }), /DATABASE_URL is required/);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit json and sqlite engines are still honoured', () => {
  const dir = tmpDir();
  assert.ok(resolveBackend(dir, { engine: 'json' }) instanceof JsonBackend);
  assert.ok(resolveBackend(dir, { engine: 'sqlite' }) instanceof SqliteBackend);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreachable PostgreSQL fails loudly rather than silently using files', async () => {
  // Port 1 is not listening; opening must reject, never degrade to JSON.
  const backend = new PostgresBackend('postgresql://user:pass@127.0.0.1:1/none', false);
  await assert.rejects(() => backend.open(), (err: unknown) => err instanceof Error);
  await backend.close().catch(() => undefined);
});

/* ----------------------- admin storage round-trip --------------------- */

async function withJsonStore(fn: (store: Store) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const store = new Store(dir, { engine: 'json' });
  await store.load();
  try {
    await fn(store);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an admin written through the store is readable by email and by id', async () => {
  await withJsonStore(async (store) => {
    const admin = makeAdmin({ email: 'boss@example.com' });
    await store.upsertAdmin(admin);

    const byEmail = store.getAdminByEmail('boss@example.com');
    assert.ok(byEmail, 'expected the admin to be found by email');
    assert.equal(byEmail.id, admin.id);
    assert.equal(store.getAdminById(admin.id)?.email, 'boss@example.com');
  });
});

test('the active Super Admin guard sees a newly created admin', async () => {
  await withJsonStore(async (store) => {
    assert.equal(store.countActiveSuperAdmins(), 0);
    await store.upsertAdmin(makeAdmin());
    assert.equal(store.countActiveSuperAdmins(), 1);
  });
});

test('a suspended or non-super admin does not satisfy the duplicate guard', async () => {
  await withJsonStore(async (store) => {
    await store.upsertAdmin(makeAdmin({ role: 'SUPPORT', status: 'active' }));
    await store.upsertAdmin(makeAdmin({ role: 'SUPER_ADMIN', status: 'suspended' }));
    assert.equal(store.countActiveSuperAdmins(), 0);
  });
});

test('admin records survive a store reopen (durability across processes)', async () => {
  const dir = tmpDir();
  const first = new Store(dir, { engine: 'json' });
  await first.load();
  const admin = makeAdmin({ email: 'persist@example.com' });
  await first.upsertAdmin(admin);
  await first.close();

  const second = new Store(dir, { engine: 'json' });
  await second.load();
  try {
    assert.equal(second.getAdminByEmail('persist@example.com')?.id, admin.id);
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------- credential handling ----------------------- */

test('password is hashed with scrypt and verifies without storing plaintext', async () => {
  const password = 'Correct-Horse-Battery-Staple-9';
  const encoded = await hashPassword(password);
  assert.match(encoded, /^scrypt\$/);
  assert.ok(!encoded.includes(password), 'hash must not embed the plaintext');
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword('wrong-password', encoded), false);
});

test('weak passwords are rejected by the strength check', () => {
  assert.equal(validatePasswordStrength('short').ok, false);
  assert.equal(validatePasswordStrength('alllowercaseletters').ok, false);
  assert.equal(validatePasswordStrength('Str0ng-Enough-Passphrase!').ok, true);
});

test('TOTP secret is sealed with AES-256-GCM and never stored in the clear', () => {
  const secret = generateTotpSecret();
  const sealed = seal(secret, SESSION_SECRET);
  assert.ok(!sealed.includes(secret), 'sealed value must not contain the secret');
  assert.equal(open(sealed, SESSION_SECRET), secret);

  // A different key must not decrypt it.
  assert.equal(open(sealed, 'a_completely_different_secret_32_chars_min_'), null);
});

test('a sealed TOTP secret round-trips into a working code', () => {
  const secret = generateTotpSecret();
  const restored = open(seal(secret, SESSION_SECRET), SESSION_SECRET);
  assert.ok(restored);
  const code = currentTotp(restored);
  assert.equal(verifyTotp(restored, code), true);
  assert.equal(verifyTotp(restored, '000000'), code === '000000');
});

test('TOTP URI is well formed and does not leak the session secret', () => {
  const secret = generateTotpSecret();
  const uri = totpUri(secret, 'boss@example.com');
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.ok(uri.includes('boss%40example.com') || uri.includes('boss@example.com'));
  assert.ok(!uri.includes(SESSION_SECRET));
});

test('recovery codes are unique and stored only as hashes', () => {
  const codes = generateRecoveryCodes(8);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8, 'codes must be unique');

  const hashes = codes.map(hashCode);
  assert.equal(new Set(hashes).size, 8);
  for (const hash of hashes) {
    assert.ok(!codes.includes(hash), 'a hash must not equal its code');
  }
  // Hashing is deterministic, so a presented code can be matched later.
  assert.equal(hashCode(codes[0]), hashes[0]);
});

/* ----------------------------- audit trail ---------------------------- */

test('bootstrap writes an audit record naming the actor and action', async () => {
  await withJsonStore(async (store) => {
    const admin = makeAdmin({ email: 'audited@example.com' });
    await store.upsertAdmin(admin);
    await writeAudit(store, {
      actorAdminId: admin.id,
      actorEmail: admin.email,
      action: 'admin.bootstrap.created',
      targetType: 'admin',
      targetId: admin.id,
      newState: { email: admin.email, role: 'SUPER_ADMIN' },
      reason: 'Initial Super Admin provisioned via bootstrap command'
    });

    const logs = store.listAudit();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].action, 'admin.bootstrap.created');
    assert.equal(logs[0].actorAdminId, admin.id);
    assert.equal(logs[0].targetId, admin.id);
  });
});

test('audit records persist across a reopen', async () => {
  const dir = tmpDir();
  const first = new Store(dir, { engine: 'json' });
  await first.load();
  await writeAudit(first, { actorAdminId: null, actorEmail: 'x@example.com', action: 'test.event' });
  await first.close();

  const second = new Store(dir, { engine: 'json' });
  await second.load();
  try {
    assert.equal(second.listAudit().some((r) => r.action === 'test.event'), true);
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------- connection cleanup ------------------------ */

test('store.close() releases the backend and can be called after a load failure', async () => {
  const dir = tmpDir();
  const store = new Store(dir, { engine: 'json' });
  await store.load();
  await store.close();
  // A second close must not throw: the bootstrap finally-block always runs it.
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a store whose backend fails to open can still be closed safely', async () => {
  const dir = tmpDir();
  const failing: StorageBackend = {
    kind: 'json',
    open: async () => {
      throw new Error('simulated open failure');
    },
    close: async () => undefined,
    loadKeyed: async () => ({}),
    loadAppend: async () => [],
    putKeyed: async () => undefined,
    deleteKeyed: async () => undefined,
    appendRecord: async () => undefined,
    deleteAppendBefore: async () => undefined,
    loadSingleton: async () => null,
    putSingleton: async () => undefined,
    transaction: async (fn) => fn(),
    counts: async () => ({})
  };
  const store = new Store(dir, { backend: failing });
  await assert.rejects(() => store.load(), /simulated open failure/);
  await assert.doesNotReject(() => store.close());
  fs.rmSync(dir, { recursive: true, force: true });
});

/* --------------------- end-to-end bootstrap CLI ----------------------- */

/**
 * Drives the real `server/admin/bootstrap.ts` as a child process against a
 * throwaway data directory. This is the closest possible check to the
 * production invocation without a database server: it proves the CLI picks the
 * configured engine, writes the account, seals the TOTP secret, records the
 * audit event, refuses a duplicate, and exits without hanging on a pool.
 */
function runBootstrap(env: Record<string, string>): { status: number | null; out: string; ms: number } {
  const started = Date.now();
  try {
    const out = execFileSync('npx', ['tsx', 'server/admin/bootstrap.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000
    });
    return { status: 0, out, ms: Date.now() - started };
  } catch (err: any) {
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, ms: Date.now() - started };
  }
}

test('bootstrap CLI creates one admin, then refuses a second', async () => {
  const dir = tmpDir();
  const env = {
    DATA_DIR: dir,
    STORAGE_ENGINE: 'json',
    NODE_ENV: 'development',
    SESSION_SECRET,
    ADMIN_EMAIL: 'cli-admin@example.com',
    ADMIN_NAME: 'CLI Admin',
    ADMIN_PASSWORD: 'Str0ng-CLI-Passphrase!42'
  };

  const first = runBootstrap(env);
  assert.equal(first.status, 0, `expected success, got:\n${first.out}`);
  assert.match(first.out, /Storage engine: json/);
  assert.match(first.out, /Super Admin created/);
  assert.match(first.out, /otpauth:\/\/totp\//);
  // The CLI must terminate on its own once the store is closed.
  assert.ok(first.ms < 120000, 'bootstrap must not hang waiting for the pool to idle');

  // The account must exist in the store the CLI wrote to.
  const store = new Store(dir, { engine: 'json' });
  await store.load();
  try {
    const admin = store.getAdminByEmail('cli-admin@example.com');
    assert.ok(admin, 'expected the CLI to have written the admin');
    assert.equal(admin.role, 'SUPER_ADMIN');
    assert.equal(admin.status, 'active');
    assert.equal(await verifyPassword('Str0ng-CLI-Passphrase!42', admin.passwordHash), true);

    // MFA secret is sealed, not plaintext, and decrypts to a usable secret.
    assert.ok(admin.mfa.secretSealed, 'expected a sealed TOTP secret');
    const secret = open(admin.mfa.secretSealed!, SESSION_SECRET);
    assert.ok(secret, 'sealed secret must open with the configured session secret');
    assert.equal(verifyTotp(secret!, currentTotp(secret!)), true);

    // Audit trail written in the same store.
    const audit = store.listAudit().find((r) => r.action === 'admin.bootstrap.created');
    assert.ok(audit, 'expected an audit record for the bootstrap');
    assert.equal(audit!.targetId, admin.id);
  } finally {
    await store.close();
  }

  const second = runBootstrap(env);
  assert.notEqual(second.status, 0, 'second run must fail');
  assert.match(second.out, /already exists/i);

  // Still exactly one admin.
  const check = new Store(dir, { engine: 'json' });
  await check.load();
  try {
    assert.equal(check.listAdmins().length, 1);
  } finally {
    await check.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap CLI fails loudly when postgres is configured without a URL', () => {
  const dir = tmpDir();
  const result = runBootstrap({
    DATA_DIR: dir,
    STORAGE_ENGINE: 'postgres',
    DATABASE_URL: '',
    NODE_ENV: 'development',
    ADMIN_EMAIL: 'never@example.com',
    ADMIN_NAME: 'Never',
    ADMIN_PASSWORD: 'Str0ng-CLI-Passphrase!42'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.out, /DATABASE_URL|postgres/i);
  // Must not have quietly written a JSON file as a fallback.
  assert.equal(fs.existsSync(path.join(dir, 'wicksentinel.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
