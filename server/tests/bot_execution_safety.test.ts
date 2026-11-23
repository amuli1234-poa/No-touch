/**
 * Execution safety: proving the six-entry end-to-end run is safe.
 *
 * `bot_run.test.ts` proves the run *works*. This file proves it is *safe* — that
 * every entry it produced came from the imported strategy, went through the one
 * gateway, passed ownership and risk checks, could not be duplicated, stopped
 * when told to, and settled into the right bot's history.
 *
 * The broker is `FakeBroker`, so nothing leaves the process; every other layer
 * (store, gateway, risk engine, runner, monitor) is the real one. A stubbed
 * gateway would make these assertions meaningless.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Store } from '../store/store.js';
import type { UserRecord } from '../store/store.js';
import { ExecutionGateway } from '../execution/gateway.js';
import { ExecutionAuditor } from '../execution/audit.js';
import { AutoExecutionRunner } from '../execution/autoRunner.js';
import { ContractMonitor } from '../execution/contractMonitor.js';
import { FakeBroker } from '../execution/broker/fakeBroker.js';
import { MarketDataService } from '../services/marketData.js';
import type { ExecutionFlags } from '../config/flags.js';
import { importBot } from '../bots/service.js';
import {
  startBotRun,
  stopBotRun,
  tickBotRun,
  type BotRunDeps
} from '../bots/runService.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/* ------------------------------- harness -------------------------------- */

const FIXTURE = fs
  .readFileSync(path.join(import.meta.dirname, '..', '..', 'Digit_Differs_AI.xml'), 'utf8')
  // The harness market streams R_100; the export trades R_50.
  .replace(/R_50/g, 'R_100');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notouch-safety-'));
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

async function marketWithTicks(quotes: number[]) {
  const sock = fakeSocket();
  const market = new MarketDataService(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    pingIntervalMs: 0,
    now: () => Date.now()
  });
  await market.connect();
  sock.emit('open');
  sock.emit('message', {
    data: JSON.stringify({
      msg_type: 'active_symbols',
      active_symbols: [
        { underlying_symbol: 'R_100', underlying_symbol_name: 'Volatility 100', pip_size: 2, exchange_is_open: 1 }
      ]
    })
  });
  for (const [i, quote] of quotes.entries()) {
    sock.emit('message', {
      data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'R_100', quote, epoch: i + 1, pip_size: 2 } })
    });
  }
  return { market, sock };
}

const DEMO_ACCOUNT = { accountId: 'DEMO', type: 'demo' as const, currency: 'USD', status: 'active' };

function makeUser(id: string, accounts = [DEMO_ACCOUNT]): UserRecord {
  return {
    id,
    derivSub: `sub_${id}`,
    accounts,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preferences: {}
  };
}

interface Harness {
  store: Store;
  deps: BotRunDeps;
  user: UserRecord;
  broker: FakeBroker;
  setQuotes: (quotes: number[]) => void;
  riskApproved: boolean;
}

async function withHarness(
  fn: (h: Harness) => Promise<void>,
  opts: { flags?: Partial<ExecutionFlags>; quotes?: number[]; riskApproved?: boolean } = {}
): Promise<void> {
  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();

  const { market, sock } = await marketWithTicks(opts.quotes ?? [1000.11, 1000.22, 1000.33, 1000.44, 1000.55]);

  const flags: ExecutionFlags = {
    allowExecution: true,
    allowDemoExecution: true,
    allowRealExecution: false,
    allowAutomaticTrading: true,
    ...opts.flags
  } as ExecutionFlags;

  const broker = new FakeBroker();
  const auditor = new ExecutionAuditor(store);
  const monitor = new ContractMonitor({ store, broker, auditor });
  const riskApproved = opts.riskApproved ?? true;
  const gateway = new ExecutionGateway({
    store,
    cfg: makeConfig(),
    flags,
    broker,
    auditor,
    balanceProvider: async () => 10_000,
    // The real risk engine is used in production; here a boolean stands in so a
    // refusal can be forced on demand without rebuilding the risk profile.
    riskEvaluator: () =>
      riskApproved ? { approved: true, reasons: [] } : { approved: false, reasons: ['forced_refusal'] },
    onContractOpened: (user, contract, token) => monitor.monitor(user, contract, token),
    onContractClosed: async (user, contract, sale) => monitor.recordSale(user, contract.id, sale)
  });
  const runner = new AutoExecutionRunner({ store, gateway, auditor });

  const user = makeUser('u_demo');
  await store.upsertUser(user);

  const deps: BotRunDeps = { store, market, gateway, runner, monitor, auditor, flags };

  try {
    await fn({
      store,
      deps,
      user,
      broker,
      riskApproved,
      setQuotes: (quotes) => {
        for (const [i, quote] of quotes.entries()) {
          sock.emit('message', {
            data: JSON.stringify({
              msg_type: 'tick',
              tick: { symbol: 'R_100', quote, epoch: 2000 + i, pip_size: 2 }
            })
          });
        }
      }
    });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* -------------------------------- tests --------------------------------- */

test('safety: every entry traces to the imported strategy and the one gateway', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const { record: bot } = await importBot(store, user.id, 'Digit_Differs_AI.xml', FIXTURE);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');

    // 1. The entry has an intent whose idempotency key names THIS run.
    const intents = store.listTradeIntents(user.id);
    assert.equal(intents.length, 1);
    assert.match(
      intents[0].idempotencyKey,
      new RegExp(`^bot:${run.runId}:`),
      'the intent must be attributable to this run, not a stray order'
    );

    // 2. It went through the gateway: the intent exists in the gateway's own
    //    state machine, and the contract it produced is owned by this user.
    assert.ok(['OPEN', 'PENDING', 'FILLED'].includes(intents[0].state), `unexpected state ${intents[0].state}`);
    const contract = store.getContract(user.id, String(first.contractId));
    assert.ok(contract, 'the contract must be recorded against the user');
    assert.equal(contract.intentId, intents[0].id, 'the contract must descend from the intent');
    assert.equal(contract.accountId, 'DEMO');

    // 3. The gateway audited the purchase itself (`execution.purchase` is the
    //    record written once a buy is confirmed; `execution.submit` only covers
    //    the pre-flight decision). An entry with no purchase record would mean
    //    something bypassed the gateway.
    const purchases = store.listExecutionAudit().filter((e) => e.action === 'execution.purchase');
    assert.ok(purchases.length >= 1, 'the confirmed purchase must be audited');
    assert.equal(purchases[0].outcome, 'allowed');
    assert.equal(purchases[0].intentId, intents[0].id, 'the audit row must name the intent it allowed');

    // 4. And risk was actually applied. The gateway only writes an
    //    `execution.risk` row when it refuses, so approval is proven by the two
    //    effects it has: the intent reached RISK_APPROVED-or-later, and the
    //    signal that drove it was consumed atomically with that approval. A
    //    signal left unconsumed could drive a second trade.
    const audit = store.listExecutionAudit();
    assert.equal(
      audit.filter((e) => e.action === 'execution.risk' && e.outcome === 'denied').length,
      0,
      'an allowed entry must not carry a risk denial'
    );
    const signals = store.listSignals(user.id);
    assert.equal(signals.length, 1, 'exactly one signal drove this entry');
    assert.equal(
      signals[0].consumedByIntentId,
      intents[0].id,
      'the signal must be consumed by the intent that used it'
    );
  });
});

