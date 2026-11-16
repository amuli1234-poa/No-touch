import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadExecutionFlags, executionPermitted } from '../config/flags.js';

/**
 * Phase 10 release review: the REAL execution gate.
 *
 * These tests pin the fail-closed contract that keeps REAL money off. They are
 * the machine-checkable half of the Phase 10 review; the prose half is
 * `docs/REAL_EXECUTION_RELEASE_REVIEW.md`.
 *
 * The point is not that REAL *can* run — it is that every path to it is closed
 * by default and opens only through an explicit, deliberate, layered opt-in.
 */

test('every flag is off with an empty environment', () => {
  const flags = loadExecutionFlags({});
  assert.equal(flags.allowExecution, false);
  assert.equal(flags.allowDemoExecution, false);
  assert.equal(flags.allowRealExecution, false);
  assert.equal(flags.allowAutomaticTrading, false);
});

test('automatic trading is off by default and never implied by the execution switches', () => {
  // Its own flag without the master switch is not enough.
  assert.equal(loadExecutionFlags({ ALLOW_AUTOMATIC_TRADING: 'true' }).allowAutomaticTrading, false);
  // The manual switches do not turn it on.
  const manual = loadExecutionFlags({ ALLOW_EXECUTION: 'true', ALLOW_DEMO_EXECUTION: 'true' });
  assert.equal(manual.allowAutomaticTrading, false);
  // Both are required.
  const auto = loadExecutionFlags({ ALLOW_EXECUTION: 'true', ALLOW_AUTOMATIC_TRADING: 'true' });
  assert.equal(auto.allowAutomaticTrading, true);
});

test('REAL is refused unless the master switch is ALSO on', () => {
  // The dedicated REAL flag alone is not enough.
  const realOnly = loadExecutionFlags({ ALLOW_REAL_EXECUTION: 'true' });
  assert.equal(realOnly.allowRealExecution, false, 'REAL needs the master switch too');
  assert.equal(executionPermitted(realOnly, 'real').permitted, false);

  // Master + REAL is the only combination that permits it.
  const both = loadExecutionFlags({ ALLOW_EXECUTION: 'true', ALLOW_REAL_EXECUTION: 'true' });
  assert.equal(both.allowRealExecution, true);
  assert.equal(executionPermitted(both, 'real').permitted, true);
});

test('DEMO can never permit REAL', () => {
  const demo = loadExecutionFlags({ ALLOW_EXECUTION: 'true', ALLOW_DEMO_EXECUTION: 'true' });
  assert.equal(executionPermitted(demo, 'demo').permitted, true);
  assert.equal(executionPermitted(demo, 'real').permitted, false);
  assert.equal(executionPermitted(demo, 'real').reason, 'real_execution_disabled');
});

test('only the exact lowercase "true" enables a switch', () => {
  for (const value of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
    const flags = loadExecutionFlags({ ALLOW_EXECUTION: 'true', ALLOW_REAL_EXECUTION: value });
    assert.equal(flags.allowRealExecution, false, `"${value}" must not enable REAL`);
  }
});

test('the master switch gates both modes', () => {
  const off = loadExecutionFlags({ ALLOW_DEMO_EXECUTION: 'true', ALLOW_REAL_EXECUTION: 'true' });
  assert.equal(executionPermitted(off, 'demo').reason, 'global_execution_disabled');
  assert.equal(executionPermitted(off, 'real').reason, 'global_execution_disabled');
});
