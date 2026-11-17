import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalisePreferences,
  durationMinutes,
  MIN_DURATION_MINUTES,
  MAX_DURATION_MINUTES
} from '../execution/preferences.js';
import type { ExecutionPreferencesRecord } from '../execution/types.js';

/**
 * Trade-panel preference validation.
 *
 * These preferences express intent only. The tests pin two properties that
 * matter for safety: a bad body is rejected with a specific reason, and the two
 * safety fields (`realExecutionAuthorised`, `autoStopped`) can never be flipped
 * by a preferences write.
 */

const USER = 'user_1';

function existing(): ExecutionPreferencesRecord {
  return {
    userId: USER,
    mode: 'manual',
    contractFamily: 'rise_fall',
    preferredAccountId: {},
    stake: { basis: 'stake', amount: 2, currency: 'USD' },
    parameters: {
      duration: 5,
      durationUnit: 'm',
      multiplier: null,
      cancellation: null,
      stopLoss: null,
      takeProfit: null
    },
    realExecutionAuthorised: false,
    autoStopped: false,
    updatedAt: 0
  };
}

test('durationMinutes converts convertible units and rejects ticks', () => {
  assert.equal(durationMinutes(30, 'm'), 30);
  assert.equal(durationMinutes(120, 's'), 2);
  assert.equal(durationMinutes(1, 'h'), 60);
  assert.equal(durationMinutes(5, 't'), null);
});

test('a fresh user gets safe defaults', () => {
  const result = normalisePreferences({}, null, USER);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.mode, 'manual');
  assert.equal(result.value.contractFamily, 'rise_fall');
  assert.equal(result.value.realExecutionAuthorised, false);
  assert.equal(result.value.autoStopped, false);
});

test('stake, duration and mode round-trip', () => {
  const result = normalisePreferences(
    { mode: 'automatic', contractFamily: 'rise_fall', stake: { amount: 20, basis: 'stake' }, parameters: { duration: 45, durationUnit: 'm' } },
    existing(),
    USER
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.mode, 'automatic');
  assert.equal(result.value.contractFamily, 'rise_fall');
  assert.equal(result.value.stake.amount, 20);
  assert.equal(result.value.parameters.duration, 45);
});

test('Multipliers are disabled: selecting them is refused', () => {
  const result = normalisePreferences({ contractFamily: 'multipliers' }, existing(), USER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'contract_family_disabled');
});

test('a stored Multipliers preference is coerced back to Rise/Fall', () => {
  const stored = { ...existing(), contractFamily: 'multipliers' as const };
  const result = normalisePreferences({}, stored, USER);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.contractFamily, 'rise_fall');
});

test('a duration outside 5–300 minutes is refused', () => {
  const tooShort = normalisePreferences({ parameters: { duration: 2, durationUnit: 'm' } }, existing(), USER);
  assert.equal(tooShort.ok, false);
  if (!tooShort.ok) assert.equal(tooShort.error.code, 'duration_out_of_range');

  const tooLong = normalisePreferences({ parameters: { duration: 400, durationUnit: 'm' } }, existing(), USER);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error.code, 'duration_out_of_range');

  // The bounds themselves are accepted.
  for (const minutes of [MIN_DURATION_MINUTES, MAX_DURATION_MINUTES]) {
    const ok = normalisePreferences({ parameters: { duration: minutes, durationUnit: 'm' } }, existing(), USER);
    assert.equal(ok.ok, true, `${minutes} minutes should be allowed`);
  }
});

test('a non-positive stake is refused', () => {
  const zero = normalisePreferences({ stake: { amount: 0 } }, existing(), USER);
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.equal(zero.error.code, 'invalid_stake');

  const negative = normalisePreferences({ stake: { amount: -5 } }, existing(), USER);
  assert.equal(negative.ok, false);
});

test('an unknown mode or family is refused', () => {
  assert.equal(normalisePreferences({ mode: 'hybrid' }, existing(), USER).ok, false);
  assert.equal(normalisePreferences({ contractFamily: 'digits' }, existing(), USER).ok, false);
});

test('the safety fields cannot be flipped through a preferences write', () => {
  const withReal = { ...existing(), realExecutionAuthorised: true };
  // Attempt to switch them off, and to switch auto-stop off, via the body.
  const result = normalisePreferences(
    { realExecutionAuthorised: false, autoStopped: false, mode: 'automatic' } as Record<string, unknown>,
    withReal,
    USER
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Carried over from the stored record, not taken from the body.
  assert.equal(result.value.realExecutionAuthorised, true);
  assert.equal(result.value.autoStopped, false);

  const stopped = { ...existing(), autoStopped: true };
  const second = normalisePreferences({ autoStopped: false, stake: { amount: 5 } }, stopped, USER);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.autoStopped, true, 'auto-stop must survive a preference save');
});

test('preference saves preserve server-owned risk-session baselines', () => {
  const stored = { ...existing(), lossStreakResetAtByAccount: { DEMO: 1_800_000_000_000 } };
  const result = normalisePreferences(
    { lossStreakResetAtByAccount: { DEMO: 0 }, stake: { amount: 5 } } as Record<string, unknown>,
    stored,
    USER
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.lossStreakResetAtByAccount, stored.lossStreakResetAtByAccount);
});

test('absent fields keep their stored values', () => {
  const result = normalisePreferences({ mode: 'automatic' }, existing(), USER);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.stake.amount, 2);
  assert.equal(result.value.contractFamily, 'rise_fall');
  assert.equal(result.value.parameters.duration, 5);
});

test('a non-object body is refused', () => {
  assert.equal(normalisePreferences(null, existing(), USER).ok, false);
  assert.equal(normalisePreferences([], existing(), USER).ok, false);
});
