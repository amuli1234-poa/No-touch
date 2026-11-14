import type { SignalRecord, SignalDirection } from '../execution/types.js';

/**
 * Strategy validation.
 *
 * A signal says "I think R_100 rises". Strategy validation asks the harder
 * question: does that opinion survive a second, independent check, and is it
 * precise enough to act on? It is the gate between "an engine produced a
 * direction" and "this is worth proposing as a trade".
 *
 * This module is deliberately pure and synchronous: it takes the signal and a
 * structured analysis and returns an explicit verdict with machine-readable
 * reasons. It never executes anything and never mutates a record.
 *
 * The analysis input is a plain structure rather than a live engine object, so
 * the AI/engine orchestration layer decides how analyses are produced and this
 * stays testable in isolation.
 */

export type StrategyCheckId =
  | 'symbol_match'
  | 'timeframe_match'
  | 'direction_agreement'
  | 'trend_alignment'
  | 'zone_present'
  | 'price_in_zone'
  | 'confidence_floor';

export interface StrategyCheck {
  id: StrategyCheckId;
  passed: boolean;
  detail: string;
}

export interface StrategyAnalysis {
  symbol: string;
  timeframe: string;
  /** The engine's directional read. `NONE` means no view. */
  direction: SignalDirection;
  /** Higher-timeframe trend, when available. */
  trend?: SignalDirection | null;
  /** A price zone the entry must fall inside, when the strategy uses one. */
  zone?: { low: number; high: number } | null;
  /** Engine confidence 0..1, when available. */
  confidence?: number | null;
  /** A live price to test against the zone, when available. */
  price?: number | null;
}

export interface StrategyPolicy {
  /** Require the analysis to name the same symbol. */
  requireSymbolMatch: boolean;
  /** Require the analysis to name the same timeframe. */
  requireTimeframeMatch: boolean;
  /** Require the engine's direction to equal the signal's. */
  requireDirectionAgreement: boolean;
  /** Require the higher-timeframe trend to agree with the signal. */
  requireTrendAlignment: boolean;
  /** Require the strategy to define a zone. */
  requireZone: boolean;
  /** Require the live price to fall inside the zone (implies requireZone). */
  requirePriceInZone: boolean;
  /** Minimum engine confidence, when a confidence is present. */
  minConfidence: number;
}

export const DEFAULT_STRATEGY_POLICY: StrategyPolicy = {
  requireSymbolMatch: true,
  requireTimeframeMatch: true,
  requireDirectionAgreement: true,
  requireTrendAlignment: false,
  requireZone: false,
  requirePriceInZone: false,
  minConfidence: 0
};

export interface StrategyVerdict {
  approved: boolean;
  /** The failed checks, in order. Empty when approved. */
  reasons: string[];
  checks: StrategyCheck[];
}

/** True when `price` is inside the inclusive zone. */
export function priceInZone(price: number, zone: { low: number; high: number }): boolean {
  const low = Math.min(zone.low, zone.high);
  const high = Math.max(zone.low, zone.high);
  return price >= low && price <= high;
}

/**
 * Runs every policy check and returns a verdict. A verdict is approved only
 * when every required check passes; the `reasons` list names exactly which did
 * not, so a rejection is explainable rather than opaque.
 */
export function validateStrategy(
  signal: SignalRecord,
  analysis: StrategyAnalysis,
  policy: StrategyPolicy = DEFAULT_STRATEGY_POLICY
): StrategyVerdict {
  const checks: StrategyCheck[] = [];
  const push = (id: StrategyCheckId, passed: boolean, detail: string) => checks.push({ id, passed, detail });

  if (policy.requireSymbolMatch) {
    push('symbol_match', signal.symbol === analysis.symbol, `signal ${signal.symbol} vs analysis ${analysis.symbol}`);
  }
  if (policy.requireTimeframeMatch) {
    push(
      'timeframe_match',
      signal.timeframe === analysis.timeframe,
      `signal ${signal.timeframe} vs analysis ${analysis.timeframe}`
    );
  }
  if (policy.requireDirectionAgreement) {
    push(
      'direction_agreement',
      signal.direction === analysis.direction && analysis.direction !== 'NONE',
      `signal ${signal.direction} vs analysis ${analysis.direction}`
    );
  }
  if (policy.requireTrendAlignment) {
    push(
      'trend_alignment',
      analysis.trend === signal.direction,
      `signal ${signal.direction} vs trend ${String(analysis.trend)}`
    );
  }

  const needsZone = policy.requireZone || policy.requirePriceInZone;
  const zone = analysis.zone ?? null;
  if (needsZone) {
    push('zone_present', zone !== null, zone ? 'zone defined' : 'no zone defined');
  }
  if (policy.requirePriceInZone) {
    const price = analysis.price;
    const ok = zone !== null && typeof price === 'number' && Number.isFinite(price) && priceInZone(price, zone);
    push(
      'price_in_zone',
      ok,
      zone && typeof price === 'number' ? `price ${price} vs zone [${zone.low}, ${zone.high}]` : 'price or zone missing'
    );
  }

  if (policy.minConfidence > 0) {
    const c = analysis.confidence;
    const ok = typeof c === 'number' && Number.isFinite(c) && c >= policy.minConfidence;
    push('confidence_floor', ok, `confidence ${String(c)} vs min ${policy.minConfidence}`);
  }

  const reasons = checks.filter((c) => !c.passed).map((c) => c.id);
  return { approved: reasons.length === 0, reasons, checks };
}
