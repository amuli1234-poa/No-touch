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
import { ExecutionAuditor } from '../execution/audit.js';
import { FakeBroker } from '../execution/broker/fakeBroker.js';
import { MarketDataService } from '../services/marketData.js';
import { createSignal } from '../services/signals.js';
import { effectiveRiskProfile, evaluateRisk } from '../services/risk.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';
import type { ExecutionPreferencesRecord } from '../execution/types.js';

/**
 * Phase 9 forward test: a deterministic, in-process simulation of the whole
 * pipeline — market tick -> validated signal -> risk -> automatic execution ->
 * contract settlement -> ledger — with no network and no live account.
 *
 * It is the closest thing to "running the strategy forward" that can live in CI.
 * It proves the pieces compose and that the money adds up, which unit tests of
 * each piece cannot.
 */

// The forward test uses the real clock end to end: the store stamps `updatedAt`
// with Date.now(), so a frozen clock would make the execution-frequency rule see
// a negative elapsed time.
const NOW = Date.now();
const clock = () => Date.now();

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fwd-'));
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
  id: 'u_fwd',
  derivSub: 'sub_fwd',
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
  return {
    addEventListener: (t: string, fn: (e: any) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    send: () => {},
    close: () => {},
    emit: (t: string, e: any = {}) => (listeners[t] || []).forEach((fn) => fn(e))
  };
}

/** Drives a synthetic tick into the market service. */
function tick(market: MarketDataService, sock: any, quote: number, epoch: number) {
  sock.emit('message', { data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'R_100', quote, epoch, pip_size: 2 } }) });
  void market;
}

test('forward test: a rising series trades, wins, and the ledger reconciles', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    const sock = fakeSocket();
    const market = new MarketDataService(makeConfig(), { wsFactory: () => sock as unknown as MinimalWebSocket, pingIntervalMs: 0 });
    await market.connect();
    sock.emit('open');
    sock.emit('message', {
      data: JSON.stringify({
        msg_type: 'active_symbols',
        active_symbols: [{ underlying_symbol: 'R_100', underlying_symbol_name: 'Volatility 100', pip_size: 2, exchange_is_open: 1 }]
      })
    });
    // A clean upward series, so the strategy has a direction to validate.
    for (let i = 0; i < 8; i++) tick(market, sock, 100 + i, Math.floor(NOW / 1000) + i);

    const broker = new FakeBroker({ script: { askPrice: 1, payout: 1.95 } });
    const auditor = new ExecutionAuditor(store, { now: clock });
    const gateway = new ExecutionGateway({
      store,
      cfg: makeConfig(),
      flags: { allowExecution: true, allowDemoExecution: true, allowRealExecution: false },
      broker,
      balanceProvider: async () => 1000,
      riskEvaluator: (user, accountId, stake, signal, balance, now) =>
        evaluateRisk(store, { userId: user.id, accountId, stake, balance, signalAgeSeconds: (now - signal.createdAt) / 1000, now }, effectiveRiskProfile(store, user.id)),
      now: clock
    });
    const monitor = new ContractMonitor({ store, broker, auditor, now: clock });
    (gateway as any).onContractOpened = (u: any, c: any, t: string) => monitor.monitor(u, c, t);
    const runner = new AutoExecutionRunner({ store, gateway, auditor, now: clock });

    await store.upsertUser(USER);
    // A profile tuned for the simulation: no frequency floor, since the whole
    // run happens within one wall-clock second.
    await store.putRiskProfile({
      userId: USER.id,
      maxStake: 10,
      maxDailyLoss: 50,
      maxConsecutiveLosses: 5,
      maxOpenContracts: 5,
      maxTradesPerSession: 20,
      maxAccountExposure: 30,
      minAvailableBalance: 5,
      maxExecutionFrequencySeconds: 0,
      signalFreshnessSeconds: 60,
      updatedAt: clock()
    });
    await store.putExecutionPreferences(prefs());

    // 1. Validate a signal from the live snapshot.
    const sig = await createSignal(store, market, {
      userId: USER.id,
      accountId: 'DEMO',
      accountMode: 'demo',
      symbol: 'R_100',
      timeframe: '5m',
      direction: 'RISE',
      contractFamily: 'rise_fall',
      analysisId: 'fwd-an',
      zone: null,
      confidence: 0.8,
      reason: 'forward test'
    });
    assert.ok(sig.id);

    // 2. Automatic execution submits it.
    const out = await runner.runForUser(USER, sig, 'tok');
    assert.equal(out.outcome, 'executed', JSON.stringify(out));
    const contract = store.listContracts(USER.id)[0];
    assert.equal(store.listLedgerEntries(USER.id).length, 1, 'one stake entry so far');

    // 3. Settle it as a win.
    broker.emitContract(Number(contract.id), 'won', 0.95);
    await new Promise((r) => setTimeout(r, 5));

    // 4. Assert the money adds up: -1 stake + 0.95 settlement.
    const ledger = store.listLedgerEntries(USER.id);
    const net = ledger.reduce((s, e) => s + e.amount, 0);
    assert.ok(Math.abs(net - -0.05) < 1e-9, `net of stake and settlement (got ${net})`);
    assert.equal(store.getContract(USER.id, contract.id)!.status, 'won');
    const intentId = store.listTradeIntents(USER.id)[0].id;
    assert.equal(store.getTradeIntent(USER.id, intentId)!.state, 'SETTLED');

    monitor.close();
    market.close();
  } finally {
    await store.close();
  }
});

