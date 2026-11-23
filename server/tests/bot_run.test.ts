/**
 * Bot execution tests: a saved strategy running against a real DEMO account.
 *
 * The broker is `FakeBroker`, so nothing here touches Deriv, but every other
 * layer is the real one — the real store, the real gateway, the real risk
 * engine, the real router. That matters: the point of these tests is to prove
 * the *controls* hold, and a stubbed gateway would prove nothing about them.
 *
 * The properties under test:
 *
 *   * Run is real demo execution: a strategy whose conditions hold produces a
 *     signal, an intent and a purchase through `gateway.submit`.
 *   * A strategy whose conditions do not hold buys nothing.
 *   * `ALLOW_DEMO_EXECUTION=false` refuses the run outright.
 *   * A REAL account is refused; it is never downgraded to demo.
 *   * One tenant cannot see or stop another tenant's run.
 *   * A run cannot be edited underneath: a revision change fails the run.
 *   * An abandoned run is settled so the bot can be started again.
 *   * Run state never touches `ImportedBotRecord.status`, and the import
 *     lifecycle rules still reject an illegal transition.
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
import { loadExecutionFlags } from '../config/flags.js';
import type { ExecutionFlags } from '../config/flags.js';
import { importBot, setBotStatus, saveBotTree } from '../bots/service.js';
import {
  BotRunError,
  RUN_IDLE_TIMEOUT_MS,
  planForBot,
  startBotRun,
  stopBotRun,
  tickBotRun,
  type BotRunDeps
} from '../bots/runService.js';
import { evaluateStrategy, planStrategy } from '../bots/evaluator.js';
import { xmlToTree } from '../bots/tree.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/* ------------------------------- fixtures -------------------------------- */

/**
 * A strategy that buys CALL when the market is rising.
 *
 * `check_direction` is the simplest condition the evaluator supports, so the
 * tests exercise the real evaluation path rather than a special case.
 */
const RISING_CALL_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
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
      <block type="check_direction">
        <field name="CHECK_DIRECTION">rise</field>
        <next><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></next>
      </block>
    </statement>
  </block>
  <block type="during_purchase"><statement name="DURING_PURCHASE_STACK"></statement></block>
  <block type="after_purchase"><statement name="AFTERPURCHASE_STACK"><block type="trade_again"></block></statement></block>
</xml>`;

/** Same strategy, but the entry condition can never be satisfied here. */
const FALLING_CALL_BOT = RISING_CALL_BOT.replace(
  '<field name="CHECK_DIRECTION">rise</field>',
  '<field name="CHECK_DIRECTION">fall</field>'
);

/**
 * A genuine DBot program: the direction test is nested inside `controls_if`, as
 * the official builder always emits it, and the decision is made by branching.
 * The plan engine cannot model this, so it must run on the interpreter.
 */
const BRANCHING_CALL_BOT = RISING_CALL_BOT.replace(
  `<block type="check_direction">
        <field name="CHECK_DIRECTION">rise</field>
        <next><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></next>
      </block>`,
  `<block type="controls_if">
        <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
        <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
      </block>`
);

/** The same program with a direction that cannot be satisfied by the ticks. */
const BRANCHING_FALLING_BOT = BRANCHING_CALL_BOT.replace(
  '<field name="CHECK_DIRECTION">rise</field>',
  '<field name="CHECK_DIRECTION">fall</field>'
);

/** A branching program whose after-purchase stack never asks to trade again. */
const BRANCHING_NO_RETRADE_BOT = BRANCHING_CALL_BOT.replace(
  '<statement name="AFTERPURCHASE_STACK"><block type="trade_again"></block></statement>',
  '<statement name="AFTERPURCHASE_STACK"></statement>'
);

const LEGACY_DIGIT_DIFF_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" collection="false">
  <block type="trade" id="trade" x="0" y="0">
    <field name="MARKET_LIST">volidx</field>
    <field name="SUBMARKET_LIST">random_index</field>
    <field name="SYMBOL_LIST">R_50</field>
    <field name="TRADETYPECAT_LIST">digits</field>
    <field name="TRADETYPE_LIST">matchesdiffers</field>
    <field name="TYPE_LIST">DIGITDIFF</field>
    <field name="CANDLEINTERVAL_LIST">60</field>
    <statement name="SUBMARKET">
      <block type="tradeOptions" id="trade_options">
        <field name="DURATIONTYPE_LIST">t</field>
        <field name="CURRENCY_LIST">USD</field>
        <value name="DURATION">
          <shadow type="math_number"><field name="NUM">1</field></shadow>
        </value>
        <value name="AMOUNT">
          <shadow type="math_number"><field name="NUM">0.35</field></shadow>
        </value>
        <value name="PREDICTION">
          <block type="last_digit"/>
        </value>
      </block>
    </statement>
  </block>
  <block type="before_purchase" id="before_purchase" x="0" y="700">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="purchase"><field name="PURCHASE_LIST">DIGITDIFF</field></block>
    </statement>
  </block>
</xml>`;

