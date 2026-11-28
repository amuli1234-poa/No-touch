import 'dotenv/config';
import { loadConfig } from '../config.js';
import { Store, storeOptionsFromConfig } from '../store/store.js';
import { open } from '../lib/crypto.js';

/**
 * Lists the administrators a deployment actually holds.
 *
 * Diagnoses "sign-in failed" on a deployed console: it shows which storage
 * engine and account rows the server will read, so an operator can tell a
 * missing bootstrap from a password or MFA problem. Read-only — it never
 * creates, resets or reveals a credential, and it prints no hash or secret.
 *
 * Usage:
 *   npm run admin:list
 */

function describeDatabase(url: string | null): string {
  if (!url) return 'none (DATABASE_URL is not set)';
  try {
    const parsed = new URL(url);
    // Host and database name only: the URL carries the password.
    const host = parsed.hostname;
    const db = parsed.pathname.replace(/^\//, '') || '(none)';
    const local = host === 'localhost' || host === '127.0.0.1';
    return `${host}/${db}${local ? ' (LOCALHOST — not a deployed database)' : ''}`;
  } catch {
    return '(DATABASE_URL is not a parseable URL)';
  }
}

function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir, storeOptionsFromConfig(cfg));

  // Printed before connecting: when a connection fails, the target is the fact
  // that matters most, and it would otherwise never be shown.
  console.log(`[admin:list] Storage engine: ${store.storage.kind}`);
  console.log(`[admin:list] Data directory: ${cfg.dataDir}`);
  // Without the host, a CLI pointed at the wrong database looks exactly like a
  // correctly seeded one whose account the server cannot see.
  console.log(`[admin:list] Database: ${describeDatabase(cfg.database?.url ?? null)}`);

  return store
    .load()
    .then(async () => {
      const admins = store.listAdmins();
      console.log(`[admin:list] Administrators: ${admins.length}`);

      if (admins.length === 0) {
        console.log('[admin:list] No administrator exists.');
        console.log('[admin:list] Create the first one with: npm run admin:bootstrap');
        return;
      }

      for (const admin of admins) {
        const mfa = admin.mfa.enrolled ? `MFA enrolled ${new Date(admin.mfa.enrolledAt ?? 0).toISOString()}` : 'MFA NOT enrolled';
        const lastLogin = admin.lastLoginAt ? new Date(admin.lastLoginAt).toISOString() : 'never';
        console.log(`  - ${admin.email}`);
        console.log(`      role: ${admin.role} | status: ${admin.status} | ${mfa} | last login: ${lastLogin}`);
        // A secret sealed under a different SESSION_SECRET is undecryptable and
        // blocks enrolment, so report it rather than leaving it to be guessed.
        if (!admin.mfa.enrolled) {
          const readable = admin.mfa.secretSealed !== null && open(admin.mfa.secretSealed, cfg.session.secret) !== null;
          console.log(
            readable
              ? '      mfa secret: readable with this SESSION_SECRET'
              : '      mfa secret: CANNOT be decrypted with this SESSION_SECRET (sign-in will fail; run npm run admin:reseal-mfa)'
          );
        }
      }

      const activeSupers = store.countActiveSuperAdmins();
      if (activeSupers === 0) {
        console.log('[admin:list] Warning: no ACTIVE Super Admin. Sign-in will fail until one is restored.');
        console.log('[admin:list] Restore access with: npm run admin:add-super');
      }
    })
    .finally(() => store.close().catch(() => undefined));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('DATABASE_URL is required')) {
    console.error('[admin:list] fatal:', message);
    console.error('[admin:list] STORAGE_ENGINE=postgres requires DATABASE_URL. Refusing to fall back to JSON/SQLite.');
  } else if (message.includes('Failed to open postgres backend') || message.toLowerCase().includes('econnrefused')) {
    console.error('[admin:list] fatal: could not connect to PostgreSQL:', message);
    console.error('[admin:list] Check DATABASE_URL and network reachability.');
  } else {
    console.error('[admin:list] fatal:', message);
  }
  process.exit(1);
});
