import test from 'node:test';
import assert from 'node:assert/strict';
import type { FullAnalysisReport, MarketDirection } from '../types/analysis';
import { buildAnalysisNarrative, summariseDirection } from './narrative';

function report(over: Partial<FullAnalysisReport> = {}): FullAnalysisReport {
  const base = {
    symbol: 'R_100',
    marketName: 'Volatility 100 Index',
    timeframe: 'M5',
    overallDirection: 'BULLISH' as MarketDirection,
    currentStructureSummary: 'Bullish Shift after CHOCH',
    htfAlignmentSummary: 'H1: BEARISH · M15: RANGING · M5: BULLISH',
    htfConflictNote: null,
    multiTimeframe: {
      macroTf: 'H1',
      structuralTf: 'M15',
      setupTf: 'M5',
      entryTf: 'M1',
      rationale: 'test',
    },
    marketCondition: 'TRANSITIONAL',
    conditionExplanation: 'Transitional market.',
    momentum: { summary: 'Bullish expansion (1.94x avg body)' },
    overlays: { signal: null },
    noSetupMessage: 'NO HIGH-QUALITY SETUP — WAITING FOR CONFIRMATION.',
  };
  return { ...base, ...over } as unknown as FullAnalysisReport;
}

test('summariseDirection maps engine direction to a tone and label', () => {
  const bull = summariseDirection(report({ overallDirection: 'BULLISH' }));
  assert.equal(bull?.tone, 'bullish');
  assert.match(bull?.label ?? '', /RISE/);
  assert.equal(bull?.ladder, 'H1 → M15 → M5 → M1');

  const bear = summariseDirection(report({ overallDirection: 'BEARISH' }));
  assert.equal(bear?.tone, 'bearish');
  assert.match(bear?.label ?? '', /FALL/);

  const neutral = summariseDirection(report({ overallDirection: 'NEUTRAL' }));
  assert.equal(neutral?.tone, 'neutral');
});

test('summariseDirection returns null without a report', () => {
  assert.equal(summariseDirection(null), null);
});

test('buildAnalysisNarrative always includes direction + top-down + no-setup sections', () => {
  const sections = buildAnalysisNarrative(report(), null);
  const headings = sections.map((s) => s.heading);
  assert.ok(headings.includes('Market direction'));
  assert.ok(headings.includes('Top-down read'));
  assert.ok(headings.includes('No confirmed setup'));
});

test('buildAnalysisNarrative reports a conflict verdict with a caution tone', () => {
  const sections = buildAnalysisNarrative(report(), {
    verdict: 'CONFLICT',
    notes: ['Engines disagree.'],
  } as never);
  const recon = sections.find((s) => s.heading === 'Dual-engine reconciliation');
  assert.equal(recon?.tone, 'caution');
  assert.match(recon?.body ?? '', /disagree/i);
});
