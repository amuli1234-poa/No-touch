import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { StoreLock } from './lock.js';
import {
  COLLECTION_SPECS,
  type CollectionName,
  type StorageBackend,
  type StoredRecord
} from './backend.js';

/**
 * SQLite backend, using Node's built-in `node:sqlite` (no native build step,
 * no third-party dependency).
 *
 * Why SQLite replaces the JSON file:
 *  - a real transaction, so a multi-record change cannot half-apply;
 *  - indexes, so lookups by `derivSub` / `userId` / `tokenHash` do not scan
 *    every record in memory;
 *  - WAL, so readers are never blocked by the writer and a crash mid-write
 *    cannot leave a torn file.
 *
 * Schema shape: each keyed collection is one table of `key -> JSON document`.
 * Storing the document as JSON keeps the record types in TypeScript as the
 * single source of truth — no column set to drift out of sync — while the key
 * and the indexed lookup fields are promoted to real columns. That is the
 * right trade-off for a schema that is still evolving; a later PostgreSQL
 * migration can promote hot fields to columns without changing this contract.
 */

const SINGLETON_KEY = 'platformConfig';
const SCHEMA_VERSION = 1;

export interface SqliteBackendOptions {
  /** Skips the directory lock. Tests only; never set in production. */
  unsafeDisableLock?: boolean;
  /**
   * Uses a caller-provided lock instead of taking its own. The migration holds
   * one lock across both backends.
   */
  lock?: StoreLock;
}

export class SqliteBackend implements StorageBackend {
  readonly kind = 'sqlite' as const;

  private readonly file: string;
  private readonly lock: StoreLock;
  /** False when the lock was injected; the injector then owns releasing it. */
  private readonly ownsLock: boolean;
  private db: DatabaseSync | null = null;
  /** Serialises transactions so two never interleave over async boundaries. */
  private txQueue: Promise<unknown> = Promise.resolve();
  private txDepth = 0;

  constructor(
    dataDir: string,
    options: SqliteBackendOptions = {}
  ) {
    this.file = path.join(dataDir, 'wicksentinel.db');
    this.ownsLock = !options.lock;
    this.lock = options.lock ?? new StoreLock(dataDir, { disabled: options.unsafeDisableLock });
  }

  get filePath(): string {
    return this.file;
  }

  async open(): Promise<void> {
    // One writer per data directory, same guarantee as the JSON backend. SQLite
    // itself tolerates concurrent writers via WAL, but the application assumes
    // a single authoritative process, so the lock keeps that assumption honest.
    if (this.ownsLock) await this.lock.acquire();
    try {
      this.db = new DatabaseSync(this.file);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      // Wait rather than fail if a checkpoint briefly holds the write lock.
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.migrateSchema();
    } catch (err) {
      if (this.ownsLock) await this.lock.release();
      throw err;
    }
  }

  async close(): Promise<void> {
    try {
      this.db?.close();
    } finally {
      this.db = null;
      if (this.ownsLock) await this.lock.release();
    }
  }

  /** Creates tables and indexes if absent. Idempotent. */
  private migrateSchema(): void {
    const db = this.requireDb();
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    for (const spec of COLLECTION_SPECS) {
      if (spec.kind === 'append') {
        db.exec(
          `CREATE TABLE IF NOT EXISTS "${spec.name}" (
             seq INTEGER PRIMARY KEY AUTOINCREMENT,
             data TEXT NOT NULL
           )`
        );
        // Append collections can still declare indexed lookup fields (e.g.
        // `timestamp` for retention deletes), promoted the same way as keyed.
        this.addIndexedColumns(spec.name, spec.indexFields);
        continue;
      }

      const keyField = spec.keyField!;
      db.exec(
        `CREATE TABLE IF NOT EXISTS "${spec.name}" (
           key TEXT PRIMARY KEY,
           data TEXT NOT NULL
         )`
      );
      this.addIndexedColumns(spec.name, spec.indexFields);
      void keyField;
    }

    db.exec(
      `CREATE TABLE IF NOT EXISTS singleton (key TEXT PRIMARY KEY, data TEXT NOT NULL)`
    );
    db.exec(
      `INSERT INTO schema_meta(key, value) VALUES ('version', '${SCHEMA_VERSION}')
         ON CONFLICT(key) DO NOTHING`
    );
  }

