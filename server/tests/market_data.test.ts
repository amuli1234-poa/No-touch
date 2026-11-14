import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { MarketDataService, MarketDataError, isSnapshotFresh } from '../services/marketData.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/**
 * Phase 3 tests: server-side market data over the public options gateway.
 *
 * The socket is a deterministic stand-in, so no network is touched. These tests
 * prove the shared-subscription behaviour, snapshot freshness, history mapping
 * and the reconnect re-subscribe path — the properties later phases rely on.
 */

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

/** A scriptable WebSocket stand-in that records what the service sends. */
function fakeSocket() {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const sent: any[] = [];
  const sock = {
    addEventListener: (t: string, fn: (e: any) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    send: (d: string) => sent.push(JSON.parse(d)),
    close: () => {},
    emit: (t: string, e: any = {}) => (listeners[t] || []).forEach((fn) => fn(e)),
    sent
  };
  return sock;
}

function tick(symbol: string, quote: number, epoch: number) {
  return JSON.stringify({
    msg_type: 'tick',
    tick: { symbol, quote, bid: quote - 0.1, ask: quote + 0.1, epoch, pip_size: 2 }
  });
}

async function connectedService(opts: { requestTimeoutMs?: number } = {}) {
  const cfg = makeConfig();
  let sock = fakeSocket();
  const svc = new MarketDataService(cfg, {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    pingIntervalMs: 0,
    reconnectBaseMs: 5,
    requestTimeoutMs: opts.requestTimeoutMs ?? 50,
    now: () => 1_000
  });
  await svc.connect();
  sock.emit('open');
  return { svc, sock: () => sock };
}

test('connect asks for the symbol catalogue and parses active_symbols', async () => {
  const { svc, sock } = await connectedService();
  try {
    assert.ok(sock().sent.some((m) => m.active_symbols === 'brief'));
    sock().emit('message', {
      data: JSON.stringify({
        msg_type: 'active_symbols',
        active_symbols: [
          {
            underlying_symbol: 'R_100',
            underlying_symbol_name: 'Volatility 100 Index',
            market: 'synthetic_index',
            submarket: 'random_index',
            pip_size: 2,
            exchange_is_open: 1,
            is_trading_suspended: 0
          }
        ]
      })
    });
    const symbols = await svc.getActiveSymbols();
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].symbol, 'R_100');
    assert.equal(symbols[0].exchangeOpen, true);
    assert.equal(svc.isKnownSymbol('R_100'), true);
    assert.equal(svc.isKnownSymbol('NOPE'), false);
  } finally {
    svc.close();
  }
});

test('subscribing sends one upstream ticks subscription and delivers snapshots', async () => {
  const { svc, sock } = await connectedService();
  try {
    const seen: number[] = [];
    const unsubA = svc.subscribeTicks('R_100', (t) => seen.push(t.quote));
    const unsubB = svc.subscribeTicks('R_100', (t) => seen.push(t.quote));
    // One upstream subscription for two local handlers.
    assert.equal(sock().sent.filter((m) => m.ticks === 'R_100').length, 1);

    sock().emit('message', { data: tick('R_100', 100, 10) });
    assert.deepEqual(seen, [100, 100]);
    assert.equal(svc.getSnapshot('R_100')?.quote, 100);
    assert.equal(svc.getSnapshot('R_100')?.bid, 99.9);
    assert.equal(svc.getSnapshot('R_100')?.ask, 100.1);
    assert.equal(svc.getSnapshot('R_100')?.epoch, 10);

    // Unsubscribing one handler keeps the upstream subscription alive.
    unsubA();
    assert.equal(sock().sent.filter((m) => m.forget).length, 0);
    // Unsubscribing the last handler forgets the symbol upstream.
    unsubB();
    assert.ok(sock().sent.some((m) => m.forget === 'R_100'));
  } finally {
    svc.close();
  }
});

test('tick buffers are bounded and ordered', async () => {
  const cfg = makeConfig();
  const sock = fakeSocket();
  const svc = new MarketDataService(cfg, {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    pingIntervalMs: 0,
    maxTicksPerSymbol: 3
  });
  await svc.connect();
  sock.emit('open');
  try {
    for (let i = 1; i <= 5; i++) sock.emit('message', { data: tick('R_100', i, i) });
    const ticks = svc.getTicks('R_100');
    assert.deepEqual(ticks.map((t) => t.quote), [3, 4, 5]);
  } finally {
    svc.close();
  }
});

