import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRiskPlan,
  DEFAULT_RISK_PROFILE,
  RISK_RULES,
  type RiskProfile,
} from './riskManagement';

const PROFILE: RiskProfile = { accountSize: 10_000, riskPercent: 1 };

describe('buildRiskPlan', () => {
  it('sizes the position from the account risk and the stop distance', () => {
    const plan = buildRiskPlan({
      entry: 100,
      stopLoss: 99,
      takeProfit: 102,
      tier: 'HIGH_QUALITY',
      precision: 2,
      profile: PROFILE,
    });
    assert.equal(plan.valid, true);
    // 1% of 10,000 = 100 risked over a 1.0 stop distance → 100 units.
    assert.equal(plan.riskAmount, 100);
    assert.equal(plan.positionSize, 100);
    assert.equal(plan.notional, 10_000);
    assert.equal(plan.riskRewardRatio, 2);
    assert.equal(plan.warnings.length, 0);
  });

  it('scales risk by the quality tier', () => {
    const exceptional = buildRiskPlan({
      entry: 100, stopLoss: 99, takeProfit: 103, tier: 'EXCEPTIONAL', precision: 2, profile: PROFILE,
    });
    const developing = buildRiskPlan({
      entry: 100, stopLoss: 99, takeProfit: 103, tier: 'DEVELOPING', precision: 2, profile: PROFILE,
    });
    assert.ok(exceptional.riskAmount > developing.riskAmount);
  });

  it('withholds a plan when entry and stop are not distinct', () => {
    const plan = buildRiskPlan({
      entry: 100, stopLoss: 100, takeProfit: 102, tier: 'HIGH_QUALITY', precision: 2, profile: PROFILE,
    });
    assert.equal(plan.valid, false);
    assert.equal(plan.positionSize, 0);
    assert.match(plan.warnings[0], /distinct positive prices/);
  });

  it('flags a reward-to-risk below the 1.5 execution gate', () => {
    const plan = buildRiskPlan({
      entry: 100, stopLoss: 99, takeProfit: 100.8, tier: 'HIGH_QUALITY', precision: 2, profile: PROFILE,
    });
    assert.ok(plan.warnings.some((w) => /1.5:1/.test(w)));
  });

  it('flags developing-tier setups for tighter confirmation', () => {
    const plan = buildRiskPlan({
      entry: 100, stopLoss: 99, takeProfit: 103, tier: 'DEVELOPING', precision: 2, profile: PROFILE,
    });
    assert.ok(plan.warnings.some((w) => /DEVELOPING/.test(w)));
  });

  it('flags excessive notional exposure', () => {
    const plan = buildRiskPlan({
      entry: 100, stopLoss: 99.99, takeProfit: 130, tier: 'HIGH_QUALITY', precision: 2,
      profile: { accountSize: 10_000, riskPercent: 1 },
    });
    assert.ok(plan.warnings.some((w) => /20×/.test(w)));
  });

  it('exposes the active execution guardrails', () => {
    assert.ok(RISK_RULES.length >= 3);
    assert.ok(RISK_RULES.every((r) => r.label.length > 0 && r.detail.length > 0));
    assert.deepEqual(DEFAULT_RISK_PROFILE, { accountSize: 10_000, riskPercent: 1 });
  });
});
