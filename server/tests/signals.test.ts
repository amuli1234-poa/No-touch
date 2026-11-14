import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import { MarketDataService } from '../services/marketData.js';
import {
  createSignal,
  validateSignalForExecution,
  consumeSignal,
  contractTypeFor,
  SignalError
} from '../services/signals.js';
import { validateStrategy, priceInZone, DEFAULT_STRATEGY_POLICY } from '../services/strategy.js';
import type { SignalRecord } from '../execution/types.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/**
 * Phase 4 tests: signal creation/validation and strategy validation.
 *
 * Signals are created against the real market data service (with a scripted
 * socket) and the real store. Nothing here executes a trade.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sig-'));
}

function makeConfig(): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir: os.tmpdir(),
    storageEngine: 'auto',
    telemetry: { retentionDays: 30, scannerSessionTtlSeconds: 120 },
    deriv: {
      appId: 'test-app',
      redirectUri: 'http://localhost:3000/auth/deriv/callback',
      clientSecret: null,
      scopes: 'trade',
      authorizationEndpoint: 'http://127.0.0.1:1/oauth2/auth',
      tokenEndpoint: 'http://127.0.0.1:1/oauth2/token',
      userinfoEndpoint: 'http://127.0.0.1:1/userinfo',
      revocationEndpoint: 'http://127.0.0.1:1/oauth2/revoke',
      apiBaseUrl: 'http://127.0.0.1:1'
    },
    session: {
      secret: 'test_session_secret_at_least_32_characters_long_000',
      ttlSeconds: 3600,
      cookieName: 'ws_session',
      oauthCookieName: 'ws_oauth',
      oauthCookieTtlSeconds: 600
    },
    admin: {
      cookieName: 'ws_admin_session',
      sessionTtlSeconds: 3600,
      mfaPendingTtlSeconds: 300,
      invitationTtlSeconds: 3600,
      resetTtlSeconds: 3600,
      allowedOrigins: [],
      maxFailedLogins: 5,
      lockoutSeconds: 60
    },
    appOrigin: 'http://localhost:8787'
  };
}

function fakeSocket() {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const sent: any[] = [];
  return {
    addEventListener: (t: string, fn: (e: any) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    send: (d: string) => sent.push(JSON.parse(d)),
    close: () => {},
    emit: (t: string, e: any = {}) => (listeners[t] || []).forEach((fn) => fn(e)),
    sent
  };
}

const NOW = 1_000_000;

async function harness() {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const sock = fakeSocket();
  const market = new MarketDataService(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    pingIntervalMs: 0,
    now: () => NOW
  });
  await market.connect();
  sock.emit('open');
  // Feed a symbol catalogue and a fresh tick.
  sock.emit('message', {
    data: JSON.stringify({
      msg_type: 'active_symbols',
      active_symbols: [
        { underlying_symbol: 'R_100', underlying_symbol_name: 'Volatility 100', pip_size: 2, exchange_is_open: 1 },
        { underlying_symbol: 'R_50', underlying_symbol_name: 'Volatility 50', pip_size: 4, exchange_is_open: 1 }
      ]
    })
  });
  const feedTick = (symbol: string, quote: number, epoch = 1) =>
    sock.emit('message', { data: JSON.stringify({ msg_type: 'tick', tick: { symbol, quote, epoch, pip_size: 2 } }) });
  feedTick('R_100', 100);
  return { store, market, sock, feedTick };
}

function baseInput(overrides: Partial<Parameters<typeof createSignal>[2]> = {}) {
  return {
    userId: 'u_a',
    accountId: 'VRTC_A',
    accountMode: 'demo' as const,
    symbol: 'R_100',
    timeframe: '5m',
    direction: 'RISE' as const,
    contractFamily: 'rise_fall' as const,
    analysisId: 'an_1',
    confidence: 0.7,
    reason: 'breakout',
    ...overrides
  };
}

/* ------------------------------ contract type ----------------------------- */

test('directions map to the correct Deriv contract types per family', () => {
  assert.equal(contractTypeFor('RISE', 'rise_fall'), 'CALL');
  assert.equal(contractTypeFor('FALL', 'rise_fall'), 'PUT');
  assert.equal(contractTypeFor('RISE', 'multipliers'), 'MULTUP');
  assert.equal(contractTypeFor('FALL', 'multipliers'), 'MULTDOWN');
  assert.throws(() => contractTypeFor('NONE', 'rise_fall'), SignalError);
});

/* -------------------------------- creation -------------------------------- */

