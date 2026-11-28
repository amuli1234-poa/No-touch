import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { Store, storeOptionsFromConfig } from '../store/store.js';
import { generateTotpSecret, totpUri } from './totp.js';
import { seal } from '../lib/crypto.js';
import { writeAudit } from '../services/admin/audit.js';
import type { AdminUserRecord } from './types.js';

/**
 * Re-seals an administrator's MFA secret under the given SESSION_SECRET.
 *
 * A fresh secret is issued rather than the original recovered: the original is
 * unreadable by definition when this is needed, and the operator re-scans the
 * QR code anyway. Password, role, permissions and status are untouched.
 */
export async function resealMfaSecret(store: Store, admin: AdminUserRecord, sessionSecret: string): Promise<string> {
  const secret = generateTotpSecret();
  admin.mfa = {
    enrolled: false,
    secretSealed: seal(secret, sessionSecret),
    enrolledAt: null,
    recoveryCodeHashes: []
  };
  await store.upsertAdmin(admin);
  // A pending MFA session issued under the old secret must not survive.
  await store.revokeAdminSessions(admin.id);
  await writeAudit(store, {
    actorAdminId: null,
    action: 'admin.mfa.reseal',
    targetType: 'admin',
    targetId: admin.id,
    newState: { email: admin.email, mfaEnrolled: false },
    reason: 'MFA secret re-sealed under the current SESSION_SECRET via CLI'
  });
  return secret;
}

/**
 * CLI entry point: re-seals an administrator's MFA secret under the
 * SESSION_SECRET this process resolves, then prints the new enrolment URI.
 *
 * Usage:
 *   npm run admin:reseal-mfa -- <admin-email> CONFIRM
 */

async function main(): Promise<void> {
  const cfg = loadConfig();
  const email = process.argv[2];
  const confirm = process.argv[3];
  if (!email || !confirm) {
    console.error('Usage: npm run admin:reseal-mfa -- <admin-email> CONFIRM');
    console.error('Re-seals the MFA secret under the current SESSION_SECRET and prints a new enrolment URI.');
    process.exit(1);
  }
  if (confirm !== 'CONFIRM') {
    console.error('Second argument must be exactly CONFIRM.');
    process.exit(1);
  }
  if (cfg.storageEngine !== 'postgres') {
    console.error('STORAGE_ENGINE must be postgres. Aborting.');
    process.exit(1);
  }

  const store = new Store(cfg.dataDir, storeOptionsFromConfig(cfg));
  try {
    await store.load();
    console.log(`[reseal-mfa] Storage engine: ${store.storage.kind}`);

    const target = store.getAdminByEmail(email);
    if (!target) {
      console.error(`[reseal-mfa] No administrator with email ${email}.`);
      console.error('[reseal-mfa] Create one with: npm run admin:bootstrap');
      process.exit(1);
    }

    const secret = await resealMfaSecret(store, target, cfg.session.secret);

    console.log(`\n[reseal-mfa] MFA secret re-sealed for ${target.email}.`);
    console.log('  Scan this in an authenticator app (or enter the secret manually):');
    console.log(`  ${totpUri(secret, target.email)}`);
    console.log(`  secret: ${secret}`);
    console.log('\n  Any previous authenticator entry for this account is now invalid.');
    console.log('  Sign in at /admin/ and confirm a code to finish enrolment.');
    console.log('  If the next sign-in reports "cannot start MFA enrolment", this process');
    console.log('  used a different SESSION_SECRET than the server.\n');
  } finally {
    await store.close().catch(() => undefined);
  }
}

// Exported for the reseal test; the CLI entry point runs only when invoked.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = invokedPath === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('DATABASE_URL is required')) {
      console.error('[reseal-mfa] fatal:', message);
      console.error('[reseal-mfa] STORAGE_ENGINE=postgres requires DATABASE_URL. Refusing to fall back to JSON/SQLite.');
    } else if (message.includes('Failed to open postgres backend') || message.toLowerCase().includes('econnrefused')) {
      console.error('[reseal-mfa] fatal: could not connect to PostgreSQL:', message);
      console.error('[reseal-mfa] Check DATABASE_URL and network reachability.');
    } else {
      console.error('[reseal-mfa] fatal:', message);
    }
    process.exit(1);
  });
}
