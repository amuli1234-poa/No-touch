import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type { AiEngineParams } from '../hooks/useAiScanner';
import { AI_MODULE_DEFINITIONS } from '../hooks/useAiModules';
import { analyzeTrendlineInstrument } from './trendlineEngine';
import { analyzeDsInstrument } from './demandSupplyEngine';
import { analyzeInstrument } from './signalEngine';
import { detectModel, MODEL_DETECTORS, type ModelDetectionContext } from './entryModels';
import type { EntryModelId } from '../types/engine';
import { analyzeMarketStructure } from './structure';
import { detectSwings, computeAtrSeries } from './swings';
import { detectSupportResistance } from './supportResistance';
import { detectSupplyDemandZones } from './supplyDemand';
import { detectTrendlines, detectChartPatterns } from './trendlinesAndPatterns';
import { assessMomentum } from './momentum';
import { buildIndicatorSnapshot } from './indicators';
import { detectRangeAnalysis } from './rangeAnalysis';

/**
 * Trade-geometry invariants under NOISY price action.
 *
 * The clean `walk()` series used elsewhere never produce the pathological bars that expose
 * level-anchoring bugs: a stop computed from a structural level, or a target computed from a
 * nearby opposing level, can land on the WRONG SIDE of the actual entry. These tests drive
 * every engine with deterministic noisy shapes and assert the invariants that must hold for
 * any published trade:
 *   - the stop is strictly beyond the entry on the risk side,
 *   - TP1 is strictly beyond the entry on the reward side,
 *   - the ladder is monotonic (TP2 beyond TP1, TP3 beyond TP2).
 */

const STEP = 300;
const T0 = 1_700_000_000;

function mk(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

type Shape = 'bull' | 'bear' | 'range' | 'chop' | 'spike' | 'vspike' | 'flat' | 'gap' | 'trendchop';

/** Deterministic LCG so the same seed always yields the same series. */
function gen(shape: Shape, n = 220, seed = 1): Candle[] {
  let p = 1000;
  let s = seed;
  const r = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    let drift = 0;
    let vol = 6;
    if (shape === 'bull') drift = 0.6;
    else if (shape === 'bear') drift = -0.6;
    else if (shape === 'range') drift = 0;
    else if (shape === 'chop') {
      drift = (i % 2 ? 1 : -1) * 1.2;
      vol = 12;
    } else if (shape === 'spike') {
      drift = i > n - 6 ? 12 : 0;
      vol = 5;
    } else if (shape === 'vspike') {
      drift = i > n - 6 ? -14 : 0;
      vol = 5;
    } else if (shape === 'flat') {
      vol = 0;
    } else if (shape === 'gap') {
      drift = i > n - 3 ? 25 : 0;
      vol = 8;
    } else if (shape === 'trendchop') {
      drift = i > n / 2 ? 3 : -3;
      vol = 10;
    }
    const o = p;
    p = p + drift + (r() - 0.5) * vol;
    const c = p;
    out.push(mk(T0 + i * STEP, o, Math.max(o, c) + r() * vol * 0.5, Math.min(o, c) - r() * vol * 0.5, c));
  }
  return out;
}

const SHAPES: Shape[] = ['bull', 'bear', 'range', 'chop', 'spike', 'vspike', 'flat', 'gap', 'trendchop'];

function params(shape: Shape, seed: number): AiEngineParams {
  return {
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    precision: 3,
    marketFamily: 'VOLATILITY',
    structureCandles: gen(shape, 220, seed),
    setupCandles: gen(shape, 220, seed + 7),
    entryCandles: gen(shape, 220, seed + 13),
    dataHealth: 'HEALTHY',
    peers: [],
  };
}

interface TradeGeometry {
  direction: 'RISE' | 'FALL';
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number | null;
  riskRewardRatio: number;
}