  private columnExists(table: string, column: string): boolean {
    // `table_info` omits VIRTUAL generated columns, so it would report a column
    // we already added as missing and re-add it. `table_xinfo` includes them.
    const rows = this.requireDb().prepare(`PRAGMA table_xinfo("${table}")`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  /**
   * Promotes each lookup field to a generated column and indexes it, so
   * lookups do not scan the JSON document. Idempotent: generated columns are
   * only added when absent (guarded via `table_xinfo`).
   */
  private addIndexedColumns(table: string, fields: readonly string[] | undefined): void {
    const db = this.requireDb();
    for (const field of fields ?? []) {
      const col = `idx_${field}`;
      if (!this.columnExists(table, col)) {
        db.exec(
          `ALTER TABLE "${table}" ADD COLUMN ${col} TEXT
             GENERATED ALWAYS AS (json_extract(data, '$.${field}')) VIRTUAL`
        );
      }
      db.exec(`CREATE INDEX IF NOT EXISTS "idx_${table}_${field}" ON "${table}" (${col})`);
    }
  }

  async loadKeyed(collection: CollectionName): Promise<Record<string, StoredRecord>> {
    const rows = this.requireDb().prepare(`SELECT key, data FROM "${collection}"`).all() as Array<{
      key: string;
      data: string;
    }>;
    const out: Record<string, StoredRecord> = {};
    for (const row of rows) out[row.key] = JSON.parse(row.data) as StoredRecord;
    return out;
  }

  async loadAppend(collection: CollectionName): Promise<StoredRecord[]> {
    const rows = this.requireDb()
      .prepare(`SELECT data FROM "${collection}" ORDER BY seq ASC`)
      .all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as StoredRecord);
  }

  async putKeyed(collection: CollectionName, key: string, record: StoredRecord): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO "${collection}" (key, data) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET data = excluded.data`
      )
      .run(key, JSON.stringify(record));
  }

  async deleteKeyed(collection: CollectionName, key: string): Promise<void> {
    this.requireDb().prepare(`DELETE FROM "${collection}" WHERE key = ?`).run(key);
  }

  async appendRecord(collection: CollectionName, record: StoredRecord): Promise<void> {
    this.requireDb().prepare(`INSERT INTO "${collection}" (data) VALUES (?)`).run(JSON.stringify(record));
  }

  async deleteAppendBefore(collection: CollectionName, cutoffMs: number): Promise<void> {
    // `json_extract` yields a real number for the comparison, so this is a
    // correct numeric range delete. Retention runs on a timer, not per request,
    // so the full scan it implies is acceptable for this volume.
    this.requireDb()
      .prepare(`DELETE FROM "${collection}" WHERE json_extract(data, '$.timestamp') < ?`)
      .run(cutoffMs);
  }

  async loadSingleton(key: string): Promise<StoredRecord | null> {
    const row = this.requireDb().prepare(`SELECT data FROM singleton WHERE key = ?`).get(key) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as StoredRecord) : null;
  }

  async putSingleton(key: string, record: StoredRecord): Promise<void> {
    this.requireDb()
      .prepare(
        `INSERT INTO singleton (key, data) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET data = excluded.data`
      )
      .run(key, JSON.stringify(record));
  }

  /**
   * Runs `fn` atomically. Nested calls join the outer transaction via
   * SAVEPOINT, so an inner failure can roll back just its own work while the
   * outer scope decides whether to commit.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const db = this.requireDb();
      const nested = this.txDepth > 0;
      const savepoint = `sp_${this.txDepth}`;
      db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      this.txDepth++;
      try {
        const result = await fn();
        this.txDepth--;
        db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (err) {
        this.txDepth--;
        try {
          db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
          if (nested) db.exec(`RELEASE ${savepoint}`);
        } catch {
          // The rollback itself failing must not mask the original error.
        }
        throw err;
      }
    };

    // Serialise top-level transactions; nested ones run inline.
    const chained = this.txQueue.then(run, run);
    this.txQueue = chained.then(
      () => undefined,
      () => undefined
    );
    return chained as Promise<T>;
  }

  async counts(): Promise<Record<string, number>> {
    const db = this.requireDb();
    const out: Record<string, number> = {};
    for (const spec of COLLECTION_SPECS) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM "${spec.name}"`).get() as { c: number };
      out[spec.name] = row.c;
    }
    const sing = db.prepare(`SELECT COUNT(*) AS c FROM singleton WHERE key = ?`).get(SINGLETON_KEY) as {
      c: number;
    };
    out[SINGLETON_KEY] = sing.c;
    return out;
  }

  /** Integrity check via SQLite's own `PRAGMA integrity_check`. */
  integrityCheck(): string {
    const row = this.requireDb().prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    return row.integrity_check;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error('SQLite backend is not open. Call open() first.');
    return this.db;
  }
}

/** Whether a SQLite database file already exists for this data directory. */
export function sqliteFileExists(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, 'wicksentinel.db'));
}
