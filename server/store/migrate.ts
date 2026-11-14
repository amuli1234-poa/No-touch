import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import { JsonBackend } from '../store/json_backend.js';
import { SqliteBackend } from '../store/sqlite_backend.js';
import { StoreLock } from '../store/lock.js';
import { COLLECTION_SPECS } from '../store/backend.js';
import type { StoredRecord } from '../store/backend.js';

/**
 * JSON -> SQLite migration.
 *
 * Safety properties, in order of importance:
 *  1. The source JSON file is NEVER deleted, moved or modified. It is read once
 *     and left exactly where it was, so rollback needs no restore step.
 *  2. A timestamped backup copy is written before anything else happens.
 *  3. All writes happen inside one SQLite transaction, so a failure part-way
 *     leaves the database exactly as it was (empty or untouched), never half
 *     populated.
 *  4. After migrating, record counts and key relationships are re-read from the
 *     database and compared against the source. Any mismatch aborts with a
 *     non-zero exit and the database is not considered migrated.
 *
 * Usage:
 *   npm run db:migrate            # migrate data/ if a JSON file is present
 *   npm run db:migrate -- --verify-only   # check an existing database only
 */

const SINGLETON_KEY = 'platformConfig';

interface MigrationReport {
  collections: Record<string, { source: number; target: number; ok: boolean }>;
  relationships: Array<{ name: string; ok: boolean; detail: string }>;
  integrity: string;
  ok: boolean;
}

function log(msg: string): void {
  console.log(`[migrate] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[migrate] ERROR: ${msg}`);
  process.exit(1);
}