/** The invariants that must hold for every published trade geometry. */
function assertAiGeometry(tag: string, s: TradeGeometry) {
  const up = s.direction === 'RISE';
  assert.ok(Number.isFinite(s.entryPrice) && s.entryPrice > 0, `${tag}: entry not finite/positive`);
  assert.ok(
    up ? s.stopLoss < s.entryPrice : s.stopLoss > s.entryPrice,
    `${tag}: stop on the wrong side of entry (${s.direction} entry=${s.entryPrice} stop=${s.stopLoss})`
  );
  assert.ok(
    up ? s.takeProfit1 > s.entryPrice : s.takeProfit1 < s.entryPrice,
    `${tag}: TP1 on the wrong side of entry (${s.direction} entry=${s.entryPrice} tp1=${s.takeProfit1})`
  );
  assert.ok(
    up ? s.takeProfit2 >= s.takeProfit1 : s.takeProfit2 <= s.takeProfit1,
    `${tag}: TP2 not beyond TP1 (tp1=${s.takeProfit1} tp2=${s.takeProfit2})`
  );
  if (s.takeProfit3 != null) {
    assert.ok(
      up ? s.takeProfit3 >= s.takeProfit2 : s.takeProfit3 <= s.takeProfit2,
      `${tag}: TP3 not beyond TP2`
    );
  }
  const risk = Math.abs(s.entryPrice - s.stopLoss);
  const reward = Math.abs(s.takeProfit1 - s.entryPrice);
  if (risk > 0) {
    assert.ok(
      Math.abs(reward / risk - s.riskRewardRatio) < 0.02,
      `${tag}: riskRewardRatio ${s.riskRewardRatio} disagrees with geometry ${(reward / risk).toFixed(3)}`
    );
  }
}

for (const def of AI_MODULE_DEFINITIONS) {
  test(`${def.id}: every published signal keeps its stop and targets on the correct side of entry`, () => {
    let published = 0;
    for (const shape of SHAPES) {
      for (let seed = 1; seed <= 3; seed++) {
        const base = params(shape, seed);
        // Confluence is peer-gated: feed it the signals the specialist engines produce.
        const peers =
          def.id === 'confluence'
            ? AI_MODULE_DEFINITIONS.filter((d) => d.id !== 'confluence')
                .map((d) => ({ module: d.id, signal: d.engine(base).signal }))
                .filter((p): p is { module: string; signal: NonNullable<typeof p.signal> } => p.signal !== null)
            : base.peers;
        const a = def.engine({ ...base, peers });
        if (a.signal) {
          published++;
          assertAiGeometry(`${def.id}/${shape}/${seed}`, a.signal);
          assert.ok(
            a.signal.score >= def.publicationGate,
            `${def.id}/${shape}/${seed}: published at ${a.signal.score} below gate ${def.publicationGate}`
          );
        }
      }
    }
    // Confluence only publishes with agreeing peer evidence, so it is exempt from the
    // "must publish somewhere" requirement (its geometry is still asserted when it does).
    // BOS Retracement & Rejection is likewise exempt: a BOS is a SETUP, not a trigger, so
    // on uncorrelated noise the full retracement → sweep → rejection → MSS sequence rarely
    // aligns. Its ability to publish on a valid setup is proven in `bosRetracement.test.ts`.
    if (def.id !== 'confluence' && def.id !== 'boschoch') {
      assert.ok(published > 0, `${def.id}: never published across any noisy shape`);
    }
  });
}

test('trendline engine: published signals keep the single target and stop on the correct side', () => {
  for (const shape of SHAPES) {
    const a = analyzeTrendlineInstrument(params(shape, 5));
    const s = a.signal;
    if (!s) continue;
    const up = s.direction === 'RISE';
    assert.ok(up ? s.stopLoss < s.entryPrice : s.stopLoss > s.entryPrice, `trendline/${shape}: stop wrong side`);
    assert.ok(up ? s.takeProfit > s.entryPrice : s.takeProfit < s.entryPrice, `trendline/${shape}: tp wrong side`);
  }
});

test('demand & supply engine: published signals keep stop and targets on the correct side', () => {
  for (const shape of SHAPES) {
    const a = analyzeDsInstrument(params(shape, 5));
    if (a.signal) assertAiGeometry(`ds/${shape}`, a.signal);
  }
});

test('signal engine: noisy inputs never throw', () => {
  for (const shape of SHAPES) {
    assert.doesNotThrow(() =>
      analyzeInstrument({
        symbol: 'R_100',
        displayName: 'Volatility 100 Index',
        precision: 3,
        marketFamily: 'VOLATILITY',
        timeframe: 'M5',
        candles: gen(shape, 220, 5),
        dataHealth: 'HEALTHY',
      })
    );
  }
});

