import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import type { ModelDetectionContext } from './entryModels';
import { detectModel, MODEL_DETECTORS } from './entryModels';
import { analyzeMarketStructure } from './structure';
import { detectSwings, computeAtrSeries } from './swings';
import { detectSupportResistance } from './supportResistance';
import { detectSupplyDemandZones } from './supplyDemand';
import { detectTrendlines, detectChartPatterns } from './trendlinesAndPatterns';
import { assessMomentum } from './momentum';
import { buildIndicatorSnapshot } from './indicators';
import { detectRangeAnalysis } from './rangeAnalysis';
import { scoreCandidate } from './qualityScore';
import { ENTRY_MODEL_LABELS, type EntryModelCandidate, type EntryModelId } from '../types/engine';

function mk(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

const STEP = 300;
const T0 = 1_700_000_000;

/**
 * Walks the series to each target price, producing a real candle per step so swings,
 * structure, momentum and ATR are all computed from genuine price action.
 */
function walk(
  legs: number[],
  start = 100,
  pad = 0.35,
  stepsPerLeg = 14
): Candle[] {
  const out: Candle[] = [];
  let t = T0;
  let price = start;
  for (const target of legs) {
    for (let s = 0; s < stepsPerLeg; s++) {
      const o = price;
      const c = price + (target - price) / (stepsPerLeg - s);
      out.push(mk(t, o, Math.max(o, c) + pad, Math.min(o, c) - pad, c));
      price = c;
      t += STEP;
    }
  }
  return out;
}

/** Repeats a leg pattern to build a longer series that keeps its character. */
function repeat(legs: number[], times: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < times; i++) out.push(...legs);
  return out;
}

const BULL = walk(repeat([106, 102, 112, 107, 120, 114, 130, 123, 140], 3));
const BEAR = walk(repeat([94, 98, 88, 93, 80, 86, 70, 77, 60], 3));
const RANGE = walk(repeat([105, 95, 105, 95, 105, 95, 105, 95, 105], 3));

