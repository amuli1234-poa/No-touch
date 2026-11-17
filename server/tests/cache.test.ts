import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryCache,
  RedisCache,
  ResilientCache,
  createCache,
  CacheKeys,
  type RedisLike
} from '../services/cache.js';

/**
 * Cache tests.
 *
 * The cache is a recomputable-read store, so these tests focus on the two
 * properties that matter: TTL expiry, and the guarantee that a Redis outage
 * degrades to the in-process cache instead of surfacing errors.
 */

/** A scriptable RedisLike whose commands can be made to fail on demand. */
class FakeRedis implements RedisLike {
  readonly store = new Map<string, string>();
  failNext = false;
  pings = 0;
  quitCalled = false;
  private readonly handlers = new Map<string, ((...a: any[]) => void)[]>();

  on(event: string, handler: (...args: any[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }

  private guard(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('redis down');
    }
  }

  async get(key: string): Promise<string | null> {
    this.guard();
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.guard();
    this.store.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<unknown> {
    this.guard();
    return this.store.delete(key) ? 1 : 0;
  }

  async ping(): Promise<string> {
    this.guard();
    this.pings += 1;
    return 'PONG';
  }

  async quit(): Promise<unknown> {
    this.quitCalled = true;
    return 'OK';
  }
}

test('MemoryCache stores and returns values', async () => {
  const cache = new MemoryCache(60);
  await cache.set('a', { n: 1 });
  assert.deepEqual(await cache.get('a'), { n: 1 });
  assert.equal(await cache.get('missing'), null);
});

test('MemoryCache honours the TTL', async () => {
  const cache = new MemoryCache(60);
  // A zero-second TTL expires immediately.
  await cache.set('a', 'x', 0);
  assert.equal(await cache.get('a'), null);
});

test('MemoryCache delete removes a key', async () => {
  const cache = new MemoryCache(60);
  await cache.set('a', 1);
  await cache.del('a');
  assert.equal(await cache.get('a'), null);
});

test('RedisCache namespaces keys with the prefix', async () => {
  const client = new FakeRedis();
  const cache = new RedisCache(client, 'test:', 60);
  await cache.set('foo', 42);
  assert.equal(await client.get('test:foo'), '42');
  assert.equal(await cache.get('foo'), 42);
});

test('RedisCache swallows a command error and returns null', async () => {
  const client = new FakeRedis();
  let errors = 0;
  const cache = new RedisCache(client, 'test:', 60, () => {
    errors += 1;
  });
  client.failNext = true;
  assert.equal(await cache.get('foo'), null);
  assert.equal(errors, 1);
});

test('createCache returns a MemoryCache when no URL is configured', async () => {
  const cache = await createCache({ url: null, keyPrefix: 'x:', ttlSeconds: 60 });
  assert.equal(cache.kind, 'memory');
});

test('createCache falls back to memory when Redis PING fails', async () => {
  const client = new FakeRedis();
  client.failNext = true; // the initial ping fails
  const cache = await createCache({
    url: 'redis://example:6379',
    keyPrefix: 'x:',
    ttlSeconds: 60,
    clientFactory: () => client
  });
  // The resilient wrapper stays, but it reports itself unhealthy.
  assert.equal(await cache.ping(), false);
  // Writes still succeed by landing in the in-process fallback.
  await cache.set('k', 'v');
  assert.equal(await cache.get('k'), 'v');
});

test('createCache uses Redis when it is reachable', async () => {
  const client = new FakeRedis();
  const cache = await createCache({
    url: 'redis://example:6379',
    keyPrefix: 'x:',
    ttlSeconds: 60,
    clientFactory: () => client
  });
  assert.equal(cache.kind, 'redis');
  await cache.set('k', { ok: true });
  assert.deepEqual(await cache.get('k'), { ok: true });
  assert.ok(client.pings >= 1);
});

test('ResilientCache demotes to memory on failure and recovers', async () => {
  const client = new FakeRedis();
  const primary = new RedisCache(client, 'x:', 60);
  const fallback = new MemoryCache(60);
  const cache = new ResilientCache(primary, fallback, 30);

  await cache.set('k', 'redis-value');
  assert.equal(await cache.get('k'), 'redis-value');

  // A failed command demotes the cache; reads and writes then use memory until
  // the retry window elapses.
  cache.noteFailure();
  await cache.set('k', 'memory-value');
  assert.equal(await cache.get('k'), 'memory-value');

  // Once the retry window passes, the next call re-probes Redis and sees the
  // value written there before the demotion.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await cache.get('k'), 'redis-value');
});

test('CacheKeys are namespaced and symbol-scoped', () => {
  assert.equal(CacheKeys.activeSymbols(), 'market:active-symbols');
  assert.equal(CacheKeys.snapshot('R_100'), 'market:snapshot:R_100');
});
