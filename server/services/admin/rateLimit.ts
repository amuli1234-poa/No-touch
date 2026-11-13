/**
 * In-memory fixed-window rate limiter for admin authentication endpoints.
 *
 * Keyed by a caller-supplied key (usually `<route>:<ip>`). State lives in the
 * process; for a multi-instance deployment this should be backed by a shared
 * store, which is noted in the security limitations. It exists to blunt
 * credential stuffing and brute force on the login and MFA routes.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private limit: number,
    private windowMs: number
  ) {}

  /** Records an attempt. Returns whether the caller is still allowed. */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count > this.limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Clears a key (e.g. after a successful login). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drops expired buckets; called opportunistically. */
  prune(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
