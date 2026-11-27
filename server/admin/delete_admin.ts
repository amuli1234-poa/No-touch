import readline from 'node:readline';

import { loadConfig } from '../config.js';
import { Store, storeOptionsFromConfig } from '../store/store.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.storageEngine !== 'postgres') {
    console.error('STORAGE_ENGINE must be postgres. Aborting.');
    process.exit(1);
  }
  if (!cfg.isProduction) {
    console.error('NODE_ENV must be production. Aborting.');
    process.exit(1);
  }

  const email = process.argv[2];
  const confirm = process.argv[3];
  if (!email || !confirm) {
    console.error('Usage: npm run admin:delete -- <admin-email> CONFIRM');
    process.exit(1);
  }
  if (confirm !== 'CONFIRM') {
    console.error('Second argument must be exactly CONFIRM.');
    process.exit(1);
  }

  const store = new Store(cfg.dataDir, storeOptionsFromConfig(cfg));
  try {
    await store.load();
    const target = store.getAdminByEmail(email);
    if (!target) {
      console.error('No admin with that email.');
      process.exit(1);
    }
    if (target.role !== 'SUPER_ADMIN' || target.status !== 'active') {
      console.error('Target is not an active SUPER_ADMIN.');
      process.exit(1);
    }
    const matches = store.listAdmins().filter((a) => a.email.toLowerCase() === email.trim().toLowerCase());
    if (matches.length !== 1) {
      console.error(`Expected exactly one matching account, found ${matches.length}. Aborting.`);
      process.exit(1);
    }
    await store.deleteAdmin(target.id, 'cli');
    console.log(`Deleted admin ${target.email} (${target.id}).`);
  } finally {
    await store.storage.close();
  }
}

main().catch((err) => {
  console.error('Deletion failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
