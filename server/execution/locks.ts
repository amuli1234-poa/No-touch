/**
 * Account-level execution locks.
 *
 * A single process must never run two executions for the same account at the
 * same time: the risk engine reads open contracts and exposure, so two
 * overlapping submissions could both pass the check and both buy. This is a
 * small in-process mutex keyed by account id.
 *
 * The store's SQLite backend owns cross-process atomicity for the *records*; the
 * lock here serialises the *decision-and-submit* sequence within the process.
 * Both are needed: the lock stops concurrent double-execution, the transaction
 * stops a torn record.
 *
 * A caller that waits longer than `timeoutMs` is rejected AND still releases its
 * place in the queue, so a timeout can never deadlock the account.
 */

export class LockTimeoutError extends Error {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`Timed out waiting for the execution lock on account ${accountId}.`);
    this.name = 'LockTimeoutError';
    this.accountId = accountId;
  }
}

/** Resolves true when `p` settles within `ms`, false on timeout. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      }
    );
  });
}

export class ExecutionLocks {
  /** accountId -> a promise that resolves when the current holder releases. */
  private readonly tails = new Map<string, Promise<void>>();
  private readonly held = new Set<string>();

  /** True when the account currently holds the lock. */
  isLocked(accountId: string): boolean {
    return this.held.has(accountId);
  }

  /**
   * Runs `fn` while holding the account's lock, serialising concurrent callers.
   * Rejects with LockTimeoutError if the lock is not obtained within `timeoutMs`.
   */
  async withLock<T>(accountId: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    const previous = this.tails.get(accountId) ?? Promise.resolve();

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    // The next waiter awaits this caller's gate, forming a fair queue.
    const tail = previous.then(() => gate);
    this.tails.set(accountId, tail);

    const cleanup = () => {
      if (this.tails.get(accountId) === tail) this.tails.delete(accountId);
    };

    const acquired = await settledWithin(previous, timeoutMs);
    if (!acquired) {
      // Give up our place so the queue keeps moving, then fail.
      releaseGate();
      cleanup();
      throw new LockTimeoutError(accountId);
    }

    this.held.add(accountId);
    try {
      return await fn();
    } finally {
      this.held.delete(accountId);
      releaseGate();
      cleanup();
    }
  }
}
