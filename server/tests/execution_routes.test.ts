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
import { SystemSignalService } from '../services/systemSignals.js';
import { evaluateRisk, effectiveRiskProfile } from '../services/risk.js';
import type { ServerConfig } from '../config.js';
import type { ContractRecord, ContractUpdate, RiskProfileRecord } from '../execution/types.js';
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
      active_symbols: [
        { underlying_symbol: 'R_100', underlying_symbol_name: 'Volatility 100', pip_size: 2, exchange_is_open: 1 },
        { underlying_symbol: 'R_75', underlying_symbol_name: 'Volatility 75', pip_size: 2, exchange_is_open: 1 },
        { underlying_symbol: 'R_50', underlying_symbol_name: 'Volatility 50', pip_size: 2, exchange_is_open: 1 }
      ]
    })
  });
  sock.emit('message', { data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 100, epoch: 1, pip_size: 2 } }) });
  sock.emit('message', { data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'R_75', quote: 100, epoch: 1, pip_size: 2 } }) });
  sock.emit('message', { data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'R_50', quote: 100, epoch: 1, pip_size: 2 } }) });
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
    /**
     * When set, the REAL risk engine runs instead of a stub, so the per-symbol
     * guard is exercised end-to-end. The profile overrides the conservative
     * defaults (the stake here is 1, so the stub profile keeps other rules quiet).
     */
    realRisk?: { profile?: Partial<RiskProfileRecord> };
    /**
     * When set, a best signal is published for the user before the request, so
     * the automatic-entry gate sees a current signal. Its shape mirrors what the
     * dashboard POSTs to /api/execution/system-signal.
     */
    systemSignal?: {
      symbol: string;
      direction: 'RISE' | 'FALL';
      displayName?: string;
      confidence?: number;
      setupKey?: string;
      source?: string;
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
  const flags = { allowExecution: true, allowDemoExecution: true, allowRealExecution: false, allowAutomaticTrading: true, ...opts.flags };
  const auditor = new ExecutionAuditor(store);
  const monitor = new ContractMonitor({ store, broker, auditor });
  const gateway = new ExecutionGateway({
    store,
    cfg,
    flags,
    broker,
    auditor,
    balanceProvider: async () => 1000,
    riskEvaluator: opts.realRisk
      ? (user, accountId, stake, signal, balance, now, intentId, symbol) =>
          evaluateRisk(
            store,
            { userId: user.id, accountId, stake, balance, signalAgeSeconds: (now - signal.createdAt) / 1000, now, excludeIntentId: intentId, symbol },
            { userId: user.id, ...effectiveRiskProfile(store, user.id), ...opts.realRisk!.profile }
          )
      : () =>
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
  // A real bridge, so the automatic-entry gate and the status surface read the
  // same published best signal the dashboard would POST.
  const systemSignals = new SystemSignalService();
  if (opts.systemSignal) {
    systemSignals.publish({
      userId: 'u_a',
      symbol: opts.systemSignal.symbol,
      displayName: opts.systemSignal.displayName ?? opts.systemSignal.symbol,
      direction: opts.systemSignal.direction,
      timeframe: '5m',
      confidence: opts.systemSignal.confidence ?? 60,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      setupKey: opts.systemSignal.setupKey ?? 'setup-1',
      source: opts.systemSignal.source ?? 'SYSTEM'
    });
  }
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
      systemSignals
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
      put: (p, b) => call('PUT', p, b),
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
    { automatic: true, systemSignal: { symbol: 'R_100', direction: 'RISE' } }
  );
});

test('an automatic user\'s signal is refused when it is not the current best signal', async () => {
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
      assert.equal(res.body.error, 'no_signal');
      assert.equal(broker.buys.length, 0, 'automatic must not enter without a published best signal');
    },
    { automatic: true }
  );
});

test('an automatic user\'s signal is refused when it contradicts the best signal', async () => {
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
      assert.equal(broker.buys.length, 0, 'automatic must not enter outside the best signal');
    },
    {
      automatic: true,
      systemSignal: { symbol: 'R_100', direction: 'FALL' }
    }
  );
});