const LEGACY_COMPLEX_DIGIT_DIFF_BOT = LEGACY_DIGIT_DIFF_BOT
  .replace('<block type="last_digit"/>', '<block type="variables_get"><field name="VAR">Current Prediction</field></block>')
  .replace(
    '<block type="purchase"><field name="PURCHASE_LIST">DIGITDIFF</field></block>',
    '<block type="controls_if"><statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">DIGITDIFF</field></block></statement></block>'
  );

/** A strategy that sells before expiry, which this build does not honour. */
const EARLY_SELL_BOT = RISING_CALL_BOT.replace(
  '<statement name="DURING_PURCHASE_STACK"></statement>',
  '<statement name="DURING_PURCHASE_STACK"><block type="check_sell"></block></statement>'
);

/** Uses a block the evaluator refuses, so the run must be declined at start. */
const UNSUPPORTED_BOT = RISING_CALL_BOT.replace(
  '<block type="check_direction">\n        <field name="CHECK_DIRECTION">rise</field>',
  '<block type="check_result">\n        <field name="CHECK_DIRECTION">rise</field>'
);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notouch-run-'));
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

/** A market service with R_100 known and a tick history the test controls. */
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
  sock: ReturnType<typeof fakeSocket>;
  setQuotes: (quotes: number[]) => void;
}

/**
 * Builds the full stack over a temp store.
 *
 * The gateway is the real one with the real risk engine; only the broker is
 * fake. `flags` lets a test flip the kill switches.
 */
