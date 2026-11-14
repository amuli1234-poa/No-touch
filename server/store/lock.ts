import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { StoreLockedError } from './errors.js';

/**
 * Exclusive writer lock for a data directory.
 *
 * The JSON store keeps the whole database in memory and rewrites the whole file
 * on every write. Two processes sharing a data directory therefore overwrite
 * each other's records: whichever writes last wins, and the loser's records are
 * gone. This lock makes that impossible by admitting exactly one writer per
 * directory.
 *
 * Only one authoritative backend process is supported by design. Multi-process
 * access needs a transactional database (see the SQLite migration), not a
 * looser lock here.
 */

export interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: number;
}

export interface StoreLockOptions {
  /**
   * When true (tests, read-only tooling) the lock is not taken and no conflict
   * is detected. Production paths never set this.
   */
  disabled?: boolean;
}

/**
 * Brief window before a lock whose PID is gone may be reclaimed. A live holder
 * is detected by signal 0, so this only avoids reclaiming a lock created in the
 * last moment; a definitive ESRCH is otherwise enough to reclaim.
 */
const STALE_GRACE_MS = 2_000;

/**
 * Lock files currently held by this process. A single process-exit handler
 * removes them all, rather than one listener per lock (which would trip
 * Node's max-listeners warning in test runs that build many stores).
 */
const heldLockPaths = new Set<string>();
let exitHandlerInstalled = false;

function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const lockPath of heldLockPaths) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Best effort; the staleness check recovers anything that survives.
      }
    }
  });
}

export class StoreLock {
  private readonly lockPath: string;
  private held = false;

  constructor(
    private readonly dataDir: string,
    private readonly options: StoreLockOptions = {}
  ) {
    this.lockPath = path.join(dataDir, 'wicksentinel.lock');
  }

  /** Acquires the lock or throws `StoreLockedError`. Idempotent per instance. */
  async acquire(): Promise<void> {
    if (this.options.disabled || this.held) return;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // wx = fail if the file exists, making creation the atomic test-and-set.
        const handle = await fsp.open(this.lockPath, 'wx');
        try {
          const info: LockInfo = {
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: Date.now()
          };
          await handle.writeFile(JSON.stringify(info), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.held = true;
        this.registerExitCleanup();
        return;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;

        const existing = await this.readLockInfo();
        if (existing && this.isStale(existing) && (await this.reclaim(existing))) {
          continue; // Reclaimed a dead holder's lock; retry the create once.
        }
        throw new StoreLockedError(
          `Data directory is locked by another process (pid ${existing?.pid ?? 'unknown'}). ` +
            'Only one backend may write to a data directory at a time. Stop the other process, ' +
            `or remove ${this.lockPath} if it is certain no such process is running.`,
          existing
        );
      }
    }

    throw new StoreLockedError('Could not acquire the data-directory lock.', await this.readLockInfo());
  }

  /** Releases the lock. Safe to call more than once. */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    try {
      await fsp.unlink(this.lockPath);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  /**
   * Removes the lock on abrupt exits (uncaught throw, `process.exit`). Only
   * synchronous work is permitted in an 'exit' handler. The staleness check
   * still recovers a lock left by SIGKILL, so this is an optimisation, not the
   * only line of defence.
   */
  private registerExitCleanup(): void {
    heldLockPaths.add(this.lockPath);
    installExitHandler();
  }

  private async readLockInfo(): Promise<LockInfo | null> {
    try {
      const raw = await fsp.readFile(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LockInfo>;
      if (typeof parsed?.pid !== 'number') return null;
      return {
        pid: parsed.pid,
        hostname: typeof parsed.hostname === 'string' ? parsed.hostname : 'unknown',
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
      };
    } catch {
      // Unreadable or half-written: treat as unknown, never as safe to steal.
      return null;
    }
  }

  /**
   * A lock is reclaimable only when its PID is definitively gone on this host.
   * A lock from another host, or one too new to judge, is never stolen.
   */
  private isStale(info: LockInfo): boolean {
    if (info.hostname !== os.hostname()) return false;
    if (info.pid === process.pid) return false;
    if (Date.now() - info.startedAt < STALE_GRACE_MS) return false;

    try {
      // Signal 0 performs error checking without delivering a signal.
      process.kill(info.pid, 0);
      return false; // Process is alive.
    } catch (err: any) {
      // ESRCH: no such process. EPERM: alive but owned by another user.
      return err?.code === 'ESRCH';
    }
  }

  private async reclaim(info: LockInfo): Promise<boolean> {
    try {
      const current = await this.readLockInfo();
      // Only remove the exact lock that was judged stale.
      if (!current || current.pid !== info.pid || current.startedAt !== info.startedAt) return false;
      await fsp.unlink(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

/** Whether a lock file exists. Diagnostics only; never used to gate writes. */
export function lockFileExists(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, 'wicksentinel.lock'));
}
