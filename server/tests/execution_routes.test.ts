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
import { BrokerError } from '../execution/broker/types.js';
import { loadExecutionFlags } from '../config/flags.js';
import { sign, seal } from '../lib/crypto.js';
import { AutoExecutionRunner } from '../execution/autoRunner.js';
import { ContractMonitor } from '../execution/contractMonitor.js';
import { ExecutionAuditor } from '../execution/audit.js';
import type { ServerConfig } from '../config.js';
import type { ContractRecord, ContractUpdate } from '../execution/types.js';
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
    limits?: { signalsPerMinute?: number; submitsPerMinute?: number };
    /** When set, the risk evaluator rejects with these reasons. */
    riskRejected?: string[];
    /** When set, a fake scanner is passed to the router for status tests. */
    scanner?: {
      isRunning: boolean;
      lastPassTime: number | null;
      recent: unknown[];
      activeMarkets?: Array<{ symbol: string; displayName: string }>;
      /** Live readings, so the scanner's setup surface can be exercised. */
      readings?: Array<{ symbol: string; direction: 'RISE' | 'FALL'; stale?: boolean; confidence?: number }>;
    };
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
  const auditor = new ExecutionAuditor(store);
  const monitor = new ContractMonitor({ store, broker, auditor });
  const gateway = new ExecutionGateway({
    store,
    cfg,
    flags,
    broker,
    auditor,
    balanceProvider: async () => 1000,
    riskEvaluator: () =>
      opts.riskRejected ? { approved: false, reasons: opts.riskRejected } : { approved: true, reasons: [] },
    onContractOpened: (user, contract, accessToken) => monitor.monitor(user, contract, accessToken),
    onContractClosed: async (user, contract, sale) => {
      await monitor.recordSale(user, contract.id, sale);
    }
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
  // The scanner fake exposes the live-reading API the status surface uses.
  const scannerFake = opts.scanner
    ? {
        ...opts.scanner,
        activeMarkets: opts.scanner.activeMarkets ?? [],
        liveReading: (symbol: string) => {
          const r = (opts.scanner!.readings ?? []).find((x) => x.symbol === symbol);
          if (!r) return null;
          return {
            candidate: {
              symbol: r.symbol,
              displayName: r.symbol,
              direction: r.direction,
              confidence: r.confidence ?? 0.5,
              reason: 'test'
            },
            stale: r.stale ?? false
          };
        },
        hasLiveSignal: (symbol: string, direction: string) => {
          const r = (opts.scanner!.readings ?? []).find((x) => x.symbol === symbol);
          return !!r && !r.stale && r.direction === direction;
        }
      }
    : undefined;
  app.use(
    createExecutionRouter({
      cfg,
      store,
      gateway,
      market,
      runner,
      monitor,
      limits: opts.limits,
      flags,
      scanner: scannerFake as any
    })
  );
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
      monitor,
      user: USER,
      post: (p, b) => call('POST', p, b),
      get: (p) => call('GET', p)
    });
  } finally {
    server.close();
    monitor.close();
    market.close();
    await store.close();
  }
}