test('createSignal records a validated signal with an expiry and the live price', async () => {
  const { store, market } = await harness();
  try {
    const sig = await createSignal(store, market, baseInput(), { ttlSeconds: 60, now: () => NOW });
    assert.equal(sig.symbol, 'R_100');
    assert.equal(sig.direction, 'RISE');
    assert.equal(sig.entryPrice, 100);
    assert.equal(sig.expiresAt, NOW + 60_000);
    assert.equal(sig.consumedByIntentId, null);
    // It is persisted and tenant-scoped.
    assert.equal(store.getSignal('u_a', sig.id)?.id, sig.id);
    assert.equal(store.getSignal('u_b', sig.id), null);
  } finally {
    await store.close();
    market.close();
  }
});

test('createSignal refuses an unknown symbol', async () => {
  const { store, market } = await harness();
  try {
    await assert.rejects(
      () => createSignal(store, market, baseInput({ symbol: 'NOPE' }), { now: () => NOW }),
      (e: unknown) => e instanceof SignalError && e.code === 'invalid_symbol'
    );
  } finally {
    await store.close();
    market.close();
  }
});

test('createSignal refuses a symbol with no price yet', async () => {
  const { store, market } = await harness();
  try {
    // R_50 is known but no tick has arrived for it.
    await assert.rejects(
      () => createSignal(store, market, baseInput({ symbol: 'R_50' }), { now: () => NOW }),
      (e: unknown) => e instanceof SignalError && e.code === 'no_price'
    );
  } finally {
    await store.close();
    market.close();
  }
});

test('createSignal refuses a stale price', async () => {
  const { store, market } = await harness();
  try {
    // The tick was stamped receivedAt=NOW; evaluate much later.
    await assert.rejects(
      () => createSignal(store, market, baseInput(), { now: () => NOW + 60_000, maxPriceAgeMs: 5_000 }),
      (e: unknown) => e instanceof SignalError && e.code === 'stale_price'
    );
  } finally {
    await store.close();
    market.close();
  }
});

test('createSignal enforces the confidence range and floor', async () => {
  const { store, market } = await harness();
  try {
    await assert.rejects(
      () => createSignal(store, market, baseInput({ confidence: 1.5 }), { now: () => NOW }),
      (e: unknown) => e instanceof SignalError && e.code === 'invalid_confidence'
    );
    await assert.rejects(
      () => createSignal(store, market, baseInput({ confidence: 0.2 }), { now: () => NOW, minConfidence: 0.5 }),
      (e: unknown) => e instanceof SignalError && e.code === 'invalid_confidence'
    );
  } finally {
    await store.close();
    market.close();
  }
});

test('createSignal refuses a NONE direction', async () => {
  const { store, market } = await harness();
  try {
    await assert.rejects(
      () => createSignal(store, market, baseInput({ direction: 'NONE' }), { now: () => NOW }),
      (e: unknown) => e instanceof SignalError && e.code === 'invalid_direction'
    );
  } finally {
    await store.close();
    market.close();
  }
});

/* ------------------------------- validation ------------------------------- */

test('validateSignalForExecution enforces ownership, expiry and single use', async () => {
  const { store, market } = await harness();
  try {
    const sig = await createSignal(store, market, baseInput(), { ttlSeconds: 30, now: () => NOW });

    // Wrong owner: not found, never leaked.
    assert.throws(
      () => validateSignalForExecution(store, 'u_b', sig.id, { now: () => NOW }),
      (e: unknown) => e instanceof SignalError && e.code === 'not_found'
    );
    // Valid before expiry.
    assert.equal(validateSignalForExecution(store, 'u_a', sig.id, { now: () => NOW }).id, sig.id);
    // Expired.
    assert.throws(
      () => validateSignalForExecution(store, 'u_a', sig.id, { now: () => NOW + 31_000 }),
      (e: unknown) => e instanceof SignalError && e.code === 'expired'
    );
    // Freshness window tighter than the TTL.
    assert.throws(
      () => validateSignalForExecution(store, 'u_a', sig.id, { now: () => NOW + 10_000, freshnessSeconds: 5 }),
      (e: unknown) => e instanceof SignalError && e.code === 'expired'
    );
  } finally {
    await store.close();
    market.close();
  }
});