async function withHarness(
  fn: (h: Harness) => Promise<void>,
  opts: { flags?: Partial<ExecutionFlags>; quotes?: number[]; accounts?: UserRecord['accounts'] } = {}
): Promise<void> {
  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();

  const { market, sock } = await marketWithTicks(opts.quotes ?? [100, 101, 102]);

  const flags: ExecutionFlags = {
    allowExecution: true,
    allowDemoExecution: true,
    allowRealExecution: false,
    // Bot intents carry no manual approval, so the gateway classifies them as
    // automatic and requires this switch. Left on here; the mid-run kill-switch
    // test flips the demo gate instead.
    allowAutomaticTrading: true,
    ...opts.flags
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

  const user = makeUser('u_demo', opts.accounts);
  await store.upsertUser(user);

  const deps: BotRunDeps = { store, market, gateway, runner, monitor, auditor, flags };

  try {
    await fn({
      store,
      deps,
      user,
      broker,
      sock,
      setQuotes: (quotes) => {
        for (const [i, quote] of quotes.entries()) {
          sock.emit('message', {
            data: JSON.stringify({
              msg_type: 'tick',
              tick: { symbol: 'R_100', quote, epoch: 1000 + i, pip_size: 2 }
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

async function importFixture(store: Store, userId: string, xml = RISING_CALL_BOT) {
  const { record } = await importBot(store, userId, 'bot.xml', xml);
  return record;
}

/* ----------------------------- plan/evaluate ----------------------------- */

test('plan: reads symbol, contract type, stake and entry conditions', () => {
  const planned = planStrategy(xmlToTree(RISING_CALL_BOT));
  assert.equal(planned.ok, true, planned.reasons.join(' '));
  const plan = planned.plan!;
  assert.equal(plan.symbol, 'R_100');
  assert.equal(plan.contractType, 'CALL');
  assert.equal(plan.direction, 'RISE');
  assert.equal(plan.stake, 1);
  assert.equal(plan.duration, 5);
  assert.deepEqual(plan.conditions, [{ kind: 'direction', direction: 'RISE' }]);
});

test('plan: refuses a strategy containing a block it cannot execute', () => {
  const planned = planStrategy(xmlToTree(UNSUPPORTED_BOT));
  assert.equal(planned.ok, false);
  assert.ok(planned.unsupported.includes('check_result'));
  assert.match(planned.reasons.join(' '), /cannot execute/);
});

test('plan: refuses an early-sell strategy instead of silently holding to expiry', () => {
  const planned = planStrategy(xmlToTree(EARLY_SELL_BOT));
  assert.equal(planned.ok, false);
  assert.ok(planned.unsupported.includes('check_sell'));
  assert.match(planned.reasons.join(' '), /held to expiry/);
});

test('plan: refuses a strategy with no entry condition', () => {
  const noCondition = RISING_CALL_BOT.replace(
    `<block type="check_direction">
        <field name="CHECK_DIRECTION">rise</field>
        <next><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></next>
      </block>`,
    '<block type="purchase"><field name="PURCHASE_LIST">CALL</field></block>'
  );
  const planned = planStrategy(xmlToTree(noCondition));
  assert.equal(planned.ok, false);
  assert.match(planned.reasons.join(' '), /no entry condition/);
});

test('plan: supports a simple legacy DIGITDIFF bot with an explicit last-digit prediction', () => {
  const planned = planStrategy(xmlToTree(LEGACY_DIGIT_DIFF_BOT));
  assert.equal(planned.ok, true, planned.reasons.join(' '));
  const plan = planned.plan!;
  assert.equal(plan.symbol, 'R_50');
  assert.equal(plan.contractType, 'DIGITDIFF');
  assert.equal(plan.contractFamily, 'digits');
  assert.equal(plan.direction, 'NONE');
  assert.equal(plan.dynamicDigit, true);
  assert.equal(plan.stake, 0.35);
  assert.equal(plan.duration, 1);
  assert.equal(plan.durationUnit, 't');
  assert.deepEqual(plan.conditions, [{ kind: 'digit_prediction', contractType: 'DIGITDIFF' }]);
});

test('plan: a branching legacy digit program runs on the interpreter', () => {
  // The root block is `trade` and the contract is a digit type, which used to
  // force the plan engine. Structure decides instead: this program gates its
  // purchase behind `controls_if`, so the interpreter owns it and the blocks the
  // plan engine cannot model are no longer a refusal.
  const planned = planStrategy(xmlToTree(LEGACY_COMPLEX_DIGIT_DIFF_BOT));
  assert.equal(planned.ok, true, planned.reasons.join(' '));
  assert.equal(planned.plan!.engine, 'interpreter');
  assert.equal(planned.plan!.contractType, 'DIGITDIFF');
  assert.equal(planned.plan!.symbol, 'R_50');
  assert.deepEqual(planned.unsupported, []);
});

/**
 * The real exported bot this build was asked to run.
 *
 * Read from disk rather than inlined so the test tracks the actual file: if the
 * export changes, the assertions change with it instead of drifting against a
 * stale copy.
 */
const DIGIT_DIFFERS_AI_XML = fs
  .readFileSync(path.join(import.meta.dirname, '..', '..', 'Digit_Differs_AI.xml'), 'utf8')
  // The harness market streams R_100; the export trades R_50.
  .replace(/R_50/g, 'R_100');

test('run: the exported Digit_Differs_AI bot reaches a digit entry end to end', async () => {
  await withHarness(async ({ deps, user, store, setQuotes }) => {
    const bot = await importFixture(store, user.id, DIGIT_DIFFERS_AI_XML);
    setQuotes([1000.11, 1000.22, 1000.33, 1000.44, 1000.55]);

    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    // INITIALIZATION runs at start, so the strategy's own session caps exist
    // before the first entry decision. Without it the gate could never open.
    assert.ok(Object.keys(run.variables).length > 0, 'initialization should set variables');

    const result = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(result.verdict, 'entry');
    assert.equal(store.listTradeIntents(user.id).length, 1);
  });
});

test('run: the exported Digit_Differs_AI bot stops itself once a contract settles in profit', async () => {
  await withHarness(async ({ deps, user, store, setQuotes }) => {
    const bot = await importFixture(store, user.id, DIGIT_DIFFERS_AI_XML);
    setQuotes([1000.11, 1000.22, 1000.33, 1000.44, 1000.55]);

    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');
    // The export's own INITIALIZATION sets Take Profit to 5 USD.
    assert.equal(run.variables.take_profit_limit, 5);

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');

    const contract = store.getContract(user.id, String(first.contractId))!;
    await store.putContract({
      ...contract,
      status: 'won',
      profit: 6,
      exitSpot: 1001,
      settlementTime: Date.now()
    });

    // The export's win branch ends without a `trade_again`, so the run stops
    // rather than opening another contract. The stop is the strategy's own
    // decision; the entry ceiling is untouched.
    const second = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');
    assert.equal(second.verdict, 'stopped');
    assert.equal(second.run.runtimeStatus, 'stopped');
    assert.equal(second.run.afterPurchaseFor, Number(first.contractId));
    assert.equal(store.listTradeIntents(user.id).length, 1);
    assert.ok(
      second.run.events.some((e) => /contract won/i.test(e.detail)),
      'the win notification should be journalled'
    );

    // A stopped run stays stopped: a later tick cannot resume it.
    const third = await tickBotRun(deps, user, run.runId, 'token', 'tick-3');
    assert.equal(third.verdict, 'stopped');
    assert.equal(store.listTradeIntents(user.id).length, 1);
  });
});

test('run: the exported Digit_Differs_AI bot stops at its own stop-loss', async () => {
  await withHarness(async ({ deps, user, store, setQuotes }) => {
    const bot = await importFixture(store, user.id, DIGIT_DIFFERS_AI_XML);
    setQuotes([1000.11, 1000.22, 1000.33, 1000.44, 1000.55]);

    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');
    // The export sets Stop Loss to 3 USD.
    assert.equal(run.variables.stop_loss_limit, 3);

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');

    const contract = store.getContract(user.id, String(first.contractId))!;
    await store.putContract({
      ...contract,
      status: 'lost',
      profit: -3.5,
      exitSpot: 999,
      settlementTime: Date.now()
    });

    // Cumulative profit is at or below minus the stop loss, so the strategy's
    // own stop condition fires and it declines to trade again.
    const second = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');
    assert.equal(second.verdict, 'stopped');
    assert.equal(second.run.runtimeStatus, 'stopped');
    assert.equal(store.listTradeIntents(user.id).length, 1);
    assert.ok(
      second.run.events.some((e) => /stop condition reached/i.test(e.detail)),
      'the stop-condition notification should be journalled'
    );
  });
});

test('plan: a flat legacy digit export keeps the plan engine', () => {
  // The older export has no decision block: its entry rule is the single
  // purchase, which only the plan engine's digit path models.
  const planned = planStrategy(xmlToTree(LEGACY_DIGIT_DIFF_BOT));
  assert.equal(planned.ok, true, planned.reasons.join(' '));
  assert.equal(planned.plan!.engine, 'plan');
});

test('evaluate: legacy DIGITDIFF resolves the latest digit for the barrier', () => {
  const plan = planStrategy(xmlToTree(LEGACY_DIGIT_DIFF_BOT)).plan!;
  const verdict = evaluateStrategy({
    plan,
    ticks: [{ symbol: 'R_50', quote: 123.4, bid: null, ask: null, epoch: 1, pipSize: 2 }]
  });
  assert.equal(verdict.kind, 'entry');
  assert.equal((verdict as { digit: number }).digit, 0);
});

test('evaluate: a legacy digit bot waits when the latest tick has no pip size', () => {
  const plan = planStrategy(xmlToTree(LEGACY_DIGIT_DIFF_BOT)).plan!;
  const verdict = evaluateStrategy({
    plan,
    ticks: [{ symbol: 'R_50', quote: 123.4, bid: null, ask: null, epoch: 1, pipSize: null }]
  });
  assert.equal(verdict.kind, 'insufficient');
  assert.match(verdict.reason, /pip size/);
});

test('evaluate: rising ticks satisfy a rise condition; falling ticks do not', () => {
  const plan = planStrategy(xmlToTree(RISING_CALL_BOT)).plan!;
  const up = evaluateStrategy({
    plan,
    ticks: [{ symbol: 'R_100', quote: 100, bid: null, ask: null, epoch: 1, pipSize: 2 },
            { symbol: 'R_100', quote: 101, bid: null, ask: null, epoch: 2, pipSize: 2 }]
  });
  assert.equal(up.kind, 'entry');
  assert.equal((up as { direction: string }).direction, 'RISE');

  const down = evaluateStrategy({
    plan,
    ticks: [{ symbol: 'R_100', quote: 101, bid: null, ask: null, epoch: 1, pipSize: 2 },
            { symbol: 'R_100', quote: 100, bid: null, ask: null, epoch: 2, pipSize: 2 }]
  });
  assert.equal(down.kind, 'no_entry');
});

test('evaluate: one tick is insufficient, never an entry', () => {
  const plan = planStrategy(xmlToTree(RISING_CALL_BOT)).plan!;
  const verdict = evaluateStrategy({
    plan,
    ticks: [{ symbol: 'R_100', quote: 100, bid: null, ask: null, epoch: 1, pipSize: 2 }]
  });
  assert.equal(verdict.kind, 'insufficient');
});

test('evaluate: is a pure function of the ticks supplied', () => {
  const plan = planStrategy(xmlToTree(RISING_CALL_BOT)).plan!;
  const ticks = [100, 101, 102].map((quote, i) => ({
    symbol: 'R_100', quote, bid: null, ask: null, epoch: i, pipSize: 2
  }));
  assert.deepEqual(evaluateStrategy({ plan, ticks }), evaluateStrategy({ plan, ticks }));
});

/* ------------------------------- start/stop ------------------------------ */

test('start: opens a running session bound to the bot revision, in demo only', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    assert.equal(run.runtimeStatus, 'running');
    assert.equal(run.accountMode, 'demo');
    assert.equal(run.botId, bot.id);
    assert.equal(run.strategyRevision, bot.revision ?? 0);
    assert.equal(run.symbol, 'R_100');
    assert.equal(run.counters.entries, 0);

    // The import lifecycle is untouched by running.
    const stored = store.getImportedBot(user.id, bot.id)!;
    assert.equal(stored.status, 'imported');
  });
});

test('start: refuses when demo execution is disabled', async () => {
  await withHarness(
    async ({ deps, user, store }) => {
      const bot = await importFixture(store, user.id);
      await assert.rejects(
        () => startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token'),
        (err: unknown) =>
          err instanceof BotRunError &&
          err.code === 'execution_disabled' &&
          err.status === 403
      );
      // Nothing was recorded, so no half-started run exists.
      assert.equal(store.listBotRuns(user.id).length, 0);
    },
    { flags: { allowDemoExecution: false } }
  );
});

test('start: refuses a real account rather than downgrading it', async () => {
  await withHarness(
    async ({ deps, user, store }) => {
      const bot = await importFixture(store, user.id);
      await assert.rejects(
        () => startBotRun(deps, user, bot.id, { accountId: 'REAL' }, 'token'),
        (err: unknown) => err instanceof BotRunError && err.code === 'real_account_refused'
      );
      assert.equal(store.listBotRuns(user.id).length, 0);
    },
    {
      accounts: [
        DEMO_ACCOUNT,
        { accountId: 'REAL', type: 'real', currency: 'USD', status: 'active' }
      ]
    }
  );
});

test('start: refuses an account that is not the caller\'s', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    await assert.rejects(
      () => startBotRun(deps, user, bot.id, { accountId: 'SOMEONE_ELSE' }, 'token'),
      (err: unknown) => err instanceof BotRunError && err.code === 'account_not_authorized'
    );
  });
});

test('start: refuses when the asserted mode disagrees with the stored mode', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    await assert.rejects(
      () =>
        startBotRun(
          deps,
          user,
          bot.id,
          { accountId: 'DEMO', accountMode: 'real' },
          'token'
        ),
      (err: unknown) => err instanceof BotRunError && err.code === 'account_mode_mismatch'
    );
  });
});

test('start: refuses without a live Deriv authorisation', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    await assert.rejects(
      () => startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, null),
      (err: unknown) => err instanceof BotRunError && err.code === 'deriv_not_authenticated'
    );
  });
});

