import { PivotPoint, FVG, TradeableRange, TrendDirection } from '../types/scanner';
import { AdaptiveFillEngine } from './AdaptiveFillEngine';

export class TradeableRangeEngine {
  /**
   * Calculates tradeable range, separates original swept swing from newly protected swing,
   * calculates adaptive fill target, and validates whether retracement path is structurally sound.
   */
  public static calculate(
    direction: TrendDirection,
    sweptPivot: PivotPoint,
    displacementPivot: PivotPoint,
    fvg: FVG,
    currentPrice: number,
    volatilityRegime: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM',
    mtfAligned: boolean = true
  ): TradeableRange | null {
    if (direction === 'BULLISH') {
      const protectedLow = sweptPivot.price;
      const brokenHigh = displacementPivot.price;

      // Price cannot have already broken through the protected low
      if (currentPrice < protectedLow) {
        return null;
      }

      const totalDistance = brokenHigh - protectedLow;
      if (totalDistance <= 0) return null;

      const adaptiveFill = AdaptiveFillEngine.computeTarget(
        fvg,
        direction,
        volatilityRegime,
        mtfAligned,
        totalDistance
      );

      // Invalidation level is strictly the protected low
      const invalidationLevel = protectedLow;

      // Retracement check: adaptive fill target must sit safely above the protected swing low
      // Buffer must be at least 15% of the total displacement move
      const buffer = totalDistance * 0.15;
      const isRetracementValid = adaptiveFill.targetLevel > protectedLow + buffer;

      return {
        sweptLiquidityLevel: sweptPivot.price,
        newlyProtectedSwing: protectedLow,
        displacementBreakLevel: brokenHigh,
        adaptiveFillTarget: adaptiveFill.targetLevel,
        fillRationale: adaptiveFill.rationale,
        invalidationLevel,
        isRetracementValid,
        rangeDistance: totalDistance,
        fillDepthType: adaptiveFill.depthType
      };
    } else {
      const protectedHigh = sweptPivot.price;
      const brokenLow = displacementPivot.price;

      // Price cannot have already broken through the protected high
      if (currentPrice > protectedHigh) {
        return null;
      }

      const totalDistance = protectedHigh - brokenLow;
      if (totalDistance <= 0) return null;

      const adaptiveFill = AdaptiveFillEngine.computeTarget(
        fvg,
        direction,
        volatilityRegime,
        mtfAligned,
        totalDistance
      );

      const invalidationLevel = protectedHigh;

      const buffer = totalDistance * 0.15;
      const isRetracementValid = adaptiveFill.targetLevel < protectedHigh - buffer;

      return {
        sweptLiquidityLevel: sweptPivot.price,
        newlyProtectedSwing: protectedHigh,
        displacementBreakLevel: brokenLow,
        adaptiveFillTarget: adaptiveFill.targetLevel,
        fillRationale: adaptiveFill.rationale,
        invalidationLevel,
        isRetracementValid,
        rangeDistance: totalDistance,
        fillDepthType: adaptiveFill.depthType
      };
    }
  }
}