test('a signal can be consumed only once', async () => {
  const { store, market } = await harness();
  try {
    const sig = await createSignal(store, market, baseInput(), { ttlSeconds: 30, now: () => NOW });
    const consumed = await consumeSignal(store, 'u_a', sig.id, 'int_1');
    assert.equal(consumed.consumedByIntentId, 'int_1');
    // Reuse is refused.
    await assert.rejects(
      () => consumeSignal(store, 'u_a', sig.id, 'int_2'),
      (e: unknown) => e instanceof SignalError && e.code === 'already_consumed'
    );
    assert.throws(
      () => validateSignalForExecution(store, 'u_a', sig.id, { now: () => NOW }),
      (e: unknown) => e instanceof SignalError && e.code === 'already_consumed'
    );
  } finally {
    await store.close();
    market.close();
  }
});

/* ------------------------------- strategy --------------------------------- */

function signalFixture(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: 'sig_1',
    userId: 'u_a',
    accountId: 'VRTC_A',
    accountMode: 'demo',
    symbol: 'R_100',
    timeframe: '5m',
    direction: 'RISE',
    contractFamily: 'rise_fall',
    analysisId: 'an_1',
    zone: null,
    entryPrice: 100,
    confidence: 0.7,
    reason: '',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    consumedByIntentId: null,
    ...overrides
  };
}

test('priceInZone is inclusive and order-independent', () => {
  assert.equal(priceInZone(5, { low: 1, high: 10 }), true);
  assert.equal(priceInZone(10, { low: 1, high: 10 }), true);
  assert.equal(priceInZone(11, { low: 1, high: 10 }), false);
  assert.equal(priceInZone(5, { low: 10, high: 1 }), true, 'reversed bounds still work');
});

test('strategy approves an agreeing analysis under the default policy', () => {
  const v = validateStrategy(signalFixture(), { symbol: 'R_100', timeframe: '5m', direction: 'RISE' });
  assert.equal(v.approved, true);
  assert.deepEqual(v.reasons, []);
});

test('strategy rejects a direction disagreement and names the failed check', () => {
  const v = validateStrategy(signalFixture(), { symbol: 'R_100', timeframe: '5m', direction: 'FALL' });
  assert.equal(v.approved, false);
  assert.deepEqual(v.reasons, ['direction_agreement']);
});

test('strategy rejects a NONE analysis direction', () => {
  const v = validateStrategy(signalFixture(), { symbol: 'R_100', timeframe: '5m', direction: 'NONE' });
  assert.equal(v.approved, false);
  assert.ok(v.reasons.includes('direction_agreement'));
});

test('strategy rejects symbol and timeframe mismatches', () => {
  const v = validateStrategy(signalFixture(), { symbol: 'R_50', timeframe: '1h', direction: 'RISE' });
  assert.equal(v.approved, false);
  // Direction agrees, so only the symbol and timeframe checks fail.
  assert.deepEqual([...v.reasons].sort(), ['symbol_match', 'timeframe_match']);
});

test('strategy enforces zone and price-in-zone when required', () => {
  const policy = { ...DEFAULT_STRATEGY_POLICY, requireZone: true, requirePriceInZone: true };
  const base = { symbol: 'R_100', timeframe: '5m', direction: 'RISE' as const };
  // No zone at all.
  assert.deepEqual(validateStrategy(signalFixture(), base, policy).reasons, ['zone_present', 'price_in_zone']);
  // Zone present, price outside.
  assert.deepEqual(
    validateStrategy(signalFixture(), { ...base, zone: { low: 90, high: 95 }, price: 100 }, policy).reasons,
    ['price_in_zone']
  );
  // Zone present, price inside.
  assert.equal(validateStrategy(signalFixture(), { ...base, zone: { low: 95, high: 105 }, price: 100 }, policy).approved, true);
});

test('strategy enforces the confidence floor when set', () => {
  const policy = { ...DEFAULT_STRATEGY_POLICY, minConfidence: 0.8 };
  const base = { symbol: 'R_100', timeframe: '5m', direction: 'RISE' as const };
  assert.deepEqual(validateStrategy(signalFixture(), { ...base, confidence: 0.5 }, policy).reasons, ['confidence_floor']);
  assert.equal(validateStrategy(signalFixture(), { ...base, confidence: 0.9 }, policy).approved, true);
});

test('strategy enforces trend alignment when required', () => {
  const policy = { ...DEFAULT_STRATEGY_POLICY, requireTrendAlignment: true };
  const base = { symbol: 'R_100', timeframe: '5m', direction: 'RISE' as const };
  assert.deepEqual(validateStrategy(signalFixture(), { ...base, trend: 'FALL' }, policy).reasons, ['trend_alignment']);
  assert.equal(validateStrategy(signalFixture(), { ...base, trend: 'RISE' }, policy).approved, true);
});