test('start: refuses a strategy this build cannot execute', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id, UNSUPPORTED_BOT);
    await assert.rejects(
      () => startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token'),
      (err: unknown) =>
        err instanceof BotRunError &&
        err.code === 'strategy_not_runnable' &&
        err.reasons.length > 0
    );
  });
});

test('start: a second start on an active run is refused', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');
    await assert.rejects(
      () => startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token'),
      (err: unknown) => err instanceof BotRunError && err.code === 'run_already_active'
    );
    assert.equal(store.listBotRuns(user.id).length, 1);
  });
});

test('start: an abandoned run is settled so the bot can start again', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const first = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    // Simulate a closed tab: no tick for longer than the idle timeout.
    const stale = { ...first, lastTickAt: Date.now() - RUN_IDLE_TIMEOUT_MS - 1000 };
    await store.putBotRun(stale);

    const second = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');
    assert.notEqual(second.runId, first.runId);
    assert.equal(store.getBotRun(user.id, first.runId)!.runtimeStatus, 'stopped');
  });
});

/* --------------------------------- ticks --------------------------------- */

test('tick: a satisfied strategy buys through the gateway, in demo', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const result = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');

    assert.equal(result.verdict, 'entry');
    assert.ok(result.contractId, 'a contract was opened');
    assert.equal(result.run.counters.entries, 1);
    assert.equal(result.run.counters.signals, 1);
    assert.equal(result.run.lastContractId, result.contractId);

    // The purchase is real execution state: an intent exists and is settled.
    const intents = store.listTradeIntents(user.id);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].accountMode, 'demo');
    assert.equal(intents[0].contractType, 'CALL');
    assert.ok(store.getContract(user.id, String(result.contractId)));

    // Still demo-only: no real intent was created.
    assert.ok(intents.every((i) => i.accountMode === 'demo'));
  });
});

