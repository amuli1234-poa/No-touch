/**
 * Synthetic market discovery, contract discovery and bot compatibility.
 *
 * The market service is a fake socket, so nothing here touches Deriv, but the
 * parsing, categorisation, compatibility and adapter layers are the real ones.
 *
 * The properties under test:
 *
 *   * Every Synthetic family Deriv publishes is listed, including the ones
 *     WickSentinel's scanner refuses (Boom/Crash, Range Break). The Bots
 *     catalogue must not inherit the scanner's filter.
 *   * Non-synthetic markets are excluded.
 *   * Contract availability is symbol-scoped and respects what Deriv returns.
 *   * A digit strategy is matched to a digit contract, never converted to
 *     Rise/Fall.
 *   * Unavailable, unsupported and invalid combinations are each reported with
 *     their own state, so the UI can distinguish them.
 *   * Only `compatible` may execute.
 *   * The digit and barrier adapters build the proposal Deriv expects, and
 *     refuse impossible predictions.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MarketDataService } from '../services/marketData.js';
import type { AvailableContract } from '../services/marketData.js';
import { loadBotMarkets, loadSymbolContracts, BotMarketError } from '../bots/markets.js';
import { evaluateCompatibility, matchPlanToMarkets, isExecutable } from '../bots/compatibility.js';
import { planStrategy } from '../bots/evaluator.js';
import type { StrategyPlan } from '../bots/evaluator.js';
import { DIGITS_ADAPTER, HIGHER_LOWER_ADAPTER, TOUCH_NO_TOUCH_ADAPTER, ACCUMULATORS_ADAPTER, MULTIPLIERS_ADAPTER } from '../execution/adapters/index.js';
import { xmlToTree } from '../bots/tree.js';
import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';

/* ------------------------------- fixtures -------------------------------- */

