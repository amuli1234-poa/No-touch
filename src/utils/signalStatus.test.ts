import test from 'node:test';
import assert from 'node:assert/strict';
import type { FullAnalysisReport } from '../types/analysis';
import { deriveSignalLifecycle, minQualityScore, passesQualityFilter } from './signalStatus';

function report(partial: Partial<FullAnalysisReport>): FullAnalysisReport {
  return {
    signalStatus: 'WAIT',
    runState: 'NO VALID SETUP',
    setupQuality: 'INVALID SETUP',
    confluenceScore: 0,
    maxConfluenceScore: 8,
    recommendedDirection: 'WAIT',
    overlays: { signal: null },
    ...partial,
  } as unknown as FullAnalysisReport;
}

test('deriveSignalLifecycle returns null without a report', () => {
  assert.equal(deriveSignalLifecycle(null), null);
});

test('a CONFIRMED engine setup becomes an actionable CONFIRMED lifecycle', () => {
  const lifecycle = deriveSignalLifecycle(
    report({
      signalStatus: 'CONFIRMED',
      runState: 'VALID RISE SETUP',
      setupQuality: 'HIGH QUALITY',
      overlays: { signal: { direction: 'RISE', quality: 'HIGH QUALITY' } },
    } as unknown as Partial<FullAnalysisReport>)
  );
  assert.equal(lifecycle?.status, 'CONFIRMED');
  assert.equal(lifecycle?.isActionable, true);
  assert.equal(lifecycle?.filterSuppressed, undefined);
});

test('a direction filter demotes a CONFIRMED setup instead of fabricating one', () => {
  const lifecycle = deriveSignalLifecycle(
    report({
      signalStatus: 'CONFIRMED',
      runState: 'VALID RISE SETUP',
      setupQuality: 'HIGH QUALITY',
      overlays: { signal: { direction: 'RISE', quality: 'HIGH QUALITY' } },
    } as unknown as Partial<FullAnalysisReport>),
    { directionPreference: 'FALL' }
  );
  assert.equal(lifecycle?.isActionable, false);
  assert.equal(lifecycle?.filterSuppressed, true);
  assert.equal(lifecycle?.label, 'FILTERED');
});

test('a quality filter demotes a CONFIRMED setup below the threshold', () => {
  const lifecycle = deriveSignalLifecycle(
    report({
      signalStatus: 'CONFIRMED',
      runState: 'VALID FALL SETUP',
      setupQuality: 'MODERATE QUALITY',
      overlays: { signal: { direction: 'FALL', quality: 'MODERATE QUALITY' } },
    } as unknown as Partial<FullAnalysisReport>),
    { minQuality: 'HIGH' }
  );
  assert.equal(lifecycle?.isActionable, false);
  assert.equal(lifecycle?.filterSuppressed, true);
});

test('no engine confirmation never yields an actionable signal', () => {
  const lifecycle = deriveSignalLifecycle(
    report({ runState: 'READY TO ANALYZE', confluenceScore: 6 })
  );
  assert.equal(lifecycle?.isActionable, false);
  assert.notEqual(lifecycle?.status, 'CONFIRMED');
});

test('an invalidated engine setup maps to INVALIDATED', () => {
  const lifecycle = deriveSignalLifecycle(
    report({ signalStatus: 'INVALIDATED', runState: 'SETUP INVALIDATED' })
  );
  assert.equal(lifecycle?.status, 'INVALIDATED');
  assert.equal(lifecycle?.isActionable, false);
});

test('waiting for confirmation maps to DEVELOPING', () => {
  const lifecycle = deriveSignalLifecycle(
    report({ runState: 'WAITING FOR CONFIRMATION' })
  );
  assert.equal(lifecycle?.status, 'DEVELOPING');
  assert.equal(lifecycle?.isActionable, false);
});

test('minQualityScore maps each filter tier to its score floor', () => {
  assert.equal(minQualityScore('ANY'), 0);
  assert.equal(minQualityScore('MODERATE'), 75);
  assert.equal(minQualityScore('HIGH'), 85);
});

test('passesQualityFilter admits a score at or above the floor and refuses below it', () => {
  assert.equal(passesQualityFilter(85, 'HIGH'), true);
  assert.equal(passesQualityFilter(84, 'HIGH'), false);
  assert.equal(passesQualityFilter(75, 'MODERATE'), true);
  assert.equal(passesQualityFilter(70, 'MODERATE'), false);
  // ANY admits every finite score, including zero.
  assert.equal(passesQualityFilter(0, 'ANY'), true);
});

test('passesQualityFilter never treats a missing or non-finite score as passing', () => {
  assert.equal(passesQualityFilter(null, 'ANY'), false);
  assert.equal(passesQualityFilter(undefined, 'ANY'), false);
  assert.equal(passesQualityFilter(Number.NaN, 'ANY'), false);
  assert.equal(passesQualityFilter(Number.POSITIVE_INFINITY, 'HIGH'), false);
});