test('tick: an unsatisfied strategy buys nothing but still records the evaluation', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id, FALLING_CALL_BOT);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const result = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');

    assert.equal(result.verdict, 'no_entry');
    assert.equal(result.run.counters.ticks, 1);
    assert.equal(result.run.counters.entries, 0);
    assert.equal(store.listTradeIntents(user.id).length, 0);
  });
});

test('tick: a duplicate tick key does not buy twice', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    const again = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');

    assert.equal(again.verdict, 'skipped');
    assert.equal(again.run.counters.entries, 1);
    assert.equal(store.listTradeIntents(user.id).length, 1);
  });
});

test('tick: a tick for a stopped run is a no-op', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');
    await stopBotRun(deps, user, run.runId, 'token');

    const after = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(after.verdict, 'stopped');
    assert.equal(store.listTradeIntents(user.id).length, 0);
  });
});

test('tick: an edit during the run fails the run instead of trading the new strategy', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    // Save a different strategy, which bumps the revision.
    await saveBotTree(store, user.id, bot.id, RISING_CALL_BOT.replace('R_100', 'R_75'));

    const result = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(result.run.runtimeStatus, 'failed');
    assert.match(result.run.error ?? '', /edited during the run/);
    assert.equal(store.listTradeIntents(user.id).length, 0);
  });
});

test('tick: stops itself once the entry ceiling is reached', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(
      deps,
      user,
      bot.id,
      { accountId: 'DEMO', maxEntries: 1 },
      'token'
    );

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');

    const second = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');
    assert.equal(second.verdict, 'stopped');
    assert.equal(second.run.runtimeStatus, 'stopped');
    assert.equal(store.listTradeIntents(user.id).length, 1);
  });
});

test('tick: a second satisfied tick opens a second contract', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(
      deps,
      user,
      bot.id,
      { accountId: 'DEMO', maxEntries: 2 },
      'token'
    );

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    const second = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');

    assert.equal(first.verdict, 'entry');
    assert.equal(second.verdict, 'entry');
    assert.notEqual(first.contractId, second.contractId);
    assert.equal(second.run.counters.entries, 2);

    // Two distinct intents, each backed by its own signal: reusing one signal
    // would have been refused by `consumeSignal`.
    const intents = store.listTradeIntents(user.id);
    assert.equal(intents.length, 2);
    assert.equal(new Set(intents.map((i) => i.signalId)).size, 2);
  });
});