function modelContext(shape: Shape, seed: number): ModelDetectionContext {
  const all = gen(shape, 220, seed);
  const confirmed = all.length > 2 ? all.slice(0, -1) : all;
  const atrs = computeAtrSeries(confirmed, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const swings = detectSwings(confirmed, 3, 3);
  const price = confirmed[confirmed.length - 1]?.close ?? 0;
  const sr = detectSupportResistance(confirmed, swings, atr, 2);
  const sd = detectSupplyDemandZones(confirmed, atrs, 2);
  return {
    symbol: 'R_100',
    timeframe: 'M5',
    marketFamily: 'VOLATILITY',
    precision: 2,
    atr,
    candles: confirmed,
    structure: analyzeMarketStructure(confirmed, swings, atrs, 2),
    swings,
    supportResistance: sr,
    supplyDemand: sd,
    trendlines: detectTrendlines(confirmed, swings, atr, 2),
    patterns: detectChartPatterns(confirmed, swings, atr, 2),
    momentum: assessMomentum({ candles: confirmed, atr, supportResistance: sr, supplyDemand: sd }),
    htfBias: { macro: 'BULLISH', structural: 'BULLISH', macroLabel: 'H1', structuralLabel: 'M15' },
    indicators: buildIndicatorSnapshot(confirmed),
    condition: 'STRONG_UPTREND',
    range: detectRangeAnalysis(confirmed, price),
    entryCandles: confirmed,
  };
}

test('entry models: every fired candidate keeps its stop and targets on the correct side', () => {
  const ids = Object.keys(MODEL_DETECTORS) as EntryModelId[];
  let fired = 0;
  for (const shape of SHAPES) {
    for (let seed = 1; seed <= 2; seed++) {
      const ctx = modelContext(shape, seed);
      for (const id of ids) {
        const c = detectModel(ctx, id);
        if (!c) continue;
        fired++;
        const up = c.direction === 'RISE';
        assert.ok(
          up ? c.stopLoss < c.entryPrice : c.stopLoss > c.entryPrice,
          `entrymodel/${shape}/${id}: stop wrong side (entry=${c.entryPrice} stop=${c.stopLoss})`
        );
        if (c.target1 != null) {
          assert.ok(
            up ? c.target1 > c.entryPrice : c.target1 < c.entryPrice,
            `entrymodel/${shape}/${id}: target1 wrong side (entry=${c.entryPrice} target1=${c.target1})`
          );
        }
        if (c.target1 != null && c.target2 != null) {
          assert.ok(
            up ? c.target2 >= c.target1 : c.target2 <= c.target1,
            `entrymodel/${shape}/${id}: target2 not beyond target1`
          );
        }
      }
    }
  }
  assert.ok(fired > 0, 'no entry-model candidate fired across any noisy shape');
});

test('every engine survives empty / tiny / flat / NaN / zero input without throwing', () => {
  const cases: Record<string, Candle[]> = {
    empty: [],
    tiny: [mk(T0, 100, 101, 99, 100)],
    flat: Array.from({ length: 120 }, (_, i) => mk(T0 + i * STEP, 100, 100, 100, 100)),
    nan: [mk(T0, NaN, NaN, NaN, NaN), ...gen('bull', 60, 2)],
    zero: Array.from({ length: 60 }, (_, i) => mk(T0 + i * STEP, 0, 0, 0, 0)),
  };
  for (const def of AI_MODULE_DEFINITIONS) {
    for (const [label, candles] of Object.entries(cases)) {
      const a = def.engine({
        symbol: 'R_100',
        displayName: 'Volatility 100 Index',
        precision: 3,
        marketFamily: 'VOLATILITY',
        structureCandles: candles,
        setupCandles: candles,
        entryCandles: candles,
        dataHealth: 'HEALTHY',
        peers: [],
      });
      assert.ok(Number.isFinite(a.bestScore), `${def.id}/${label}: bestScore not finite`);
      if (a.signal) assertAiGeometry(`${def.id}/${label}`, a.signal);
    }
  }
});
