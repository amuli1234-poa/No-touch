import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../types/market';
import {
  analyzeMarketAnomaly,
  assessStrategySuitability,
  classifyRegime,
  computeBaseline,
  detectDataAnomalies,
  severityFromZ,
} from './marketAnomaly';

const STEP = 300;

function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c };
}

/** A calm, mildly trending series with a stable range — the instrument's own baseline. */
function calmSeries(count = 120, startTime = 1_700_000_000): Candle[] {
  const out: Candle[] = [];
  let price = 1000;
  for (let i = 0; i < count; i++) {
    const o = price;
    const c = price + (i % 2 === 0 ? 0.4 : -0.3);
    out.push(candle(startTime + i * STEP, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c));
    price = c;
  }
  return out;
}

test('severityFromZ maps robust z-scores to severity bands', () => {
  assert.equal(severityFromZ(null), 'NORMAL');
  assert.equal(severityFromZ(0.5), 'NORMAL');
  assert.equal(severityFromZ(2.6), 'LOW');
  assert.equal(severityFromZ(3.6), 'MODERATE');
  assert.equal(severityFromZ(5.5), 'HIGH');
  assert.equal(severityFromZ(-5.5), 'HIGH', 'severity is direction-agnostic');
});

test('computeBaseline adapts to the instrument and ignores the live bar', () => {
  const baseline = computeBaseline(calmSeries());
  assert.ok(baseline.atr > 0);
  assert.ok(baseline.sampleSize >= 100);
  assert.ok(baseline.rangeMedianAtr > 0);
});

test('detectDataAnomalies flags staleness, duplicates, gaps and disorder — never price behaviour', () => {
  const now = 1_700_000_000 + 200 * STEP;
  const healthy = detectDataAnomalies({
    candles: calmSeries(120, 1_700_000_000),
    granularitySec: STEP,
    nowSec: now,
  });
  assert.equal(healthy.stale, true, 'the tail is far behind wall-clock time in this fixture');

  const freshTail = calmSeries(120, now - 120 * STEP);
  const fresh = detectDataAnomalies({ candles: freshTail, granularitySec: STEP, nowSec: now });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.missingCandles, 0);
  assert.equal(fresh.duplicateTimes, 0);
  assert.equal(fresh.healthy, true);

  const withDup = [...freshTail];
  withDup.splice(50, 0, { ...withDup[50] });
  const dupHealth = detectDataAnomalies({ candles: withDup, granularitySec: STEP, nowSec: now });
  assert.ok(dupHealth.duplicateTimes >= 1);
  assert.equal(dupHealth.healthy, false);

  const gapped = [...freshTail];
  gapped.splice(40, 1);
  gapped.splice(41, 1);
  const gapHealth = detectDataAnomalies({ candles: gapped, granularitySec: STEP, nowSec: now });
  assert.ok(gapHealth.missingCandles >= 2);
});

test('a genuine data failure yields CRITICAL_DATA, not a price anomaly', () => {
  const now = 1_700_000_000 + 500 * STEP;
  const report = analyzeMarketAnomaly({
    symbol: 'R_100',
    displayName: 'Volatility 100',
    timeframe: 'M5',
    granularitySec: STEP,
    candles: calmSeries(120, 1_700_000_000),
    nowSec: now,
  });
  assert.equal(report.severity, 'CRITICAL_DATA');
  assert.ok(report.findings.some((f) => f.class === 'DATA'));
  assert.equal(report.suitability[0].verdict, 'WAIT');
});

test('an unusually large candle is detected against the instrument baseline', () => {
  const now = 1_700_000_000 + 130 * STEP;
  const series = calmSeries(120, now - 120 * STEP);
  const last = series[series.length - 1];
  series.push(
    candle(last.time + STEP, last.close, last.close + 60, last.close - 5, last.close + 55)
  );
  // One more bar so the large candle is a CONFIRMED bar (the live bar is always dropped).
  const big = series[series.length - 1];
  series.push(candle(big.time + STEP, big.close, big.close + 0.2, big.close - 0.2, big.close));
  const report = analyzeMarketAnomaly({
    symbol: 'R_75',
    displayName: 'Volatility 75',
    timeframe: 'M5',
    granularitySec: STEP,
    candles: series,
    nowSec: now + 2 * STEP,
  });
  assert.ok(
    report.findings.some((f) => f.kind === 'UNUSUALLY_LARGE_CANDLE'),
    'the large candle must be flagged'
  );
  assert.notEqual(report.severity, 'NORMAL');
});

test('a calm series reports NORMAL with no fabricated findings', () => {
  const now = 1_700_000_000 + 200 * STEP;
  const report = analyzeMarketAnomaly({
    symbol: 'R_50',
    displayName: 'Volatility 50',
    timeframe: 'M5',
    granularitySec: STEP,
    candles: calmSeries(150, now - 150 * STEP),
    nowSec: now,
  });
  assert.equal(report.findings.length, 0);
  assert.equal(report.severity, 'NORMAL');
  assert.equal(report.dataHealth.healthy, true);
});

test('classifyRegime distinguishes a trend from a range', () => {
  const trending: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 80; i++) {
    const o = price;
    const c = price + 0.6;
    trending.push(candle(1_700_000_000 + i * STEP, o, c + 0.1, o - 0.1, c));
    price = c;
  }
  const trendBaseline = computeBaseline(trending);
  const trend = classifyRegime(trending, trendBaseline);
  assert.ok(['STRONG_BULLISH', 'WEAK_TREND'].includes(trend.regime));

  const range: Candle[] = [];
  for (let i = 0; i < 80; i++) {
    const base = 100 + (i % 2 === 0 ? 0.2 : -0.2);
    range.push(candle(1_700_000_000 + i * STEP, base, base + 0.3, base - 0.3, base));
  }
  const rangeRead = classifyRegime(range, computeBaseline(range));
  assert.ok(['SIDEWAYS', 'CONSOLIDATION', 'VOLATILITY_COMPRESSION'].includes(rangeRead.regime));
});

test('assessStrategySuitability warns when a data feed is unhealthy', () => {
  const suitability = assessStrategySuitability({
    findings: [],
    regime: 'SIDEWAYS',
    dataHealthy: false,
  });
  assert.equal(suitability[0].verdict, 'WAIT');
});

test('assessStrategySuitability favours breakouts during expansion and warns on failed breakouts', () => {
  const expansion = assessStrategySuitability({
    findings: [{ kind: 'VOLATILITY_EXPANSION', severity: 'MODERATE' }],
    regime: 'VOLATILITY_EXPANSION',
    dataHealthy: true,
  });
  const breakout = expansion.find((s) => s.module.includes('Breakout'));
  assert.equal(breakout?.verdict, 'SUITABLE');
  assert.match(breakout?.reason ?? '', /candle-close confirmation/);

  const failed = assessStrategySuitability({
    findings: [{ kind: 'FALSE_BREAKOUT', severity: 'MODERATE' }],
    regime: 'SIDEWAYS',
    dataHealthy: true,
  });
  const caution = failed.find((s) => s.module.includes('Breakout'));
  assert.equal(caution?.verdict, 'CAUTION');
});

test('early warnings are never presented as confirmed events', () => {
  const now = 1_700_000_000 + 200 * STEP;
  const report = analyzeMarketAnomaly({
    symbol: 'R_25',
    displayName: 'Volatility 25',
    timeframe: 'M5',
    granularitySec: STEP,
    candles: calmSeries(150, now - 150 * STEP),
    nowSec: now,
  });
  for (const w of report.earlyWarnings) assert.equal(w.confirmed, false);
});