test('forward test: a losing series engages auto-stop after the consecutive-loss limit', async () => {
  const store = new Store(tmpDir(), { unsafeDisableLock: true });
  await store.load();
  try {
    const broker = new FakeBroker();
    const auditor = new ExecutionAuditor(store, { now: clock });
    const gateway = new ExecutionGateway({
      store,
      cfg: makeConfig(),
      flags: { allowExecution: true, allowDemoExecution: true, allowRealExecution: false },
      broker,
      balanceProvider: async () => 1000,
      riskEvaluator: (user, accountId, stake, signal, balance, now) =>
        evaluateRisk(store, { userId: user.id, accountId, stake, balance, signalAgeSeconds: (now - signal.createdAt) / 1000, now }, effectiveRiskProfile(store, user.id)),
      now: clock
    });
    const monitor = new ContractMonitor({ store, broker, auditor, now: clock });
    (gateway as any).onContractOpened = (u: any, c: any, t: string) => monitor.monitor(u, c, t);
    const runner = new AutoExecutionRunner({ store, gateway, auditor, now: clock });

    await store.upsertUser(USER);
    // A tight profile so the streak trips quickly.
    await store.putRiskProfile({
      userId: USER.id,
      maxStake: 10,
      maxDailyLoss: 50,
      maxConsecutiveLosses: 2,
      maxOpenContracts: 5,
      maxTradesPerSession: 20,
      maxAccountExposure: 30,
      minAvailableBalance: 5,
      maxExecutionFrequencySeconds: 0,
      signalFreshnessSeconds: 60,
      updatedAt: NOW
    });
    await store.putExecutionPreferences(prefs());

    // Two losing trades in a row.
    for (let i = 0; i < 2; i++) {
      const sig = {
        id: `sig_${i}`,
        userId: USER.id,
        accountId: 'DEMO',
        accountMode: 'demo' as const,
        symbol: 'R_100',
        timeframe: '5m',
        direction: 'RISE' as const,
        contractFamily: 'rise_fall' as const,
        analysisId: 'an',
        zone: null,
        entryPrice: 100,
        confidence: 0.8,
        reason: '',
        createdAt: NOW,
        expiresAt: NOW + 60_000,
        consumedByIntentId: null
      };
      await store.putSignal(sig);
      const out = await runner.runForUser(USER, sig, 'tok');
      assert.equal(out.outcome, 'executed', `trade ${i}`);
      const contract = store.listContracts(USER.id).find((c) => c.intentId === out.result!.intent.id)!;
      broker.emitContract(Number(contract.id), 'lost', -1);
      await new Promise((r) => setTimeout(r, 5));
    }

    // The streak limit is reached; the next signal must be refused and auto-stop
    // must be engaged.
    const sig3 = {
      id: 'sig_3',
      userId: USER.id,
      accountId: 'DEMO',
      accountMode: 'demo' as const,
      symbol: 'R_100',
      timeframe: '5m',
      direction: 'RISE' as const,
      contractFamily: 'rise_fall' as const,
      analysisId: 'an',
      zone: null,
      entryPrice: 100,
      confidence: 0.8,
      reason: '',
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      consumedByIntentId: null
    };
    await store.putSignal(sig3);
    const out3 = await runner.runForUser(USER, sig3, 'tok');
    assert.equal(out3.outcome, 'rejected', JSON.stringify(out3));
    assert.equal(store.getExecutionPreferences(USER.id)?.autoStopped, true, 'auto-stop engaged after the streak');
    assert.equal(store.listContracts(USER.id).length, 2, 'no third contract was opened');

    monitor.close();
  } finally {
    await store.close();
  }
});