function openContractUpdate(contractId: number, profit: number): ContractUpdate {
  return {
    contractId,
    status: 'open',
    profit,
    isExpired: false,
    entrySpot: 100,
    exitSpot: null,
    currentSpot: 101,
    payout: 1.95,
    dateStart: Math.floor(Date.now() / 1000) - 60,
    dateExpiry: null,
    dateSettlement: null,
    soldFor: null,
    derivTransactionId: null
  };
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

test('POST /place runs the whole flow in one request and buys once', async () => {
  await withServer(async ({ post, broker }) => {
    const res = await post('/api/execution/place', {
      accountId: 'DEMO',
      symbol: 'R_100',
      timeframe: '5m',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      stake: 1,
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm' },
      idempotencyKey: 'place-one-shot'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.intent.state, 'OPEN');
    assert.ok(res.body.contractId);
    assert.equal(broker.buys.length, 1);
  });
});

test('POST /place is idempotent: the same key buys only once', async () => {
  await withServer(async ({ post, broker }) => {
    const ticket = {
      accountId: 'DEMO',
      symbol: 'R_100',
      timeframe: '5m',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      stake: 1,
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm' },
      idempotencyKey: 'place-retry'
    };
    const first = await post('/api/execution/place', ticket);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await post('/api/execution/place', ticket);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(broker.buys.length, 1, 'a repeated key must not place a second purchase');
  });
});

test('POST /place still enforces the risk engine on a free manual trade', async () => {
  await withServer(
    async ({ post, broker }) => {
      const res = await post('/api/execution/place', {
        accountId: 'DEMO',
        symbol: 'R_100',
        timeframe: '5m',
        direction: 'FALL',
        contractFamily: 'rise_fall',
        stake: 1,
        currency: 'USD',
        parameters: { duration: 5, durationUnit: 'm' },
        idempotencyKey: 'place-risk'
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'risk_rejected');
      assert.equal(broker.buys.length, 0);
    },
    { riskRejected: ['max_open_contracts'] }
  );
});

test('POST /place requires an idempotency key', async () => {
  await withServer(async ({ post, broker }) => {
    const res = await post('/api/execution/place', {
      accountId: 'DEMO',
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      stake: 1,
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_idempotency_key');
    assert.equal(broker.buys.length, 0);
  });
});

test('a confirmed close sells only the selected open contract and records realized P/L', async () => {
  await withServer(async ({ post, get, broker, store }) => {
    const sig = await post('/api/execution/signals', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'DEMO',
      timeframe: '5m'
    });
    const intent = await post('/api/execution/intents', {
      signalId: sig.body.signal.id,
      stake: 1,
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      parameters: { duration: 5, durationUnit: 'm' },
      idempotencyKey: 'close-confirmed'
    });
    const submitted = await post(`/api/execution/intents/${intent.body.intent.id}/submit`);
    const contractId = String(submitted.body.contractId);

    const closed = await post(`/api/execution/contracts/${contractId}/close`);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(broker.sells.length, 1);
    assert.equal(broker.sells[0].contractId, Number(contractId));
    assert.equal(broker.sells[0].price, 0);

    const contract = store.getContract('u_a', contractId);
    assert.equal(contract?.status, 'sold');
    assert.equal(contract?.soldFor, 1.5);
    assert.equal(contract?.profit, 0.5);
    assert.equal(store.getTradeIntent('u_a', intent.body.intent.id)?.state, 'SETTLED');
    const closeAttempt = store
      .listExecutionAttempts('u_a', intent.body.intent.id)
      .find((attempt) => attempt.phase === 'close');
    assert.equal(closeAttempt?.outcome, 'ok');
    assert.ok(closeAttempt?.finishedAt);

    const ledger = await get('/api/execution/ledger');
    assert.equal(ledger.body.entries.length, 2);
    const settlement = ledger.body.entries.find((entry: { kind: string }) => entry.kind === 'settlement');
    assert.equal(settlement?.amount, 0.5);

    const history = await get('/api/execution/contracts');
    assert.equal(history.body.contracts[0].status, 'sold');
    assert.equal(history.body.contracts[0].closePending, false);

    const repeated = await post(`/api/execution/contracts/${contractId}/close`);
    assert.equal(repeated.status, 409);
    assert.equal(repeated.body.error, 'contract_not_open');
    assert.equal(broker.sells.length, 1);
  });
});

test('a definite close rejection restores the open intent for a later attempt', async () => {
  await withServer(async ({ post, get, broker, store }) => {
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
      idempotencyKey: 'close-rejected'
    });
    const submitted = await post(`/api/execution/intents/${intent.body.intent.id}/submit`);
    const contractId = String(submitted.body.contractId);
    broker.setScript({ sellError: new BrokerError('deriv_rejected', 'Sale rejected.', false, 'InvalidContract') });

    const rejected = await post(`/api/execution/contracts/${contractId}/close`);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'close_rejected');
    assert.equal(store.getContract('u_a', contractId)?.status, 'open');
    assert.equal(store.getTradeIntent('u_a', intent.body.intent.id)?.state, 'OPEN');
    assert.equal((await get('/api/execution/contracts')).body.contracts[0].closePending, false);

    broker.setScript({ soldFor: 1.5 });
    const retried = await post(`/api/execution/contracts/${contractId}/close`);
    assert.equal(retried.status, 200);
    assert.equal(broker.sells.length, 2);
  });
});

test('an uncertain close blocks a blind retry and leaves the position open', async () => {
  await withServer(async ({ post, get, broker, store, monitor, user }) => {
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
      idempotencyKey: 'close-uncertain'
    });
    const submitted = await post(`/api/execution/intents/${intent.body.intent.id}/submit`);
    const contractId = String(submitted.body.contractId);
    broker.setScript({ sellError: new BrokerError('timeout', 'No sell confirmation.', true) });

    const close = await post(`/api/execution/contracts/${contractId}/close`);
    assert.equal(close.status, 409);
    assert.equal(close.body.error, 'close_pending');
    assert.equal(store.getContract('u_a', contractId)?.status, 'open');
    assert.equal(store.getTradeIntent('u_a', intent.body.intent.id)?.state, 'RECONCILIATION_REQUIRED');

    const history = await get('/api/execution/contracts');
    assert.equal(history.body.contracts[0].closePending, true);

    const retry = await post(`/api/execution/contracts/${contractId}/close`);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, 'close_pending');
    assert.equal(broker.sells.length, 1);

    await monitor.onUpdate(user, contractId, openContractUpdate(Number(contractId), 0.25));
    const refreshed = await get('/api/execution/contracts');
    assert.equal(refreshed.body.contracts[0].closePending, false);
    assert.equal(store.getTradeIntent('u_a', intent.body.intent.id)?.state, 'OPEN');

    broker.setScript({ soldFor: 1.5 });
    const confirmedRetry = await post(`/api/execution/contracts/${contractId}/close`);
    assert.equal(confirmedRetry.status, 200);
    assert.equal(broker.sells.length, 2);
    assert.equal(store.getContract('u_a', contractId)?.status, 'sold');
  });
});

