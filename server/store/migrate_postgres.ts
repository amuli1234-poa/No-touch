/**
 * PostgreSQL schema initialization and migration tool.
 *
 * Usage:
 *   npm run db:migrate:postgres              # initialize schema
 *   npm run db:migrate:postgres -- --verify-only  # verify schema (read-only)
 *
 * Requires DATABASE_URL and STORAGE_ENGINE=postgres.
 */

import { PostgresBackend } from './postgres_backend.js';

async function main(): Promise<void> {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    console.error('DATABASE_URL is required. See .env.example.');
    process.exit(1);
  }

  const ssl = process.env.NODE_ENV === 'production' || connStr.includes('supabase');
  const backend = new PostgresBackend(connStr, ssl);
  await backend.open();

  const verifyOnly = process.argv.includes('--verify-only');

  if (verifyOnly) {
    const counts = await backend.counts();
    console.log('Schema verification (read-only):');
    console.log(JSON.stringify(counts, null, 2));
    const { rows } = await backend.query('SELECT version, applied_at, description FROM _schema_migrations ORDER BY applied_at');
    console.log('Applied migrations:', rows);
    await backend.close();
    return;
  }

  // Record baseline migration if not already applied
  const { rows } = await backend.query('SELECT version FROM _schema_migrations WHERE version = $1', ['001_baseline']);
  if (rows.length === 0) {
    await backend.query(
      `INSERT INTO _schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
      ['001_baseline', 'Initial PostgreSQL schema (all collections)']
    );
    console.log('Baseline migration 001_baseline recorded.');
  } else {
    console.log('Baseline migration already applied.');
  }

  const counts = await backend.counts();
  console.log('Schema initialized. Record counts:', JSON.stringify(counts));
  await backend.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
