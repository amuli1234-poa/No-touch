/**
 * Sell rejection and lifecycle integrity.
 *
 * Early selling is only safe if every way a sale can fail is distinguished from
 * success. Deriv answers a sell in one of three ways, and this file pins one
 * test to each:
 *
 *   * `InvalidOfferings` — a definite refusal. The contract is too close to
 *     expiry to be offered, so nothing was sold, nothing is realised, and the
 *     run must stop asking rather than resubmit the same request every tick.
 *   * an uncertain outcome — the request may have reached Deriv. The contract's
 *     real state is read back; the sale is never assumed to have failed and
 *     never blindly retried.
 *   * success — settles normally, through `after_purchase`.
 *
 * Every layer below the broker is real (store, gateway, risk engine, monitor),
 * so these tests exercise the actual execution state, not a stub of it.
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
import { BrokerError } from '../execution/broker/types.js';
import { MarketDataService } from '../services/marketData.js';
import type { ExecutionFlags } from '../config/flags.js';
import { importBot } from '../bots/service.js';
import { startBotRun, tickBotRun, type BotRunDeps } from '../bots/runService.js';
import { planStrategy } from '../bots/evaluator.js';
import { xmlToTree } from '../bots/tree.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/* ------------------------------- fixtures -------------------------------- */

/**
 * Buys CALL when the market rises, then sells as soon as Deriv allows.
 *
 * The entry sits inside `controls_if`, as the official builder always emits it,
 * so the program runs on the interpreter — the only engine with a
 * `during_purchase` phase.
 */
const SELL_EARLY_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="trade_definition">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <next><block type="trade_definition_tradetype">
          <field name="TRADETYPECAT_LIST">callput</field>
          <field name="TRADETYPE_LIST">callput</field>
          <next><block type="trade_definition_contracttype">
            <field name="TYPE_LIST">CALL</field>
            <next><block type="trade_definition_candleinterval">
              <field name="CANDLEINTERVAL_LIST">60</field>
              <next><block type="trade_definition_tradeoptions">
                <field name="DURATIONTYPE_LIST">m</field>
                <field name="CURRENCY_LIST">USD</field>
                <value name="DURATION"><shadow type="math_number"><field name="NUM">5</field></shadow></value>
                <value name="AMOUNT"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
              </block></next>
            </block></next>
          </block></next>
        </block></next>
      </block>
    </statement>
  </block>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
        <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
      </block>
    </statement>
  </block>
  <block type="during_purchase">
    <statement name="DURING_PURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="check_sell"></block></value>
        <statement name="DO0"><block type="sell_at_market"></block></statement>
      </block>
    </statement>
  </block>
</xml>`;

/**
 * A second, distinct strategy. `importBot` de-duplicates by source hash, so two
 * byte-identical files would be one record — not two bots.
 */
const SELL_EARLY_BOT_B = SELL_EARLY_BOT.replace(
  '<value name="AMOUNT"><shadow type="math_number"><field name="NUM">1</field></shadow></value>',
  '<value name="AMOUNT"><shadow type="math_number"><field name="NUM">2</field></shadow></value>'
);

/** The same program, but after_purchase asks to go round again. */
const SELL_EARLY_RETRADE_BOT = SELL_EARLY_BOT.replace(
  '</xml>',
  `  <block type="after_purchase">
    <statement name="AFTERPURCHASE_STACK"><block type="trade_again"></block></statement>
  </block>
