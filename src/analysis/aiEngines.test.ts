import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiInstrumentAnalysis, AiSignal } from '../types/aiModule';
import type { Candle, MarketFamily } from '../types/market';
import type { AiEngineParams } from '../hooks/useAiScanner';
import { analyzeBosChochInstrument, BOS_CHOCH_PUBLICATION_MIN_SCORE } from './bosChochEngine';
import { analyzeTechnicalInstrument, TECHNICAL_PUBLICATION_MIN_SCORE } from './technicalEngine';
import { analyzeSmcInstrument, SMC_PUBLICATION_MIN_SCORE } from './smcEngine';
import { analyzeLiquidityInstrument, LIQUIDITY_PUBLICATION_MIN_SCORE } from './liquidityEngine';
import { analyzeFvgInstrument, FVG_PUBLICATION_MIN_SCORE } from './fvgEngine';
import { analyzeOrderBlockInstrument, ORDER_BLOCK_PUBLICATION_MIN_SCORE } from './orderBlockEngine';
import { analyzeMomentumInstrument, MOMENTUM_PUBLICATION_MIN_SCORE } from './momentumEngine';
import {
  analyzeMarketRegimeInstrument,
  REGIME_PUBLICATION_MIN_SCORE,
} from './marketRegimeEngine';
import { analyzeConfluenceInstrument, CONFLUENCE_PUBLICATION_MIN_SCORE } from './confluenceEngine';
import { analyzeLiveInstrument, LIVE_SCANNER_PUBLICATION_MIN_SCORE } from './liveScannerEngine';
import { resolveTargets, confluenceBonus, statusForScore } from './aiCommon';