test('tick: a branching DBot program runs on the interpreter and buys', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id, BRANCHING_CALL_BOT);

    // The plan must hand the decision to the interpreter, not refuse the
    // branching block or fall back to a condition list it cannot honour.
    const plan = planForBot(bot);
    assert.equal(plan.engine, 'interpreter');

    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');
    const result = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');

    assert.equal(result.verdict, 'entry');
    assert.ok(result.contractId, 'the program reached purchase');
    assert.equal(result.run.counters.entries, 1);
    assert.equal(store.listTradeIntents(user.id).length, 1);
  });
});

test('tick: a branching program whose condition fails buys nothing', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id, BRANCHING_FALLING_BOT);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const result = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(result.verdict, 'no_entry');
    assert.equal(result.run.runtimeStatus, 'running');
    assert.equal(store.listTradeIntents(user.id).length, 0);
  });
});

test('tick: interpreter variables persist across ticks', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const counterBot = BRANCHING_CALL_BOT.replace(
      `<block type="controls_if">
        <value name="IF0"><block type="check_direction"><field name="CHECK_DIRECTION">rise</field></block></value>
        <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
      </block>`,
      `<block type="math_change">
        <field name="VAR" id="v1">count</field>
        <value name="DELTA"><block type="math_number"><field name="NUM">1</field></block></value>
        <next>
          <block type="controls_if">
            <value name="IF0"><block type="logic_compare">
              <field name="OP">EQ</field>
              <value name="A"><block type="variables_get"><field name="VAR" id="v1">count</field></block></value>
              <value name="B"><block type="math_number"><field name="NUM">2</field></block></value>
            </block></value>
            <statement name="DO0"><block type="purchase"><field name="PURCHASE_LIST">CALL</field></block></statement>
          </block>
        </next>
      </block>`
    );

    const bot = await importFixture(store, user.id, counterBot);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    // First tick increments to 1 and does not buy; the second reaches 2 and buys.
    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'no_entry');
    assert.equal(first.run.variables.v1, 1);

    const second = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');
    assert.equal(second.verdict, 'entry');
    assert.equal(second.run.variables.v1, 2);
  });
});

test('tick: a settled contract runs after_purchase and stops when it declines to retrade', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id, BRANCHING_NO_RETRADE_BOT);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');
    const contractId = String(first.contractId);

    // Settle the contract the way Deriv would, with a small profit.
    const contract = store.getContract(user.id, contractId)!;
    await store.putContract({
      ...contract,
      status: 'won',
      profit: 0.95,
      exitSpot: 101,
      settlementTime: Date.now()
    });

    // The strategy's after_purchase has no `trade_again`, so the run ends rather
    // than looping, and the settlement is not replayed on a later tick.
    const second = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');
    assert.equal(second.verdict, 'stopped');
    assert.equal(second.run.runtimeStatus, 'stopped');
    assert.equal(second.run.afterPurchaseFor, Number(contractId));
    assert.equal(store.listTradeIntents(user.id).length, 1);
  });
});

test('tick: after_purchase runs once per settlement, not once per tick', async () => {
  await withHarness(async ({ deps, user, store }) => {
    // `BRANCHING_CALL_BOT` ends in `trade_again`, so a settled contract must let
    // the run continue — but the same settlement must not be replayed each tick.
    const bot = await importFixture(store, user.id, BRANCHING_CALL_BOT);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const first = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(first.verdict, 'entry');

    const contract = store.getContract(user.id, String(first.contractId))!;
    await store.putContract({
      ...contract,
      status: 'won',
      profit: 0.95,
      exitSpot: 101,
      settlementTime: Date.now()
    });

    const second = await tickBotRun(deps, user, run.runId, 'token', 'tick-2');
    assert.equal(second.run.runtimeStatus, 'running');
    assert.equal(second.run.afterPurchaseFor, Number(first.contractId));
    assert.equal(second.verdict, 'entry');
  });
});

test('tick: refuses to act once demo execution is switched off mid-run', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    // Flip the kill switch the way an operator would.
    (deps.flags as { allowDemoExecution: boolean }).allowDemoExecution = false;

    const result = await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    assert.equal(result.run.runtimeStatus, 'failed');
    assert.match(result.run.error ?? '', /disabled while the run was active/);
    assert.equal(store.listTradeIntents(user.id).length, 0);
  });
});

/* --------------------------------- stop ---------------------------------- */

test('stop: settles a running run and is idempotent', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const stopped = await stopBotRun(deps, user, run.runId, 'token');
    assert.equal(stopped.runtimeStatus, 'stopped');
    assert.ok(stopped.stoppedAt);

    const again = await stopBotRun(deps, user, run.runId, 'token');
    assert.equal(again.runtimeStatus, 'stopped');
    assert.equal(again.stoppedAt, stopped.stoppedAt);
  });
});

/* --------------------------- tenant isolation ---------------------------- */