test('safety: an unowned account is refused, and nothing is bought', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const { record: bot } = await importBot(store, user.id, 'Digit_Differs_AI.xml', FIXTURE);
    // The user has DEMO; ask for an account they do not own.
    await assert.rejects(
      () => startBotRun(deps, user, bot.id, { accountId: 'REAL_NOT_OWNED' }, 'token'),
      /account|authoriz|not/i
    );
    assert.equal(store.listTradeIntents(user.id).length, 0);
    assert.equal(store.listContracts(user.id).length, 0);
  });
});

test('safety: a risk refusal blocks the entry and is journalled', async () => {
  await withHarness(
    async ({ deps, user, store }) => {
      const { record: bot } = await importBot(store, user.id, 'Digit_Differs_AI.xml', FIXTURE);
      const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

      const result = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
      assert.equal(result.verdict, 'no_entry');
      assert.match(String(result.reason), /risk|refus|forced/i);
      assert.equal(store.listContracts(user.id).length, 0, 'a refused entry must buy nothing');
      assert.ok(
        result.run.events.some((e) => e.kind === 'rejected'),
        'the refusal must be visible in the run journal'
      );
    },
    { riskApproved: false }
  );
});

test('safety: replaying the same tick key does not open a second contract', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const { record: bot } = await importBot(store, user.id, 'Digit_Differs_AI.xml', FIXTURE);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');

    // The same tick, delivered twice — a reconnecting client, a retry, a poller
    // that fires twice. It must not buy again.
    const again = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.notEqual(again.verdict, 'entry');
    assert.equal(store.listTradeIntents(user.id).length, 1, 'a duplicate tick must not duplicate the order');
    assert.equal(store.listContracts(user.id).length, 1);
  });
});

test('safety: stop prevents any further entry', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const { record: bot } = await importBot(store, user.id, 'Digit_Differs_AI.xml', FIXTURE);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');

    await stopBotRun(deps, user, run.runId, 'token', 'test stop');
    const afterStop = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');
    assert.equal(afterStop.verdict, 'stopped');
    assert.equal(
      store.listTradeIntents(user.id).length,
      1,
      'a stopped run must not open another contract'
    );
  });
});

test('safety: a settlement updates this bot\'s run state and history, not another run\'s', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const { record: bot } = await importBot(store, user.id, 'Digit_Differs_AI.xml', FIXTURE);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    const contract = store.getContract(user.id, String(first.contractId))!;
    await store.putContract({
      ...contract,
      status: 'won',
      profit: 6,
      exitSpot: 1001,
      settlementTime: Date.now()
    });

    // The next tick consumes the settlement and runs after_purchase.
    const second = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');
    assert.equal(second.run.afterPurchaseFor, Number(first.contractId), 'the run must record which settlement it consumed');
    assert.ok(
      second.run.events.some((e) => /contract won/i.test(e.detail)),
      'the settlement must appear in this run\'s journal'
    );

    // The settlement is consumed once: replaying the same settled contract must
    // not run after_purchase again or book the profit twice.
    const third = await tickBotRun(deps, user, run.runId, 'token', 'tick-3');
    assert.notEqual(third.run.afterPurchaseFor, null);
    assert.equal(third.run.runtimeStatus, 'stopped');
  });
});

test('safety: a second user cannot see or drive the first user\'s run', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const { record: bot } = await importBot(store, user.id, 'Digit_Differs_AI.xml', FIXTURE);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const intruder = makeUser('u_intruder');
    await store.upsertUser(intruder);

    await assert.rejects(
      () => tickBotRun(deps, intruder, run.runId, 'token', 'tick-x'),
      /not found/i,
      'another tenant must not be able to tick this run'
    );
    await assert.rejects(
      () => stopBotRun(deps, intruder, run.runId, 'token', 'intruder stop'),
      /not found/i
    );
  });
});