test('an automatic user\'s signal executes when it matches the current best signal', async () => {
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
      systemSignal: { symbol: 'R_100', direction: 'RISE', confidence: 60 }
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


test('an automatic user is NOT executed when automatic trading is switched off', async () => {
  await withServer(
    async ({ post, broker, store }) => {
      const res = await post('/api/execution/signals', {
        symbol: 'R_100',
        direction: 'RISE',
        contractFamily: 'rise_fall',
        accountId: 'DEMO',
        timeframe: '5m'
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      // The signal is still recorded, but no purchase happens.
      assert.equal(broker.buys.length, 0, 'automatic must not buy while the switch is off');
      assert.equal(res.body.auto?.outcome, 'rejected');
      assert.equal(res.body.auto?.reason, 'automatic_disabled');
      // The refusal is auditable, not silent.
      assert.ok(
        store
          .listExecutionAudit()
          .some((entry) => entry.action === 'execution.submit' && entry.detail?.reason === 'automatic_disabled')
      );
    },
    { automatic: true, flags: { allowAutomaticTrading: false }, systemSignal: { symbol: 'R_100', direction: 'RISE' } }
  );
});

test('PUT /preferences refuses automatic mode while automatic trading is switched off', async () => {
  await withServer(
    async ({ store, put }) => {
      const res = await put('/api/execution/preferences', { mode: 'automatic' });
      assert.equal(res.status, 422);
      assert.equal(res.body.error, 'automatic_disabled');
      assert.notEqual(store.getExecutionPreferences('u_a')?.mode, 'automatic');
    },
    { flags: { allowAutomaticTrading: false } }
  );
});

test('GET /scanner reports automatic trading disabled with a reason', async () => {
  await withServer(
    async ({ get }) => {
      const res = await get('/api/execution/scanner');
      assert.equal(res.status, 200);
      assert.equal(res.body.automaticEnabled, false);
      assert.equal(res.body.reason, 'automatic_disabled');
    },
    { flags: { allowAutomaticTrading: false } }
  );
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
      // The dashboard owns the market universe; the server reports none.
      assert.deepEqual(res.body.watchedMarkets, []);
    },
    { systemSignal: { symbol: 'R_100', direction: 'RISE', displayName: 'Volatility 100 Index' } }
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

test('a manual signal is accepted with no best signal published at all', async () => {
  await withServer(async ({ post }) => {
    const res = await post('/api/execution/signals', {
      accountId: 'DEMO',
      symbol: 'R_100',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      source: 'manual'
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.signal?.id);
  });
});

test('a manual signal may contradict the published best signal', async () => {
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
    { systemSignal: { symbol: 'R_100', direction: 'RISE' } }
  );
});

test('a manual signal may target a market the best signal is not on', async () => {
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
    { systemSignal: { symbol: 'R_50', direction: 'RISE' } }
  );
});

test('a manual place succeeds without a best signal and still buys once', async () => {
  await withServer(async ({ post, broker }) => {
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
  });
});

test('a manual place still succeeds while automatic trading is switched off', async () => {
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
        idempotencyKey: 'manual-while-auto-off'
      });
      // The automatic switch must not touch the manual path: the customer's own
      // trade carries an approval, so it is never `approvedBy === null`.
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.intent.state, 'OPEN');
      assert.equal(res.body.intent.approvedBy, 'customer');
      assert.equal(broker.buys.length, 1);
    },
    { flags: { allowAutomaticTrading: false } }
  );
});

test('GET /scanner exposes the current best signal the Trade panel may show', async () => {
  await withServer(
    async ({ get }) => {
      const res = await get('/api/execution/scanner');
      assert.equal(res.status, 200);
      assert.equal(res.body.setups.length, 1);
      assert.equal(res.body.setups[0].symbol, 'R_100');
      assert.equal(res.body.setups[0].direction, 'RISE');
    },
    {
      systemSignal: {
        symbol: 'R_100',
        direction: 'RISE',
        displayName: 'Volatility 100 Index',
        confidence: 60
      }
    }
  );
});

test('GET /scanner exposes no setup when nothing has been published', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/api/execution/scanner');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.setups, []);
    assert.equal(res.body.lastPassAt, null);
  });
});

/* ------------------- the dashboard publishes, the server trades ------------------- */