function mk(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const STEP = 900;
const T0 = 1_700_000_000;

/** Walks a series to each target price, producing real pivots at the turns. */
function walk(legs: number[], start = 100, pad = 0.4, stepsPerLeg = 6): Candle[] {
  const candles: Candle[] = [];
  let t = T0;
  let price = start;
  for (const target of legs) {
    for (let s = 0; s < stepsPerLeg; s++) {
      const o = price;
      const c = price + (target - price) / (stepsPerLeg - s);
      candles.push(mk(t, o, Math.max(o, c) + pad, Math.min(o, c) - pad, c));
      price = c;
      t += STEP;
    }
  }
  return candles;
}

/** A realistic uptrend: higher highs and higher lows with pullbacks. */
const BULL = walk([104, 101, 108, 104, 113, 109, 118, 114, 123], 100, 0.5, 20);
/** A realistic downtrend: lower lows and lower highs with pullbacks. */
const BEAR = walk([96, 99, 92, 96, 87, 91, 82, 86, 77], 100, 0.5, 20);
/** A range: oscillation between two bounds. */
const RANGE = walk([104, 100, 104, 100, 104, 100, 104, 100, 104], 100, 0.5, 20);

const ENGINES: { id: string; gate: number; fn: (p: AiEngineParams) => AiInstrumentAnalysis }[] = [
  { id: 'boschoch', gate: BOS_CHOCH_PUBLICATION_MIN_SCORE, fn: analyzeBosChochInstrument },
  { id: 'technical', gate: TECHNICAL_PUBLICATION_MIN_SCORE, fn: analyzeTechnicalInstrument },
  { id: 'smc', gate: SMC_PUBLICATION_MIN_SCORE, fn: analyzeSmcInstrument },
  { id: 'liquidity', gate: LIQUIDITY_PUBLICATION_MIN_SCORE, fn: analyzeLiquidityInstrument },
  { id: 'fvg', gate: FVG_PUBLICATION_MIN_SCORE, fn: analyzeFvgInstrument },
  { id: 'orderblock', gate: ORDER_BLOCK_PUBLICATION_MIN_SCORE, fn: analyzeOrderBlockInstrument },
  { id: 'momentum', gate: MOMENTUM_PUBLICATION_MIN_SCORE, fn: analyzeMomentumInstrument },
  { id: 'regime', gate: REGIME_PUBLICATION_MIN_SCORE, fn: analyzeMarketRegimeInstrument },
  {
    id: 'confluence',
    gate: CONFLUENCE_PUBLICATION_MIN_SCORE,
    fn: (p) => analyzeConfluenceInstrument({ ...p, peers: p.peers ?? [] }),
  },
  { id: 'live', gate: LIVE_SCANNER_PUBLICATION_MIN_SCORE, fn: analyzeLiveInstrument },
];

function params(candles: Candle[], over: Partial<AiEngineParams> = {}): AiEngineParams {
  return {
    symbol: 'R_10',
    displayName: 'Volatility 10 Index',
    precision: 2,
    marketFamily: 'VOLATILITY' as MarketFamily,
    structureCandles: candles,
    setupCandles: candles,
    entryCandles: candles,
    dataHealth: 'HEALTHY',
    peers: [],
    ...over,
  };
}

/**
 * The structural invariant every module must uphold: a published trade's stop is on the
 * risk side of the entry, its targets are on the reward side, and the ladder is monotonic.
 */
function assertValidSignal(signal: AiSignal): void {
  const { direction, entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3 } = signal;
  for (const v of [entryPrice, stopLoss, takeProfit1, takeProfit2]) {
    assert.ok(Number.isFinite(v), `non-finite level ${v}`);
  }
  assert.ok(Number.isFinite(signal.riskRewardRatio) && signal.riskRewardRatio >= 0, 'bad RR');
  assert.ok(signal.score >= 0 && signal.score <= 100, `score out of range ${signal.score}`);
  assert.ok(signal.reasons.length > 0, 'no reasons');
  assert.ok(signal.invalidationCondition.length > 0, 'no invalidation condition');
  const kinds = new Set(signal.levels.map((l) => l.kind));
  assert.ok(kinds.has('entry') && kinds.has('stop') && kinds.has('target'), 'missing chart levels');

  if (direction === 'RISE') {
    assert.ok(stopLoss < entryPrice, `RISE stop ${stopLoss} not below entry ${entryPrice}`);
    assert.ok(takeProfit1 > entryPrice, `RISE tp1 ${takeProfit1} not above entry ${entryPrice}`);
    assert.ok(takeProfit2 >= takeProfit1, 'RISE tp2 < tp1');
    if (takeProfit3 !== null) assert.ok(takeProfit3 >= takeProfit2, 'RISE tp3 < tp2');
  } else {
    assert.ok(stopLoss > entryPrice, `FALL stop ${stopLoss} not above entry ${entryPrice}`);
    assert.ok(takeProfit1 < entryPrice, `FALL tp1 ${takeProfit1} not below entry ${entryPrice}`);
    assert.ok(takeProfit2 <= takeProfit1, 'FALL tp2 > tp1');
    if (takeProfit3 !== null) assert.ok(takeProfit3 <= takeProfit2, 'FALL tp3 > tp2');
  }
}

function assertSaneAnalysis(a: AiInstrumentAnalysis, label: string): void {
  assert.equal(a.symbol, 'R_10');
  assert.ok(Number.isFinite(a.price) && a.price > 0, `${label}: bad price ${a.price}`);
  assert.ok(Number.isFinite(a.atr) && a.atr > 0, `${label}: bad atr ${a.atr}`);
  assert.ok(Number.isFinite(a.bestScore) && a.bestScore >= 0 && a.bestScore <= 100, `${label}: bad score`);
  assert.ok(a.statusExplanation.length > 0, `${label}: empty statusExplanation`);
  assert.equal(a.timeframes.length, 3, `${label}: expected 3 timeframe reads`);
  for (const z of [...a.activeZones, ...a.watchZones]) {
    assert.ok(Number.isFinite(z.upperPrice) && Number.isFinite(z.lowerPrice), `${label}: bad zone price`);
    assert.ok(z.upperPrice >= z.lowerPrice, `${label}: zone upper < lower`);
    assert.ok(z.quality >= 0 && z.quality <= 100, `${label}: zone quality ${z.quality}`);
  }
  if (a.signal) assertValidSignal(a.signal);
}

// ---------------------------------------------------------------------------
// 1. Every engine handles bullish / bearish / ranging and degenerate data
// ---------------------------------------------------------------------------
for (const eng of ENGINES) {
  test(`${eng.id}: bullish, bearish and ranging inputs all produce a sane analysis`, () => {
    for (const [label, candles] of [
      ['bullish', BULL],
      ['bearish', BEAR],
      ['ranging', RANGE],
    ] as const) {
      const a = eng.fn(params(candles));
      assertSaneAnalysis(a, `${eng.id}/${label}`);
    }
  });

  test(`${eng.id}: never throws and never fabricates on empty / tiny / flat / NaN input`, () => {
    const cases: [string, Candle[]][] = [
      ['empty', []],
      ['tiny', [mk(T0, 100, 101, 99, 100)]],
      ['flat', Array.from({ length: 120 }, (_, i) => mk(T0 + i * STEP, 100, 100, 100, 100))],
      ['nan', [mk(T0, NaN, NaN, NaN, NaN), ...BULL]],
      ['zero', Array.from({ length: 60 }, (_, i) => mk(T0 + i * STEP, 0, 0, 0, 0))],
    ];
    for (const [label, candles] of cases) {
      const a = eng.fn(params(candles));
      assert.ok(Number.isFinite(a.atr), `${eng.id}/${label}: atr not finite`);
      assert.ok(Number.isFinite(a.bestScore), `${eng.id}/${label}: bestScore not finite`);
      if (a.signal) assertValidSignal(a.signal);
    }
  });

  test(`${eng.id}: no signal is published below its own publication gate`, () => {
    for (const candles of [BULL, BEAR, RANGE]) {
      const a = eng.fn(params(candles));
      if (a.signal) {
        assert.ok(
          a.signal.score >= eng.gate,
          `${eng.id}: published at score ${a.signal.score} below gate ${eng.gate}`
        );
      }
    }
  });

  test(`${eng.id}: an unconfirmed high score never reads as CONFIRMED`, () => {
    for (const candles of [BULL, BEAR, RANGE]) {
      const a = eng.fn(params(candles));
      if (a.status === 'CONFIRMED') {
        assert.ok(a.signal !== null, `${eng.id}: status CONFIRMED with no published signal`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 1b. Every engine reads all ten timeframes when the whole ladder is supplied
// ---------------------------------------------------------------------------
for (const eng of ENGINES) {
  test(`${eng.id}: reads the whole M30→M1 ladder when all ten series are supplied`, () => {
    for (const candles of [BULL, BEAR, RANGE]) {
      const ladder: Partial<Record<string, Candle[]>> = {
        M30: candles,
        M15: candles,
        M10: candles,
        M7: candles,
        M6: candles,
        M5: candles,
        M4: candles,
        M3: candles,
        M2: candles,
        M1: candles,
      };
      const a = eng.fn(
        params(candles, {
          trendCandles: candles,
          confirmCandles: candles,
          candlesByTimeframe: ladder as AiEngineParams['candlesByTimeframe'],
        })
      );
      assert.equal(a.timeframes.length, 10, `${eng.id}: expected 10 timeframe reads`);
      assert.deepEqual(
        a.timeframes.map((t) => t.timeframe),
        ['M30', 'M15', 'M10', 'M7', 'M6', 'M5', 'M4', 'M3', 'M2', 'M1'],
        `${eng.id}: timeframe reads out of hierarchy order`
      );
      for (const tf of a.timeframes) {
        assert.ok(tf.detail.length > 0, `${eng.id}/${tf.timeframe}: empty detail`);
      }
    }
  });

  test(`${eng.id}: omits M7/M3 reads when those series are not supplied (never faked)`, () => {
    const a = eng.fn(params(BULL));
    assert.equal(a.timeframes.length, 3);
    assert.ok(!a.timeframes.some((t) => t.timeframe === 'M7' || t.timeframe === 'M3'));
  });

  test(`${eng.id}: M7 and M3 reads reflect their own series — no false timeframe alignment`, () => {
    // M15 is bullish, but M7 is bearish and M3 is bullish. The M7 read must report the
    // bearish series it was handed, never a copy of the M15 structure read.
    const a = eng.fn(
      params(BULL, { structureCandles: BULL, trendCandles: BEAR, confirmCandles: BULL })
    );
    const m7 = a.timeframes.find((t) => t.timeframe === 'M7');
    const m3 = a.timeframes.find((t) => t.timeframe === 'M3');
    assert.ok(m7 && m3, `${eng.id}: missing M7/M3 reads`);
    assert.equal(m7.tone, 'bear', `${eng.id}: M7 read did not follow the bearish M7 series`);
    assert.notEqual(m7.detail, a.timeframes[0].detail, `${eng.id}: M7 read echoed the M15 read`);
    assert.equal(m3.tone, 'bull', `${eng.id}: M3 read did not follow the bullish M3 series`);
  });
}

// ---------------------------------------------------------------------------
// 2. The gate is reachable — the bug class where a module could never publish
// ---------------------------------------------------------------------------
test('every module gate is at most its documented maximum achievable score', () => {
  // A fully-confirmed setup with the maximum confluence bonus must be able to clear the
  // gate. Max bonus is 18; the highest base + confirmation bonus across modules is 74, so
  // a gate above 92 would be unreachable by construction.
  for (const eng of ENGINES) {
    assert.ok(eng.gate <= 92, `${eng.id}: gate ${eng.gate} is unreachable (max base+confirmation ~74)`);
  }
});

// ---------------------------------------------------------------------------
// 3. resolveTargets — the entry-anchored ladder guarantee
// ---------------------------------------------------------------------------
test('resolveTargets always returns a monotonic ladder strictly beyond the entry', () => {
  // FALL with structural candidates that all sit ABOVE the entry (the real-world bug):
  // the ladder must ignore them and still produce targets below the entry.
  const fall = resolveTargets('FALL', 100, [101, 102, 103], 5);
  assert.ok(fall.length >= 2);
  assert.ok(fall[0] < 100 && fall[1] < fall[0]);
  // RISE with candidates below the entry.
  const rise = resolveTargets('RISE', 100, [95, 90, 85], 5);
  assert.ok(rise[0] > 100 && rise[1] > rise[0]);
  // Valid structural candidates are preserved, ordered nearest first.
  const rise2 = resolveTargets('RISE', 100, [130, 110, 120], 5);
  assert.deepEqual(rise2, [110, 120, 130]);
  const fall2 = resolveTargets('FALL', 100, [90, 70, 80], 5);
  assert.deepEqual(fall2, [90, 80, 70]);
  // Null / NaN candidates are ignored, never propagated.
  const mixed = resolveTargets('RISE', 100, [null, NaN, 115, undefined], 5);
  assert.ok(mixed.every((v) => Number.isFinite(v)));
  assert.ok(mixed[0] > 100);
});

test('resolveTargets guarantees at least TP1 and TP2 when structure offers none', () => {
  const t = resolveTargets('RISE', 1000, [], 10);
  assert.equal(t.length, 2);
  assert.ok(t[0] > 1000 && t[1] > t[0]);
  const f = resolveTargets('FALL', 1000, [], 10);
  assert.equal(f.length, 2);
  assert.ok(f[0] < 1000 && f[1] < f[0]);
});

// ---------------------------------------------------------------------------
// 4. confluenceBonus is bounded and monotonic in evidence
// ---------------------------------------------------------------------------
test('confluenceBonus is bounded by 18 and rewards stronger evidence', () => {
  assert.equal(confluenceBonus({}), 0);
  assert.ok(confluenceBonus({ fvgQuality: 80, obQuality: 80, momentumConfirmed: true }) <= 18);
  assert.ok(
    confluenceBonus({ fvgQuality: 80, obQuality: 80, momentumConfirmed: true, poolTouches: 3, trendAligned: true, displacement: true }) <= 18
  );
  assert.ok(confluenceBonus({ fvgQuality: 80 }) > confluenceBonus({ fvgQuality: 40 }));
});

// ---------------------------------------------------------------------------
// 5. statusForScore never claims CONFIRMED without confirmation
// ---------------------------------------------------------------------------
test('statusForScore only returns CONFIRMED when the setup is actually confirmed', () => {
  assert.equal(statusForScore(95, 85, true), 'CONFIRMED');
  assert.equal(statusForScore(95, 85, false), 'WAITING_FOR_CONFIRMATION');
  assert.equal(statusForScore(80, 85, false), 'WAITING_FOR_CONFIRMATION');
  assert.equal(statusForScore(50, 85, true), 'WAITING_FOR_SETUP');
});

// ---------------------------------------------------------------------------
// 6. Confluence requires independent peer agreement
// ---------------------------------------------------------------------------
test('confluence does not publish without peer evidence, and validates peers that exist', () => {
  const solo = analyzeConfluenceInstrument({ ...params(BULL), peers: [] });
  assert.equal(solo.signal, null, 'confluence published with no peers');

  // Build a genuine peer signal from a sibling engine and feed it back.
  const peer = analyzeOrderBlockInstrument(params(BULL));
  const peers = peer.signal
    ? [{ module: 'Order Block & Breaker Block AI', signal: peer.signal }]
    : [];
  const withPeer = analyzeConfluenceInstrument({ ...params(BULL), peers });
  if (withPeer.signal) assertValidSignal(withPeer.signal);
  assertSaneAnalysis(withPeer, 'confluence/withPeer');
});
