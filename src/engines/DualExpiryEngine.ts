import { Candle, TradeableRange, BarrierProposal, TrendDirection } from '../types/scanner';
import { AdaptiveBarrierEngine } from './AdaptiveBarrierEngine';
import { DerivWebSocketManager } from '../services/DerivWebSocketManager';

export interface ExpiryEvaluation {
  durationMinutes: number;
  durationSeconds: number;
  barrierProposal: BarrierProposal | null;
  score: number; // Composite risk-adjusted score (0 - 100)
  isRecommended: boolean;
  notes: string;
}

export class DualExpiryEngine {
  public static readonly CANDIDATE_DURATIONS = [2, 3, 5, 10, 15];

  /**
   * Evaluates fixed user-selected durations independently against the live market
   */
  public static async evaluateFixedDurations(
    symbol: string,
    currentPrice: number,
    direction: TrendDirection,
    tradeableRange: TradeableRange,
    candles2m: Candle[],
    wsManager: DerivWebSocketManager,
    durations: number[] = DualExpiryEngine.CANDIDATE_DURATIONS
  ): Promise<ExpiryEvaluation[]> {
    const results: ExpiryEvaluation[] = [];

    for (const duration of durations) {
      const proposal = await AdaptiveBarrierEngine.evaluateBestBarrier(
        symbol,
        currentPrice,
        direction,
        tradeableRange,
        candles2m,
        wsManager,
        duration
      );

      if (!proposal) {
        results.push({
          durationMinutes: duration,
          durationSeconds: duration * 60,
          barrierProposal: null,
          score: 0,
          isRecommended: false,
          notes: 'No viable barrier offset available for this horizon.'
        });
        continue;
      }

      // Risk-adjusted scoring:
      // Weight survival probability (65%) and EV margin ratio (35%)
      const evRatio = proposal.askPrice > 0 ? proposal.expectedValue / proposal.askPrice : 0;
      const rawScore = proposal.pathSurvivalProb * 65 + Math.min(1.0, Math.max(0, evRatio)) * 35;
      const score = Math.round(rawScore);

      results.push({
        durationMinutes: duration,
        durationSeconds: duration * 60,
        barrierProposal: proposal,
        score,
        isRecommended: false,
        notes: `Survival: ${(proposal.pathSurvivalProb * 100).toFixed(1)}% | Payout: $${proposal.payout.toFixed(2)} | EV: +$${proposal.expectedValue.toFixed(2)}`
      });
    }

    return results;
  }

  /**
   * Automatic Expiry Mode:
   * Scans candidate horizons and autonomously recommends the duration with the best
   * risk-adjusted path survival and contract expectation.
   */
  public static async determineAutoExpiry(
    symbol: string,
    currentPrice: number,
    direction: TrendDirection,
    tradeableRange: TradeableRange,
    candles2m: Candle[],
    wsManager: DerivWebSocketManager
  ): Promise<{ recommended: ExpiryEvaluation | null; allEvaluations: ExpiryEvaluation[] }> {
    const evaluations = await this.evaluateFixedDurations(
      symbol,
      currentPrice,
      direction,
      tradeableRange,
      candles2m,
      wsManager
    );

    const viable = evaluations.filter((e) => e.barrierProposal !== null && e.barrierProposal.isViable);
    if (viable.length === 0) {
      return { recommended: null, allEvaluations: evaluations };
    }

    // Rank candidates by composite score
    viable.sort((a, b) => b.score - a.score);

    const best = viable[0];
    best.isRecommended = true;

    return {
      recommended: best,
      allEvaluations: evaluations
    };
  }
}