test('isolation: a run is invisible and unstopable to another tenant', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');

    const intruder = makeUser('u_intruder');
    await store.upsertUser(intruder);

    // The store accessor is the isolation boundary.
    assert.equal(store.getBotRun(intruder.id, run.runId), null);
    assert.deepEqual(store.listBotRuns(intruder.id), []);
    assert.equal(store.findActiveBotRun(intruder.id, bot.id), null);

    // And the service refuses to touch it.
    await assert.rejects(
      () => tickBotRun(deps, intruder, run.runId, 'token', 'tick-1'),
      (err: unknown) => err instanceof BotRunError && err.code === 'run_not_found'
    );
    await assert.rejects(
      () => stopBotRun(deps, intruder, run.runId, 'token'),
      (err: unknown) => err instanceof BotRunError && err.code === 'run_not_found'
    );

    // The owner's run is untouched.
    assert.equal(store.getBotRun(user.id, run.runId)!.runtimeStatus, 'running');
  });
});

/* ------------------- lifecycle separation and regressions ---------------- */

test('lifecycle: run state never changes ImportedBotRecord.status', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const before = store.getImportedBot(user.id, bot.id)!.status;
    assert.equal(before, 'imported');

    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');
    await tickBotRun(deps, user, run.runId, 'token', 'tick-1');
    await stopBotRun(deps, user, run.runId, 'token');

    assert.equal(store.getImportedBot(user.id, bot.id)!.status, 'imported');
    assert.equal(store.getImportedBot(user.id, bot.id)!.revision ?? 0, bot.revision ?? 0);
  });
});

test('lifecycle: illegal transitions are still rejected after a run', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    const run = await startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token');
    await stopBotRun(deps, user, run.runId, 'token');

    // archived -> paused is not a legal move, and a run must not create one.
    await setBotStatus(store, user.id, bot.id, 'archived');
    await assert.rejects(
      () => setBotStatus(store, user.id, bot.id, 'paused'),
      (err: unknown) => err instanceof Error && /Cannot move a bot/.test(err.message)
    );
  });
});

test('lifecycle: an archived bot cannot be started', async () => {
  await withHarness(async ({ deps, user, store }) => {
    const bot = await importFixture(store, user.id);
    await setBotStatus(store, user.id, bot.id, 'archived');
    await assert.rejects(
      () => startBotRun(deps, user, bot.id, { accountId: 'DEMO' }, 'token'),
      (err: unknown) => err instanceof BotRunError && err.code === 'strategy_not_runnable'
    );
  });
});

test('planForBot: surfaces the refusal reasons for an unrunnable strategy', async () => {
  await withHarness(async ({ user, store }) => {
    const bot = await importFixture(store, user.id, UNSUPPORTED_BOT);
    assert.throws(() => planForBot(bot), (err: unknown) => err instanceof BotRunError);
  });
});

test('default flags keep demo execution off', () => {
  const flags = loadExecutionFlags({} as NodeJS.ProcessEnv);
  assert.equal(flags.allowExecution, false);
  assert.equal(flags.allowDemoExecution, false);
  assert.equal(flags.allowRealExecution, false);
});

/* --------------------------------- routes -------------------------------- */

/**
 * Route-level tests: the HTTP surface must be session-guarded, tenant-scoped and
 * demo-only, and must report each refusal with a code the UI can explain.
 *
 * The real Express router is mounted over the real store and gateway; only the
 * broker is fake.
 */
