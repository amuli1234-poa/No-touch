import 'dotenv/config';
import readline from 'node:readline';
import { loadConfig, type ServerConfig } from '../config.js';
import { Store, storeOptionsFromConfig } from '../store/store.js';
import { hashPassword, validatePasswordStrength } from './passwords.js';
import { generateTotpSecret, totpUri, currentTotp } from './totp.js';
import { seal } from '../lib/crypto.js';
import { createOpaqueId } from '../lib/pkce.js';
import { randomUUID } from 'node:crypto';
import { redact } from '../services/admin/audit.js';
import type { AdminUserRecord } from './types.js';

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      const stdin = process.stdin;
      const onData = (char: Buffer) => {
        const s = char.toString();
        if (s === '\n' || s === '\r' || s === '\u0004') {
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
        } else {
          process.stdout.clearLine?.(0);
          process.stdout.cursorTo?.(0);
          process.stdout.write(question + '*'.repeat(rl.line.length));
        }
      };
      process.stdout.write(question);
      stdin.on('data', onData);
      rl.once('line', (answer) => { rl.close(); resolve(answer); });
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    }
  });
}

async function run(store: Store, cfg: ServerConfig): Promise<void> {
  if (store.countActiveSuperAdmins() === 0) {
    console.error('[add-super] No active Super Admin exists. Use admin:bootstrap first.');
    process.exitCode = 1;
    return;
  }

  const email = (process.env.ADMIN_EMAIL ?? (await ask('New Super Admin email: '))).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('[add-super] Invalid email address.');
    process.exitCode = 1;
    return;
  }
  if (store.getAdminByEmail(email)) {
    console.error('[add-super] An administrator with that email already exists.');
    process.exitCode = 1;
    return;
  }

  const displayName = (process.env.ADMIN_NAME ?? (await ask('Display name: '))).trim() || email.split('@')[0];
  let password = process.env.ADMIN_PASSWORD ?? '';
  if (!password) password = await ask('Password (hidden): ', true);
  const strength = validatePasswordStrength(password);
  if (!strength.ok) {
    console.error(`[add-super] Weak password: ${strength.reason}`);
    process.exitCode = 1;
    return;
  }

  const secret = generateTotpSecret();
  const now = Date.now();
  const admin: AdminUserRecord = {
    id: `adm_${createOpaqueId(12)}`,
    email,
    displayName,
    passwordHash: await hashPassword(password),
    role: 'SUPER_ADMIN',
    extraPermissions: [],
    status: 'active',
    mfa: { enrolled: false, secretSealed: seal(secret, cfg.session.secret), enrolledAt: null, recoveryCodeHashes: [] },
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    createdBy: null
  };

  const audit: import('../admin/types.js').AuditRecord = {
    id: `aud_${randomUUID()}`,
    timestamp: now,
    actorAdminId: admin.id,
    actorEmail: admin.email,
    action: 'admin.super.created',
    targetType: 'admin',
    targetId: admin.id,
    previousState: null,
    newState: redact({ email, role: 'SUPER_ADMIN' }) as any,
    reason: 'Additional Super Admin provisioned via add-super command',
    correlationId: randomUUID(),
    sourceIp: null,
    metadata: (redact({}) as Record<string, unknown>) ?? {}
  };

  await store.createSuperAdmin(admin, audit);

  console.log('\n[add-super] Super Admin created.');
  console.log(`  id:    ${admin.id}`);
  console.log(`  email: ${admin.email}`);
  console.log(`\n  MFA secret: ${secret}`);
  console.log(`  otpauth: ${totpUri(secret, admin.email)}\n`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.storageEngine !== 'postgres') {
    console.error('[add-super] STORAGE_ENGINE must be postgres. Aborting.');
    process.exit(1);
  }
  if (!cfg.isProduction) {
    console.error('[add-super] NODE_ENV must be production. Aborting.');
    process.exit(1);
  }
  const store = new Store(cfg.dataDir, storeOptionsFromConfig(cfg));
  try {
    await store.load();
    console.log(`[add-super] Storage engine: ${store.storage.kind}`);
    await run(store, cfg);
  } finally {
    await store.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[add-super] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
