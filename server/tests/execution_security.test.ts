import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import { ExecutionGateway } from '../execution/gateway.js';
import { AutoExecutionRunner } from '../execution/autoRunner.js';
import { ContractMonitor } from '../execution/contractMonitor.js';
import { ExecutionAuditor, redact } from '../execution/audit.js';
import { FakeBroker, uncertainBuyError } from '../execution/broker/fakeBroker.js';
import { BrokerError } from '../execution/broker/types.js';
import { IllegalTransitionError, assertTransition } from '../execution/stateMachine.js';
import type { ServerConfig } from '../config.js';
import type { SignalRecord, ExecutionPreferencesRecord } from '../execution/types.js';

/**
 * Phase 9 tests: security and failure recovery.
 *
 * The most important assertion here is a sweep: after a full trade lifecycle,
 * the secret token string appears NOWHERE in the persisted state. That is the
 * property a redaction unit test alone cannot prove.
 */

const NOW = 1_000_000;
const SECRET_TOKEN = 'DERIV-SECRET-TOKEN-abc123-do-not-leak';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sec-'));
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

const USER: UserRecord = {
  id: 'u_a',
  derivSub: 'sub_a',
  accounts: [{ accountId: 'DEMO', type: 'demo', currency: 'USD', status: 'active' }],
  createdAt: NOW,
  updatedAt: NOW,
  preferences: {}
};

function signal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: 'sig_1',
    userId: 'u_a',
    accountId: 'DEMO',
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

function prefs(overrides: Partial<ExecutionPreferencesRecord> = {}): ExecutionPreferencesRecord {
  return {
    userId: 'u_a',
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

/* ------------------------------ secret sweep ------------------------------ */

test('the Deriv token never appears anywhere in persisted state after a trade', async () => {
  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();
  try {
    const broker = new FakeBroker();
    const auditor = new ExecutionAuditor(store, { now: () => NOW });
    const gateway = new ExecutionGateway({
      store,
      cfg: makeConfig(),
      flags: { allowExecution: true, allowDemoExecution: true, allowRealExecution: false },
      broker,
      balanceProvider: async () => 1000,
      riskEvaluator: () => ({ approved: true, reasons: [] }),
      now: () => NOW
    });
    const monitor = new ContractMonitor({ store, broker, auditor, now: () => NOW });
    (gateway as any).onContractOpened = (u: any, c: any, t: string) => monitor.monitor(u, c, t);
    const runner = new AutoExecutionRunner({ store, gateway, auditor, now: () => NOW });

    await store.putExecutionPreferences(prefs());
    const sig = signal();
    await store.putSignal(sig);
    const out = await runner.runForUser(USER, sig, SECRET_TOKEN);
    assert.equal(out.outcome, 'executed');

    // Settle it too, exercising the settlement path.
    const contract = store.listContracts('u_a')[0];
    broker.emitContract(Number(contract.id), 'won', 0.95);
    await new Promise((r) => setTimeout(r, 5));
    monitor.close();

    // Sweep the ENTIRE persisted JSON for the secret.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    let all = '';
    for (const f of files) all += fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(all.length > 0, 'something was persisted');
    assert.ok(!all.includes(SECRET_TOKEN), 'the token must not appear in persisted state');

    // And the in-memory audit trail, which is the likeliest place to leak it.
    const audit = store.listExecutionAudit();
    assert.ok(audit.length > 0, 'the lifecycle was audited');
    assert.ok(!JSON.stringify(audit).includes(SECRET_TOKEN), 'the token must not appear in the audit');
  } finally {
    await store.close();
  }
});

test('redact strips secrets at any depth and in any key casing', () => {
  const out = redact({
    accessToken: SECRET_TOKEN,
    nested: { authorization: `Bearer ${SECRET_TOKEN}`, apiKey: SECRET_TOKEN, otp: SECRET_TOKEN },
    list: [{ token: SECRET_TOKEN }, 'plain'],
    safe: 'kept'
  }) as any;
  assert.equal(out.accessToken, '[redacted]');
  assert.equal(out.nested.authorization, '[redacted]');
  assert.equal(out.nested.apiKey, '[redacted]');
  assert.equal(out.nested.otp, '[redacted]');
  assert.equal(out.list[0].token, '[redacted]');
  assert.equal(out.safe, 'kept');
  assert.ok(!JSON.stringify(out).includes(SECRET_TOKEN));
});

/* --------------------------- failure recovery ----------------------------- */

test('an uncertain purchase is never retried, only reconciled', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    const broker = new FakeBroker({ script: { buyError: uncertainBuyError() } });
    const gateway = new ExecutionGateway({
      store,
      cfg: makeConfig(),
      flags: { allowExecution: true, allowDemoExecution: true, allowRealExecution: false },
      broker,
      balanceProvider: async () => 1000,
      riskEvaluator: () => ({ approved: true, reasons: [] }),
      now: () => NOW
    });
    const sig = signal();
    await store.putSignal(sig);
    const intent = await gateway.createIntent({
      user: USER,
      accountId: 'DEMO',
      signal: sig,
      contractType: 'CALL',
      contractFamily: 'rise_fall',
      stake: 1,
      basis: 'stake',
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      idempotencyKey: 'unc'
    });
    await assert.rejects(() => gateway.submit(USER, intent.id, SECRET_TOKEN));
    assert.equal(store.getTradeIntent('u_a', intent.id)!.state, 'RECONCILIATION_REQUIRED');

    // Re-submitting the SAME intent must not issue a second buy.
    await assert.rejects(() => gateway.submit(USER, intent.id, SECRET_TOKEN));
    assert.equal(broker.buys.length, 1, 'the purchase was attempted exactly once');
  } finally {
    await store.close();
  }
});

