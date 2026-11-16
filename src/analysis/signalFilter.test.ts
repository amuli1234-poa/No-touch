import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Candle } from '../types/market';
import type { RankedSetup } from '../types/ranking';
import { DEFAULT_SIGNAL_FILTER_CONFIG } from '../types/signalFilter';
import { applySignalQualityFilter } from './signalFilter';

/** A clean, confirmed uptrend with one trailing live candle (the filter reads confirmed bars). */
function trendCandles(count: number, step = 0.6, base = 100): Candle[] {
  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    out.push({
      time: 1_700_000_000 + i * 60,
      open,
      high: close + step * 0.2,
      low: open - step * 0.2,
      close,
    });
    price = close;
  }
  return out;
}

function setup(over: Partial<RankedSetup> = {}): RankedSetup {
  return {
    key: 'PRICE_ACTION:R_100:RISE:Model 2',
    source: 'PRICE_ACTION',
    sourceLabel: 'Market Scanner',
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    marketFamily: 'VOLATILITY',
    timeframe: 'M5',
    precision: 2,
    direction: 'RISE',
    modelLabel: 'Model 2',
    score: 90,
    entryPrice: 100,
    stopLoss: 98,
    takeProfit1: 106,
    takeProfit2: 110,
    riskRewardRatio: 3,
    reasons: [],
    confirmedBarTime: 0,
    createdAt: 0,
    sequence: 0,
    ...over,
  };
}

/** Context anchored one bar after the newest confirmed candle. */
function context(candles: Candle[], over: Partial<Parameters<typeof applySignalQualityFilter>[1]> = {}) {
  const confirmedLast = candles.length > 1 ? candles[candles.length - 2] : candles[0];
  return {
    connectionStatus: 'connected' as const,
    candlesBySymbol: new Map<string, readonly Candle[]>([['R_100', candles]]),
    now: (confirmedLast.time + 60) * 1000,
    ...over,
  };
}

/** Anchor the setup's entry at the newest confirmed close so it is a fresh, valid entry. */
function anchored(candles: Candle[], over: Partial<RankedSetup> = {}): RankedSetup {
  const confirmedLast = candles.length > 1 ? candles[candles.length - 2] : candles[0];
  return setup({ entryPrice: confirmedLast.close, ...over });
}

function first(result: ReturnType<typeof applySignalQualityFilter>) {
  const all = [...result.accepted, ...result.rejected];
  assert.equal(all.length, 1);
  return all[0];
}

