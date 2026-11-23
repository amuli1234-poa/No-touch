/**
 * `timeout` block: pause, then resume inside the block.
 *
 * DBot compiles `timeout` to `sleep(n); <TIMEOUTSTACK>; <rest of the chain>`, so
 * the strategy is suspended for N seconds and the blocks *after* the timeout
 * block also wait. These tests pin that behaviour, because the failure mode it
 * replaces was silent: the interpreter recorded the delay and the run service
 * threw it away, so a strategy that asked to wait ran immediately.
 *
 * The clock is injected (`deps.now`) so the tests never sleep for real.
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
import { startBotRun, stopBotRun, tickBotRun, type BotRunDeps } from '../bots/runService.js';
import { xmlToTree, xmlToStack, stackToXml } from '../bots/tree.js';
import { executeStack, runDeferredTimeout } from '../bots/interpreter.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/* ------------------------------- fixtures -------------------------------- */

/**
 * A branching program that waits 3 seconds before buying.
 *
 * The delay wraps the entry decision, which is how the official builder emits a
 * "wait, then trade" strategy. The `purchase` sits inside `TIMEOUTSTACK`, so
 * reaching it proves the deferred stack actually ran.
 */
const TIMEOUT_BEFORE_PURCHASE_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="trade_definition">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <next>
          <block type="trade_definition_tradetype">
            <field name="TRADETYPECAT_LIST">callput</field>
            <field name="TRADETYPE_LIST">callput</field>
            <next>
              <block type="trade_definition_contracttype">
                <field name="TYPE_LIST">CALL</field>
                <next>
                  <block type="trade_definition_candleinterval">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                    <next>
                      <block type="trade_definition_tradeoptions">
                        <field name="DURATIONTYPE_LIST">m</field>
                        <field name="CURRENCY_LIST">USD</field>
                        <value name="DURATION"><block type="math_number"><field name="NUM">5</field></block></value>
                        <value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value>
                      </block>
                    </next>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
  </block>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="timeout">
        <value name="SECONDS"><block type="math_number"><field name="NUM">3</field></block></value>
        <statement name="TIMEOUTSTACK">
          <block type="controls_if">
            <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
            <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
          </block>
        </statement>
      </block>
    </statement>
  </block>
  <block type="during_purchase"><statement name="DURING_PURCHASE_STACK"></statement></block>
  <block type="after_purchase"><statement name="AFTERPURCHASE_STACK"><block type="trade_again"></block></statement></block>
</xml>`;

/**
 * The same program, but the timeout has an empty body and the `purchase` sits
 * *after* it in the chain. DBot's `sleep(n)` pauses everything that follows, so
 * this purchase must wait too — the property a naive implementation misses.
 */
const TIMEOUT_BEFORE_CHAIN_BOT = TIMEOUT_BEFORE_PURCHASE_BOT.replace(
  `<block type="timeout">
        <value name="SECONDS"><block type="math_number"><field name="NUM">3</field></block></value>
        <statement name="TIMEOUTSTACK">
          <block type="controls_if">
            <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
            <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
          </block>
        </statement>
      </block>`,
  `<block type="timeout">
        <value name="SECONDS"><block type="math_number"><field name="NUM">3</field></block></value>
        <statement name="TIMEOUTSTACK"></statement>
        <next>
          <block type="controls_if">
            <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
            <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
          </block>
        </next>
      </block>`
);

/**
 * The real idiom, taken from DBot's own `wait 3 mins after 3 loss.xml`: the
 * delay sits in `after_purchase`, inside a counter branch, and the stack it
 * guards is `trade_again`. A build that ignores this deferral stops the run
 * instead of pausing it, ending a strategy that only asked to wait.
 */
const TIMEOUT_BEFORE_TRADE_AGAIN_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="trade_definition">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <next>
          <block type="trade_definition_tradetype">
            <field name="TRADETYPECAT_LIST">callput</field>
            <field name="TRADETYPE_LIST">callput</field>
            <next>
              <block type="trade_definition_contracttype">
                <field name="TYPE_LIST">CALL</field>
                <next>
                  <block type="trade_definition_candleinterval">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                    <next>
                      <block type="trade_definition_tradeoptions">
                        <field name="DURATIONTYPE_LIST">m</field>
                        <field name="CURRENCY_LIST">USD</field>
                        <value name="DURATION"><block type="math_number"><field name="NUM">5</field></block></value>
                        <value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value>
                      </block>
                    </next>
                  </block>
                </next>
              </block>
            </next>
          </block>
        </next>
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
  <block type="during_purchase"><statement name="DURING_PURCHASE_STACK"></statement></block>
  <block type="after_purchase">
    <statement name="AFTERPURCHASE_STACK">
      <block type="timeout">
        <value name="SECONDS"><block type="math_number"><field name="NUM">180</field></block></value>
        <statement name="TIMEOUTSTACK">
          <block type="trade_again"></block>
        </statement>
      </block>
    </statement>
  </block>
</xml>`;

