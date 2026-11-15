import type { QualityTier } from '../types/engine';

/**
 * RISK MANAGEMENT & TRADE EXECUTION AI.
 *
 * Position sizing, R:R gates and stop-validity checks. It never invents a balance: it works
 * from the account size supplied by the user (default 10,000) and the quality tier produced by
 * the signal engine. Pure functions — trivially testable.
 */

export interface RiskProfile {
  accountSize: number;
  /** Percent of the account risked per trade. */
  riskPercent: number;
}

export const DEFAULT_RISK_PROFILE: RiskProfile = {
  accountSize: 10_000,
  riskPercent: 1,
};

/** Tier-based risk multiplier: stronger setups may take slightly more of the account. */
const TIER_MULTIPLIER: Record<QualityTier, number> = {
  EXCEPTIONAL: 1.25,
  HIGH_QUALITY: 1,
  DEVELOPING: 0.75,
  REJECTED: 0.5,
};

export interface RiskPlan {
  /** Absolute money risked on this trade. */
  riskAmount: number;
  /** Price distance between entry and stop. */
  stopDistance: number;
  /** Units of the instrument to trade. */
  positionSize: number;
  /** Notional value of the position. */
  notional: number;
  /** Reward-to-risk ratio from entry → first target. */
  riskRewardRatio: number;
  /** True when the stop and entry are valid (entry ≠ stop, both finite and positive). */
  valid: boolean;
  warnings: string[];
}

export interface RiskPlanInput {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  tier: QualityTier;
  precision: number;
  profile?: RiskProfile;
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/** Computes a cost-free position plan. Withholds a plan when the levels are not valid. */
export function buildRiskPlan(input: RiskPlanInput): RiskPlan {
  const profile = input.profile ?? DEFAULT_RISK_PROFILE;
  const warnings: string[] = [];
  const { entry, stopLoss, takeProfit } = input;

  const levelsValid =
    Number.isFinite(entry) &&
    Number.isFinite(stopLoss) &&
    Number.isFinite(takeProfit) &&
    entry > 0 &&
    stopLoss > 0 &&
    takeProfit > 0 &&
    entry !== stopLoss;

  if (!levelsValid) {
    return {
      riskAmount: 0,
      stopDistance: 0,
      positionSize: 0,
      notional: 0,
      riskRewardRatio: 0,
      valid: false,
      warnings: ['Entry, stop and target must be distinct positive prices.'],
    };
  }

  const stopDistance = Math.abs(entry - stopLoss);
  const riskAmount = (profile.accountSize * profile.riskPercent) / 100 * TIER_MULTIPLIER[input.tier];
  const positionSize = stopDistance > 0 ? riskAmount / stopDistance : 0;
  const notional = positionSize * entry;
  const riskRewardRatio = stopDistance > 0 ? Math.abs(takeProfit - entry) / stopDistance : 0;

  if (riskRewardRatio < 1.5) {
    warnings.push(
      `Reward-to-risk is ${riskRewardRatio.toFixed(2)}:1 — below the 1.5:1 execution gate.`
    );
  }
  if (notional > profile.accountSize * 20) {
    warnings.push('Notional exposure exceeds 20× the account — reduce size or widen the stop.');
  }
  if (input.tier === 'DEVELOPING' || input.tier === 'REJECTED') {
    warnings.push(
      `Setup tier is ${input.tier.replace('_', ' ')} — size is reduced and a tighter confirmation is advised.`
    );
  }

  return {
    riskAmount: roundTo(riskAmount, 2),
    stopDistance: roundTo(stopDistance, input.precision),
    positionSize: roundTo(positionSize, 4),
    notional: roundTo(notional, 2),
    riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
    valid: true,
    warnings,
  };
}

export interface RiskRule {
  id: string;
  label: string;
  detail: string;
}

/** The active execution guardrails. Count drives the health-centre risk check. */
export const RISK_RULES: readonly RiskRule[] = [
  {
    id: 'size',
    label: 'Position sizing',
    detail: 'Risk per trade is a fixed percentage of the account, scaled by setup tier.',
  },
  {
    id: 'stop',
    label: 'Stop validity',
    detail: 'A plan is withheld unless the stop and entry are distinct, positive prices.',
  },
  {
    id: 'rr',
    label: 'Reward-to-risk gate',
    detail: 'Setups below 1.5:1 reward-to-risk are flagged before execution.',
  },
  {
    id: 'exposure',
    label: 'Notional exposure cap',
    detail: 'Positions above 20× the account are flagged for review.',
  },
] as const;