async function withRouteServer(
  fn: (ctx: {
    post: (p: string, body?: unknown) => Promise<{ status: number; body: any }>;
    get: (p: string) => Promise<{ status: number; body: any }>;
    user: UserRecord;
    other: UserRecord;
    store: Store;
    botId: string;
    otherBotId: string;
  }) => Promise<void>,
  opts: { flags?: Partial<ExecutionFlags>; token?: string | null; accounts?: UserRecord['accounts'] } = {}
): Promise<void> {
  const express = (await import('express')).default;
  const { createBotsRouter } = await import('../bots/routes.js');
  const { sign, seal } = await import('../lib/crypto.js');
  const { importBot: doImport } = await import('../bots/service.js');

  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();
  const cfg = makeConfig();
  const { market } = await marketWithTicks([100, 101, 102]);

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
  const gateway = new ExecutionGateway({
    store,
    cfg,
    flags,
    broker,
    auditor,
    balanceProvider: async () => 10_000,
    riskEvaluator: () => ({ approved: true, reasons: [] }),
    onContractOpened: (u, c, t) => monitor.monitor(u, c, t),
    onContractClosed: async (u, c, sale) => monitor.recordSale(u, c.id, sale)
  });
  const runner = new AutoExecutionRunner({ store, gateway, auditor });

  const user = makeUser('u_route', opts.accounts);
  const other = makeUser('u_other');
  await store.upsertUser(user);
  await store.upsertUser(other);

  const token = opts.token === undefined ? 'fake-token' : opts.token;
  await store.createSession({
    id: 'sess-route',
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + 100_000,
    lastSeenAt: Date.now(),
    revoked: false,
    derivTokenSealed: token === null ? '' : seal(token, cfg.session.secret),
    derivTokenExpiresAt: Date.now() + 100_000,
    derivSub: user.derivSub
  });

  const { record: bot } = await doImport(store, user.id, 'bot.xml', RISING_CALL_BOT);
  const { record: otherBot } = await doImport(store, other.id, 'bot.xml', RISING_CALL_BOT);

  const app = express();
  app.use(
    createBotsRouter({ cfg, store }, store, {
      gateway,
      runner,
      monitor,
      auditor,
      market,
      flags
    })
  );
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const cookie = `${cfg.session.cookieName}=${sign('sess-route', cfg.session.secret)}`;

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  try {
    await fn({
      post: (p, body) => call('POST', p, body),
      get: (p) => call('GET', p),
      user,
      other,
      store,
      botId: bot.id,
      otherBotId: otherBot.id
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('route: run, tick, stop over HTTP produces a demo contract', async () => {
  await withRouteServer(async ({ post, get, botId }) => {
    const started = await post(`/api/bots/${botId}/run`, { accountId: 'DEMO' });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.run.runtimeStatus, 'running');
    assert.equal(started.body.sessionDependent, true);
    assert.equal(typeof started.body.idleTimeoutMs, 'number');

    const runId = started.body.run.runId;

    const tick = await post(`/api/bots/runs/${runId}/tick`, { tickKey: 'k1' });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.verdict, 'entry');
    assert.ok(tick.body.contractId);

    const active = await get(`/api/bots/${botId}/run`);
    assert.equal(active.body.run.runId, runId);

    const stopped = await post(`/api/bots/runs/${runId}/stop`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.run.runtimeStatus, 'stopped');

    const listed = await get('/api/bots/runs');
    assert.equal(listed.body.runs.length, 1);
    assert.equal(listed.body.runs[0].runId, runId);
    // A token must never appear in a run payload.
    assert.equal(JSON.stringify(listed.body).includes('fake-token'), false);
  });
});

test('route: no session means no run', async () => {
  const express = (await import('express')).default;
  const { createBotsRouter } = await import('../bots/routes.js');
  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();
  const cfg = makeConfig();
  const app = express();
  app.use(createBotsRouter({ cfg, store }, store));
  const server = app.listen(0);
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bots/anything/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'DEMO' })
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('route: another tenant\'s bot and run are not reachable', async () => {
  await withRouteServer(async ({ post, get, otherBotId }) => {
    // Starting someone else's bot is a 404, not a 403: the id is not ours to know.
    const started = await post(`/api/bots/${otherBotId}/run`, { accountId: 'DEMO' });
    assert.equal(started.status, 404);

    const runs = await get('/api/bots/runs');
    assert.deepEqual(runs.body.runs, []);

    const tick = await post('/api/bots/runs/run_does_not_exist/tick', {});
    assert.equal(tick.status, 404);
    assert.equal(tick.body.error, 'run_not_found');
  });
});

test('route: run is refused with a code when demo execution is off', async () => {
  await withRouteServer(
    async ({ post, botId }) => {
      const started = await post(`/api/bots/${botId}/run`, { accountId: 'DEMO' });
      assert.equal(started.status, 403);
      assert.equal(started.body.error, 'execution_disabled');
      assert.ok(Array.isArray(started.body.reasons));
    },
    { flags: { allowDemoExecution: false } }
  );
});

test('route: a real account is refused over HTTP', async () => {
  await withRouteServer(
    async ({ post, botId }) => {
      const started = await post(`/api/bots/${botId}/run`, { accountId: 'REAL' });
      assert.equal(started.status, 403);
      assert.equal(started.body.error, 'real_account_refused');
    },
    {
      accounts: [DEMO_ACCOUNT, { accountId: 'REAL', type: 'real', currency: 'USD', status: 'active' }]
    }
  );
});

test('route: run is refused when the Deriv session has no token', async () => {
  await withRouteServer(
    async ({ post, botId }) => {
      const started = await post(`/api/bots/${botId}/run`, { accountId: 'DEMO' });
      assert.equal(started.status, 401);
      assert.equal(started.body.error, 'deriv_not_authenticated');
    },
    { token: null }
  );
});

test('route: run endpoints report 503 when the runtime is not wired', async () => {
  const express = (await import('express')).default;
  const { createBotsRouter } = await import('../bots/routes.js');
  const { sign } = await import('../lib/crypto.js');
  const dir = tmpDir();
  const store = new Store(dir, { unsafeDisableLock: true });
  await store.load();
  const cfg = makeConfig();
  const user = makeUser('u_nort');
  await store.upsertUser(user);
  await store.createSession({
    id: 'sess-nort',
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + 100_000,
    lastSeenAt: Date.now(),
    revoked: false,
    derivTokenSealed: '',
    derivTokenExpiresAt: Date.now() + 100_000,
    derivSub: user.derivSub
  });
  const app = express();
  // No runtime argument: the import-only build.
  app.use(createBotsRouter({ cfg, store }, store));
  const server = app.listen(0);
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bots/x/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${cfg.session.cookieName}=${sign('sess-nort', cfg.session.secret)}`
      },
      body: JSON.stringify({ accountId: 'DEMO' })
    });
    assert.equal(res.status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
