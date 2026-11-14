/**
 * Store-level failures, kept separate from the persistence implementation so a
 * future PostgreSQL driver can raise the same error contract.
 */

/**
 * Another live process already holds the data directory. Thrown *before* any
 * read or write, so a second writer can never load a stale snapshot and then
 * overwrite the first writer's records.
 */
export class StoreLockedError extends Error {
  readonly code = 'STORE_LOCKED';
  constructor(
    message: string,
    readonly holder: { pid: number; hostname: string; startedAt: number } | null
  ) {
    super(message);
    this.name = 'StoreLockedError';
  }
}

/**
 * The on-disk file changed underneath this process. The in-memory snapshot is
 * therefore stale, and writing it would silently destroy the other writer's
 * records. The store latches into a poisoned state and refuses further writes
 * rather than corrupting data.
 */
export class StoreConflictError extends Error {
  readonly code = 'STORE_CONFLICT';
  constructor(
    message: string,
    readonly detail: { expectedMtimeMs: number | null; actualMtimeMs: number | null }
  ) {
    super(message);
    this.name = 'StoreConflictError';
  }
}