test('waitForTick resolves on the next tick and rejects on timeout', async () => {
  const { svc, sock } = await connectedService({ requestTimeoutMs: 20 });
  try {
    const p = svc.waitForTick('R_100', 20);
    sock().emit('message', { data: tick('R_100', 42, 1) });
    assert.equal((await p).quote, 42);

    await assert.rejects(
      () => svc.waitForTick('R_50', 20),
      (e: unknown) => e instanceof MarketDataError && e.code === 'timeout'
    );
  } finally {
    svc.close();
  }
});

test('getTicksHistory maps prices and times into snapshots', async () => {
  const { svc, sock } = await connectedService();
  try {
    const p = svc.getTicksHistory('R_100', 3);
    // Respond to the request that was just sent (match by req_id).
    const req = sock().sent.find((m) => m.ticks_history === 'R_100');
    sock().emit('message', {
      data: JSON.stringify({
        msg_type: 'history',
        req_id: req.req_id,
        pip_size: 2,
        history: { prices: [10, 11, 12], times: [1, 2, 3] }
      })
    });
    const hist = await p;
    assert.deepEqual(hist.map((t) => t.quote), [10, 11, 12]);
    assert.deepEqual(hist.map((t) => t.epoch), [1, 2, 3]);
    assert.equal(hist[0].symbol, 'R_100');
  } finally {
    svc.close();
  }
});

test('reconnect re-subscribes to every active symbol', async () => {
  const { svc, sock } = await connectedService();
  try {
    svc.subscribeTicks('R_100', () => {});
    svc.subscribeTicks('R_50', () => {});
    const before = sock().sent.filter((m) => m.ticks).length;
    assert.equal(before, 2);
    // Simulate the connection coming back: the service re-sends subscriptions.
    sock().emit('open');
    const after = sock().sent.filter((m) => m.ticks).length;
    assert.equal(after, 4, 'both symbols re-subscribed after reopen');
  } finally {
    svc.close();
  }
});

test('a Deriv error response rejects the pending request', async () => {
  const { svc, sock } = await connectedService();
  try {
    const p = svc.getTicksHistory('BAD', 3);
    const req = sock().sent.find((m) => m.ticks_history === 'BAD');
    sock().emit('message', {
      data: JSON.stringify({ msg_type: 'history', req_id: req.req_id, error: { message: 'Unknown symbol' } })
    });
    await assert.rejects(p, (e: unknown) => e instanceof MarketDataError && e.code === 'deriv_error');
  } finally {
    svc.close();
  }
});

test('the service refuses a non-Deriv gateway URL', async () => {
  const cfg = makeConfig();
  const svc = new MarketDataService(cfg, {
    wsFactory: () => fakeSocket() as unknown as MinimalWebSocket,
    url: 'wss://evil.example.com/ws'
  });
  await assert.rejects(
    () => svc.connect(),
    (e: unknown) => e instanceof MarketDataError && e.code === 'socket_failed'
  );
  svc.close();
});

test('isSnapshotFresh only accepts a recent snapshot', () => {
  const snap = { symbol: 'R_100', quote: 1, bid: null, ask: null, epoch: 1, pipSize: null, receivedAt: 1000 };
  assert.equal(isSnapshotFresh(snap, 500, 1200), true);
  assert.equal(isSnapshotFresh(snap, 500, 1600), false);
  assert.equal(isSnapshotFresh(null, 500, 1000), false);
});

test('requests auto-connect and reject on timeout if no response arrives', async () => {
  const cfg = makeConfig();
  const sock = fakeSocket();
  const svc = new MarketDataService(cfg, {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    pingIntervalMs: 0,
    requestTimeoutMs: 20
  });
  try {
    // getTicksHistory calls connect() itself, then waits for a response.
    await assert.rejects(
      () => svc.getTicksHistory('R_100'),
      (e: unknown) => e instanceof MarketDataError && e.code === 'timeout'
    );
  } finally {
    svc.close();
  }
});