</xml>`
);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notouch-sellrej-'));
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

function makeUser(id: string): UserRecord {
  return {
    id,
    derivSub: `sub_${id}`,
    accounts: [DEMO_ACCOUNT],
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
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();
  const { market } = await marketWithTicks([100, 101, 102]);

  const flags: ExecutionFlags = {
    allowExecution: true,
    allowDemoExecution: true,
    allowRealExecution: false,
    allowAutomaticTrading: true
  } as ExecutionFlags;

  const broker = new FakeBroker();
  const auditor = new ExecutionAuditor(store);
  const monitor = new ContractMonitor({ store, broker, auditor });
  const gateway = new ExecutionGateway({
    store,
    cfg: makeConfig(),
    flags,
    broker,
    auditor,
    balanceProvider: async () => 10_000,
    riskEvaluator: () => ({ approved: true, reasons: [] }),
    onContractOpened: (user, contract, token) => monitor.monitor(user, contract, token),
    onContractClosed: async (user, contract, sale) => monitor.recordSale(user, contract.id, sale)
  });
  const runner = new AutoExecutionRunner({ store, gateway, auditor });
  const user = makeUser('u_sellrej');
  await store.upsertUser(user);
  const deps: BotRunDeps = { store, market, gateway, runner, monitor, auditor, flags };

  try {
    await fn({ store, deps, user, broker });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Marks an open contract as sellable, the way `proposal_open_contract` would. */
async function makeSellable(store: Store, userId: string, contractId: string, bidPrice = 9.5) {
  const contract = store.getContract(userId, contractId)!;
  await store.putContract({ ...contract, bidPrice, isValidToSell: true });
}

/** Settlement entries only: a stake entry is posted at purchase, not at close. */
function settlements(store: Store, userId: string) {
  return store.listLedgerEntries(userId).filter((e) => e.kind === 'settlement');
}

/** The exact error the broker produces for a Deriv `InvalidOfferings` answer. */
function invalidOfferings(): BrokerError {
  return new BrokerError(
    'invalid_offerings',
    'Contract is too close to expiry to be sold.',
    false,
    'InvalidOfferings'
  );
}

/** Opens one contract and returns its id, asserting the entry landed. */
async function enter(
  h: Harness,
  botId: string,
  runId: string,
  tickKey = 'tick-1'
): Promise<string> {
  const entry = await tickBotRun(h.deps, h.user, runId, 'token', tickKey);
  assert.equal(entry.verdict, 'entry', `expected an entry, got ${entry.verdict} (${entry.reason})`);
  assert.ok(entry.contractId, 'an entry must name a contract');
  return String(entry.contractId);
}

/* ---------------------------- InvalidOfferings ---------------------------- */

test('InvalidOfferings: the sale is refused, not recorded as a sale', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    h.broker.setScript({ sellError: invalidOfferings() });
    const after = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');

    assert.equal(h.broker.sells.length, 1, 'the request reached the broker once');
    assert.equal(after.run.runtimeStatus, 'running', 'a refusal does not stop the run');
    assert.ok(
      !after.run.events.some((e) => e.kind === 'exit'),
      'a refused sale must not be journalled as an exit'
    );
  });
});

test('InvalidOfferings: the contract stays open and is still held', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    h.broker.setScript({ sellError: invalidOfferings() });
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');

    const contract = h.store.getContract(h.user.id, contractId)!;
    assert.equal(contract.status, 'open', 'the contract was never sold');
    assert.equal(contract.profit, null, 'an unsold contract has no profit');
    assert.equal(contract.settlementTime, null, 'nothing settled');
    assert.equal(h.store.getTradeIntent(h.user.id, contract.intentId)!.state, 'OPEN');
  });
});

test('InvalidOfferings: no profit is realised for a sale that did not happen', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    h.broker.setScript({ sellError: invalidOfferings() });
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');

    // The stake was posted at purchase; a refused sale must add nothing to it.
    assert.deepEqual(settlements(h.store, h.user.id), [], 'a refused sale settles nothing');
    // The run's own profit accounting reads the ledger, so it must agree.
    const after = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-3');
    assert.equal(after.run.counters.entries, 1, 'still exactly one entry');
  });
});

test('InvalidOfferings: the rejected request is not resubmitted on every tick', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    h.broker.setScript({ sellError: invalidOfferings() });
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');
    assert.equal(h.broker.sells.length, 1);

    // Five more ticks. The contract is still flagged sellable by Deriv, so
    // without the refusal being remembered each tick would resubmit.
    for (let i = 3; i <= 7; i++) {
      await tickBotRun(h.deps, h.user, run.runId, 'token', `tick-${i}`);
    }
    assert.equal(h.broker.sells.length, 1, 'the refused sale was not resubmitted');

    const runAfter = h.store.getBotRun(h.user.id, run.runId)!;
    assert.equal(runAfter.sellRefusedFor, Number(contractId), 'the refusal is remembered per contract');
    assert.equal(runAfter.sellRefusedReason, 'invalid_offerings');
  });
});

test('InvalidOfferings: the refusal is recorded once, with the Deriv code', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    h.broker.setScript({ sellError: invalidOfferings() });
    for (let i = 2; i <= 5; i++) {
      await tickBotRun(h.deps, h.user, run.runId, 'token', `tick-${i}`);
    }

    const denials = h.store
      .listExecutionAudit()
      .filter((e) => e.userId === h.user.id && e.action === 'bot.run.sell' && e.outcome === 'denied');
    assert.equal(denials.length, 1, 'the refusal is journalled once, not once per tick');
    assert.equal((denials[0].detail as any).reason, 'invalid_offerings');
  });
});

test('InvalidOfferings: the contract then expires normally and after_purchase runs', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_RETRADE_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    h.broker.setScript({ sellError: invalidOfferings() });
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');

    // Deriv settles the contract at expiry, exactly as it would without a sale.
    // The update goes through the monitor's subscription, which is what posts
    // the settlement entry — writing the record directly would bypass it.
     await h.broker.emitContract(Number(contractId), 'won', 0.95);
    await Promise.resolve();

    const settled = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-3');

    assert.equal(settled.run.afterPurchaseFor, Number(contractId), 'after_purchase saw the settlement');
    assert.equal(settled.verdict, 'entry', 'trade_again went round again');
    assert.equal(h.broker.sells.length, 1, 'no further sale was attempted after the refusal');

    // The expiry settlement is the only settlement, and it is the real one.
    const settledEntries = settlements(h.store, h.user.id);
    assert.equal(settledEntries.length, 1);
    assert.equal(settledEntries[0].amount, 0.95);
  });
});

/* ------------------------------- uncertain -------------------------------- */

test('uncertain: an unconfirmed sale is reconciled, not assumed to have failed', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    // The request may have reached Deriv; no answer came back.
    h.broker.setScript({
      sellError: new BrokerError('timeout', 'No confirmation received.', true)
    });

    // Deriv is then read back and reports the contract still open.
    const ticks: Promise<void>[] = [];
    const pending = tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');
    // The monitor subscribes for the refresh; emit an open update to answer it.
    setTimeout(() => h.broker.emitContract(Number(contractId), 'open', null), 5);
    await pending;

    const after = h.store.getBotRun(h.user.id, run.runId)!;
    assert.equal(after.runtimeStatus, 'running', 'an uncertain sale does not stop the run');
    assert.equal(h.broker.sells.length, 1, 'the sale was not blindly retried');

    // The reconciliation is journalled as an error, never as an exit.
    assert.ok(
      !after.events.some((e) => e.kind === 'exit'),
      'an unconfirmed sale is not a sale'
    );
    assert.ok(
      after.events.some((e) => /reconcil|not confirmed/i.test(e.detail)),
      `expected a reconciliation note, got ${after.events.map((e) => e.detail).join(' | ')}`
    );
    assert.deepEqual(settlements(h.store, h.user.id), [], 'nothing was realised');
    assert.equal(h.store.getContract(h.user.id, contractId)!.status, 'open', 'the contract is still held');
    void ticks;
  });
});

test('uncertain: a duplicate sale cannot be submitted while one is unresolved', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    // The broker answers uncertainly and Deriv never replies to the re-read,
    // so the close attempt stays pending.
    h.broker.setScript({ sellError: new BrokerError('timeout', 'No confirmation received.', true) });
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');
    const afterFirst = h.broker.sells.length;

    // A second tick must not submit again: the pending-close guard holds.
    h.broker.setScript({});
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-3');
    assert.equal(h.broker.sells.length, afterFirst, 'no duplicate sale was submitted');
  });
});

/* ------------------------------ success path ------------------------------ */

test('success: a completed sale settles and realises its proceeds', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_RETRADE_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');
    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    h.broker.setScript({ soldFor: 9.5 });
    const after = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');

    assert.equal(h.broker.sells.length, 1);
    const contract = h.store.getContract(h.user.id, contractId)!;
    assert.notEqual(contract.status, 'open', 'a completed sale closes the contract');
    assert.equal(after.run.afterPurchaseFor, Number(contractId), 'after_purchase ran on the sale');

    const settled = settlements(h.store, h.user.id);
    assert.equal(settled.length, 1, 'the sale posts exactly one settlement');
    assert.equal(settled[0].contractId, contractId);
    assert.equal(contract.status, 'sold');
    // A sale realises the difference between what Deriv paid and what was paid.
    assert.equal(settled[0].amount, 9.5 - contract.buyPrice);
  });
});

/* ----------------------------- full lifecycle ----------------------------- */

test('lifecycle: purchase, sell attempt, settlement, after_purchase, trade_again', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_RETRADE_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, first);

    // during_purchase sells, the sale settles, after_purchase asks for another
    // trade, and the same tick opens the next contract. That is DBot's loop.
    const sold = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');
    assert.equal(sold.verdict, 'entry', 'trade_again opened the next contract');
    assert.equal(h.broker.sells.length, 1, 'exactly one sale');
    const second = String(sold.contractId);
    assert.notEqual(second, first, 'a genuinely new contract was opened');
    assert.equal(h.store.getContract(h.user.id, first)!.status !== 'open', true);
    assert.equal(h.store.getContract(h.user.id, second)!.status, 'open');
  });
});

test('lifecycle: InvalidOfferings, expiry, after_purchase, trade_again', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_RETRADE_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, first);

    h.broker.setScript({ sellError: invalidOfferings() });
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');
    assert.equal(h.broker.sells.length, 1, 'one refused attempt');
    assert.equal(h.store.getContract(h.user.id, first)!.status, 'open', 'still held after the refusal');

    // Expiry settles it, and the loop continues exactly as it would have.
     await h.broker.emitContract(Number(first), 'lost', -1);
    await Promise.resolve();

    const after = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-3');
    assert.equal(after.run.afterPurchaseFor, Number(first));
    assert.equal(after.verdict, 'entry', 'trade_again continued the loop');
    assert.equal(h.broker.sells.length, 1, 'the refused sale was never resubmitted');
    assert.equal(settlements(h.store, h.user.id).length, 1, 'only the expiry settled');
  });
});

test('lifecycle: the entry ceiling never interrupts management of an open contract', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO', maxEntries: 1 }, 'token');

    const contractId = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, contractId);

    const after = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');

    assert.equal(h.broker.sells.length, 1, 'the held contract was still sold at the ceiling');
    assert.notEqual(h.store.getContract(h.user.id, contractId)!.status, 'open');
    assert.equal(after.run.counters.entries, 1, 'the ceiling still capped entries');
  });
});

test('lifecycle: one open contract per bot, even with ticks arriving quickly', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_RETRADE_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');

    const contractId = await enter(h, bot.id, run.runId);

    // The contract is open and not yet sellable: nothing may buy a second one.
    for (let i = 2; i <= 5; i++) {
      const tick = await tickBotRun(h.deps, h.user, run.runId, 'token', `tick-${i}`);
      assert.equal(tick.verdict, 'skipped');
      assert.equal(tick.reason, 'a contract is still open');
    }
    assert.equal(h.store.listContracts(h.user.id).length, 1, 'only one contract exists');
    assert.equal(h.broker.buys.length, 1, 'only one purchase was submitted');
    assert.equal(h.store.getContract(h.user.id, contractId)!.status, 'open');
  });
});

/* ---------------------------- multiple bots ------------------------------ */

test('isolation: one bot\'s refusal does not affect another bot', async () => {
  await withHarness(async (h) => {
    // Two bots on the same account. Each run keeps its own refusal, so bot A
    // being told "no sale available" must not silence bot B.
    const botA = await importBot(h.store, h.user.id, 'a.xml', SELL_EARLY_BOT).then((r) => r.record);
    const botB = await importBot(h.store, h.user.id, 'b.xml', SELL_EARLY_BOT_B).then((r) => r.record);
    assert.notEqual(botA.id, botB.id, 'the two fixtures must be distinct bots');

    const runA = await startBotRun(h.deps, h.user, botA.id, { accountId: 'DEMO' }, 'token');
    const contractA = await enter(h, botA.id, runA.runId, 'a-1');
    await makeSellable(h.store, h.user.id, contractA);

    h.broker.setScript({ sellError: invalidOfferings() });
    await tickBotRun(h.deps, h.user, runA.runId, 'token', 'a-2');
    assert.equal(h.store.getBotRun(h.user.id, runA.runId)!.sellRefusedFor, Number(contractA));

    // Bot B runs its own loop and is unaffected by A's verdict.
    const runB = await startBotRun(h.deps, h.user, botB.id, { accountId: 'DEMO' }, 'token');
    const contractB = await enter(h, botB.id, runB.runId, 'b-1');
    await makeSellable(h.store, h.user.id, contractB);

    h.broker.setScript({ soldFor: 8 });
    const soldB = await tickBotRun(h.deps, h.user, runB.runId, 'token', 'b-2');

    assert.equal(h.store.getBotRun(h.user.id, runB.runId)!.sellRefusedFor, null, 'bot B was never refused');
    assert.notEqual(h.store.getContract(h.user.id, contractB)!.status, 'open', 'bot B sold normally');
    assert.equal(soldB.run.runId, runB.runId);

    // Bot A's contract is still open, still refused, and still its own.
    assert.equal(h.store.getContract(h.user.id, contractA)!.status, 'open');
    assert.equal(h.store.getBotRun(h.user.id, runA.runId)!.sellRefusedFor, Number(contractA));

    // Bot A does not resume selling either: its refusal is unchanged by B's sale.
    await tickBotRun(h.deps, h.user, runA.runId, 'token', 'a-3');
    assert.equal(h.broker.sells.filter((s) => s.contractId === Number(contractA)).length, 1);
  });
});

test('isolation: a new contract for the same bot starts with a clean refusal slate', async () => {
  await withHarness(async (h) => {
    const bot = await importBot(h.store, h.user.id, 'bot.xml', SELL_EARLY_RETRADE_BOT).then((r) => r.record);
    const run = await startBotRun(h.deps, h.user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await enter(h, bot.id, run.runId);
    await makeSellable(h.store, h.user.id, first);
    h.broker.setScript({ sellError: invalidOfferings() });
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');
    assert.equal(h.store.getBotRun(h.user.id, run.runId)!.sellRefusedFor, Number(first));

    // The first contract expires; trade_again opens a second one.
     await h.broker.emitContract(Number(first), 'won', 0.95);
    await Promise.resolve();
    const next = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-3');
    assert.equal(next.verdict, 'entry');
    const second = String(next.contractId);
    assert.notEqual(second, first);

    // The new contract inherits nothing: it can be sold.
    await makeSellable(h.store, h.user.id, second);
    h.broker.setScript({ soldFor: 7 });
    await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-4');

    assert.equal(h.broker.sells.length, 2, 'the second contract was sold normally');
    assert.equal(h.store.getBotRun(h.user.id, run.runId)!.sellRefusedFor, null);
    assert.notEqual(h.store.getContract(h.user.id, second)!.status, 'open');
  });
});

/* ---------------------- planning rejects bad shapes ---------------------- */

test('plan: a bare value block in statement position is refused before any purchase', () => {
  // `check_sell` is a value block. In statement position it can never sell, and
  // the interpreter would throw on the first tick after a purchase — leaving the
  // contract open with nothing to manage it. Planning must catch it first.
  const malformed = SELL_EARLY_BOT.replace(
    `<block type="controls_if">
        <value name="IF0"><block type="check_sell"></block></value>
        <statement name="DO0"><block type="sell_at_market"></block></statement>
      </block>`,
    '<block type="check_sell"></block>'
  );
  assert.notEqual(malformed, SELL_EARLY_BOT, 'the fixture must actually be rewritten');

  const planned = planStrategy(xmlToTree(malformed));
  assert.equal(planned.ok, false, 'a strategy that cannot reach its sell must not start');
  assert.match(planned.reasons.join(' '), /value block \(check_sell\) where a statement is required/);
});

test('plan: the correct early-sell shape is still accepted', () => {
  // The guard above must not become a blanket refusal of early selling.
  const planned = planStrategy(xmlToTree(SELL_EARLY_BOT));
  assert.equal(planned.ok, true, `expected acceptance, got: ${planned.reasons.join(' ')}`);
  assert.equal(planned.plan?.engine, 'interpreter', 'the early-sell program runs on the interpreter');
});
