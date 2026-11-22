import test from 'node:test';
import assert from 'node:assert/strict';

import { STATE_COPY } from './compatibilityCopy';
import { COMPATIBILITY_STATES } from '../../../server/bots/compatibility';

/**
 * The availability check speaks the server's `CompatibilityState` vocabulary,
 * which differs from the import-time `CompatibilityLevel`. When the copy map was
 * keyed by the wrong set, a compatible symbol rendered as a bare "Checked" — a
 * silent wrong answer rather than a visible failure. These tests keep the map in
 * step with the server.
 */
test('every server compatibility state has copy', () => {
  const missing = COMPATIBILITY_STATES.filter((state) => !(state in STATE_COPY));
  assert.deepEqual(missing, [], `no copy for: ${missing.join(', ')}`);
});

test('the copy map defines no state the server does not emit', () => {
  const known = new Set<string>(COMPATIBILITY_STATES);
  const extra = Object.keys(STATE_COPY).filter((state) => !known.has(state));
  assert.deepEqual(extra, [], `copy for unknown states: ${extra.join(', ')}`);
});

test('only the compatible state reads as a success', () => {
  for (const state of COMPATIBILITY_STATES) {
    assert.equal(STATE_COPY[state].ok, state === 'compatible', `wrong tone for ${state}`);
  }
});

test('every label is a sentence a customer can act on', () => {
  for (const state of COMPATIBILITY_STATES) {
    const { label } = STATE_COPY[state];
    assert.ok(label.trim().length > 0, `empty label for ${state}`);
    assert.ok(label[0] === label[0].toUpperCase(), `label not capitalised for ${state}`);
  }
});