/* ------------------------------- harness --------------------------------- */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-test-'));
}

const DEMO_ACCOUNT_REC = { accountId: 'DEMO', type: 'demo' as const, currency: 'USD', status: 'active' };

function makeUser(id: string): UserRecord {
  return {
    id,
    derivSub: `sub_${id}`,
    accounts: [DEMO_ACCOUNT_REC],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preferences: {}
  };
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
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  return {
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    send: () => {},
    close: () => {},
    emit: (t: string, e: unknown = {}) => (listeners[t] || []).forEach((fn) => fn(e))
  };
}

interface Harness {
  store: Store;
  deps: BotRunDeps;
  user: UserRecord;
  setQuotes: (quotes: number[]) => void;
  advance: (ms: number) => void;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();

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

  // An injectable clock so the tests assert on the delay without sleeping.
  let clock = 1_000_000;
  const deps: BotRunDeps = {
    store,
    market,
    gateway,
    runner,
    monitor,
    auditor,
    flags,
    now: () => clock
  };

  const user = makeUser('u_timeout');
  await store.upsertUser(user);

  try {
    await fn({
      store,
      deps,
      user,
      setQuotes: (quotes) => {
        for (const [i, quote] of quotes.entries()) {
          sock.emit('message', {
            data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'R_100', quote, epoch: i + 1, pip_size: 2 } })
          });
        }
      },
      advance: (ms) => {
        clock += ms;
      }
    });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------- interpreter-level tests ------------------------ */

test('timeout: records the delay and the continuation, and suspends the chain', () => {
  const tree = xmlToTree(TIMEOUT_BEFORE_PURCHASE_BOT);
  const before = tree.blocks.find((b) => b.type === 'before_purchase');
  assert.ok(before, 'fixture has a before_purchase block');
  const stack = before!.inputs.find((i) => i.name === 'BEFOREPURCHASE_STACK')?.block ?? null;

  const result = executeStack(stack, {
    ticks: [],
    variables: new Map(),
    totalProfit: 0,
    lastContract: null
  });

  assert.equal(result.timeouts.length, 1);
  assert.equal(result.timeouts[0].delayMs, 3000);
  // Suspended, so nothing downstream ran: no purchase on the first pass.
  assert.equal(result.purchase, null);
  assert.ok(result.timeouts[0].stack, 'the nested stack was captured');
});

test('timeout: the deferred stack runs when replayed, and reaches the purchase', () => {
  const tree = xmlToTree(TIMEOUT_BEFORE_PURCHASE_BOT);
  const before = tree.blocks.find((b) => b.type === 'before_purchase')!;
  const stack = before.inputs.find((i) => i.name === 'BEFOREPURCHASE_STACK')?.block ?? null;

  const ctx = {
    ticks: [
      { symbol: 'R_100', quote: 100, epoch: 1, pipSize: 2 },
      { symbol: 'R_100', quote: 101, epoch: 2, pipSize: 2 }
    ],
    variables: new Map(),
    totalProfit: 0,
    lastContract: null
  };

  const first = executeStack(stack, ctx);
  const deferred = first.timeouts[0];

  const resumed = runDeferredTimeout(deferred, ctx, tree);
  assert.equal(resumed.purchase, 'CALL', 'the delayed stack reached purchase');
  assert.equal(resumed.timeouts.length, 0);
});

