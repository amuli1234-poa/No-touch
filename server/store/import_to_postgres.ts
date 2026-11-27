/**
 * Import data from JSON or SQLite into PostgreSQL.
 *
 * Usage:
 *   SOURCE_ENGINE=json SOURCE_DATA_DIR=./data DATABASE_URL=... npm run db:import:postgres
 *   SOURCE_ENGINE=sqlite ... npm run db:import:postgres
 */
import { resolveBackend } from './store.js';
import { COLLECTIONS, COLLECTION_SPECS } from './backend.js';

async function main(): Promise<void> {
  const sourceEngine = (process.env.SOURCE_ENGINE ?? 'json').toLowerCase();
  const dataDir = process.env.SOURCE_DATA_DIR ?? process.env.DATA_DIR ?? './data';
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const ssl = process.env.NODE_ENV === 'production' || connStr.includes('supabase');

  const src = resolveBackend(dataDir, { engine: sourceEngine as any });
  const dst = resolveBackend(dataDir, { engine: 'postgres', connectionString: connStr, ssl });
  await src.open();
  await dst.open();

  await dst.transaction(async () => {
    for (const spec of COLLECTION_SPECS) {
      if (spec.kind === 'keyed') {
        const recs = await src.loadKeyed(spec.name);
        for (const [key, rec] of Object.entries(recs)) {
          await dst.putKeyed(spec.name, key, rec);
        }
        console.log(`${spec.name}: ${Object.keys(recs).length} records`);
      } else {
        const recs = await src.loadAppend(spec.name);
        for (const rec of recs) {
          await dst.appendRecord(spec.name, rec);
        }
        console.log(`${spec.name}: ${recs.length} records`);
      }
    }
    // singletons
    for (const key of ['platformConfig']) {
      const rec = await src.loadSingleton(key);
      if (rec) await dst.putSingleton(key, rec);
    }
  });

  const srcCounts = await src.counts();
  const dstCounts = await dst.counts();
  console.log('Source counts:', JSON.stringify(srcCounts));
  console.log('Target counts:', JSON.stringify(dstCounts));

  await src.close();
  await dst.close();
  console.log('Import complete.');
}

main().catch((err) => {
  console.error('Import failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
