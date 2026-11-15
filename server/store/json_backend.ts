import fsp from 'node:fs/promises';
import path from 'node:path';

import { StoreConflictError } from './errors.js';
import { StoreLock } from './lock.js';
import {
  COLLECTION_SPECS,
  type CollectionName,
  type StorageBackend,
  type StoredRecord
} from './backend.js';

/**
 * Single-file JSON backend — the original persistence engine, kept intact so
 * the SQLite migration can be verified against a known-good implementation and
 * rolled back to it without data loss.
 *
 * Durability model (unchanged from Phase 0A):
 *  - one exclusive lock per data directory, so a second process cannot load a
 *    snapshot that is already doomed to be overwritten;
 *  - writes serialised through a promise chain and flushed atomically via
 *    write-temp-then-rename;
 *  - an mtime ownership check that refuses to overwrite a file another process
 *    modified, poisoning the store instead of destroying records.
 *
 * The whole file is rewritten on every write. That is acceptable for a single
 * writer and is exactly the limitation the SQLite backend removes.
 */

const SINGLETON_KEY = 'platformConfig';
const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;

type RenameOperation = (source: string, destination: string) => Promise<void>;
type WaitOperation = (milliseconds: number) => Promise<void>;

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function renameWithRetry(
  source: string,
  destination: string,
  rename: RenameOperation = (from, to) => fsp.rename(from, to),
  delay: WaitOperation = wait
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
      if ((code !== 'EPERM' && code !== 'EACCES') || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await delay(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export interface JsonBackendOptions {
  /** Skips the directory lock. Tests only; never set in production. */
  unsafeDisableLock?: boolean;
  /**
   * Uses a caller-provided lock instead of taking its own. The migration holds
   * one lock across both backends; without this, opening the second backend
   * would fail against the first one's lock.
   */
  lock?: StoreLock;
}

export class JsonBackend implements StorageBackend {
  readonly kind = 'json' as const;

  private readonly file: string;
  private readonly lock: StoreLock;
  /** False when the lock was injected; the injector then owns releasing it. */
  private readonly ownsLock: boolean;
  private db: Record<string, unknown> = {};
  private queue: Promise<void> = Promise.resolve();
  private lastWrittenMtimeMs: number | null = null;
  private poisoned: StoreConflictError | null = null;

  constructor(
    dataDir: string,
    options: JsonBackendOptions = {}
  ) {
    this.file = path.join(dataDir, 'wicksentinel.json');
    this.ownsLock = !options.lock;
    this.lock = options.lock ?? new StoreLock(dataDir, { disabled: options.unsafeDisableLock });
  }

  get filePath(): string {
    return this.file;
  }

  async open(): Promise<void> {
    if (this.ownsLock) await this.lock.acquire();
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      this.db = JSON.parse(raw) as Record<string, unknown>;
      this.lastWrittenMtimeMs = (await fsp.stat(this.file)).mtimeMs;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        if (this.ownsLock) await this.lock.release();
        throw err;
      }
      this.db = {};
      this.lastWrittenMtimeMs = null;
    }
  }

  async close(): Promise<void> {
    if (this.ownsLock) await this.lock.release();
  }

  async loadKeyed(collection: CollectionName): Promise<Record<string, StoredRecord>> {
    const bucket = this.db[collection];
    if (!bucket || typeof bucket !== 'object') return {};
    return structuredClone(bucket) as Record<string, StoredRecord>;
  }

  async loadAppend(collection: CollectionName): Promise<StoredRecord[]> {
    const bucket = this.db[collection];
    if (!Array.isArray(bucket)) return [];
    return structuredClone(bucket) as StoredRecord[];
  }

  async putKeyed(collection: CollectionName, key: string, record: StoredRecord): Promise<void> {
    const bucket = (this.db[collection] ??= {}) as Record<string, StoredRecord>;
    bucket[key] = record;
    await this.flush();
  }

  async deleteKeyed(collection: CollectionName, key: string): Promise<void> {
    const bucket = this.db[collection] as Record<string, StoredRecord> | undefined;
    if (!bucket || !(key in bucket)) return;
    delete bucket[key];
    await this.flush();
  }

  async appendRecord(collection: CollectionName, record: StoredRecord): Promise<void> {
    const bucket = (this.db[collection] ??= []) as StoredRecord[];
    bucket.push(record);
    await this.flush();
  }

  async deleteAppendBefore(collection: CollectionName, cutoffMs: number): Promise<void> {
    const bucket = this.db[collection];
    if (!Array.isArray(bucket)) return;
    const kept = (bucket as StoredRecord[]).filter((r) => {
      const t = r.timestamp;
      return typeof t === 'number' && t >= cutoffMs;
    });
    if (kept.length === bucket.length) return;
    this.db[collection] = kept;
    await this.flush();
  }

  async loadSingleton(key: string): Promise<StoredRecord | null> {
    const value = this.db[key];
    if (!value || typeof value !== 'object') return null;
    return structuredClone(value) as StoredRecord;
  }

  async putSingleton(key: string, record: StoredRecord): Promise<void> {
    this.db[key] = record;
    await this.flush();
  }

  /**
   * JSON has no real transactions. The whole snapshot is written as one atomic
   * rename, so a caller that batches its writes and flushes once gets the same
   * all-or-nothing outcome at the file level. `fn` must therefore not flush
   * mid-way; the store uses this only for the migration.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const spec of COLLECTION_SPECS) {
      const bucket = this.db[spec.name];
      out[spec.name] = spec.kind === 'append' ? (Array.isArray(bucket) ? bucket.length : 0) : Object.keys((bucket as object) ?? {}).length;
    }
    out[SINGLETON_KEY] = this.db[SINGLETON_KEY] ? 1 : 0;
    return out;
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(this.db, null, 2);
    this.queue = this.queue.then(async () => {
      if (this.poisoned) throw this.poisoned;

      // A changed mtime means another writer touched the file; this snapshot is
      // stale and writing it would erase their records.
      const currentMtime = await this.currentMtimeMs();
      if (!this.ownsFile(currentMtime)) {
        this.poisoned = new StoreConflictError(
          'The data file was modified by another process. Refusing to overwrite it ' +
            'with a stale snapshot, which would destroy records written elsewhere. ' +
            'Restart the server so it reloads the current data.',
          { expectedMtimeMs: this.lastWrittenMtimeMs, actualMtimeMs: currentMtime }
        );
        throw this.poisoned;
      }

      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await renameWithRetry(tmp, this.file);
      this.lastWrittenMtimeMs = (await fsp.stat(this.file)).mtimeMs;
    });
    return this.queue;
  }

  private async currentMtimeMs(): Promise<number | null> {
    try {
      return (await fsp.stat(this.file)).mtimeMs;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  private ownsFile(currentMtimeMs: number | null): boolean {
    if (this.lastWrittenMtimeMs === null) return currentMtimeMs === null;
    return currentMtimeMs === this.lastWrittenMtimeMs;
  }
}