test('timeout: a purchase after the block also waits, matching sleep(n) semantics', () => {
  const tree = xmlToTree(TIMEOUT_BEFORE_CHAIN_BOT);
  const before = tree.blocks.find((b) => b.type === 'before_purchase')!;
  const stack = before.inputs.find((i) => i.name === 'BEFOREPURCHASE_STACK')?.block ?? null;

  const ctx = {
    ticks: [
      { symbol: 'R_100', quote: 100, epoch: 1, pipSize: 2 },
      { symbol: 'R_100', quote: 101, epoch: 2, pipSize: 2 }
    ],
    variables: new Map(),
    totalProfit: 0,
    lastContract: null
  };

  const first = executeStack(stack, ctx);
  // The empty body means the purchase is in the continuation, not the stack.
  assert.equal(first.purchase, null, 'nothing may buy before the delay elapses');
  assert.equal(first.timeouts.length, 1);
  assert.ok(first.timeouts[0].continuation, 'the following chain was captured');

  const resumed = runDeferredTimeout(first.timeouts[0], ctx, tree);
  assert.equal(resumed.purchase, 'CALL', 'the continuation ran after the delay');
});

test('timeout: a timeout inside a loop pauses the whole strategy', () => {
  const xml = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
    <block type="controls_repeat_ext">
      <value name="TIMES"><block type="math_number"><field name="NUM">5</field></block></value>
      <statement name="DO">
        <block type="timeout">
          <value name="SECONDS"><block type="math_number"><field name="NUM">1</field></block></value>
          <statement name="TIMEOUTSTACK"></statement>
        </block>
      </statement>
    </block>
  </xml>`;
  const tree = xmlToTree(xml);
  const result = executeStack(tree.blocks[0], {
    ticks: [],
    variables: new Map(),
    totalProfit: 0,
    lastContract: null
  });

  // One deferral, not five: the loop must not spin through its iterations while
  // the strategy is asleep.
  assert.equal(result.timeouts.length, 1);
  assert.equal(result.timeouts[0].delayMs, 1000);
});

test('timeout: a negative delay is clamped, matching the generator fallback', () => {
  const xml = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
    <block type="timeout">
      <value name="SECONDS"><block type="math_number"><field name="NUM">-5</field></block></value>
      <statement name="TIMEOUTSTACK"></statement>
    </block>
  </xml>`;
  const tree = xmlToTree(xml);
  const result = executeStack(tree.blocks[0], {
    ticks: [],
    variables: new Map(),
    totalProfit: 0,
    lastContract: null
  });
  // A negative sleep would be nonsense; DBot defaults the input to 1 second.
  assert.equal(result.timeouts[0].delayMs, 1000);
});

/* --------------------------- round-trip of deferral ----------------------- */

test('deferral: a captured stack survives serialisation and re-parsing', () => {
  const tree = xmlToTree(TIMEOUT_BEFORE_PURCHASE_BOT);
  const before = tree.blocks.find((b) => b.type === 'before_purchase')!;
  const stack = before.inputs.find((i) => i.name === 'BEFOREPURCHASE_STACK')?.block ?? null;

  const result = executeStack(stack, {
    ticks: [],
    variables: new Map(),
    totalProfit: 0,
    lastContract: null
  });
  const timeout = result.timeouts[0];

  const xml = stackToXml(timeout.stack);
  assert.ok(xml && xml.includes('controls_if'), 'the stack was written as XML');

  const restored = xmlToStack(xml);
  assert.ok(restored, 'the fragment parsed back');
  assert.equal(restored!.type, 'controls_if');

  // Replaying the restored stack must still reach the purchase, which proves no
  // field, input or mutation was lost in the round trip.
  const ctx = {
    ticks: [
      { symbol: 'R_100', quote: 100, epoch: 1, pipSize: 2 },
      { symbol: 'R_100', quote: 101, epoch: 2, pipSize: 2 }
    ],
    variables: new Map(),
    totalProfit: 0,
    lastContract: null
  };
  const resumed = runDeferredTimeout(
    { delayMs: 0, stack: restored, continuation: xmlToStack(stackToXml(timeout.continuation)) },
    ctx,
    tree
  );
  assert.equal(resumed.purchase, 'CALL');
});

/* ---------------------------- run-service tests --------------------------- */