/** Builds the exact ModelDetectionContext the signal engine builds, from candles. */
function buildContext(candles: Candle[]): ModelDetectionContext {
  const confirmed = candles.length > 2 ? candles.slice(0, -1) : candles;
  const atrs = computeAtrSeries(confirmed, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const swings = detectSwings(confirmed, 3, 3);
  const structure = analyzeMarketStructure(confirmed, swings, atrs, 2);
  const price = confirmed[confirmed.length - 1]?.close ?? 0;
  const range = detectRangeAnalysis(confirmed, price);
  return {
    symbol: 'R_10',
    timeframe: 'M5',
    marketFamily: 'VOLATILITY',
    precision: 2,
    atr,
    candles: confirmed,
    structure,
    swings,
    supportResistance: detectSupportResistance(confirmed, swings, atr, 2),
    supplyDemand: detectSupplyDemandZones(confirmed, atrs, 2),
    trendlines: detectTrendlines(confirmed, swings, atr, 2),
    patterns: detectChartPatterns(confirmed, swings, atr, 2),
    momentum: assessMomentum({
      candles: confirmed,
      atr,
      supportResistance: detectSupportResistance(confirmed, swings, atr, 2),
      supplyDemand: detectSupplyDemandZones(confirmed, atrs, 2),
    }),
    htfBias: { macro: 'BULLISH', structural: 'BULLISH', macroLabel: 'H1', structuralLabel: 'M15' },
    indicators: buildIndicatorSnapshot(confirmed),
    condition: 'STRONG_UPTREND',
    range,
    entryCandles: confirmed,
  };
}

const ALL_MODELS = Object.keys(MODEL_DETECTORS) as EntryModelId[];

test('the eight documented entry models are all registered', () => {
  assert.equal(ALL_MODELS.length, 8);
  for (const id of ALL_MODELS) {
    assert.ok(ENTRY_MODEL_LABELS[id], `no label for ${id}`);
    assert.equal(typeof MODEL_DETECTORS[id], 'function', `${id} detector missing`);
  }
});

test('every model detector returns a structurally valid candidate when it fires', () => {
  const scenarios: [string, Candle[]][] = [
    ['bullish', BULL],
    ['bearish', BEAR],
    ['ranging', RANGE],
  ];
  let totalFires = 0;
  for (const id of ALL_MODELS) {
    for (const [label, candles] of scenarios) {
      const ctx = buildContext(candles);
      let candidate: EntryModelCandidate | null = null;
      try {
        candidate = detectModel(ctx, id);
      } catch (e) {
        assert.fail(`${id}/${label} threw: ${(e as Error).message}`);
      }
      if (candidate === null) continue;
      totalFires++;
      const c: EntryModelCandidate = candidate;
      assert.equal(c.model, id, `${id}/${label}: wrong model id on candidate`);
      assert.ok(c.direction === 'RISE' || c.direction === 'FALL', `${id}/${label}: bad direction`);
      for (const [k, v] of Object.entries({
        entryPrice: c.entryPrice,
        stopLoss: c.stopLoss,
        structuralLevelPrice: c.structuralLevelPrice,
        riskRewardRatio: c.riskRewardRatio,
        availableSpaceAtr: c.availableSpaceAtr,
      })) {
        assert.ok(Number.isFinite(v as number), `${id}/${label}: ${k} not finite`);
      }
      assert.ok(c.reasons.length > 0, `${id}/${label}: no reasons`);
      assert.ok(c.invalidationCondition.length > 0, `${id}/${label}: no invalidation condition`);
      assert.ok(c.confirmationExplanation.length > 0, `${id}/${label}: no confirmation text`);
      // Stop must sit on the risk side of the entry for the candidate's direction.
      if (c.direction === 'RISE') {
        assert.ok(c.stopLoss < c.entryPrice, `${id}/${label}: RISE stop not below entry`);
        if (c.target1 !== null) assert.ok(c.target1 > c.entryPrice, `${id}/${label}: RISE tp1 not above entry`);
      } else {
        assert.ok(c.stopLoss > c.entryPrice, `${id}/${label}: FALL stop not above entry`);
        if (c.target1 !== null) assert.ok(c.target1 < c.entryPrice, `${id}/${label}: FALL tp1 not below entry`);
      }
      for (const k of ['structure', 'levelZone', 'entryConfirmation', 'momentum', 'multiTimeframe', 'availableSpace'] as const) {
        const v = c.scores[k];
        assert.ok(Number.isFinite(v) && v >= 0, `${id}/${label}: score ${k}=${v}`);
      }
      const quality = scoreCandidate(c);
      assert.ok(Number.isFinite(quality.total) && quality.total >= 0 && quality.total <= 100, `${id}/${label}: quality ${quality.total}`);
    }
  }
  // A structurally valid, well-formed scenario set must actually fire at least some models —
  // a detector that can never fire on trending AND ranging data is dead code.
  assert.ok(totalFires > 0, 'no entry model fired on any scenario — detectors may be dead');
});

test('model detectors are deterministic and never mutate their context', () => {
  const ctx = buildContext(BULL);
  const snapshot = JSON.stringify(ctx.candles);
  for (const id of ALL_MODELS) {
    const a = detectModel(ctx, id);
    const b = detectModel(ctx, id);
    assert.deepEqual(
      a === null ? null : { d: a.direction, e: a.entryPrice, s: a.stopLoss, t: a.target1 },
      b === null ? null : { d: b.direction, e: b.entryPrice, s: b.stopLoss, t: b.target1 },
      `${id}: non-deterministic`
    );
  }
  assert.equal(JSON.stringify(ctx.candles), snapshot, 'detector mutated the candle array');
});

test('every model detector tolerates degenerate input without throwing', () => {
  const cases: [string, Candle[]][] = [
    ['empty', []],
    ['single', [mk(T0, 100, 101, 99, 100)]],
    ['flat', Array.from({ length: 120 }, (_, i) => mk(T0 + i * STEP, 100, 100, 100, 100))],
    ['nan', [mk(T0, NaN, NaN, NaN, NaN), ...BULL]],
  ];
  for (const [label, candles] of cases) {
    const ctx = buildContext(candles);
    for (const id of ALL_MODELS) {
      assert.doesNotThrow(() => detectModel(ctx, id), `${id}/${label} threw`);
    }
  }
});