test('a persisted close in progress is reconciled after a server restart', async () => {
  await withServer(async ({ post, get, store, monitor, user }) => {
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
      idempotencyKey: 'close-recovery'
    });
    const submitted = await post(`/api/execution/intents/${intent.body.intent.id}/submit`);
    const contractId = String(submitted.body.contractId);
    const persistedIntent = store.getTradeIntent('u_a', intent.body.intent.id)!;
    persistedIntent.state = 'CLOSE_PENDING';
    await store.putTradeIntent(persistedIntent);
    const attempts = store.listExecutionAttempts('u_a', intent.body.intent.id);
    await store.putExecutionAttempt({
      id: 'att_close_crash',
      intentId: intent.body.intent.id,
      userId: 'u_a',
      attemptNumber: attempts.length + 1,
      phase: 'close',
      outcome: 'pending',
      reqId: 1,
      requestSummary: { contractId },
      responseSummary: null,
      errorCode: null,
      errorMessage: null,
      startedAt: Date.now(),
      finishedAt: null
    });

    const history = await get('/api/execution/contracts');
    assert.equal(history.status, 200);
    assert.equal(store.getTradeIntent('u_a', intent.body.intent.id)?.state, 'RECONCILIATION_REQUIRED');

    await monitor.onUpdate(user, contractId, openContractUpdate(Number(contractId), 0.25));
    const reconciled = await get('/api/execution/contracts');
    assert.equal(reconciled.body.contracts[0].closePending, false);
    assert.equal(store.getTradeIntent('u_a', intent.body.intent.id)?.state, 'OPEN');
    assert.equal(
      store.listExecutionAttempts('u_a', intent.body.intent.id).find((attempt) => attempt.id === 'att_close_crash')?.outcome,
      'error'
    );
  });

});

test('closing a contract requires an authenticated session', async () => {
  await withServer(
    async ({ post }) => {
      const response = await post('/api/execution/contracts/500000/close');
      assert.equal(response.status, 401);
    },
    { session: false }
  );
});

