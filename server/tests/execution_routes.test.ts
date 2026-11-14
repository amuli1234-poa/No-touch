import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import { createExecution } from '../execution/composition.js';
import { createExecutionRouter } from '../routes/execution.js';
import { ExecutionGateway } from '../execution/gateway.js';
import { MarketDataService } from '../services/marketData.js';
import { FakeBroker } from '../execution/broker/fakeBroker.js';
import { loadExecutionFlags } from '../config/flags.js';
import { sign, seal } from '../lib/crypto.js';
import { AutoExecutionRunner } from '../execution/autoRunner.js';
import { ExecutionAuditor } from '../execution/audit.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/**
 * Phase 6 route tests: the execution HTTP surface, driven through the real
 * Express router with a fake broker and a scripted market socket. Proves the
 * routes are session-guarded and that the request body cannot widen access.
 *
 * A tiny in-process harness stands in for the full app so these tests do not
 * need the whole server (auth, admin, telemetry) to boot.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-execroute-'));
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
  return {
    addEventListener: (t: string, fn: (e: any) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    send: () => {},
    close: () => {},
    emit: (t: string, e: any = {}) => (listeners[t] || []).forEach((fn) => fn(e))
  };
}

async function marketWithTick() {
  const sock = fakeSocket();
  const market = new MarketDataService(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    pingIntervalMs: 0
  });
  await market.connect();
  sock.emit('open');
  sock.emit('message', {
    data: JSON.stringify({
      msg_type: 'active_symbols',
      active_symbols: [{ underlying_symbol: 'R_100', underlying_symbol_name: 'Volatility 100', pip_size: 2, exchange_is_open: 1 }]
    })
  });
  sock.emit('message', { data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 100, epoch: 1, pip_size: 2 } }) });
  return market;
}

/**
 * Minimal express harness: mounts the execution router with an injected session
 * so a request is always "logged in" as USER.
 */