test('a published strong signal is auto-traded for an automatic user', async () => {
  await withServer(
    async ({ post, broker }) => {
      const res = await post('/api/execution/system-signal', {
        symbol: 'R_100',
        displayName: 'Volatility 100 Index',
        direction: 'RISE',
        timeframe: '5m',
        confidence: 88,
        entryPrice: 100,
        stopLoss: 99,
        takeProfit: 103,
        setupKey: 'R_100|5m|RISE|boschoch',
        source: 'AI:boschoch'
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.auto?.outcome, 'executed', JSON.stringify(res.body));
      assert.equal(broker.buys.length, 1);
    },
    { automatic: true }
  );
});

test('a published weak signal is recorded but never auto-traded', async () => {
  await withServer(
    async ({ post, broker }) => {
      const res = await post('/api/execution/system-signal', {
        symbol: 'R_100',
        direction: 'RISE',
        timeframe: '5m',
        confidence: 40,
        setupKey: 'R_100|5m|RISE|weak',
        source: 'AI:technical'
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.auto, null);
      assert.equal(res.body.reason, 'weak_signal');
      assert.equal(broker.buys.length, 0);
    },
    { automatic: true }
  );
});

test('the auto-trade bar is strictly above 80: 80 is refused, 81 is entered', async () => {
  await withServer(
    async ({ post, broker }) => {
      const publish = (confidence: number, setupKey: string) =>
        post('/api/execution/system-signal', {
          symbol: 'R_100',
          direction: 'RISE',
          timeframe: '5m',
          confidence,
          setupKey,
          source: 'AI:boschoch'
        });
      const atBar = await publish(80, 'at-80');
      assert.equal(atBar.body.auto, null, JSON.stringify(atBar.body));
      assert.equal(atBar.body.reason, 'weak_signal');
      assert.equal(broker.buys.length, 0, '80/100 must not be traded');
      const aboveBar = await publish(81, 'above-80');
      assert.equal(aboveBar.body.auto?.outcome, 'executed', JSON.stringify(aboveBar.body));
      assert.equal(broker.buys.length, 1, '81/100 must be traded');
    },
    { automatic: true }
  );
});

test('each distinct published setup is traded once and never twice', async () => {
  await withServer(
    async ({ post, broker }) => {
      const publish = (symbol: string, setupKey: string, direction: 'RISE' | 'FALL') =>
        post('/api/execution/system-signal', {
          symbol,
          direction,
          timeframe: '5m',
          confidence: 90,
          setupKey,
          source: 'AI:smc'
        });
      const first = await publish('R_75', 'setup-a', 'RISE');
      const second = await publish('R_50', 'setup-b', 'FALL');
      assert.equal(first.body.auto?.outcome, 'executed', JSON.stringify(first.body));
      assert.equal(second.body.auto?.outcome, 'executed', JSON.stringify(second.body));
      assert.equal(broker.buys.length, 2);
      // Re-publishing a setup already traded is refused, so it never doubles up.
      const repeat = await publish('R_75', 'setup-a', 'RISE');
      assert.equal(repeat.body.reason, 'already_traded');
      assert.equal(broker.buys.length, 2);
    },
    { automatic: true }
  );
});

test('correlated signals on one symbol collapse to a single open contract', async () => {
  // Two different modules confirm the same market. Both are strong, but the
  // per-symbol guard means only the first opens a position; the second is
  // refused by the risk engine rather than stacking a correlated trade.
  await withServer(
    async ({ post, broker, store }) => {
      const publish = (setupKey: string, direction: 'RISE' | 'FALL') =>
        post('/api/execution/system-signal', {
          symbol: 'R_100',
          direction,
          timeframe: '5m',
          confidence: 92,
          setupKey,
          source: 'AI:module'
        });
      const first = await publish('module-a|R_100', 'RISE');
      assert.equal(first.body.auto?.outcome, 'executed', JSON.stringify(first.body));
      const second = await publish('module-b|R_100', 'FALL');
      assert.equal(second.body.auto?.outcome, 'rejected', JSON.stringify(second.body));
      assert.equal(broker.buys.length, 1, 'one symbol must hold at most one contract');
      // The second attempt was refused by the per-symbol rule, not some other one.
      const rejected = store.listTradeIntents('u_a').find((i) => i.reason?.includes('symbol_in_use'));
      assert.ok(rejected, 'the second intent must be rejected for symbol_in_use');
    },
    { automatic: true, realRisk: { profile: { maxExecutionFrequencySeconds: 0 } } }
  );
});

test('a published signal is inert for a manual user', async () => {
  await withServer(async ({ post, broker }) => {
    const res = await post('/api/execution/system-signal', {
      symbol: 'R_100',
      direction: 'RISE',
      timeframe: '5m',
      confidence: 90,
      setupKey: 'setup-manual',
      source: 'AI:live'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.auto, null);
    assert.equal(broker.buys.length, 0);
  });
});
