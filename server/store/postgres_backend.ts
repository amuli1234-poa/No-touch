/**
 * PostgreSQL storage backend (Supabase).
 *
 * Implements the StorageBackend contract against a PostgreSQL database.
 * Connection is via DATABASE_URL environment variable.
 */

import { Pool, type PoolClient } from 'pg';

import { COLLECTIONS, COLLECTION_SPECS, type CollectionName, type StorageBackend, type StoredRecord } from './backend.js';

const KEYED_DDL = (table: string, indexFields: string[]) => {
  const cols = indexFields.map((f) => `"${f}" TEXT`).join(', ');
  const idx = indexFields.map((f) => `CREATE INDEX IF NOT EXISTS idx_${table}_${f} ON ${table} ("${f}");`).join('\n');
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      ${cols ? cols + ',' : ''}
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ${idx}
  `;
};

const APPEND_DDL = (table: string) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    id SERIAL PRIMARY KEY,
    data JSONB NOT NULL,
    timestamp BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_${table}_timestamp ON ${table} (timestamp);
`;

const SINGLETON_DDL = `
  CREATE TABLE IF NOT EXISTS _singletons (
    key TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

export class PostgresBackend implements StorageBackend {
  readonly kind = 'postgres';
  private pool: Pool;
  private opened = false;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const client = await this.pool.connect();
    try {
      // Create all tables
      for (const spec of COLLECTION_SPECS) {
        if (spec.kind === 'keyed') {
          await client.query(KEYED_DDL(spec.name, spec.indexFields ?? []));
        } else {
          await client.query(APPEND_DDL(spec.name));
        }
      }
      await client.query(SINGLETON_DDL);
      this.opened = true;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.opened = false;
  }

  private async ensureOpen(): Promise<void> {
    if (!this.opened) await this.open();
  }

  private get client(): Pool | PoolClient {
    return (this as any)._txClient ?? this.pool;
  }

  private spec(collection: CollectionName) {
    return COLLECTION_SPECS.find((s) => s.name === collection)!;
  }

  async loadKeyed(collection: CollectionName): Promise<Record<string, StoredRecord>> {
    await this.ensureOpen();
    const spec = this.spec(collection);
    const keyField = spec.keyField ?? 'id';
    const result = await this.client.query(`SELECT data FROM ${collection}`);
    const out: Record<string, StoredRecord> = {};
    for (const row of result.rows) {
      const rec = row.data as StoredRecord;
      const key = String(rec[keyField]);
      out[key] = rec;
    }
    return out;
  }

  async loadAppend(collection: CollectionName): Promise<StoredRecord[]> {
    await this.ensureOpen();
    const result = await this.client.query(`SELECT data FROM ${collection} ORDER BY id ASC`);
    return result.rows.map((r) => r.data as StoredRecord);
  }

  async putKeyed(collection: CollectionName, key: string, record: StoredRecord): Promise<void> {
    await this.ensureOpen();
    const spec = this.spec(collection);
    const indexFields = spec.indexFields ?? [];
    const cols = ['key', 'data', ...indexFields];
    const vals = [key, JSON.stringify(record), ...indexFields.map((f) => (record as any)[f] ?? null)];
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const colNames = cols.map((c) => `"${c}"`).join(', ');
    const updateSet = ['data = EXCLUDED.data', ...indexFields.map((f) => `"${f}" = EXCLUDED."${f}"`)].join(', ');
    await this.client.query(
      `INSERT INTO ${collection} (${colNames}) VALUES (${placeholders})
       ON CONFLICT (key) DO UPDATE SET ${updateSet}`,
      vals
    );
  }

  async deleteKeyed(collection: CollectionName, key: string): Promise<void> {
    await this.ensureOpen();
    await this.client.query(`DELETE FROM ${collection} WHERE key = $1`, [key]);
  }

  async appendRecord(collection: CollectionName, record: StoredRecord): Promise<void> {
    await this.ensureOpen();
    const ts = (record as any).timestamp ?? (record as any).createdAt ?? Date.now();
    await this.client.query(
      `INSERT INTO ${collection} (data, timestamp) VALUES ($1, $2)`,
      [JSON.stringify(record), ts]
    );
  }

  async deleteAppendBefore(collection: CollectionName, cutoffMs: number): Promise<void> {
    await this.ensureOpen();
    await this.client.query(`DELETE FROM ${collection} WHERE timestamp < $1`, [cutoffMs]);
  }

  async loadSingleton(key: string): Promise<StoredRecord | null> {
    await this.ensureOpen();
    const result = await this.client.query(`SELECT data FROM _singletons WHERE key = $1`, [key]);
    if (result.rows.length === 0) return null;
    return result.rows[0].data as StoredRecord;
  }

  async putSingleton(key: string, record: StoredRecord): Promise<void> {
    await this.ensureOpen();
    await this.client.query(
      `INSERT INTO _singletons (key, data) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [key, JSON.stringify(record)]
    );
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureOpen();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Temporarily swap pool query to use client — but our methods use this.pool directly.
      // Instead, we set a transaction client and run fn, then commit/rollback.
      const prevClient = (this as any)._txClient;
      (this as any)._txClient = client;
      const result = await fn();
      await client.query('COMMIT');
      (this as any)._txClient = prevClient;
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      (this as any)._txClient = null;
      throw e;
    } finally {
      client.release();
    }
  }

  async counts(): Promise<Record<string, number>> {
    await this.ensureOpen();
    const out: Record<string, number> = {};
    for (const name of COLLECTIONS) {
      const result = await this.client.query(`SELECT COUNT(*) AS c FROM ${name}`);
      out[name] = parseInt(result.rows[0].c, 10);
    }
    out._singletons = (await this.client.query(`SELECT COUNT(*) AS c FROM _singletons`)).rows[0].c;
    return out;
  }
}
