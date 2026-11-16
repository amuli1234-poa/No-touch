/**
 * Shared cache.
 *
 * Redis is used as a CACHE, never as a system of record. Everything stored here
 * is recomputable from the upstream socket or the store, so a Redis outage
 * degrades to "do the work again" and can never lose a trade, a session or a
 * signal. The contract is deliberately narrow — get / set / del with a TTL — so
 * the cache cannot grow business logic of its own.
 *
 * Two implementations satisfy it:
 *   - `MemoryCache`  — an in-process Map with TTL. The default, and the fallback
 *                      whenever Redis is unconfigured or unreachable.
 *   - `RedisCache`   — ioredis-backed, shared across processes.
 *
 * `createCache` never throws and never blocks boot: a bad or unreachable Redis
 * degrades to the memory cache. ioredis is imported lazily so a deployment that
 * does not use Redis never loads the client.
 */

export interface Cache {
  readonly kind: 'memory' | 'redis';
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** A liveness probe for the health surface. */
  ping(): Promise<boolean>;
  /** Releases the underlying connection. */
  close(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** In-process TTL cache. Used alone, or as the fallback when Redis is down. */
export class MemoryCache implements Cache {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, Entry>();
  private readonly defaultTtlSeconds: number;

  constructor(defaultTtlSeconds = 60) {
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = this.defaultTtlSeconds): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

/** Minimal surface of ioredis that the cache relies on, so tests can fake it. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  on(event: string, handler: (...args: any[]) => void): unknown;
}

export class RedisCache implements Cache {
  readonly kind = 'redis' as const;
  private healthy = true;

  constructor(
    private readonly client: RedisLike,
    private readonly prefix: string,
    private readonly defaultTtlSeconds = 60,
    /** Called when a command fails, so the caller can fall back to memory. */
    private readonly onError: (err: unknown) => void = () => {}
  ) {
    this.client.on('error', (err) => this.onError(err));
    this.client.on('ready', () => {
      this.healthy = true;
    });
    this.client.on('end', () => {
      this.healthy = false;
    });
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(this.key(key));
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
      this.onError(err);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = this.defaultTtlSeconds): Promise<void> {
    try {
      await this.client.set(this.key(key), JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.onError(err);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(this.key(key));
    } catch (err) {
      this.onError(err);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      this.healthy = pong === 'PONG';
      return this.healthy;
    } catch (err) {
      this.onError(err);
      this.healthy = false;
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      /* closing a dead connection is not an error */
    }
  }
}

/**
 * A cache that prefers Redis and silently falls back to memory whenever a Redis
 * call fails. This keeps a flapping Redis from turning into user-visible errors:
 * the first failure demotes reads/writes to the local cache for `retryMs`, then
 * a later call re-probes Redis. Correctness never depends on Redis.
 */
export class ResilientCache implements Cache {
  kind: 'memory' | 'redis';
  private usingRedis: boolean;
  private lastFailureAt = 0;

  constructor(
    private readonly primary: RedisCache,
    private readonly fallback: MemoryCache,
    private readonly retryMs = 15_000
  ) {
    this.usingRedis = true;
    this.kind = 'redis';
  }

  private get active(): Cache {
    if (this.usingRedis) return this.primary;
    // Periodically re-probe Redis rather than staying demoted forever. A
    // retryMs of 0 means "retry on the very next call".
    if (Date.now() - this.lastFailureAt >= this.retryMs) {
      this.usingRedis = true;
      this.kind = 'redis';
      return this.primary;
    }
    return this.fallback;
  }

  private demote(): void {
    if (this.usingRedis) {
      this.usingRedis = false;
      this.kind = 'memory';
    }
    this.lastFailureAt = Date.now();
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.active.get<T>(key);
    return value;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.active.set(key, value, ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.active.del(key);
  }

  async ping(): Promise<boolean> {
    if (!this.usingRedis) return false;
    const ok = await this.primary.ping();
    if (!ok) this.demote();
    return ok;
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()]);
  }

  /** Records a Redis command failure observed elsewhere (e.g. by ioredis). */
  noteFailure(): void {
    this.demote();
  }
}

export interface CreateCacheOptions {
  url: string | null;
  keyPrefix: string;
  ttlSeconds: number;
  /** Injected for tests: builds a RedisLike client from a URL. */
  clientFactory?: (url: string) => RedisLike;
}

/**
 * Builds the cache. Returns a ResilientCache when Redis is configured, otherwise
 * a plain MemoryCache. Never throws: an unreachable Redis logs once and falls
 * back to memory, so a missing cache server cannot stop the app from booting.
 */
export async function createCache(opts: CreateCacheOptions): Promise<Cache> {
  const memory = new MemoryCache(opts.ttlSeconds);
  if (!opts.url) return memory;

  let client: RedisLike;
  try {
    if (opts.clientFactory) {
      client = opts.clientFactory(opts.url);
    } else {
      // Lazy so a deployment without Redis never loads the driver.
      const mod = (await import('ioredis')) as unknown as {
        default: new (url: string, opts?: Record<string, unknown>) => RedisLike;
      };
      const Redis = mod.default;
      client = new Redis(opts.url, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
        retryStrategy: (times: number) => Math.min(times * 200, 5_000)
      }) as unknown as RedisLike;
    }
  } catch (err) {
    console.warn('[cache] Redis unavailable, using the in-process cache:', (err as Error).message);
    return memory;
  }

  const resilient = new ResilientCache(
    new RedisCache(client, opts.keyPrefix, opts.ttlSeconds, () => resilient.noteFailure()),
    memory
  );
  const ok = await resilient.ping();
  if (!ok) {
    console.warn('[cache] Redis did not respond to PING; using the in-process cache until it recovers.');
  } else {
    console.log(`[cache] Redis cache connected (${opts.keyPrefix}*).`);
  }
  return resilient;
}

/* --------------------------------- keys ---------------------------------- */

/** Namespaced cache keys, kept in one place so they cannot drift apart. */
export const CacheKeys = {
  activeSymbols: () => 'market:active-symbols',
  snapshot: (symbol: string) => `market:snapshot:${symbol}`,
  scannerReading: (symbol: string) => `scanner:reading:${symbol}`
} as const;
