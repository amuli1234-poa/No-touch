import { FVG, TrendDirection } from '../types/scanner';

export interface AdaptiveFillDecision {
  targetLevel: number;
  depthType: 'NEAR_EDGE' | 'INTERMEDIATE_25' | 'MIDPOINT_50' | 'DEEP_75' | 'FULL_100';
  rationale: string;
}

export class AdaptiveFillEngine {
  /**
   * Autonomously determines the optimal, defensible retracement fill depth
   * rather than assuming a fixed 50% or 100% level.
   */
  public static computeTarget(
    fvg: FVG,
    direction: TrendDirection,
    volatilityRegime: 'LOW' | 'MEDIUM' | 'HIGH',
    mtfAligned: boolean,
    protectedSwingDistance: number
  ): AdaptiveFillDecision {
    const range = fvg.upperBoundary - fvg.lowerBoundary;

    // High volatility + non-aligned MTF: market frequently hunts deeper liquidity into the imbalance
    if (volatilityRegime === 'HIGH' && !mtfAligned) {
      const target =
        direction === 'BULLISH'
          ? fvg.lowerBoundary + range * 0.25 // 75% deep retracement towards lower boundary
          : fvg.upperBoundary - range * 0.25;

      return {
        targetLevel: target,
        depthType: 'DEEP_75',
        rationale: 'High volatility environment with divergent 5m bias dictates anticipation of deep 75% mitigation.'
      };
    }

    // High momentum + strong MTF alignment: institutional pressure often rejects immediately at the near edge
    if (mtfAligned && fvg.displacementPips > range * 1.5 && volatilityRegime === 'LOW') {
      const target = direction === 'BULLISH' ? fvg.upperBoundary : fvg.lowerBoundary;
      return {
        targetLevel: target,
        depthType: 'NEAR_EDGE',
        rationale: 'Strong momentum and aligned higher timeframe order flow support prompt reaction at the near edge.'
      };
    }

    // Large FVG gap size: midpoint (50% equilibrium / mean threshold) provides superior risk-to-reward
    if (range > protectedSwingDistance * 0.35) {
      return {
        targetLevel: fvg.midpoint,
        depthType: 'MIDPOINT_50',
        rationale: 'Significant gap magnitude establishes 50% equilibrium as the most defensible institutional entry.'
      };
    }

    // Moderate / balanced regime: 50% midpoint
    return {
      targetLevel: fvg.midpoint,
      depthType: 'MIDPOINT_50',
      rationale: 'Standard institutional equilibrium (Consequent Encroachment) balance point.'
    };
  }
}