function makeConfig(): ServerConfig {
  return {
    port: 0,
    isProduction: false,
    dataDir: '/tmp',
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
  const sent: any[] = [];
  return {
    sent,
    addEventListener: (t: string, fn: (e: any) => void) => {
      (listeners[t] ||= []).push(fn);
    },
    send: (raw: string) => {
      sent.push(JSON.parse(raw));
    },
    close: () => {},
    emit: (t: string, e: any = {}) => (listeners[t] || []).forEach((fn) => fn(e))
  };
}

/** The synthetic symbols the tests pretend Deriv returned. */
const SYNTHETIC_SYMBOLS = [
  { underlying_symbol: 'R_10', underlying_symbol_name: 'Volatility 10 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 3, exchange_is_open: 1 },
  { underlying_symbol: 'R_100', underlying_symbol_name: 'Volatility 100 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 2, exchange_is_open: 1 },
  { underlying_symbol: '1HZ100V', underlying_symbol_name: 'Volatility 100 (1s) Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 2, exchange_is_open: 1 },
  { underlying_symbol: 'BOOM1000', underlying_symbol_name: 'Boom 1000 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 4, exchange_is_open: 1 },
  { underlying_symbol: 'CRASH500', underlying_symbol_name: 'Crash 500 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 4, exchange_is_open: 1 },
  { underlying_symbol: 'JD10', underlying_symbol_name: 'Jump 10 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 2, exchange_is_open: 1 },
  { underlying_symbol: 'stpRNG', underlying_symbol_name: 'Step Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 1, exchange_is_open: 1 },
  { underlying_symbol: 'RB100', underlying_symbol_name: 'Range Break 100 Index', market: 'synthetic_index', submarket: 'random_index', pip_size: 4, exchange_is_open: 0 },
  // A non-synthetic market that must never appear in the Bots catalogue.
  { underlying_symbol: 'frxEURUSD', underlying_symbol_name: 'EUR/USD', market: 'forex', submarket: 'major_pairs', pip_size: 5, exchange_is_open: 1 }
];

async function marketWithSymbols() {
  const sock = fakeSocket();
  const market = new MarketDataService(makeConfig(), {
    wsFactory: () => sock as unknown as MinimalWebSocket,
    pingIntervalMs: 0,
    now: () => Date.now()
  });
  await market.connect();
  sock.emit('open');
  sock.emit('message', {
    data: JSON.stringify({ msg_type: 'active_symbols', active_symbols: SYNTHETIC_SYMBOLS })
  });
  return { market, sock };
}

/** Answers the next `contracts_for` request with the given rows. */
function answerContracts(sock: ReturnType<typeof fakeSocket>, rows: any[]) {
  const request = sock.sent.filter((m) => m.contracts_for).pop();
  assert.ok(request, 'a contracts_for request should have been sent');
  sock.emit('message', {
    data: JSON.stringify({
      msg_type: 'contracts_for',
      req_id: request.req_id,
      contracts_for: { available: rows }
    })
  });
}

const R100_CONTRACTS = [
  {
    contract_type: 'CALL',
    contract_category: 'callput',
    expiry_type: 'intraday',
    barriers: 0,
    min_contract_duration: '1t',
    max_contract_duration: '10t'
  },
  {
    contract_type: 'PUT',
    contract_category: 'callput',
    expiry_type: 'intraday',
    barriers: 0,
    min_contract_duration: '1t',
    max_contract_duration: '10t'
  },
  {
    contract_type: 'DIGITEVEN',
    contract_category: 'digits',
    expiry_type: 'tick',
    barriers: 0,
    min_contract_duration: '1t',
    max_contract_duration: '10t'
  },
  {
    contract_type: 'DIGITODD',
    contract_category: 'digits',
    expiry_type: 'tick',
    barriers: 0,
    min_contract_duration: '1t',
    max_contract_duration: '10t'
  },
  {
    contract_type: 'DIGITMATCH',
    contract_category: 'digits',
    expiry_type: 'tick',
    barriers: 0,
    min_contract_duration: '1t',
    max_contract_duration: '10t'
  },
  {
    contract_type: 'DIGITDIFF',
    contract_category: 'digits',
    expiry_type: 'tick',
    barriers: 0,
    min_contract_duration: '1t',
    max_contract_duration: '10t'
  }
];

/** A digit strategy: buys DIGITEVEN when the market is rising. */
const DIGIT_EVEN_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="trade_definition">
    <statement name="TRADE_OPTIONS">
      <block type="trade_definition_market">
        <field name="MARKET_LIST">synthetic_index</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <next>
          <block type="trade_definition_tradetype">
            <field name="TRADETYPECAT_LIST">digits</field>
            <field name="TRADETYPE_LIST">evenodd</field>
            <next>
              <block type="trade_definition_contracttype">
                <field name="TYPE_LIST">DIGITEVEN</field>
                <next>
                  <block type="trade_definition_candleinterval">
                    <field name="CANDLEINTERVAL_LIST">60</field>
                    <next>
                      <block type="trade_definition_tradeoptions">
                        <field name="DURATIONTYPE_LIST">t</field>
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
        <next><block type="purchase"><field name="PURCHASE_LIST">DIGITEVEN</field></block></next>
      </block>
    </statement>
  </block>
  <block type="during_purchase"><statement name="DURING_PURCHASE_STACK"></statement></block>
  <block type="after_purchase"><statement name="AFTER_PURCHASE_STACK"><block type="trade_again"></block></statement></block>
</xml>`;

function planOf(xml: string): StrategyPlan {
  const planned = planStrategy(xmlToTree(xml));
  assert.ok(planned.ok && planned.plan, `expected a plan, got: ${planned.reasons.join('; ')}`);
  return planned.plan;
}

const CONTRACT = (over: Partial<AvailableContract> = {}): AvailableContract => ({
  contractType: 'CALL',
  category: 'callput',
  barriers: 0,
  expiryType: 'intraday',
  minDuration: 1,
  maxDuration: 10,
  durationUnit: 't',
  requiresDigit: false,
  ...over
});

/* --------------------------- market discovery ---------------------------- */

test('markets: lists every Synthetic family Deriv publishes', async () => {
  const { market } = await marketWithSymbols();
  const catalog = await loadBotMarkets(market);
  const symbols = catalog.symbols.map((s) => s.symbol);

  assert.ok(symbols.includes('R_10'));
  assert.ok(symbols.includes('1HZ100V'), '1s indices must be listed');
  assert.ok(symbols.includes('JD10'), 'Jump indices must be listed');
  assert.ok(symbols.includes('stpRNG'), 'Step index must be listed');
});

test('markets: Boom, Crash and Range Break are listed despite the scanner refusing them', async () => {
  const { market } = await marketWithSymbols();
  const catalog = await loadBotMarkets(market);
  const symbols = catalog.symbols.map((s) => s.symbol);

  // WickSentinel's eligibleMarkets excludes these; the Bots catalogue must not.
  assert.ok(symbols.includes('BOOM1000'));
  assert.ok(symbols.includes('CRASH500'));
  assert.ok(symbols.includes('RB100'));

  const boom = catalog.symbols.find((s) => s.symbol === 'BOOM1000')!;
  assert.equal(boom.category, 'crash_boom');
});

test('markets: excludes non-synthetic markets', async () => {
  const { market } = await marketWithSymbols();
  const catalog = await loadBotMarkets(market);
  assert.ok(!catalog.symbols.some((s) => s.symbol === 'frxEURUSD'), 'forex must not appear');
});

test('markets: categories only include ones that have symbols, and 1s is its own category', async () => {
  const { market } = await marketWithSymbols();
  const catalog = await loadBotMarkets(market);
  const keys = catalog.categories.map((c) => c.key);

  assert.ok(keys.includes('volatility_1s'));
  assert.ok(keys.includes('volatility'));
  assert.ok(keys.includes('jump'));
  assert.ok(keys.includes('step'));
  assert.ok(keys.includes('crash_boom'));
  assert.ok(keys.includes('range_break'));
  // Every advertised category must contain at least one symbol.
  for (const key of keys) {
    assert.ok(catalog.symbols.some((s) => s.category === key), `${key} has no symbols`);
  }
});

test('markets: a closed market is listed but marked unavailable with a reason', async () => {
  const { market } = await marketWithSymbols();
  const catalog = await loadBotMarkets(market);
  const rb = catalog.symbols.find((s) => s.symbol === 'RB100')!;

  assert.equal(rb.available, false);
  assert.match(rb.unavailableReason ?? '', /closed/i);
});

test('markets: a disconnected service refuses rather than returning an empty list', async () => {
  const market = new MarketDataService(makeConfig(), {
    wsFactory: () => fakeSocket() as unknown as MinimalWebSocket,
    pingIntervalMs: 0
  });
  await assert.rejects(() => loadBotMarkets(market, { timeoutMs: 20 }), (e: unknown) => {
    assert.ok(e instanceof BotMarketError);
    assert.equal(e.code, 'market_data_unavailable');
    return true;
  });
});

/* -------------------------- contract discovery --------------------------- */

test('contracts: returns the symbol-scoped catalogue Deriv reported', async () => {
  const { market, sock } = await marketWithSymbols();
  const pending = loadSymbolContracts(market, 'R_100');
  answerContracts(sock, R100_CONTRACTS);
  const { contracts } = await pending;

  const types = contracts.map((c) => c.contractType);
  assert.deepEqual(types, ['CALL', 'DIGITDIFF', 'DIGITEVEN', 'DIGITMATCH', 'DIGITODD', 'PUT']);
  assert.ok(contracts.every((c) => c.durationUnit === 't'));
  // Even/Odd name their own prediction; only Match/Diff/Over/Under need a digit.
  assert.equal(contracts.find((c) => c.contractType === 'DIGITEVEN')!.requiresDigit, false);
  assert.equal(contracts.find((c) => c.contractType === 'DIGITMATCH')!.requiresDigit, true);
});

test('contracts: collapses duplicate expiry variants to one row per type', async () => {
  const { market, sock } = await marketWithSymbols();
  const pending = loadSymbolContracts(market, 'R_100');
  answerContracts(sock, [
    { contract_type: 'CALL', contract_category: 'callput', barriers: 0, min_contract_duration: '1t', max_contract_duration: '5t' },
    { contract_type: 'CALL', contract_category: 'callput', barriers: 0, min_contract_duration: '1t', max_contract_duration: '10t' }
  ]);
  const { contracts } = await pending;

  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].maxDuration, 10, 'keeps the most permissive window');
});

test('contracts: an unknown symbol is refused', async () => {
  const { market } = await marketWithSymbols();
  await assert.rejects(() => loadSymbolContracts(market, 'NOPE_1'), (e: unknown) => {
    assert.ok(e instanceof BotMarketError);
    assert.equal(e.code, 'unknown_symbol');
    return true;
  });
});

/* ---------------------------- plan extraction ---------------------------- */

test('plan: a digit strategy yields the digit family, not Rise/Fall', () => {
  const plan = planOf(DIGIT_EVEN_BOT);
  assert.equal(plan.contractType, 'DIGITEVEN');
  assert.equal(plan.contractFamily, 'digits');
  // Even/Odd are complete predictions, so no digit is needed.
  assert.equal(plan.digit, null);
});

test('plan: a digit strategy with no prediction is refused', () => {
  // The fixture buys DIGITMATCH without naming a digit.
  const xml = DIGIT_EVEN_BOT.replace(/DIGITEVEN/g, 'DIGITMATCH');
  const planned = planStrategy(xmlToTree(xml));
  assert.equal(planned.ok, false);
  assert.ok(planned.reasons.some((r) => /digit prediction/i.test(r)));
});

test('plan: a CALL strategy with a barrier becomes Higher/Lower', () => {
  const xml = DIGIT_EVEN_BOT.replace(/DIGITEVEN/g, 'CALL')
    .replace('<field name="TRADETYPE_LIST">evenodd</field>', '<field name="TRADETYPE_LIST">higherlower</field>')
    .replace(
      '<value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value>',
      '<value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value><value name="BARRIER"><block type="math_number"><field name="NUM">+0.5</field></block></value>'
    );
  const plan = planOf(xml);
  assert.equal(plan.contractType, 'CALL');
  assert.equal(plan.contractFamily, 'higher_lower');
  assert.equal(plan.barrier, '+0.5');
});

/* ------------------------- compatibility engine -------------------------- */

test('compatibility: a digit strategy is compatible with a symbol offering it', () => {
  const plan = planOf(DIGIT_EVEN_BOT.replace(/DIGITEVEN/g, 'DIGITMATCH').replace(
    '<value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value>',
    '<value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value><value name="BARRIER"><block type="math_number"><field name="NUM">3</field></block></value>'
  ));
  const verdict = evaluateCompatibility(plan, 'R_100', R100_CONTRACTS.map((c) => CONTRACT({
    contractType: c.contract_type,
    category: c.contract_category,
    requiresDigit: c.contract_type.startsWith('DIGIT')
  })));

  assert.equal(verdict.state, 'compatible');
  assert.equal(isExecutable(verdict), true);
});

test('compatibility: a contract the symbol does not offer is unavailable', () => {
  const plan = planOf(DIGIT_EVEN_BOT.replace(/DIGITEVEN/g, 'DIGITMATCH').replace(
    '<value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value>',
    '<value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value><value name="BARRIER"><block type="math_number"><field name="NUM">3</field></block></value>'
  ));
  // A symbol that only offers Rise/Fall.
  const verdict = evaluateCompatibility(plan, 'R_10', [
    CONTRACT({ contractType: 'CALL' }),
    CONTRACT({ contractType: 'PUT' })
  ]);

  assert.equal(verdict.state, 'unavailable');
  assert.match(verdict.reason, /does not offer DIGITMATCH/);
  assert.equal(isExecutable(verdict), false);
});

test('compatibility: an unimplemented family is unsupported, not unavailable', () => {
  const plan: StrategyPlan = {
    ...planOf(DIGIT_EVEN_BOT),
    contractType: 'MULTUP',
    contractFamily: 'multipliers',
    direction: 'RISE'
  };
  const verdict = evaluateCompatibility(plan, 'R_100', [CONTRACT({ contractType: 'MULTUP' })]);

  assert.equal(verdict.state, 'unsupported');
  assert.match(verdict.reason, /not enabled/i);
});

test('compatibility: an empty contract catalogue is never compatible', () => {
  const plan = planOf(DIGIT_EVEN_BOT);
  const verdict = evaluateCompatibility(plan, 'R_100', []);
  assert.notEqual(verdict.state, 'compatible');
  assert.equal(verdict.state, 'unavailable');
});

test('compatibility: a contract outside its own family is invalid', () => {
  const plan: StrategyPlan = { ...planOf(DIGIT_EVEN_BOT), contractFamily: 'rise_fall' };
  const verdict = evaluateCompatibility(plan, 'R_100', [CONTRACT({ contractType: 'DIGITEVEN' })]);
  assert.equal(verdict.state, 'invalid');
});

test('compatibility: a duration outside the symbol window is incompatible', () => {
  const plan = { ...planOf(DIGIT_EVEN_BOT), duration: 99 };
  const verdict = evaluateCompatibility(plan, 'R_100', [
    CONTRACT({ contractType: 'DIGITEVEN', requiresDigit: true, maxDuration: 10 })
  ]);
  assert.equal(verdict.state, 'incompatible');
  assert.ok(verdict.details.some((d) => /exceeds the maximum/i.test(d)));
});

test('compatibility: matching across markets reports a row per symbol', () => {
  const plan = planOf(DIGIT_EVEN_BOT);
  const map = new Map<string, readonly AvailableContract[]>([
    ['R_100', [CONTRACT({ contractType: 'DIGITEVEN', requiresDigit: true })]],
    ['R_10', [CONTRACT({ contractType: 'CALL' })]]
  ]);
  const rows = matchPlanToMarkets(plan, ['R_100', 'R_10', 'JD10'], map);

  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.symbol === 'R_100')!.state, 'compatible');
  assert.equal(rows.find((r) => r.symbol === 'R_10')!.state, 'unavailable');
  assert.equal(rows.find((r) => r.symbol === 'JD10')!.state, 'unavailable');
  assert.match(rows.find((r) => r.symbol === 'JD10')!.reason, /has not been loaded/);
});

/* ------------------------------ adapters --------------------------------- */

const BASE = {
  amount: 1,
  basis: 'stake' as const,
  currency: 'USD',
  symbol: 'R_100'
};

const PARAMS = {
  duration: 5,
  durationUnit: 't',
  multiplier: null,
  cancellation: null,
  stopLoss: null,
  takeProfit: null
};

test('digits adapter: builds the barrier-carrying tick proposal Deriv expects', () => {
  const payload = DIGITS_ADAPTER.buildProposal({
    ...BASE,
    directionContractType: 'DIGITOVER',
    parameters: { ...PARAMS, digit: 5 }
  });
  assert.equal(payload.contract_type, 'DIGITOVER');
  assert.equal(payload.duration, 5);
  assert.equal(payload.duration_unit, 't');
  assert.equal(payload.barrier, 5);
});

test('digits adapter: refuses a prediction that can never win', () => {
  assert.throws(
    () => DIGITS_ADAPTER.buildProposal({ ...BASE, directionContractType: 'DIGITOVER', parameters: { ...PARAMS, digit: 9 } }),
    /can never win/
  );
  assert.throws(
    () => DIGITS_ADAPTER.buildProposal({ ...BASE, directionContractType: 'DIGITUNDER', parameters: { ...PARAMS, digit: 0 } }),
    /can never win/
  );
});

test('digits adapter: Even/Odd need no prediction and are priced with no barrier', () => {
  for (const type of ['DIGITEVEN', 'DIGITODD'] as const) {
    const payload = DIGITS_ADAPTER.buildProposal({
      ...BASE,
      directionContractType: type,
      parameters: { ...PARAMS, digit: null }
    });
    assert.equal(payload.contract_type, type);
    assert.equal(payload.duration_unit, 't');
    assert.equal('barrier' in payload, false);
  }
});

test('digits adapter: refuses a missing or non-integer digit on prediction types', () => {
  assert.throws(
    () => DIGITS_ADAPTER.buildProposal({ ...BASE, directionContractType: 'DIGITOVER', parameters: { ...PARAMS, digit: null } }),
    /prediction from 0 to 9/
  );
  assert.throws(
    () => DIGITS_ADAPTER.buildProposal({ ...BASE, directionContractType: 'DIGITDIFF', parameters: { ...PARAMS, digit: 4.5 } }),
    /prediction from 0 to 9/
  );
});

test('digits adapter: refuses a non-tick duration', () => {
  assert.throws(
    () => DIGITS_ADAPTER.buildProposal({ ...BASE, directionContractType: 'DIGITEVEN', parameters: { ...PARAMS, durationUnit: 'm', digit: 4 } }),
    /tick-duration/
  );
});

test('higher/lower adapter: carries the barrier and validates the duration', () => {
  const payload = HIGHER_LOWER_ADAPTER.buildProposal({
    ...BASE,
    directionContractType: 'CALL',
    parameters: { ...PARAMS, durationUnit: 'm', barrier: '+0.25' }
  });
  assert.equal(payload.barrier, '+0.25');
  assert.equal(payload.duration_unit, 'm');

  assert.throws(
    () => HIGHER_LOWER_ADAPTER.buildProposal({ ...BASE, directionContractType: 'CALL', parameters: { ...PARAMS, durationUnit: 'm', barrier: null } }),
    /requires a barrier/
  );
  assert.throws(
    () => HIGHER_LOWER_ADAPTER.buildProposal({ ...BASE, directionContractType: 'CALL', parameters: { ...PARAMS, durationUnit: 'm', barrier: 'abc' } }),
    /not a number/
  );
});

test('touch/no-touch adapter: accepts ONETOUCH and refuses a CALL', () => {
  const payload = TOUCH_NO_TOUCH_ADAPTER.buildProposal({
    ...BASE,
    directionContractType: 'ONETOUCH',
    parameters: { ...PARAMS, durationUnit: 'm', barrier: '1.5' }
  });
  assert.equal(payload.contract_type, 'ONETOUCH');

  assert.throws(
    () => TOUCH_NO_TOUCH_ADAPTER.buildProposal({ ...BASE, directionContractType: 'CALL', parameters: { ...PARAMS, durationUnit: 'm', barrier: '1.5' } }),
    /not a touch_no_touch contract/
  );
});

test('accumulators adapter: requires a growth rate between 0 and 1', () => {
  assert.throws(
    () => ACCUMULATORS_ADAPTER.buildProposal({ ...BASE, directionContractType: 'ACCU', parameters: { ...PARAMS, growthRate: null } }),
    /growth rate/
  );
  const payload = ACCUMULATORS_ADAPTER.buildProposal({
    ...BASE,
    directionContractType: 'ACCU',
    parameters: { ...PARAMS, growthRate: 0.03 }
  });
  assert.equal(payload.growth_rate, 0.03);
});

test('multipliers adapter: still refuses a digit contract type', () => {
  assert.throws(
    () => MULTIPLIERS_ADAPTER.buildProposal({ ...BASE, directionContractType: 'DIGITEVEN', parameters: { ...PARAMS, multiplier: 100 } }),
    /not a Multipliers contract/
  );
});

/* --------------------- oldest-generation `market` block ------------------- */

/**
 * A legacy export keeps market, contract and stake on a `market` block nested
 * inside `trade`'s SUBMARKET statement. The planner must read that block or it
 * would report a perfectly configured strategy as naming no symbol and no
 * contract. Shape copied from `xml-examples/misc/Alternate Even-Odd.xml`.
 */
const LEGACY_MARKET_BOT = `<xml xmlns="http://www.w3.org/1999/xhtml" is_dbot="true">
  <block type="trade">
    <statement name="SUBMARKET">
      <block type="market">
        <field name="MARKET_LIST">volidx</field>
        <field name="SUBMARKET_LIST">random_index</field>
        <field name="SYMBOL_LIST">R_100</field>
        <field name="TRADETYPECAT_LIST">digits</field>
        <field name="TRADETYPE_LIST">evenodd</field>
        <field name="TYPE_LIST">both</field>
        <field name="CANDLEINTERVAL_LIST">60</field>
        <field name="DURATIONTYPE_LIST">t</field>
        <field name="CURRENCY_LIST">USD</field>
        <value name="DURATION"><block type="math_number"><field name="NUM">5</field></block></value>
        <value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value>
      </block>
    </statement>
  </block>
  <block type="before_purchase">
    <statement name="BEFOREPURCHASE_STACK">
      <block type="controls_if">
        <value name="IF0"><block type="logic_compare">
          <field name="OP">EQ</field>
          <value name="A"><block type="last_digit"/></value>
          <value name="B"><block type="math_number"><field name="NUM">1</field></block></value>
        </block></value>
        <statement name="DO0">
          <block type="purchase"><field name="PURCHASE_LIST">DIGITEVEN</field></block>
        </statement>
      </block>
    </statement>
  </block>
</xml>`;

test('a legacy `market` block supplies the plan symbol, contract and stake', () => {
  const plan = planOf(LEGACY_MARKET_BOT);

  assert.equal(plan.symbol, 'R_100');
  assert.equal(plan.timeframe, '60s');
  assert.equal(plan.contractType, 'DIGITEVEN');
  assert.equal(plan.contractFamily, 'digits');
  assert.equal(plan.stake, 1);
  assert.equal(plan.currency, 'USD');
  assert.equal(plan.duration, 5);
  assert.equal(plan.durationUnit, 't');
  assert.equal(plan.engine, 'interpreter');
});

test('a legacy `both` contract type resolves to the trade type\'s first contract', () => {
  // `both` means "either direction"; the interpreter still buys the contract
  // named by the author's purchase block, so the plan carries a placeable
  // default rather than the unplaceable literal "both".
  const plan = planOf(LEGACY_MARKET_BOT);
  assert.equal(plan.contractType, 'DIGITEVEN');
});

test('a legacy `market` block alone does not make the plan unsupported', () => {
  const planned = planStrategy(xmlToTree(LEGACY_MARKET_BOT));
  assert.ok(planned.ok);
  assert.ok(!planned.reasons.some((r) => r.includes('market')));
});
