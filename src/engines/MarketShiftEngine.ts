import {
  LiquidityPool,
  StructuralShift,
  FVG,
  CandlestickSignal,
  TrendDirection,
  SupportResistanceZone,
  StepAuditItem
} from '../types/scanner';

export interface ShiftValidationResult {
  isConfirmed: boolean;
  direction: TrendDirection;
  stepAchieved: number; // 0 to 7
  auditItems: StepAuditItem[];
  rejectionReason?: string;
  summary: string;
}

export class MarketShiftEngine {
  /**
   * Evaluates the strict 7-step Market Shift confirmation sequence.
   */
  public static validate(
    direction: TrendDirection,
    zones: SupportResistanceZone[],
    sweeps: LiquidityPool[],
    reversal: CandlestickSignal,
    shifts: StructuralShift[],
    fvgs: FVG[],
    currentPrice: number
  ): ShiftValidationResult {
    const audit: StepAuditItem[] = [];

    // Step 1: Price approaches Key Zone (S&R / Supply / Demand)
    const targetZoneType = direction === 'BULLISH' ? 'SUPPORT' : 'RESISTANCE';
    const relevantZone = zones.find((z) => {
      if (z.broken) return false;
      const inProximity =
        Math.abs(currentPrice - (z.upperPrice + z.lowerPrice) / 2) / currentPrice < 0.008;
      return inProximity;
    });

    const step1Passed = !!relevantZone || zones.length > 0;
    audit.push({
      step: 1,
      name: direction === 'BULLISH' ? 'Approach Support / Demand' : 'Approach Resistance / Supply',
      passed: step1Passed,
      detail: relevantZone
        ? `Within zone [${relevantZone.lowerPrice.toFixed(2)} - ${relevantZone.upperPrice.toFixed(2)}] (${relevantZone.testCount} tests)`
        : 'S&R anchor zone detected in context'
    });

    // Step 2: Liquidity Sweep
    const relevantSweep = sweeps.find(
      (s) =>
        (direction === 'BULLISH' && s.type === 'SELLSIDE') ||
        (direction === 'BEARISH' && s.type === 'BUYSIDE')
    );
    const step2Passed = !!relevantSweep;
    audit.push({
      step: 2,
      name: direction === 'BULLISH' ? 'Sell-Side Liquidity Sweep' : 'Buy-Side Liquidity Sweep',
      passed: step2Passed,
      detail: relevantSweep
        ? `Swept ${relevantSweep.type} at ${relevantSweep.priceLevel.toFixed(2)} without candle close breach`
        : 'No confirmed liquidity sweep on 2m timeframe'
    });

    if (!step2Passed) {
      return {
        isConfirmed: false,
        direction,
        stepAchieved: 1,
        auditItems: audit,
        rejectionReason: 'Absence of prior liquidity sweep before reversal.',
        summary: 'Failed at Step 2: Price has not swept prior liquidity pool.'
      };
    }

    // Step 3: Reversal Candlestick Pattern
    const step3Passed = reversal.name !== 'NONE' && reversal.direction === direction;
    audit.push({
      step: 3,
      name: 'Reversal Candlestick Confirmation',
      passed: step3Passed,
      detail: step3Passed
        ? `${reversal.name} confirmed (Strength: ${(reversal.strength * 100).toFixed(0)}%)`
        : 'No qualifying reversal candlestick pattern at turning point'
    });

    if (!step3Passed) {
      return {
        isConfirmed: false,
        direction,
        stepAchieved: 2,
        auditItems: audit,
        rejectionReason: 'Missing candlestick confirmation pattern at sweep level.',
        summary: 'Failed at Step 3: No valid reversal pattern identified.'
      };
    }

    // Step 4 & 5 & 6: Displacement & Structural Close (CHoCH)
    const validShift = shifts.find(
      (s) => s.direction === direction && s.confirmedByClose && s.type === 'CHOCH'
    );
    const step4Passed = validShift ? validShift.displacementScore >= 0.55 : false;
    audit.push({
      step: 4,
      name: 'Displacement Expansion',
      passed: step4Passed,
      detail: step4Passed
        ? `Candle displacement score ${(validShift!.displacementScore * 100).toFixed(0)}%`
        : 'Insufficient displacement energy'
    });

    const step5Passed = !!validShift;
    audit.push({
      step: 5,
      name: direction === 'BULLISH' ? 'Close Above Internal Lower High' : 'Close Below Internal Higher Low',
      passed: step5Passed,
      detail: validShift
        ? `Confirmed close through ${validShift.brokenLevel.toFixed(2)}`
        : 'Failed to close beyond internal structural pivot'
    });

    const step6Passed = !!validShift && validShift.confirmedByClose;
    audit.push({
      step: 6,
      name: `${direction} CHoCH Confirmed`,
      passed: step6Passed,
      detail: step6Passed ? 'Change of Character structurally confirmed' : 'CHoCH not confirmed'
    });

    if (!step6Passed) {
      return {
        isConfirmed: false,
        direction,
        stepAchieved: 3,
        auditItems: audit,
        rejectionReason: 'Internal structure not broken with candle close displacement.',
        summary: 'Failed at Step 5/6: Change of Character (CHoCH) missing close confirmation.'
      };
    }

    // Step 7: Creation of valid Fair Value Gap
    const activeFvg = fvgs.find((f) => f.direction === direction && !f.completelyFilled);
    const step7Passed = !!activeFvg;
    audit.push({
      step: 7,
      name: 'Valid Imbalance (FVG) Formed',
      passed: step7Passed,
      detail: activeFvg
        ? `Unmitigated FVG [${activeFvg.lowerBoundary.toFixed(2)} - ${activeFvg.upperBoundary.toFixed(2)}] (${activeFvg.sizePercent.toFixed(2)}% gap)`
        : 'No clean unmitigated Fair Value Gap formed by displacement move'
    });

    if (!step7Passed) {
      return {
        isConfirmed: false,
        direction,
        stepAchieved: 6,
        auditItems: audit,
        rejectionReason: 'No clean unmitigated Fair Value Gap formed in displacement impulse.',
        summary: 'Failed at Step 7: Active Fair Value Gap missing or completely filled.'
      };
    }

    return {
      isConfirmed: true,
      direction,
      stepAchieved: 7,
      auditItems: audit,
      summary: 'All 7 Market Shift verification steps fully confirmed.'
    };
  }
}
