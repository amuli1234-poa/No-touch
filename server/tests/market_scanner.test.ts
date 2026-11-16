import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import { ExecutionGateway } from '../execution/gateway.js';
import { AutoExecutionRunner } from '../execution/autoRunner.js';
import { ExecutionAuditor } from '../execution/audit.js';
import { FakeBroker } from '../execution/broker/fakeBroker.js';
import { MarketDataService, type MarketSnapshot } from '../services/marketData.js';
import { MarketScanner, analyseTicks, isEligibleVolatilitySymbol, DEFAULT_SCANNER_OPTIONS } from '../services/marketScanner.js';
import { effectiveRiskProfile, evaluateRisk } from '../services/risk.js';
import { seal } from '../lib/crypto.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';
import type { ExecutionPreferencesRecord } from '../execution/types.js';

/**
 * Market scanner tests.
 *
 * The score is pure, so most of this is deterministic arithmetic. The pass test
 * drives the real pipeline end to end — ticks -> score -> signal -> automatic
 * runner -> fake broker — with no network and a frozen clock.
 */

// Anchored to the real clock: the store and createSignal stamp with Date.now().
const NOW = Date.now();
const clock = () => NOW;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scanner-'));
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

function snapshot(quote: number, receivedAt = NOW): MarketSnapshot {
  return { symbol: 'R_100', quote, bid: null, ask: null, epoch: 0, pipSize: 2, receivedAt };
}

function series(quotes: number[]): MarketSnapshot[] {
  return quotes.map((q) => snapshot(q));
}

test('analyseTicks reads a clean uptrend as RISE', () => {
  const reading = analyseTicks(series([100, 101, 102, 103, 104, 105]), { ...DEFAULT_SCANNER_OPTIONS, minTicks: 5 }, NOW);
  assert.ok(reading);
  assert.equal(reading!.direction, 'RISE');
  assert.equal(reading!.confidence, 1); // a straight line: net == path
});

test('analyseTicks reads a clean downtrend as FALL', () => {
  const reading = analyseTicks(series([105, 104, 103, 102, 101, 100]), { ...DEFAULT_SCANNER_OPTIONS, minTicks: 5 }, NOW);
  assert.equal(reading?.direction, 'FALL');
});

test('analyseTicks refuses a choppy market that ends where it started', () => {
  const reading = analyseTicks(series([100, 110, 100, 110, 100, 110, 100]), { ...DEFAULT_SCANNER_OPTIONS, minTicks: 5 }, NOW);
  assert.equal(reading, null);
});

test('analyseTicks refuses a market with too few ticks', () => {
  const reading = analyseTicks(series([100, 101, 102]), { ...DEFAULT_SCANNER_OPTIONS, minTicks: 5 }, NOW);
  assert.equal(reading, null);
});

test('analyseTicks ignores ticks outside the time window', () => {
  const stale = series([100, 101, 102, 103, 104, 105]).map((s) => ({ ...s, receivedAt: NOW - 10 * 60_000 }));
  const reading = analyseTicks(stale, { ...DEFAULT_SCANNER_OPTIONS, minTicks: 5 }, NOW);
  assert.equal(reading, null);
});

test('isEligibleVolatilitySymbol keeps volatility indices and drops every other family', () => {
  const sym = (symbol: string, displayName: string, submarket = 'random_index') => ({
    symbol,
    displayName,
    market: 'synthetic_index',
    submarket,
    pipSize: 2,
    exchangeOpen: true,
    tradingSuspended: false
  });
  assert.equal(isEligibleVolatilitySymbol(sym('R_100', 'Volatility 100 Index')), true);
  assert.equal(isEligibleVolatilitySymbol(sym('1HZ100V', 'Volatility 100 (1s) Index')), true);
  assert.equal(isEligibleVolatilitySymbol(sym('BOOM500', 'Boom 500 Index')), false);
  assert.equal(isEligibleVolatilitySymbol(sym('CRASH500', 'Crash 500 Index')), false);
  assert.equal(isEligibleVolatilitySymbol(sym('JD10', 'Jump 10 Index')), false);
  assert.equal(isEligibleVolatilitySymbol(sym('STPRNG', 'Step Index')), false);
  assert.equal(isEligibleVolatilitySymbol(sym('RB100', 'Range Break 100 Index')), false);
});

