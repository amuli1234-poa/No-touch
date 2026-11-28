import 'dotenv/config';
import { loadConfig } from '../config.js';
import { Store, storeOptionsFromConfig } from '../store/store.js';

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

function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir, storeOptionsFromConfig(cfg));

  return store
    .load()
    .then(async () => {
      // Same line the bootstrap prints, so the two commands can be compared.
      console.log(`[admin:list] Storage engine: ${store.storage.kind}`);
      console.log(`[admin:list] Data directory: ${cfg.dataDir}`);

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
