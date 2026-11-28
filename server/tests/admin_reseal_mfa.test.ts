import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import { resealMfaSecret } from '../admin/reseal_mfa.js';
import { open } from '../lib/crypto.js';
import { hashPassword } from '../admin/passwords.js';
import { generateTotpSecret } from '../admin/totp.js';
import { seal } from '../lib/crypto.js';
import { createOpaqueId } from '../lib/pkce.js';
import type { AdminUserRecord } from '../admin/types.js';

/**
 * `admin:reseal-mfa` tests.
 *
 * The bug it repairs: an MFA secret is sealed with SESSION_SECRET when the
 * account is created, so changing that secret later leaves existing rows
 * undecryptable and sign-in stops at "cannot start MFA enrolment". Changing the
 * environment variable alone cannot fix it — only rewriting the row can.
 */

const OLD_SECRET = 'old_secret_key_32_characters_long_0000';
const NEW_SECRET = 'new_secret_key_32_characters_long_0000';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-reseal-'));
}

async function seed(store: Store, email: string): Promise<AdminUserRecord> {
  const now = Date.now();
  const admin: AdminUserRecord = {
    id: `adm_${createOpaqueId(12)}`,
    email,
    displayName: 'Reseal Test',
    passwordHash: await hashPassword('Str0ng-Passw0rd!2026'),
    role: 'SUPER_ADMIN',
    extraPermissions: [],
    status: 'active',
    mfa: { enrolled: false, secretSealed: seal(generateTotpSecret(), OLD_SECRET), enrolledAt: null, recoveryCodeHashes: [] },
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    createdBy: null
  };
  await store.upsertAdmin(admin);
  return admin;
}

test('a secret sealed under the wrong key is unreadable, which is what blocks enrolment', async () => {
  const store = new Store(tmpDir(), {});
  await store.load();
  const admin = await seed(store, 'reseal@example.com');

  assert.equal(open(admin.mfa.secretSealed!, NEW_SECRET), null);
  assert.ok(open(admin.mfa.secretSealed!, OLD_SECRET));
  await store.close();
});

test('re-sealing makes the secret readable with the current key', async () => {
  const dir = tmpDir();
  const first = new Store(dir, {});
  await first.load();
  await seed(first, 'reseal@example.com');
  const before = first.getAdminByEmail('reseal@example.com')!.mfa.secretSealed;

  const target = first.getAdminByEmail('reseal@example.com')!;
  const secret = await resealMfaSecret(first, target, NEW_SECRET);
  await first.close();

  const after = new Store(dir, {});
  await after.load();
  const repaired = after.getAdminByEmail('reseal@example.com')!;
  assert.notEqual(repaired.mfa.secretSealed, before, 'ciphertext must change');
  assert.equal(open(repaired.mfa.secretSealed!, NEW_SECRET), secret, 'new key must open the re-sealed secret');
  assert.equal(repaired.mfa.enrolled, false, 'account must be sent back to enrolment');
  await after.close();
});

test('re-sealing preserves password, role and status', async () => {
  const store = new Store(tmpDir(), {});
  await store.load();
  const seeded = await seed(store, 'keep@example.com');

  const secret = await resealMfaSecret(store, store.getAdminByEmail('keep@example.com')!, NEW_SECRET);
  const reloaded = store.getAdminByEmail('keep@example.com')!;

  assert.equal(reloaded.passwordHash, seeded.passwordHash);
  assert.equal(reloaded.role, 'SUPER_ADMIN');
  assert.equal(reloaded.status, 'active');
  assert.equal(open(reloaded.mfa.secretSealed!, NEW_SECRET), secret);
  await store.close();
});

test('re-sealing revokes pending MFA sessions so the old secret cannot be reused', async () => {
  const store = new Store(tmpDir(), {});
  await store.load();
  const seeded = await seed(store, 'sessions@example.com');

  const now = Date.now();
  await store.createAdminSession({
    id: 'sess_pending_1',
    adminId: seeded.id,
    createdAt: now,
    expiresAt: now + 600_000,
    lastSeenAt: now,
    revoked: false,
    mfaPending: true,
    csrfToken: 'csrf',
    ip: null,
    userAgent: null
  });

  await resealMfaSecret(store, store.getAdminByEmail('sessions@example.com')!, NEW_SECRET);

  assert.equal(store.getAdminSession('sess_pending_1')!.revoked, true);
  await store.close();
});