const USER: UserRecord = {
  id: 'u_scan',
  derivSub: 'sub_scan',
  accounts: [{ accountId: 'DEMO', type: 'demo', currency: 'USD', status: 'active' }],
  createdAt: NOW,
  updatedAt: NOW,
  preferences: {}
};

function prefs(overrides: Partial<ExecutionPreferencesRecord> = {}): ExecutionPreferencesRecord {
  return {
    userId: USER.id,
    mode: 'automatic',
    contractFamily: 'rise_fall',
    preferredAccountId: { demo: 'DEMO' },
    stake: { basis: 'stake', amount: 1, currency: 'USD' },
    parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
    realExecutionAuthorised: false,
    autoStopped: false,
    updatedAt: NOW,
    ...overrides
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

async function withScanner(
  fn: (ctx: { store: Store; scanner: MarketScanner; broker: FakeBroker; sock: any; market: MarketDataService }) => Promise<void>,
  opts: {
    automatic?: boolean;
    withToken?: boolean;
    quotes?: number[];
    marketQuotes?: Record<string, number[]>;
  } = {}
) {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const cfg = makeConfig();
  const sock = fakeSocket();
  const market = new MarketDataService(cfg, { wsFactory: () => sock as unknown as MinimalWebSocket, pingIntervalMs: 0, now: clock });
  await market.connect();
  sock.emit('open');
  sock.emit('message', {
    data: JSON.stringify({
      msg_type: 'active_symbols',
      active_symbols: [
        { underlying_symbol: 'R_100', underlying_symbol_name: 'Volatility 100 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 2, exchange_is_open: 1 },
        { underlying_symbol: 'R_50', underlying_symbol_name: 'Volatility 50 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 2, exchange_is_open: 1 },
        { underlying_symbol: '1HZ100V', underlying_symbol_name: 'Volatility 100 (1s) Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 2, exchange_is_open: 1 },
        { underlying_symbol: 'BOOM500', underlying_symbol_name: 'Boom 500 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 2, exchange_is_open: 1 }
      ]
    })
  });
  const marketQuotes = opts.marketQuotes ?? { R_100: opts.quotes ?? [100, 101, 102, 103, 104, 105] };
  for (const [symbol, quotes] of Object.entries(marketQuotes)) {
    for (const [i, q] of quotes.entries()) {
      sock.emit('message', { data: JSON.stringify({ msg_type: 'tick', tick: { symbol, quote: q, epoch: i, pip_size: 2 } }) });
    }
  }

  await store.upsertUser(USER);
  if (opts.automatic !== false) await store.putExecutionPreferences(prefs());
  await store.putRiskProfile({
    userId: USER.id,
    ...effectiveRiskProfile(store, USER.id),
    maxExecutionFrequencySeconds: 0,
    updatedAt: NOW
  });
  if (opts.withToken !== false) {
    await store.createSession({
      id: 'sess-scan',
      userId: USER.id,
      createdAt: NOW,
      expiresAt: NOW + 100_000,
      lastSeenAt: NOW,
      revoked: false,
      derivTokenSealed: seal('fake-token', cfg.session.secret),
      derivTokenExpiresAt: NOW + 100_000,
      derivSub: 'sub_scan'
    });
  }

  const broker = new FakeBroker();
  const auditor = new ExecutionAuditor(store, { now: clock });
  const gateway = new ExecutionGateway({
    store,
    cfg,
    flags: { allowExecution: true, allowDemoExecution: true, allowRealExecution: false },
    broker,
    balanceProvider: async () => 1000,
    riskEvaluator: (user, accountId, stake, signal, balance, now, intentId) =>
      evaluateRisk(
        store,
        { userId: user.id, accountId, stake, balance, signalAgeSeconds: (now - signal.createdAt) / 1000, now, excludeIntentId: intentId },
        effectiveRiskProfile(store, user.id)
      ),
    now: clock
  });
  const runner = new AutoExecutionRunner({ store, gateway, auditor, now: clock });
  const scanner = new MarketScanner({ store, cfg, market, runner, now: clock, options: { minTicks: 5 } });
  try {
    await fn({ store, scanner, broker, sock, market });
  } finally {
    scanner.stop();
    market.close();
    await store.close();
  }
}

test('scanOnce proposes and executes a signal for an automatic user', async () => {
  await withScanner(async ({ scanner, broker }) => {
    const outcomes = await scanner.scanOnce();
    const proposed = outcomes.filter((o) => o.outcome === 'proposed');
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].symbol, 'R_100');
    assert.equal(proposed[0].candidate?.direction, 'RISE');
    assert.equal(proposed[0].auto?.outcome, 'executed');
    // The one purchase path was used, and only once.
    assert.equal(broker.buys.length, 1);
    assert.equal(broker.proposals.length, 1);
  });
});

test('scanOnce watches only eligible markets', async () => {
  await withScanner(async ({ scanner }) => {
    const markets = await scanner.watchedMarkets();
    assert.deepEqual(markets.map((m) => m.symbol), ['R_100', 'R_50', '1HZ100V']);
  });
});

test('scanOnce evaluates and offers candidates from every eligible market', async () => {
  await withScanner(
    async ({ scanner, broker }) => {
      const outcomes = await scanner.scanOnce();
      assert.deepEqual(outcomes.map((outcome) => outcome.symbol), ['R_100', 'R_50', '1HZ100V']);
      assert.equal(outcomes.filter((outcome) => outcome.outcome === 'proposed').length, 3);
      assert.equal(broker.buys.length, 3);
    },
    {
      marketQuotes: {
        R_100: [100, 101, 102, 103, 104, 105],
        R_50: [200, 201, 202, 203, 204, 205],
        '1HZ100V': [300, 301, 302, 303, 304, 305]
      }
    }
  );
});

test('scanOnce does nothing for a manual user', async () => {
  await withScanner(
    async ({ scanner, broker }) => {
      const outcomes = await scanner.scanOnce();
      assert.equal(outcomes.length, 0);
      assert.equal(broker.buys.length, 0);
    },
    { automatic: false }
  );
});

test('scanOnce does nothing when the user has no live session', async () => {
  await withScanner(
    async ({ scanner, broker }) => {
      const outcomes = await scanner.scanOnce();
      assert.equal(outcomes.length, 0);
      assert.equal(broker.buys.length, 0);
    },
    { withToken: false }
  );
});

test('a second pass for the same market is skipped by the cooldown', async () => {
  await withScanner(async ({ scanner }) => {
    const first = await scanner.scanOnce();
    assert.equal(first.filter((o) => o.outcome === 'proposed').length, 1);
    const second = await scanner.scanOnce();
    const skipped = second.filter((o) => o.outcome === 'skipped_cooldown');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].symbol, 'R_100');
  });
});

test('scanOnce proposes nothing from a choppy series', async () => {
  await withScanner(
    async ({ scanner, broker }) => {
      const outcomes = await scanner.scanOnce();
      assert.equal(outcomes.filter((o) => o.outcome === 'proposed').length, 0);
      assert.equal(broker.buys.length, 0);
    },
    { quotes: [100, 110, 100, 110, 100, 110, 100, 110] }
  );
});

test('start subscribes to the watched markets and stop unsubscribes', async () => {
  await withScanner(async ({ scanner, sock }) => {
    await scanner.start();
    assert.equal(scanner.isRunning, true);
    assert.deepEqual(scanner.activeMarkets.map((market) => market.symbol), ['R_100', 'R_50', '1HZ100V']);
    const subscribed = sock.sent.filter((m: any) => m.ticks).map((m: any) => m.ticks);
    assert.deepEqual(subscribed, ['R_100', 'R_50', '1HZ100V']);
    scanner.stop();
    assert.equal(scanner.isRunning, false);
    assert.deepEqual(scanner.activeMarkets, []);
  });
});
