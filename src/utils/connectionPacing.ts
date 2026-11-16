import { WS_MAX_RECONNECT_DELAY_MS, WS_RATE_LIMIT_BACKOFF_MS } from '../config/deriv';

/**
 * Pure helpers behind the Deriv connection manager's resilience. They are kept separate
 * from the WebSocket service so the pacing / backoff policy can be unit-tested without a
 * live socket. Nothing here fabricates a status — it only translates what the server and
 * the clock actually report.
 */

/** True when a Deriv error code/message means the connection is being throttled. */
export function isRateLimitError(code: string | undefined, message: string): boolean {
  if (code && /rate|limit/i.test(code)) return true;
  return /rate.?limit|too many requests/i.test(message);
}

/**
 * How long to pause outbound requests (ms) after a server rate-limit error. Deriv reports
 * the remaining seconds on the error object; we honour it (capped) and fall back to a fixed
 * conservative backoff when it is absent or unparseable.
 */
export function rateLimitBackoffMs(errorObj: Record<string, unknown>): number {
  const rl = errorObj.rate_limit as Record<string, unknown> | undefined;
  const remaining =
    rl && typeof rl.remaining_seconds === 'number'
      ? rl.remaining_seconds
      : typeof errorObj.rate_limit === 'number'
        ? (errorObj.rate_limit as number)
        : null;
  if (remaining !== null && Number.isFinite(remaining) && remaining > 0) {
    return Math.min(remaining * 1000, 30_000);
  }
  return WS_RATE_LIMIT_BACKOFF_MS;
}

/**
 * Exponential backoff with full jitter. The jitter spreads reconnects so many clients (or
 * tabs) never stampede the endpoint at the same instant after an outage. `rand` defaults to
 * Math.random and is injectable for deterministic tests.
 */
export function nextReconnectDelay(
  attempt: number,
  rand: () => number = Math.random,
  maxDelay = WS_MAX_RECONNECT_DELAY_MS
): number {
  const base = Math.min(maxDelay, 1000 * Math.pow(2, Math.max(0, attempt)));
  return base / 2 + rand() * (base / 2);
}

/**
 * The delay (ms) before the next queued request may be sent, given the current time, the
 * last send time and any active rate-limit gate. Returns 0 when a slot is free now.
 */
export function nextSendDelayMs(params: {
  now: number;
  lastSendAt: number;
  minIntervalMs: number;
  rateLimitedUntil: number;
}): number {
  const { now, lastSendAt, minIntervalMs, rateLimitedUntil } = params;
  const gate = Math.max(rateLimitedUntil, lastSendAt + minIntervalMs);
  return Math.max(0, gate - now);
}

/**
 * Sliding-window rate limiter for `ticks_history`. The public endpoint allows ~50 history
 * requests per window and then answers `RateLimit` (measured against the live server), so
 * the limiter holds each request until fewer than `maxPerWindow` have been released in the
 * trailing `windowMs`. Keeping our own budget below the server's means a full sweep of
 * every eligible market never trips the server limit at all — which matters because the
 * server limit is per connection and is NOT reset by reconnecting.
 */
export class SlidingWindowLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number
  ) {}

  /** Records a release at `now` and drops stamps that have aged out of the window. */
  private prune(now: number) {
    const cutoff = now - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift();
  }

  /** Delay (ms) until a slot is free. 0 means the request may be released immediately. */
  delayMs(now: number): number {
    this.prune(now);
    if (this.stamps.length < this.maxPerWindow) return 0;
    return Math.max(0, this.stamps[0] + this.windowMs - now);
  }

  /** Reserves a slot at `now`. Call only when `delayMs(now) === 0`. */
  record(now: number) {
    this.prune(now);
    this.stamps.push(now);
  }

  /** Requests released inside the current window (for diagnostics). */
  used(now: number): number {
    this.prune(now);
    return this.stamps.length;
  }

  /**
   * Marks the window as fully consumed. Called when the SERVER reports `RateLimit`, so the
   * client stops issuing history requests until the window clears even though it believed it
   * had budget left (the server's own accounting always wins).
   */
  exhaust(now: number) {
    this.stamps = Array.from({ length: this.maxPerWindow }, (_, i) => now - i);
  }
}
