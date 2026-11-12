import { Candle, CandlestickSignal } from '../types/scanner';

export class CandlestickEngine {
  /**
   * Evaluates reversal candlestick patterns on the latest candle relative to previous candles.
   */
  public static evaluate(
    candle: Candle,
    prior1?: Candle,
    prior2?: Candle
  ): CandlestickSignal {
    const totalRange = candle.high - candle.low;
    if (totalRange <= 0) {
      return {
        name: 'NONE',
        direction: 'NEUTRAL',
        epoch: candle.epoch,
        strength: 0,
        rejectionWickRatio: 0,
        bodyRatio: 0,
        description: 'Doji / zero-range candle'
      };
    }

    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;

    const bodyRatio = body / totalRange;
    const lowerWickRatio = lowerWick / totalRange;
    const upperWickRatio = upperWick / totalRange;

    // 1. Hammer / Bullish Pin Bar
    // Long lower wick (>= 58%), small body (<= 32%), closes in upper third
    if (lowerWickRatio >= 0.58 && bodyRatio <= 0.32 && candle.close >= candle.open) {
      return {
        name: lowerWickRatio >= 0.68 ? 'BULLISH_PIN_BAR' : 'HAMMER',
        direction: 'BULLISH',
        epoch: candle.epoch,
        strength: Math.min(1.0, lowerWickRatio + 0.15),
        rejectionWickRatio: lowerWickRatio,
        bodyRatio,
        description: `Bullish rejection with ${(lowerWickRatio * 100).toFixed(0)}% lower wick.`
      };
    }

    // 2. Shooting Star / Bearish Pin Bar
    // Long upper wick (>= 58%), small body (<= 32%), closes in lower third
    if (upperWickRatio >= 0.58 && bodyRatio <= 0.32 && candle.close <= candle.open) {
      return {
        name: upperWickRatio >= 0.68 ? 'BEARISH_PIN_BAR' : 'SHOOTING_STAR',
        direction: 'BEARISH',
        epoch: candle.epoch,
        strength: Math.min(1.0, upperWickRatio + 0.15),
        rejectionWickRatio: upperWickRatio,
        bodyRatio,
        description: `Bearish rejection with ${(upperWickRatio * 100).toFixed(0)}% upper wick.`
      };
    }

    // 3. Strong Bullish Rejection (regardless of candle color, massive lower wick >= 65%)
    if (lowerWickRatio >= 0.65) {
      return {
        name: 'STRONG_BULLISH_REJECTION',
        direction: 'BULLISH',
        epoch: candle.epoch,
        strength: Math.min(1.0, lowerWickRatio + 0.1),
        rejectionWickRatio: lowerWickRatio,
        bodyRatio,
        description: `Strong buy-side absorption with ${(lowerWickRatio * 100).toFixed(0)}% lower wick.`
      };
    }

    // 4. Strong Bearish Rejection (massive upper wick >= 65%)
    if (upperWickRatio >= 0.65) {
      return {
        name: 'STRONG_BEARISH_REJECTION',
        direction: 'BEARISH',
        epoch: candle.epoch,
        strength: Math.min(1.0, upperWickRatio + 0.1),
        rejectionWickRatio: upperWickRatio,
        bodyRatio,
        description: `Strong sell-side absorption with ${(upperWickRatio * 100).toFixed(0)}% upper wick.`
      };
    }

    // 5. Bullish Engulfing
    if (
      prior1 &&
      prior1.close < prior1.open && // prior red
      candle.close > candle.open &&  // current green
      candle.open <= prior1.close && // opens at or below prior close
      candle.close > prior1.open &&  // closes above prior open
      bodyRatio >= 0.60
    ) {
      return {
        name: 'BULLISH_ENGULFING',
        direction: 'BULLISH',
        epoch: candle.epoch,
        strength: 0.88,
        rejectionWickRatio: lowerWickRatio,
        bodyRatio,
        description: 'Bullish engulfing candle covering previous bearish range.'
      };
    }

    // 6. Bearish Engulfing
    if (
      prior1 &&
      prior1.close > prior1.open && // prior green
      candle.close < candle.open &&  // current red
      candle.open >= prior1.close && // opens at or above prior close
      candle.close < prior1.open &&  // closes below prior open
      bodyRatio >= 0.60
    ) {
      return {
        name: 'BEARISH_ENGULFING',
        direction: 'BEARISH',
        epoch: candle.epoch,
        strength: 0.88,
        rejectionWickRatio: upperWickRatio,
        bodyRatio,
        description: 'Bearish engulfing candle covering previous bullish range.'
      };
    }

    // 7. Morning Star (3-candle bullish reversal)
    if (
      prior1 &&
      prior2 &&
      prior2.close < prior2.open && // C1 strong red
      Math.abs(prior1.close - prior1.open) < body * 0.4 && // C2 small doji
      candle.close > candle.open && // C3 strong green
      candle.close > (prior2.open + prior2.close) / 2
    ) {
      return {
        name: 'MORNING_STAR',
        direction: 'BULLISH',
        epoch: candle.epoch,
        strength: 0.90,
        rejectionWickRatio: lowerWickRatio,
        bodyRatio,
        description: 'Morning star 3-candle reversal confirming bottom turn.'
      };
    }

    // 8. Evening Star (3-candle bearish reversal)
    if (
      prior1 &&
      prior2 &&
      prior2.close > prior2.open && // C1 strong green
      Math.abs(prior1.close - prior1.open) < body * 0.4 && // C2 small doji
      candle.close < candle.open && // C3 strong red
      candle.close < (prior2.open + prior2.close) / 2
    ) {
      return {
        name: 'EVENING_STAR',
        direction: 'BEARISH',
        epoch: candle.epoch,
        strength: 0.90,
        rejectionWickRatio: upperWickRatio,
        bodyRatio,
        description: 'Evening star 3-candle reversal confirming top turn.'
      };
    }

    return {
      name: 'NONE',
      direction: 'NEUTRAL',
      epoch: candle.epoch,
      strength: 0,
      rejectionWickRatio: 0,
      bodyRatio,
      description: 'Standard continuation / non-reversal candle.'
    };
  }
}
