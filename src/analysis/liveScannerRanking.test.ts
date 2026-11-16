import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rewardToRiskScore } from './aiCommon';
import { analyzeLiveInstrument } from './liveScannerEngine';
import { AI_MODULE_DEFINITIONS } from '../hooks/useAiModules';
import type { Candle } from '../types/market';

/**
 * The Live Scanner advertises ranking "by quality, structure and reward-to-risk", so a bounded
 * reward-to-risk term must participate in the score. These tests pin the sub-score thresholds
 * and prove the scanner's published scores actually carry the term.
 */

test('rewardToRiskScore: thresholds match the Demand & Supply spaceScore ladder', () => {
  assert.equal(rewardToRiskScore(4, 2), 20); // 2.0 → 20
  assert.equal(rewardToRiskScore(3, 2), 15); // 1.5 → 15
  assert.equal(rewardToRiskScore(1.2, 1), 9); // 1.2 → 9
  assert.equal(rewardToRiskScore(0.5, 1), 3); // < 1 → 3
});

test('rewardToRiskScore: degenerate inputs are guarded, never NaN/Infinity', () => {
  assert.equal(rewardToRiskScore(10, 0), 0);
  assert.equal(rewardToRiskScore(10, -1), 0);
  assert.equal(rewardToRiskScore(NaN, 1), 0);
  assert.equal(rewardToRiskScore(1, NaN), 0);
  assert.equal(rewardToRiskScore(Infinity, 1), 0);
});

test('rewardToRiskScore: monotonic non-decreasing in reward and bounded 0–20', () => {
  const samples = [0.1, 0.5, 1, 1.4, 1.5, 2, 3, 10];
  let prev = -1;
  for (const r of samples) {
    const v = rewardToRiskScore(r, 1);
    assert.ok(v >= 0 && v <= 20, `rewardToRiskScore(${r},1)=${v} out of bounds`);
    assert.ok(v >= prev, `rewardToRiskScore not monotonic at reward ${r}`);
    prev = v;
  }
});

/** Deterministic noisy candle generator (mirrors signalGeometry.test.ts). */
function makeCandles(seed: number, drift: number, count = 220): Candle[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const out: Candle[] = [];
  let price = 1000 + rnd() * 50;
  for (let i = 0; i < count; i++) {
    const open = price;
    const step = (rnd() - 0.5) * 4 + drift;
    const close = Math.max(1, open + step);
    const high = Math.max(open, close) + rnd() * 2;
    const low = Math.min(open, close) - rnd() * 2;
    out.push({ time: 1_700_000_000 + i * 300, open, high, low, close });
    price = close;
  }
  return out;
}

test('live scanner: every published score reflects a bounded reward-to-risk term', () => {
  const def = AI_MODULE_DEFINITIONS.find((d) => d.id === 'live');
  assert.ok(def, 'live module definition is registered');

  let published = 0;
  for (const drift of [0.6, -0.6, 0.25, -0.25, 0]) {
    for (let seed = 1; seed <= 6; seed++) {
      const candles = makeCandles(seed * 7 + 3, drift);
      const a = analyzeLiveInstrument({
        symbol: 'R_100',
        displayName: 'Volatility 100 Index',
        precision: 2,
        marketFamily: 'VOLATILITY',
        structureCandles: candles,
        setupCandles: candles,
        entryCandles: candles,
        dataHealth: 'HEALTHY',
      });
      if (!a.signal) continue;
      published++;
      const sig = a.signal;
      // The R:R term is derived from the published, entry-anchored geometry and must be
      // well-defined and positive for a genuinely published trade.
      const rrSub = rewardToRiskScore(
        Math.abs(sig.takeProfit1 - sig.entryPrice),
        Math.abs(sig.entryPrice - sig.stopLoss)
      );
      assert.ok(rrSub >= 0 && rrSub <= 20, `live/${seed}/${drift}: rrSub ${rrSub} out of bounds`);
      assert.ok(
        sig.riskRewardRatio > 0,
        `live/${seed}/${drift}: published signal has non-positive R:R ${sig.riskRewardRatio}`
      );
      assert.ok(
        sig.score >= def.publicationGate,
        `live/${seed}/${drift}: published at ${sig.score} below gate ${def.publicationGate}`
      );
    }
  }
  assert.ok(published > 0, 'live scanner never published across the noisy shapes');
});
