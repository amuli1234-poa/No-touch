import {
  OpportunityScoreBreakdown,
  TrendDirection,
  CandlestickSignal,
  StructuralShift,
  FVG,
  TradeableRange,
  BarrierProposal,
  OpportunityStatus
} from '../types/scanner';

export class OpportunityScoringEngine {
  /**
   * Evaluates the master 7-component weighted score model and enforces mandatory gating.
   */
  public static evaluateScore(
    tf5mDirection: TrendDirection,
    tf2mDirection: TrendDirection,
    sweepIdentified: boolean,
    protectedSwingValid: boolean,
    reversal: CandlestickSignal,
    shift: StructuralShift | null,
    fvg: FVG | null,
    tradeableRange: TradeableRange | null,
    barrier: BarrierProposal | null,
    minQualifiedScore = 90
  ): {
    breakdown: OpportunityScoreBreakdown;
    status: OpportunityStatus;
    rejectionReasons: string[];
    explanation: string;
  } {
    const reasons: string[] = [];
    const breakdown: OpportunityScoreBreakdown = {
      structureAlignment: 0,
      liquidityAndProtectedSwing: 0,
      candlestickConfirmation: 0,
      confirmedMarketShift: 0,
      fvgAndDisplacement: 0,
      tradeableRangeAndRetracement: 0,
      barrierSurvival: 0,
      total: 0
    };

    // 1. Structure Alignment (20%)
    if (tf5mDirection === tf2mDirection && tf5mDirection !== 'NEUTRAL') {
      breakdown.structureAlignment = 20;
    } else if (tf2mDirection !== 'NEUTRAL') {
      breakdown.structureAlignment = 10;
      reasons.push('5m directional context is divergent or neutral relative to 2m structure.');
    } else {
      reasons.push('Primary timeframes exhibit neutral / consolidating structure.');
    }

    // 2. Liquidity Sweep & Protected Swing (15%) - MANDATORY
    if (!sweepIdentified) {
      reasons.push('Mandatory Requirement Unmet: No liquidity sweep identified on 2m timeframe.');
    } else if (!protectedSwingValid) {
      reasons.push('Mandatory Requirement Unmet: Protected swing level has been breached.');
    } else {
      breakdown.liquidityAndProtectedSwing = 15;
    }

    // 3. Candlestick Confirmation (10%)
    if (reversal.name !== 'NONE' && reversal.strength >= 0.75) {
      breakdown.candlestickConfirmation = 10;
    } else if (reversal.name !== 'NONE') {
      breakdown.candlestickConfirmation = Math.round(reversal.strength * 10);
    } else {
      reasons.push('No recognized candlestick reversal pattern formed at key level.');
    }

    // 4. Confirmed Market Shift (15%) - MANDATORY
    if (shift && shift.confirmedByClose) {
      const score = Math.round(15 * Math.min(1.0, shift.displacementScore));
      breakdown.confirmedMarketShift = Math.max(10, score);
    } else {
      reasons.push('Mandatory Requirement Unmet: No structural shift (CHoCH) confirmed by candle close.');
    }

    // 5. FVG & Displacement (15%) - MANDATORY
    if (fvg && !fvg.completelyFilled && fvg.fresh) {
      breakdown.fvgAndDisplacement = 15;
    } else if (fvg && !fvg.completelyFilled) {
      // Partially mitigated FVG gets partial score
      const unmitigatedRatio = (100 - fvg.fillPercentage) / 100;
      breakdown.fvgAndDisplacement = Math.round(15 * unmitigatedRatio);
    } else {
      reasons.push('Mandatory Requirement Unmet: Missing clean, unmitigated Fair Value Gap.');
    }

    // 6. Tradeable Range & Retracement (15%) - MANDATORY
    if (tradeableRange && tradeableRange.isRetracementValid) {
      breakdown.tradeableRangeAndRetracement = 15;
    } else {
      reasons.push('Mandatory Requirement Unmet: Retracement path lacks defensible room above protected swing.');
    }

    // 7. Barrier Survival Assessment (10%)
    if (barrier && barrier.isViable) {
      breakdown.barrierSurvival = Math.round(barrier.pathSurvivalProb * 10);
    } else if (barrier) {
      breakdown.barrierSurvival = Math.round(barrier.pathSurvivalProb * 6);
      reasons.push('Barrier survival probability is acceptable but lacks expected value edge.');
    } else {
      reasons.push('No economically viable No Touch barrier proposal available.');
    }

    // Calculate composite score
    breakdown.total =
      breakdown.structureAlignment +
      breakdown.liquidityAndProtectedSwing +
      breakdown.candlestickConfirmation +
      breakdown.confirmedMarketShift +
      breakdown.fvgAndDisplacement +
      breakdown.tradeableRangeAndRetracement +
      breakdown.barrierSurvival;

    // Strict Mandatory Condition Gating:
    // Any failure of mandatory conditions immediately disqualifies the setup
    const mandatoryPassed =
      sweepIdentified &&
      protectedSwingValid &&
      shift !== null &&
      shift.confirmedByClose &&
      fvg !== null &&
      !fvg.completelyFilled &&
      tradeableRange !== null &&
      tradeableRange.isRetracementValid;

    let status: OpportunityStatus = 'REJECTED';

    if (!mandatoryPassed) {
      status = 'REJECTED';
    } else if (breakdown.total >= minQualifiedScore && barrier && barrier.isViable) {
      status = 'QUALIFIED';
    } else if (breakdown.total >= 80) {
      status = 'WATCHLIST';
    } else {
      status = 'REJECTED';
    }

    let explanation = '';
    if (status === 'QUALIFIED') {
      explanation = `Fully qualified ${tf2mDirection} opportunity. Liquidity swept, clean CHoCH closed with ${((shift?.displacementScore || 0) * 100).toFixed(0)}% displacement, unmitigated FVG active, and adaptive barrier offers ${((barrier?.pathSurvivalProb || 0) * 100).toFixed(1)}% path survival.`;
    } else if (status === 'WATCHLIST') {
      explanation = `Potential ${tf2mDirection} setup developing. Mandatory conditions confirmed with score of ${breakdown.total}%. Monitoring for optimal barrier quote or deeper retracement.`;
    } else {
      explanation = reasons.length > 0 ? reasons[0] : 'Setup does not meet institutional qualification criteria.';
    }

    return {
      breakdown,
      status,
      rejectionReasons: reasons,
      explanation
    };
  }
}
