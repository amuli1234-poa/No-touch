import 'dotenv/config';
import readline from 'node:readline';
import { loadConfig, type ServerConfig } from '../config.js';
import { Store, storeOptionsFromConfig } from '../store/store.js';
import { hashPassword, validatePasswordStrength } from './passwords.js';
import { generateTotpSecret, totpUri, currentTotp } from './totp.js';
import { seal } from '../lib/crypto.js';
import { createOpaqueId } from '../lib/pkce.js';
import { writeAudit } from '../services/admin/audit.js';
import type { AdminUserRecord } from './types.js';

/**
 * Secure Super Admin bootstrap.
 *
 * Creates the first SUPER_ADMIN account. There is no public registration route;
 * this command is the only way to seed an administrator. It never hardcodes a
 * credential: the operator supplies email, name and password interactively (or
 * via env for automation), and the password is hashed with scrypt.
 *
 * Usage:
 *   npm run admin:bootstrap
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' ADMIN_NAME='Your Name' npm run admin:bootstrap
 *
 * The account starts un-enrolled in MFA; on first login the operator scans the
 * otpauth URI and confirms a TOTP code to complete enrolment.
 */

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
      rl.once('line', (answer) => {
        rl.close();
        resolve(answer);
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function run(store: Store, cfg: ServerConfig): Promise<void> {
  if (store.countActiveSuperAdmins() > 0) {
    console.error('[bootstrap] An active Super Admin already exists. Refusing to create another.');
    console.error('            Use the admin dashboard to invite additional administrators.');
    process.exitCode = 1;
    return;
  }

  const email = (process.env.ADMIN_EMAIL ?? (await ask('Super Admin email: '))).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('[bootstrap] Invalid email address.');
    process.exitCode = 1;
    return;
  }
  if (store.getAdminByEmail(email)) {
    console.error('[bootstrap] An administrator with that email already exists.');
    process.exitCode = 1;
    return;
  }

  const displayName = (process.env.ADMIN_NAME ?? (await ask('Display name: '))).trim() || email.split('@')[0];

  let password = process.env.ADMIN_PASSWORD ?? '';
  if (!password) {
    password = await ask('Password (hidden): ', true);
  }
  const strength = validatePasswordStrength(password);
  if (!strength.ok) {
    console.error(`[bootstrap] Weak password: ${strength.reason}`);
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
  await store.upsertAdmin(admin);

  await writeAudit(store, {
    actorAdminId: admin.id,
    actorEmail: admin.email,
    action: 'admin.bootstrap.created',
    targetType: 'admin',
    targetId: admin.id,
    newState: { email, role: 'SUPER_ADMIN' },
    reason: 'Initial Super Admin provisioned via bootstrap command'
  });

  console.log('\n[bootstrap] Super Admin created.');
  console.log(`  id:    ${admin.id}`);
  console.log(`  email: ${admin.email}`);
  console.log('\n  MFA enrolment — scan this in an authenticator app (or enter the secret manually):');
  console.log(`  ${totpUri(secret, admin.email)}`);
  console.log(`  secret: ${secret}`);
  console.log('\n  Current TOTP code (for reference only):', currentTotp(secret));
  console.log('\n  Sign in at /admin/ and confirm a code to finish enrolment.\n');
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir, storeOptionsFromConfig(cfg));
  try {
    await store.load();
    // Report the backend so an operator can see the account is going to the
    // same place the server reads. The connection string is never printed.
    console.log(`[bootstrap] Storage engine: ${store.storage.kind}`);
    await run(store, cfg);
  } finally {
    // Postgres keeps a connection pool open; without this the CLI would hang
    // until the pool idled out, and a failure path would leak connections.
    await store.close().catch(() => undefined);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('DATABASE_URL is required')) {
    console.error('[bootstrap] fatal:', message);
    console.error('[bootstrap] STORAGE_ENGINE=postgres requires DATABASE_URL. Refusing to fall back to JSON/SQLite.');
  } else if (message.includes('Failed to open postgres backend') || message.toLowerCase().includes('econnrefused')) {
    console.error('[bootstrap] fatal: could not connect to PostgreSQL:', message);
    console.error('[bootstrap] Check DATABASE_URL and network reachability. Refusing to fall back to JSON/SQLite.');
  } else {
    console.error('[bootstrap] fatal:', message);
  }
  process.exit(1);
});