test('a rejected (non-uncertain) purchase fails cleanly and is not stuck', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    const broker = new FakeBroker({ script: { buyError: new BrokerError('rejected', 'nope', false, 'InvalidPrice') } });
    const gateway = new ExecutionGateway({
      store,
      cfg: makeConfig(),
      flags: { allowExecution: true, allowDemoExecution: true, allowRealExecution: false },
      broker,
      balanceProvider: async () => 1000,
      riskEvaluator: () => ({ approved: true, reasons: [] }),
      now: () => NOW
    });
    const sig = signal();
    await store.putSignal(sig);
    const intent = await gateway.createIntent({
      user: USER,
      accountId: 'DEMO',
      signal: sig,
      contractType: 'CALL',
      contractFamily: 'rise_fall',
      stake: 1,
      basis: 'stake',
      currency: 'USD',
      parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
      idempotencyKey: 'rej'
    });
    await assert.rejects(() => gateway.submit(USER, intent.id, SECRET_TOKEN));
    const failed = store.getTradeIntent('u_a', intent.id)!;
    assert.equal(failed.state, 'FAILED');
    assert.equal(store.listContracts('u_a').length, 0, 'no contract is recorded for a rejected purchase');
  } finally {
    await store.close();
  }
});

test('illegal intent transitions are refused by the state machine', () => {
  assert.throws(() => assertTransition('SETTLED', 'OPEN'), IllegalTransitionError);
  assert.throws(() => assertTransition('CREATED', 'OPEN'), IllegalTransitionError);
  assert.doesNotThrow(() => assertTransition('OPEN', 'SETTLED'));
});

test('a signal can drive only one trade even under a concurrent double submit', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    const broker = new FakeBroker();
    const gateway = new ExecutionGateway({
      store,
      cfg: makeConfig(),
      flags: { allowExecution: true, allowDemoExecution: true, allowRealExecution: false },
      broker,
      balanceProvider: async () => 1000,
      riskEvaluator: () => ({ approved: true, reasons: [] }),
      now: () => NOW
    });
    const sig = signal();
    await store.putSignal(sig);
    const mk = (key: string) =>
      gateway.createIntent({
        user: USER,
        accountId: 'DEMO',
        signal: sig,
        contractType: 'CALL',
        contractFamily: 'rise_fall',
        stake: 1,
        basis: 'stake',
        currency: 'USD',
        parameters: { duration: 5, durationUnit: 'm', multiplier: null, cancellation: null, stopLoss: null, takeProfit: null },
        idempotencyKey: key
      });
    // Two intents may be created from one signal; the signal is consumed at
    // submit, so a concurrent double submit must buy exactly once.
    const intentA = await mk('k1');
    const intentB = await mk('k2');
    const results = await Promise.allSettled([
      gateway.submit(USER, intentA.id, SECRET_TOKEN),
      gateway.submit(USER, intentB.id, SECRET_TOKEN)
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'only one submit may consume the signal');
    assert.equal(broker.buys.length, 1, 'the signal drove exactly one purchase');
  } finally {
    await store.close();
  }
});