/** Copies the JSON file to a timestamped sibling. Returns the backup path. */
function backupJsonFile(jsonPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${jsonPath}.backup-${stamp}`;
  fs.copyFileSync(jsonPath, backupPath);
  return backupPath;
}

async function readSource(jsonPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.promises.readFile(jsonPath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dataDir = cfg.dataDir;
  const jsonPath = path.join(dataDir, 'wicksentinel.json');
  const dbPath = path.join(dataDir, 'wicksentinel.db');
  const verifyOnly = process.argv.includes('--verify-only');

  if (!fs.existsSync(jsonPath)) {
    if (fs.existsSync(dbPath)) {
      log(`No JSON source at ${jsonPath}; database already exists. Running verification only.`);
      const report = await verifyExisting(dbPath);
      printReport(report, dbPath, jsonPath, null);
      process.exit(report.ok ? 0 : 1);
    }
    fail(`No JSON source found at ${jsonPath} and no database at ${dbPath}. Nothing to migrate.`);
  }

  // `--verify-only` must never write. Checking an existing database is the whole
  // point of the flag; migrating here would append to append-only collections a
  // second time and silently duplicate audit records.
  if (verifyOnly) {
    if (!fs.existsSync(dbPath)) {
      fail(`--verify-only was given but ${dbPath} does not exist.`);
    }
    log(`Verifying existing database: ${dbPath}`);
    const report = await verifyExisting(dbPath);
    printReport(report, dbPath, jsonPath, null);
    process.exit(report.ok ? 0 : 1);
  }

  log(`Source:      ${jsonPath}`);
  log(`Destination: ${dbPath}`);

  // Refuse to clobber an existing database: migrating twice would duplicate
  // append-only records (audit logs) with no way to tell them apart.
  if (fs.existsSync(dbPath)) {
    fail(
      `${dbPath} already exists. Refusing to overwrite it. ` +
        'Remove it deliberately (after backing it up) if you intend to re-migrate.'
    );
  }

  // 1. Back up the source before touching anything.
  const backupPath = backupJsonFile(jsonPath);
  log(`Backup:      ${backupPath}`);

  const source = await readSource(jsonPath);

  // 2. Hold one lock across both backends: opening the JSON backend takes the
  //    directory lock, which also stops a running server from writing while we
  //    read. The lock is injected into both so neither releases it early.
  const lock = new StoreLock(dataDir);
  await lock.acquire();
  const json = new JsonBackend(dataDir, { lock });
  const sqlite = new SqliteBackend(dataDir, { lock });

  let report: MigrationReport;
  try {
    await json.open();
    await sqlite.open();

    // 3. One transaction for every write.
    await sqlite.transaction(async () => {
      for (const spec of COLLECTION_SPECS) {
        if (spec.kind === 'append') {
          const rows = await json.loadAppend(spec.name);
          for (const row of rows) await sqlite.appendRecord(spec.name, row);
        } else {
          const keyed = await json.loadKeyed(spec.name);
          for (const [key, record] of Object.entries(keyed)) {
            await sqlite.putKeyed(spec.name, key, record);
          }
        }
      }
      const platformConfig = await json.loadSingleton(SINGLETON_KEY);
      if (platformConfig) await sqlite.putSingleton(SINGLETON_KEY, platformConfig);
    });

    // 4. Verify against the source, reading back through the real backend.
    report = await verifyAgainst(source, sqlite);
  } finally {
    await sqlite.close();
    await json.close();
    await lock.release();
  }

  printReport(report, dbPath, jsonPath, backupPath);
  process.exit(report.ok ? 0 : 1);
}

/** Re-reads every collection from SQLite and compares to the JSON source. */
async function verifyAgainst(source: Record<string, unknown>, sqlite: SqliteBackend): Promise<MigrationReport> {
  const collections: MigrationReport['collections'] = {};

  for (const spec of COLLECTION_SPECS) {
    const bucket = source[spec.name];
    const sourceCount =
      spec.kind === 'append' ? (Array.isArray(bucket) ? bucket.length : 0) : Object.keys((bucket as object) ?? {}).length;

    const targetCount =
      spec.kind === 'append'
        ? (await sqlite.loadAppend(spec.name)).length
        : Object.keys(await sqlite.loadKeyed(spec.name)).length;

    collections[spec.name] = { source: sourceCount, target: targetCount, ok: sourceCount === targetCount };
  }

  const sourceConfig = source[SINGLETON_KEY] ? 1 : 0;
  const targetConfig = (await sqlite.loadSingleton(SINGLETON_KEY)) ? 1 : 0;
  collections[SINGLETON_KEY] = { source: sourceConfig, target: targetConfig, ok: sourceConfig === targetConfig };

  const relationships = await verifyRelationships(sqlite);
  const integrity = sqlite.integrityCheck();

  const countsOk = Object.values(collections).every((c) => c.ok);
  const relsOk = relationships.every((r) => r.ok);

  return { collections, relationships, integrity, ok: countsOk && relsOk && integrity === 'ok' };
}

/** Checks that foreign-key-style links survived the migration. */
async function verifyRelationships(sqlite: SqliteBackend): Promise<MigrationReport['relationships']> {
  const sessions = Object.values(await sqlite.loadKeyed('sessions'));
  const users = await sqlite.loadKeyed('users');
  const messages = Object.values(await sqlite.loadKeyed('supportTicketMessages'));
  const tickets = await sqlite.loadKeyed('supportTickets');
  const adminSessions = Object.values(await sqlite.loadKeyed('adminSessions'));
  const admins = await sqlite.loadKeyed('adminUsers');

  const orphan = (rows: StoredRecord[], field: string, valid: Set<string>) =>
    rows.filter((r) => typeof r[field] === 'string' && !valid.has(r[field] as string));

  const orphanSessions = orphan(sessions, 'userId', new Set(Object.keys(users)));
  const orphanMessages = orphan(messages, 'ticketId', new Set(Object.keys(tickets)));
  const orphanAdminSessions = orphan(adminSessions, 'adminId', new Set(Object.keys(admins)));

  return [
    { name: 'sessions.userId -> users', ok: orphanSessions.length === 0, detail: `${orphanSessions.length} orphan(s)` },
    { name: 'supportTicketMessages.ticketId -> supportTickets', ok: orphanMessages.length === 0, detail: `${orphanMessages.length} orphan(s)` },
    { name: 'adminSessions.adminId -> adminUsers', ok: orphanAdminSessions.length === 0, detail: `${orphanAdminSessions.length} orphan(s)` }
  ];
}

async function verifyExisting(dbPath: string): Promise<MigrationReport> {
  const dataDir = path.dirname(dbPath);
  const sqlite = new SqliteBackend(dataDir);
  try {
    await sqlite.open();
    const counts = await sqlite.counts();
    const collections: MigrationReport['collections'] = {};
    for (const [name, n] of Object.entries(counts)) collections[name] = { source: n, target: n, ok: true };

    const relationships = await verifyRelationships(sqlite);

    // An append-only collection has no key, so a botched re-run can duplicate
    // records silently. Audit records carry a unique id; flag any repeat.
    const audit = await sqlite.loadAppend('auditLogs');
    const ids = audit.map((r) => (r as { id?: string }).id).filter((id): id is string => typeof id === 'string');
    const unique = new Set(ids);
    const duplicateCount = ids.length - unique.size;
    relationships.push({
      name: 'auditLogs.id uniqueness',
      ok: duplicateCount === 0,
      detail: duplicateCount === 0 ? 'no duplicates' : `${duplicateCount} duplicate id(s)`
    });

    const integrity = sqlite.integrityCheck();
    return { collections, relationships, integrity, ok: relationships.every((r) => r.ok) && integrity === 'ok' };
  } finally {
    await sqlite.close();
  }
}

function printReport(report: MigrationReport, dbPath: string, jsonPath: string, backupPath: string | null): void {
  console.log('\n[migrate] ---- Record counts ----');
  for (const [name, c] of Object.entries(report.collections)) {
    console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${name.padEnd(24)} source=${c.source} target=${c.target}`);
  }

  console.log('\n[migrate] ---- Relationships ----');
  for (const r of report.relationships) {
    console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name} (${r.detail})`);
  }

  console.log(`\n[migrate] SQLite integrity_check: ${report.integrity}`);
  console.log(`[migrate] Database: ${dbPath}`);
  if (backupPath) {
    console.log(`[migrate] Backup:   ${backupPath}`);
    console.log(`[migrate] Original JSON retained at: ${jsonPath}`);
  }

  console.log(`\n[migrate] ${report.ok ? 'SUCCESS — database verified.' : 'FAILED — database NOT verified; see failures above.'}`);
}

// Exported for the migration test; the CLI entry point runs only when invoked.
export { verifyAgainst, verifyRelationships };

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = invokedPath === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error('[migrate] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