async function withServer(
  fn: (ctx: { store: Store; broker: FakeBroker; post: (path: string, body?: unknown) => Promise<{ status: number; body: any }>; get: (path: string) => Promise<{ status: number; body: any }> }) => Promise<void>,
  opts: {
    flags?: Partial<ReturnType<typeof loadExecutionFlags>>;
    session?: boolean;
    token?: string | null;
    /** When set, an automatic runner is wired and these preferences are stored. */
    automatic?: boolean;
  } = {}
) {
  const express = (await import('express')).default;
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  const cfg = makeConfig();
  const broker = new FakeBroker();
  const market = await marketWithTick();

  const USER: UserRecord = {
    id: 'u_a',
    derivSub: 'sub_a',
    accounts: [{ accountId: 'DEMO', type: 'demo', currency: 'USD', status: 'active' }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preferences: {}
  };
  await store.upsertUser(USER);
  const flags = { allowExecution: true, allowDemoExecution: true, allowRealExecution: false, ...opts.flags };
  const gateway = new ExecutionGateway({
    store,
    cfg,
    flags,
    broker,
    balanceProvider: async () => 1000,
    riskEvaluator: () => ({ approved: true, reasons: [] })
  });

  // A real session record and a signed cookie, so requireSession resolves it the
  // same way the live server does. `token` controls the sealed Deriv token.
  const token = opts.token === undefined ? 'fake-token' : opts.token;
  const sessionId = 'sess-1';
  await store.createSession({
    id: sessionId,
    userId: 'u_a',
    createdAt: Date.now(),
    expiresAt: Date.now() + 100_000,
    lastSeenAt: Date.now(),
    revoked: false,
    derivTokenSealed: token === null ? '' : seal(token, cfg.session.secret),
    derivTokenExpiresAt: Date.now() + 100_000,
    derivSub: 'sub_a'
  });

  let runner: AutoExecutionRunner | undefined;
  if (opts.automatic) {
    runner = new AutoExecutionRunner({ store, gateway, auditor: new ExecutionAuditor(store) });
    await store.putExecutionPreferences({
      userId: 'u_a',
      mode: 'automatic',
      contractFamily: 'rise_fall',
      preferredAccountId: { demo: 'DEMO' },
      stake: { basis: 'stake', amount: 1, currency: 'USD' },
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      realExecutionAuthorised: false,
      autoStopped: false,
      updatedAt: Date.now()
    });
  }
  const app = express();
  app.use(createExecutionRouter({ cfg, store, gateway, market, runner }));
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const cookie = opts.session === false ? '' : `${cfg.session.cookieName}=${sign(sessionId, cfg.session.secret)}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await fn({
      store,
      broker,
      post: (p, b) => call('POST', p, b),
      get: (p) => call('GET', p)
    });
  } finally {
    server.close();
    market.close();
    await store.close();
  }
}

test('POST /signals requires a session', async () => {
  await withServer(
    async ({ post }) => {
      const res = await post('/api/execution/signals', { symbol: 'R_100', direction: 'RISE', contractFamily: 'rise_fall', accountId: 'DEMO' });
      assert.equal(res.status, 401);
    },
    { session: false }
  );
});

test('POST /signals rejects an account the user does not own', async () => {
  await withServer(async ({ post }) => {
    const res = await post('/api/execution/signals', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'SOMEONE_ELSES'
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'account_not_authorized');
  });
});

test('a full signal -> intent -> submit flow executes on the fake broker', async () => {
  await withServer(async ({ post, broker }) => {
    const sig = await post('/api/execution/signals', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'DEMO',
      timeframe: '5m',
      confidence: 0.8
    });
    assert.equal(sig.status, 201, JSON.stringify(sig.body));
    const signalId = sig.body.signal.id;

    const intent = await post('/api/execution/intents', {
      signalId,
      stake: 1,
      basis: 'stake',
      currency: 'USD',
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      parameters: { duration: 5, durationUnit: 'm' },
      idempotencyKey: 'idem-e2e'
    });
    assert.equal(intent.status, 201, JSON.stringify(intent.body));
    const intentId = intent.body.intent.id;

    const submit = await post(`/api/execution/intents/${intentId}/submit`);
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    assert.equal(submit.body.intent.state, 'OPEN');
    assert.ok(submit.body.contractId);
    assert.equal(broker.buys.length, 1);
  });
});

test('creating an intent with a mismatched contract type is refused', async () => {
  await withServer(async ({ post }) => {
    const sig = await post('/api/execution/signals', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'DEMO'
    });
    const res = await post('/api/execution/intents', {
      signalId: sig.body.signal.id,
      stake: 1,
      contractFamily: 'rise_fall',
      // MULTUP is not a Rise/Fall contract.
      contractType: 'MULTUP',
      parameters: { duration: 5, durationUnit: 'm' },
      idempotencyKey: 'bad-type'
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_contract_type');
  });
});

test('submitting an intent with execution disabled is refused', async () => {
  await withServer(
    async ({ post }) => {
      const sig = await post('/api/execution/signals', {
        symbol: 'R_100',
        direction: 'RISE',
        contractFamily: 'rise_fall',
        accountId: 'DEMO'
      });
      const intent = await post('/api/execution/intents', {
        signalId: sig.body.signal.id,
        stake: 1,
        contractFamily: 'rise_fall',
        contractType: 'CALL',
        parameters: { duration: 5, durationUnit: 'm' },
        idempotencyKey: 'disabled'
      });
      const submit = await post(`/api/execution/intents/${intent.body.intent.id}/submit`);
      assert.equal(submit.status, 409);
      assert.equal(submit.body.error, 'execution_disabled');
    },
    { flags: { allowExecution: false } }
  );
});

test('an intent without an idempotency key is refused', async () => {
  await withServer(async ({ post }) => {
    const sig = await post('/api/execution/signals', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'DEMO'
    });
    const res = await post('/api/execution/intents', {
      signalId: sig.body.signal.id,
      stake: 1,
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      parameters: { duration: 5, durationUnit: 'm' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_idempotency_key');
  });
});


test('an automatic user\'s signal is executed on creation through the runner', async () => {
  await withServer(
    async ({ post, broker }) => {
      const res = await post('/api/execution/signals', {
        symbol: 'R_100',
        direction: 'RISE',
        contractFamily: 'rise_fall',
        accountId: 'DEMO',
        timeframe: '5m'
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      // The runner ran automatically: the response carries the outcome.
      assert.equal(res.body.auto?.outcome, 'executed', JSON.stringify(res.body));
      assert.equal(broker.buys.length, 1);
    },
    { automatic: true }
  );
});

test('a manual user\'s signal is NOT auto-executed', async () => {
  await withServer(async ({ post, broker }) => {
    const res = await post('/api/execution/signals', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'DEMO'
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.auto, null);
    assert.equal(broker.buys.length, 0);
  });
});