test('a user cannot close a contract owned by another tenant', async () => {
  await withServer(async ({ post, broker, store }) => {
    const foreign: ContractRecord = {
      id: '700001',
      userId: 'u_other',
      accountId: 'DEMO',
      accountMode: 'demo',
      intentId: 'int_foreign',
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      symbol: 'R_100',
      buyPrice: 1,
      stake: 1,
      currency: 'USD',
      payout: 1.95,
      entrySpot: 100,
      exitSpot: null,
      purchaseTime: 1,
      startTime: 1,
      expiryTime: null,
      settlementTime: null,
      status: 'open',
      profit: null,
      soldFor: null,
      buyTransactionId: 1,
      updatedAt: 1
    };
    await store.putContract(foreign);

    const response = await post(`/api/execution/contracts/${foreign.id}/close`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'not_found');
    assert.equal(broker.sells.length, 0);
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

test('an automatic user\'s signal is refused when it is not backed by a live setup', async () => {
  await withServer(
    async ({ post, broker }) => {
      const res = await post('/api/execution/signals', {
        symbol: 'R_100',
        direction: 'RISE',
        contractFamily: 'rise_fall',
        accountId: 'DEMO',
        timeframe: '5m'
      });
      assert.equal(res.status, 422);
      assert.equal(res.body.error, 'no_valid_signal');
      assert.equal(broker.buys.length, 0, 'automatic must not enter outside a live setup');
    },
    {
      automatic: true,
      scanner: { isRunning: true, lastPassTime: 1, recent: [], readings: [] }
    }
  );
});

test('an automatic user\'s signal executes when it matches a live setup', async () => {
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
      assert.equal(res.body.auto?.outcome, 'executed', JSON.stringify(res.body));
      assert.equal(broker.buys.length, 1);
    },
    {
      automatic: true,
      scanner: {
        isRunning: true,
        lastPassTime: 1,
        recent: [],
        readings: [{ symbol: 'R_100', direction: 'RISE', confidence: 0.6 }]
      }
    }
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


test('GET /ledger returns the stake entry for an executed contract', async () => {
  await withServer(async ({ post, get }) => {
    const sig = await post('/api/execution/signals', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'DEMO'
    });
    const intent = await post('/api/execution/intents', {
      signalId: sig.body.signal.id,
      stake: 2,
      contractFamily: 'rise_fall',
      contractType: 'CALL',
      parameters: { duration: 5, durationUnit: 'm' },
      idempotencyKey: 'ledger-1'
    });
    await post(`/api/execution/intents/${intent.body.intent.id}/submit`);
    const ledger = await get('/api/execution/ledger');
    assert.equal(ledger.status, 200);
    assert.equal(ledger.body.entries.length, 1);
    assert.equal(ledger.body.entries[0].kind, 'stake');
    assert.equal(ledger.body.entries[0].amount, -2);
  });
});

test('a confirmed DEMO risk-session reset clears the stop and keeps prior contracts', async () => {
  await withServer(
    async ({ store, post }) => {
      const prefs = store.getExecutionPreferences('u_a');
      assert.ok(prefs);
      await store.putExecutionPreferences({ ...prefs, autoStopped: true });

      const now = Date.now();
      for (let index = 0; index < 3; index += 1) {
        const closedAt = now - (index + 1) * 1000;
        const contract: ContractRecord = {
          id: `old-${index}`,
          userId: 'u_a',
          accountId: 'DEMO',
          accountMode: 'demo',
          intentId: `intent-old-${index}`,
          contractFamily: 'rise_fall',
          contractType: 'CALL',
          symbol: 'R_100',
          buyPrice: 1,
          stake: 1,
          currency: 'USD',
          payout: 1.95,
          entrySpot: 100,
          exitSpot: 99,
          purchaseTime: Math.floor(closedAt / 1000) - 60,
          startTime: Math.floor(closedAt / 1000) - 60,
          expiryTime: Math.floor(closedAt / 1000),
          settlementTime: Math.floor(closedAt / 1000),
          status: 'lost',
          profit: -1,
          soldFor: null,
          buyTransactionId: index + 1,
          updatedAt: closedAt
        };
        await store.putContract(contract);
      }

      const response = await post('/api/execution/risk-session/reset', { accountId: 'DEMO' });
      assert.equal(response.status, 200);
      assert.equal(response.body.preferences.autoStopped, false);
      assert.equal(typeof response.body.resetAt, 'number');
      assert.equal(store.listContracts('u_a').length, 3, 'reset must not delete trading history');
      const audit = store.listExecutionAudit().find((entry) => entry.action === 'execution.risk_session_reset');
      assert.equal(audit?.accountId, 'DEMO');
      assert.equal(audit?.detail.priorLossStreak, 3);
      assert.equal(
        store.getExecutionPreferences('u_a')?.lossStreakResetAtByAccount?.DEMO,
        response.body.resetAt
      );
    },
    { automatic: true }
  );
});

test('risk-session reset refuses an account the user does not own', async () => {
  await withServer(
    async ({ store, post }) => {
      const prefs = store.getExecutionPreferences('u_a');
      assert.ok(prefs);
      await store.putExecutionPreferences({ ...prefs, autoStopped: true });
      const response = await post('/api/execution/risk-session/reset', { accountId: 'FOREIGN' });
      assert.equal(response.status, 403);
      assert.equal(response.body.error, 'account_not_authorized');
      assert.equal(store.getExecutionPreferences('u_a')?.autoStopped, true);
      assert.equal(store.listExecutionAudit().some((entry) => entry.action === 'execution.risk_session_reset'), false);
    },
    { automatic: true }
  );
});

test('POST /reconcile on a non-stuck intent is a no-op returning it', async () => {
  await withServer(async ({ post }) => {
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
      idempotencyKey: 'recon-noop'
    });
    await post(`/api/execution/intents/${intent.body.intent.id}/submit`);
    const res = await post(`/api/execution/intents/${intent.body.intent.id}/reconcile`);
    assert.equal(res.status, 200);
    assert.equal(res.body.intent.state, 'OPEN');
  });
});


test('a runaway client is rate-limited on signals', async () => {
  await withServer(
    async ({ post }) => {
      let limited = 0;
      for (let i = 0; i < 5; i++) {
        const res = await post('/api/execution/signals', {
          symbol: 'R_100',
          direction: 'RISE',
          contractFamily: 'rise_fall',
          accountId: 'DEMO'
        });
        if (res.status === 429) limited += 1;
      }
      assert.ok(limited > 0, 'some requests were rate-limited');
    },
    { limits: { signalsPerMinute: 2 } }
  );
});

/* ------------------------------- preview -------------------------------- */

test('POST /preview prices a trade without buying anything', async () => {
  await withServer(async ({ post, broker }) => {
    const res = await post('/api/execution/preview', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'DEMO',
      stake: 20,
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm' }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.preview.payout > 0);
    // A preview asks Deriv for a price and nothing else.
    assert.equal(broker.proposals.length, 1);
    assert.equal(broker.buys.length, 0);
  });
});

test('POST /preview requires a session', async () => {
  await withServer(
    async ({ post }) => {
      const res = await post('/api/execution/preview', {
        symbol: 'R_100',
        direction: 'RISE',
        contractFamily: 'rise_fall',
        accountId: 'DEMO',
        stake: 20
      });
      assert.equal(res.status, 401);
    },
    { session: false }
  );
});

test('POST /preview rejects an account the user does not own', async () => {
  await withServer(async ({ post }) => {
    const res = await post('/api/execution/preview', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'SOMEONE_ELSES',
      stake: 20
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'account_not_authorized');
  });
});

test('POST /preview is refused when the kill switch is off', async () => {
  await withServer(
    async ({ post }) => {
      const res = await post('/api/execution/preview', {
        symbol: 'R_100',
        direction: 'RISE',
        contractFamily: 'rise_fall',
        accountId: 'DEMO',
        stake: 20
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'execution_disabled');
    },
    { flags: { allowExecution: false } }
  );
});

test('POST /preview rejects a parameter the family does not support', async () => {
  await withServer(async ({ post }) => {
    const res = await post('/api/execution/preview', {
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      accountId: 'DEMO',
      stake: 20,
      // Rise/Fall has no stop-loss; the adapter must refuse it.
      parameters: { duration: 5, durationUnit: 'm', stopLoss: 1 }
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'unsupported_parameter');
  });
});

test('GET /scanner reports running with the switches on', async () => {
  await withServer(
    async ({ get }) => {
      const res = await get('/api/execution/scanner');
      assert.equal(res.status, 200);
      assert.equal(res.body.running, true);
      assert.equal(res.body.executionEnabled, true);
      assert.equal(res.body.demoEnabled, true);
      assert.equal(res.body.reason, null);
      assert.deepEqual(res.body.watchedMarkets.map((market: { symbol: string }) => market.symbol), ['R_100', 'R_50']);
    },
    {
      scanner: {
        isRunning: true,
        lastPassTime: 123,
        recent: [],
        activeMarkets: [
          { symbol: 'R_100', displayName: 'Volatility 100 Index' },
          { symbol: 'R_50', displayName: 'Volatility 50 Index' }
        ]
      }
    }
  );
});

test('GET /scanner explains the master switch is off', async () => {
  await withServer(
    async ({ get }) => {
      const res = await get('/api/execution/scanner');
      assert.equal(res.status, 200);
      assert.equal(res.body.running, false);
      assert.equal(res.body.executionEnabled, false);
      assert.equal(res.body.reason, 'execution_disabled');
    },
    { flags: { allowExecution: false, allowDemoExecution: false } }
  );
});

test('GET /scanner explains the demo switch is off', async () => {
  await withServer(
    async ({ get }) => {
      const res = await get('/api/execution/scanner');
      assert.equal(res.status, 200);
      assert.equal(res.body.running, false);
      assert.equal(res.body.executionEnabled, true);
      assert.equal(res.body.demoEnabled, false);
      assert.equal(res.body.reason, 'demo_execution_disabled');
    },
    { flags: { allowExecution: true, allowDemoExecution: false } }
  );
});

/* ------------------ manual trades are the trader's own call ------------------ */

test('a manual signal is accepted with no live scanner setup at all', async () => {
  await withServer(
    async ({ post }) => {
      const res = await post('/api/execution/signals', {
        accountId: 'DEMO',
        symbol: 'R_100',
        direction: 'RISE',
        contractFamily: 'rise_fall',
        source: 'manual'
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.ok(res.body.signal?.id);
    },
    { scanner: { isRunning: false, lastPassTime: null, recent: [], readings: [] } }
  );
});

test('a manual signal may contradict the scanner\'s live setup', async () => {
  await withServer(
    async ({ post }) => {
      const res = await post('/api/execution/signals', {
        accountId: 'DEMO',
        symbol: 'R_100',
        direction: 'FALL',
        contractFamily: 'rise_fall',
        source: 'manual'
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.ok(res.body.signal?.id);
    },
    {
      scanner: {
        isRunning: true,
        lastPassTime: 1,
        recent: [],
        readings: [{ symbol: 'R_100', direction: 'RISE' }]
      }
    }
  );
});

test('a manual signal may target a market the scanner is not watching', async () => {
  await withServer(
    async ({ post }) => {
      const res = await post('/api/execution/signals', {
        accountId: 'DEMO',
        symbol: 'R_100',
        direction: 'RISE',
        contractFamily: 'rise_fall',
        source: 'manual'
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    },
    { scanner: { isRunning: true, lastPassTime: 1, recent: [], readings: [] } }
  );
});

test('a manual place succeeds without a live setup and still buys once', async () => {
  await withServer(
    async ({ post, broker }) => {
      const res = await post('/api/execution/place', {
        accountId: 'DEMO',
        symbol: 'R_100',
        timeframe: '5m',
        direction: 'FALL',
        contractFamily: 'rise_fall',
        stake: 1,
        currency: 'USD',
        parameters: { duration: 5, durationUnit: 'm' },
        idempotencyKey: 'manual-free'
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.intent.state, 'OPEN');
      assert.equal(broker.buys.length, 1);
    },
    { scanner: { isRunning: false, lastPassTime: null, recent: [], readings: [] } }
  );
});

test('GET /scanner exposes the live setups the Trade panel may show', async () => {
  await withServer(
    async ({ get }) => {
      const res = await get('/api/execution/scanner');
      assert.equal(res.status, 200);
      assert.equal(res.body.setups.length, 1);
      assert.equal(res.body.setups[0].symbol, 'R_100');
      assert.equal(res.body.setups[0].direction, 'RISE');
    },
    {
      scanner: {
        isRunning: true,
        lastPassTime: 1,
        recent: [],
        activeMarkets: [{ symbol: 'R_100', displayName: 'Volatility 100 Index' }],
        readings: [{ symbol: 'R_100', direction: 'RISE', confidence: 0.6 }]
      }
    }
  );
});