describe('applySignalQualityFilter', () => {
  it('accepts a clean, aligned setup on live data', () => {
    const candles = trendCandles(80);
    const result = applySignalQualityFilter([anchored(candles)], context(candles));
    const f = first(result);
    assert.equal(f.verdict, 'ACCEPTED');
    assert.equal(f.reasons.length, 0);
    assert.ok(f.score >= DEFAULT_SIGNAL_FILTER_CONFIG.minQuality);
    assert.ok(f.checks.every((c) => c.passed), 'every check must pass on an accepted setup');
  });

  it('scores every setup between 0 and 100', () => {
    const candles = trendCandles(80);
    const result = applySignalQualityFilter(
      [anchored(candles), anchored(candles, { direction: 'FALL' })],
      context(candles)
    );
    for (const f of [...result.accepted, ...result.rejected]) {
      assert.ok(f.score >= 0 && f.score <= 100, `score out of range: ${f.score}`);
    }
  });

  it('withholds every signal when the Deriv feed is not live', () => {
    const candles = trendCandles(80);
    const result = applySignalQualityFilter(
      [anchored(candles)],
      context(candles, { connectionStatus: 'disconnected' })
    );
    const f = first(result);
    assert.equal(f.verdict, 'FILTERED');
    assert.equal(f.checks.find((c) => c.id === 'DATA')!.passed, false);
    assert.match(f.reasons.join(' '), /Feed not live/);
  });

  it('rejects stale data even when everything else is valid', () => {
    const candles = trendCandles(80);
    const result = applySignalQualityFilter(
      [anchored(candles)],
      context(candles, { now: (candles[candles.length - 2].time + 5000) * 1000 })
    );
    const f = first(result);
    assert.equal(f.verdict, 'FILTERED');
    assert.match(f.checks.find((c) => c.id === 'DATA')!.detail, /stale/);
  });

  it('rejects a setup fighting the dominant trend', () => {
    const candles = trendCandles(80);
    const result = applySignalQualityFilter(
      [anchored(candles, { direction: 'FALL' })],
      context(candles)
    );
    const f = first(result);
    assert.equal(f.verdict, 'FILTERED');
    assert.equal(f.checks.find((c) => c.id === 'TREND')!.passed, false);
    assert.match(f.reasons.join(' '), /Trend not aligned/);
  });

  it('rejects a setup with insufficient room for the projected move', () => {
    const candles = trendCandles(80);
    const result = applySignalQualityFilter(
      [anchored(candles, { riskRewardRatio: 0.3 })],
      context(candles)
    );
    const f = first(result);
    assert.equal(f.verdict, 'FILTERED');
    assert.equal(f.checks.find((c) => c.id === 'ROOM')!.passed, false);
    assert.match(f.reasons.join(' '), /Insufficient room/);
  });

  it('rejects a setup with no computable reward:risk', () => {
    const candles = trendCandles(80);
    const result = applySignalQualityFilter(
      [anchored(candles, { riskRewardRatio: null })],
      context(candles)
    );
    assert.equal(first(result).checks.find((c) => c.id === 'ROOM')!.passed, false);
  });

  it('keeps only the strongest direction per instrument (conflict rejection)', () => {
    const candles = trendCandles(80);
    const strong = anchored(candles, { key: 'k-rise', direction: 'RISE', score: 92 });
    const weak = anchored(candles, { key: 'k-fall', direction: 'FALL', score: 60 });
    const result = applySignalQualityFilter([strong, weak], context(candles));
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].key, 'k-rise');
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].key, 'k-fall');
    assert.match(result.rejected[0].reasons.join(' '), /conflicting/i);
    assert.match(
      result.rejected[0].checks.find((c) => c.id === 'NOVELTY')!.detail,
      /Conflicts/
    );
  });

  it('rejects an exact duplicate submitted in the same pass', () => {
    const candles = trendCandles(80);
    const a = anchored(candles, { key: 'dup-a' });
    const b = anchored(candles, { key: 'dup-b' });
    const result = applySignalQualityFilter([a, b], context(candles));
    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reasons.join(' '), /Duplicate/);
  });

  it('honours the configuration toggles', () => {
    const candles = trendCandles(80);
    // A misaligned setup is filtered by default...
    const def = first(
      applySignalQualityFilter([anchored(candles, { direction: 'FALL' })], context(candles))
    );
    assert.equal(def.verdict, 'FILTERED');
    // ...but is accepted when trend alignment is not required and the gate is lowered.
    const relaxed = first(
      applySignalQualityFilter([anchored(candles, { direction: 'FALL' })], context(candles), {
        ...DEFAULT_SIGNAL_FILTER_CONFIG,
        requireTrendAlignment: false,
        minQuality: 0,
      })
    );
    assert.equal(relaxed.verdict, 'ACCEPTED');
  });

  it('preserves the originating engine score and never rewrites it', () => {
    const candles = trendCandles(80);
    const result = applySignalQualityFilter([anchored(candles, { score: 91 })], context(candles));
    const f = first(result);
    assert.equal(f.engineScore, 91);
    assert.equal(f.setup.score, 91);
  });

  it('rejects a confirmed late entry that already ran past the setup entry', () => {
    // A calm uptrend, then a large CONFIRMED displacement candle, then a live candle.
    const candles = trendCandles(78, 0.02);
    const prev = candles[candles.length - 1];
    candles.push({
      time: prev.time + 60,
      open: prev.close,
      high: prev.close + 8,
      low: prev.close - 0.01,
      close: prev.close + 7.8,
    });
    candles.push({
      time: prev.time + 120,
      open: candles[candles.length - 1].close,
      high: candles[candles.length - 1].close + 0.05,
      low: candles[candles.length - 1].close - 0.05,
      close: candles[candles.length - 1].close + 0.02,
    });
    // Entry was anchored far below where price now sits.
    const late = setup({ entryPrice: prev.close, direction: 'RISE', riskRewardRatio: 3 });
    const result = applySignalQualityFilter([late], context(candles));
    const f = first(result);
    assert.equal(f.verdict, 'FILTERED');
    assert.equal(f.checks.find((c) => c.id === 'TRIGGER')!.passed, false);
  });

  it('returns accepted and rejected lists sorted strongest first', () => {
    const candles = trendCandles(80);
    const a = anchored(candles, { key: 'a', riskRewardRatio: 1.0 });
    const b = anchored(candles, { key: 'b', riskRewardRatio: 4.0 });
    const c = anchored(candles, { key: 'c', riskRewardRatio: 2.5 });
    const result = applySignalQualityFilter([a, b, c], context(candles));
    const scores = result.accepted.map((s) => s.score);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i - 1] >= scores[i], 'accepted list must be sorted descending');
    }
  });
});