test('run: a timeout pauses the run, then buys once the delay has elapsed', async () => {
  await withHarness(async (h) => {
    const { record } = await importBot(h.store, h.user.id, 'bot.xml', TIMEOUT_BEFORE_PURCHASE_BOT);
    // Rising quotes, so the entry condition holds once the delay has passed.
    h.setQuotes([100, 101, 102, 103, 104, 105, 106, 107]);
    const run = await startBotRun(
      h.deps,
      h.user,
      record.id,
      { accountId: DEMO_ACCOUNT_REC.accountId },
      'token'
    );

    const first = await tickBotRun(h.deps, h.user, run.runId, 'token');
    assert.equal(first.verdict, 'no_entry', 'the first tick only schedules the delay');
    assert.ok(first.run.pendingDeferral, 'the run recorded what to resume');
    assert.equal(first.run.counters.entries, 0, 'nothing was bought during the pause');

    // A tick before the delay elapses must not buy either.
    h.advance(1000);
    const early = await tickBotRun(h.deps, h.user, run.runId, 'token');
    assert.equal(early.verdict, 'waiting');
    assert.equal(early.run.counters.entries, 0, 'still paused, so still no entry');

    // Once the delay has elapsed the deferred stack runs and buys.
    h.advance(2500);
    const resumed = await tickBotRun(h.deps, h.user, run.runId, 'token');
    assert.equal(resumed.run.pendingDeferral, null, 'the deferral was consumed');
    assert.equal(resumed.run.counters.entries, 1, 'the delayed purchase went through');
    assert.equal(resumed.verdict, 'entry');

    await stopBotRun(h.deps, h.user, run.runId, 'token', 'test done');
  });
});

test('run: stopping a paused run clears its deferral and buys nothing', async () => {
  await withHarness(async (h) => {
    const { record } = await importBot(h.store, h.user.id, 'bot.xml', TIMEOUT_BEFORE_PURCHASE_BOT);
    h.setQuotes([100, 101, 102, 103, 104, 105, 106, 107]);
    const run = await startBotRun(
      h.deps,
      h.user,
      record.id,
      { accountId: DEMO_ACCOUNT_REC.accountId },
      'token'
    );

    const first = await tickBotRun(h.deps, h.user, run.runId, 'token');
    assert.ok(first.run.pendingDeferral);

    const stopped = await stopBotRun(h.deps, h.user, run.runId, 'token', 'customer stopped the bot');
    assert.equal(stopped.runtimeStatus, 'stopped');

    // A tick after the stop is a no-op, even though the delay has elapsed and
    // the deferred stack would otherwise have bought.
    h.advance(10_000);
    const after = await tickBotRun(h.deps, h.user, run.runId, 'token');
    assert.equal(after.verdict, 'stopped');
    assert.equal(after.run.counters.entries, 0);
  });
});

test('run: a timeout in after_purchase pauses before trade_again, then resumes', async () => {
  await withHarness(async (h) => {
    const { record } = await importBot(h.store, h.user.id, 'bot.xml', TIMEOUT_BEFORE_TRADE_AGAIN_BOT);
    h.setQuotes([100, 101, 102, 103, 104, 105, 106, 107]);
    const run = await startBotRun(
      h.deps,
      h.user,
      record.id,
      { accountId: DEMO_ACCOUNT_REC.accountId },
      'token'
    );

    const first = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');
    const contractId = String(first.contractId);

    // Settle the contract the way Deriv would.
    const contract = h.store.getContract(h.user.id, contractId)!;
    await h.store.putContract({
      ...contract,
      status: 'won',
      profit: 0.95,
      exitSpot: 101,
      settlementTime: Date.now()
    });

    // `after_purchase` hits its 180s timeout, so the run pauses instead of
    // deciding whether to trade again. Stopping here would end a strategy that
    // only asked to wait between contracts.
    const paused = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-2');
    assert.equal(paused.verdict, 'waiting');
    assert.equal(paused.run.runtimeStatus, 'running', 'a pause is not a stop');
    assert.equal(paused.run.pendingDeferral?.phase, 'after_purchase');
    assert.equal(paused.run.afterPurchaseFor, Number(contractId), 'the settlement was consumed once');

    // A tick inside the delay still waits, and still does not re-run the stack.
    h.advance(1000);
    const stillWaiting = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-3');
    assert.equal(stillWaiting.verdict, 'waiting');
    assert.equal(stillWaiting.run.counters.entries, 1, 'no second entry while paused');

    // Once the delay elapses the deferred `trade_again` runs and the run
    // continues to the next entry decision.
    h.advance(180_000);
    const resumed = await tickBotRun(h.deps, h.user, run.runId, 'token', 'tick-4');
    assert.equal(resumed.run.pendingDeferral, null, 'the deferral was consumed');
    assert.equal(resumed.run.runtimeStatus, 'running', 'trade_again kept the run alive');
    assert.equal(resumed.verdict, 'entry', 'the next entry followed the delay');
    assert.equal(resumed.run.counters.entries, 2);

    await stopBotRun(h.deps, h.user, run.runId, 'token', 'test done');
  });
});
