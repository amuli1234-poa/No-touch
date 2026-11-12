import { Candle, TradeableRange, BarrierProposal, TrendDirection } from '../types/scanner';
import { PathTouchProbability } from './PathTouchProbability';
import { DerivWebSocketManager } from '../services/DerivWebSocketManager';

export class AdaptiveBarrierEngine {
  /**
   * Calculates Average True Range (ATR) over N periods
   */
  public static calculateATR(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return 0;
    let trSum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trSum += tr;
    }
    return trSum / period;
  }

  /**
   * Calculates per-second realized volatility from 2-minute candle log returns
   */
  public static calculateRealizedVolPerSec(candles: Candle[]): number {
    if (candles.length < 20) return 0.001;
    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length - 1);
    const stdDevCandle = Math.sqrt(variance);

    // 2-minute candle = 120 seconds
    const currentPrice = candles[candles.length - 1].close;
    return (stdDevCandle * currentPrice) / Math.sqrt(120);
  }

  /**
   * Evaluates candidate No Touch barriers beyond the newly protected swing level,
   * queries the actual Deriv API for live proposal pricing, and determines positive EV viability.
   */
  public static async evaluateBestBarrier(
    symbol: string,
    currentPrice: number,
    direction: TrendDirection,
    tradeableRange: TradeableRange,
    candles2m: Candle[],
    wsManager: DerivWebSocketManager,
    durationMinutes: number = 5
  ): Promise<BarrierProposal | null> {
    const atr = this.calculateATR(candles2m, 14);
    if (atr <= 0) return null;

    const volPerSec = this.calculateRealizedVolPerSec(candles2m);
    const durationSec = durationMinutes * 60;

    // We test multiple ATR multipliers beyond the protected swing level:
    // e.g. 1.2x, 2.0x, 3.0x ATR buffer
    const multipliers = [1.2, 2.0, 3.0];
    const proposals: BarrierProposal[] = [];

    for (const mult of multipliers) {
      const buffer = mult * atr;
      let candidateBarrierLevel: number;
      let barrierOffsetStr: string;
      let barrierDirection: 'ABOVE' | 'BELOW';

      if (direction === 'BULLISH') {
        // In a Bullish setup, the dangerous touch boundary is below the protected swing low.
        // We place a LOWER No Touch barrier safely below the protected low.
        candidateBarrierLevel = tradeableRange.newlyProtectedSwing - buffer;
        const diff = candidateBarrierLevel - currentPrice;
        // In Deriv, lower barrier offset is negative (e.g. "-12.50")
        barrierOffsetStr = diff.toFixed(3);
        barrierDirection = 'BELOW';
      } else {
        // In a Bearish setup, the dangerous touch boundary is above the protected swing high.
        // We place an UPPER No Touch barrier safely above the protected high.
        candidateBarrierLevel = tradeableRange.newlyProtectedSwing + buffer;
        const diff = candidateBarrierLevel - currentPrice;
        // Upper barrier offset is positive (e.g. "+15.20")
        barrierOffsetStr = `+${diff.toFixed(3)}`;
        barrierDirection = 'ABOVE';
      }

      const distance = Math.abs(currentPrice - candidateBarrierLevel);
      // Continuous first-passage touch probability
      const touchProb = PathTouchProbability.calculateTouchRisk(distance, volPerSec, durationSec);
      const survivalProb = 1.0 - touchProb;

      try {
        const prop = await wsManager.getNoTouchProposal(
          symbol,
          barrierOffsetStr,
          durationMinutes,
          10
        );

        const payout = Number(prop.payout);
        const askPrice = Number(prop.ask_price);
        const impliedProb = askPrice / payout;

        // Mathematical Expectation:
        // EV = (P_survival * Payout) - AskPrice
        const expectedValue = survivalProb * payout - askPrice;

        // Viability threshold: Positive EV, and survival probability >= 72%
        const isViable = expectedValue > 0.05 && survivalProb >= 0.72;

        proposals.push({
          contractType: 'NOTOUCH',
          barrier: barrierOffsetStr,
          barrierLevel: candidateBarrierLevel,
          barrierOffset: parseFloat(barrierOffsetStr),
          direction: barrierDirection,
          durationMinutes,
          durationSeconds: durationSec,
          payout,
          askPrice,
          impliedProb,
          pathSurvivalProb: survivalProb,
          expectedValue,
          isViable,
          spotPriceAtQuote: currentPrice
        });
      } catch {
        // Deriv contract unavailable or rejected for this specific barrier offset
        continue;
      }
    }

    if (proposals.length === 0) return null;

    // Filter to viable proposals
    const viableProposals = proposals.filter((p) => p.isViable);
    if (viableProposals.length === 0) {
      // If none met full viability, check if any has positive expectation
      const posEv = proposals.filter((p) => p.expectedValue > 0);
      if (posEv.length > 0) {
        posEv.sort((a, b) => b.pathSurvivalProb - a.pathSurvivalProb);
        return posEv[0];
      }
      return null;
    }

    // Rank by highest survival probability (safety first) with positive expectation
    viableProposals.sort((a, b) => b.pathSurvivalProb - a.pathSurvivalProb);
    return viableProposals[0];
  }
}
