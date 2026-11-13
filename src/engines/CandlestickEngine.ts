import {
  Candle,
  CandlestickSignal,
  CandlestickAnnotation,
  MomentumAssessment,
  MomentumClassification,
  TrendDirection
} from '../types/scanner';

export interface CandlestickContext {
  supportLevel?: number;
  resistanceLevel?: number;
  atr?: number;
}

export class CandlestickEngine {
  /**
   * Evaluates reversal, breakout, momentum, and containment candlestick patterns
   * using candle closes and structural context (not candle names alone).
   */
  public static evaluate(
    candle: Candle,
    prior1?: Candle,
    prior2?: Candle,
    context?: CandlestickContext
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

    // 0A. Contextual Breakout & Failed Breakout Candles
    if (context?.resistanceLevel && prior1) {
      const res = context.resistanceLevel;
      if (
        prior1.close <= res &&
        candle.close > res &&
        candle.close > candle.open &&
        bodyRatio >= 0.56
      ) {
        return {
          name: 'BREAKOUT_BULLISH',
          direction: 'BULLISH',
          epoch: candle.epoch,
          strength: 0.92,
          rejectionWickRatio: lowerWickRatio,
          bodyRatio,
          description: `Decisive bullish breakout candle closed above resistance ${res.toFixed(2)}.`
        };
      }
      if (
        candle.high > res &&
        candle.close < res &&
        upperWickRatio >= 0.38
      ) {
        return {
          name: 'FAILED_BREAKOUT_BEARISH',
          direction: 'BEARISH',
          epoch: candle.epoch,
          strength: 0.9,
          rejectionWickRatio: upperWickRatio,
          bodyRatio,
          description: `Failed bullish breakout (bull trap) closing back beneath resistance ${res.toFixed(2)}.`
        };
      }
    }

    if (context?.supportLevel && prior1) {
      const sup = context.supportLevel;
      if (
        prior1.close >= sup &&
        candle.close < sup &&
        candle.close < candle.open &&
        bodyRatio >= 0.56
      ) {
        return {
          name: 'BREAKOUT_BEARISH',
          direction: 'BEARISH',
          epoch: candle.epoch,
          strength: 0.92,
          rejectionWickRatio: upperWickRatio,
          bodyRatio,
          description: `Decisive bearish breakdown candle closed below support ${sup.toFixed(2)}.`
        };
      }
      if (
        candle.low < sup &&
        candle.close > sup &&
        lowerWickRatio >= 0.38
      ) {
        return {
          name: 'FAILED_BREAKOUT_BULLISH',
          direction: 'BULLISH',
          epoch: candle.epoch,
          strength: 0.9,
          rejectionWickRatio: lowerWickRatio,
          bodyRatio,
          description: `Failed breakdown (bear trap) reclaiming support ${sup.toFixed(2)} on candle close.`
        };
      }
    }

    // 1. Hammer / Bullish Pin Bar
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

    // 3. Strong Bullish Rejection
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

    // 4. Strong Bearish Rejection
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

    // 5. Bullish & Bearish Engulfing
    if (
      prior1 &&
      prior1.close < prior1.open &&
      candle.close > candle.open &&
      candle.open <= prior1.close &&
      candle.close > prior1.open &&
      bodyRatio >= 0.58
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

    if (
      prior1 &&
      prior1.close > prior1.open &&
      candle.close < candle.open &&
      candle.open >= prior1.close &&
      candle.close < prior1.open &&
      bodyRatio >= 0.58
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

    // 6. Tweezer Tops & Tweezer Bottoms
    if (prior1) {
      const avgLevel = (candle.high + prior1.high) / 2;
      if (
        Math.abs(candle.high - prior1.high) / Math.max(1e-9, avgLevel) <= 0.0005 &&
        prior1.close > prior1.open &&
        candle.close < candle.open &&
        bodyRatio >= 0.4
      ) {
        return {
          name: 'TWEEZER_TOP',
          direction: 'BEARISH',
          epoch: candle.epoch,
          strength: 0.84,
          rejectionWickRatio: upperWickRatio,
          bodyRatio,
          description: 'Tweezer Top matching prior high followed by bearish close.'
        };
      }
      const avgLow = (candle.low + prior1.low) / 2;
      if (
        Math.abs(candle.low - prior1.low) / Math.max(1e-9, avgLow) <= 0.0005 &&
        prior1.close < prior1.open &&
        candle.close > candle.open &&
        bodyRatio >= 0.4
      ) {
        return {
          name: 'TWEEZER_BOTTOM',
          direction: 'BULLISH',
          epoch: candle.epoch,
          strength: 0.84,
          rejectionWickRatio: lowerWickRatio,
          bodyRatio,
          description: 'Tweezer Bottom matching prior low followed by bullish close.'
        };
      }
    }

    // 7. Morning Star & Evening Star
    if (
      prior1 &&
      prior2 &&
      prior2.close < prior2.open &&
      Math.abs(prior1.close - prior1.open) < body * 0.45 &&
      candle.close > candle.open &&
      candle.close > (prior2.open + prior2.close) / 2
    ) {
      return {
        name: 'MORNING_STAR',
        direction: 'BULLISH',
        epoch: candle.epoch,
        strength: 0.9,
        rejectionWickRatio: lowerWickRatio,
        bodyRatio,
        description: 'Morning star 3-candle reversal confirming bottom turn.'
      };
    }

    if (
      prior1 &&
      prior2 &&
      prior2.close > prior2.open &&
      Math.abs(prior1.close - prior1.open) < body * 0.45 &&
      candle.close < candle.open &&
      candle.close < (prior2.open + prior2.close) / 2
    ) {
      return {
        name: 'EVENING_STAR',
        direction: 'BEARISH',
        epoch: candle.epoch,
        strength: 0.9,
        rejectionWickRatio: upperWickRatio,
        bodyRatio,
        description: 'Evening star 3-candle reversal confirming top turn.'
      };
    }

    // 8. Outside Bar & Inside Bar
    if (
      prior1 &&
      candle.high > prior1.high &&
      candle.low < prior1.low &&
      bodyRatio >= 0.48
    ) {
      const dir: TrendDirection =
        candle.close > prior1.high ? 'BULLISH' : candle.close < prior1.low ? 'BEARISH' : 'NEUTRAL';
      if (dir !== 'NEUTRAL') {
        return {
          name: 'OUTSIDE_BAR',
          direction: dir,
          epoch: candle.epoch,
          strength: 0.82,
          rejectionWickRatio: dir === 'BULLISH' ? lowerWickRatio : upperWickRatio,
          bodyRatio,
          description: `Outside Bar closing decisively ${dir === 'BULLISH' ? 'above prior high' : 'below prior low'}.`
        };
      }
    }

    if (prior1 && candle.high <= prior1.high && candle.low >= prior1.low) {
      return {
        name: 'INSIDE_BAR',
        direction: 'NEUTRAL',
        epoch: candle.epoch,
        strength: 0.55,
        rejectionWickRatio: Math.max(upperWickRatio, lowerWickRatio),
        bodyRatio,
        description: 'Inside Bar consolidation within prior candle range — awaiting breakout close.'
      };
    }

    // 9. Strong Momentum Candles
    const atrOk = !context?.atr || context.atr <= 0 || totalRange >= context.atr * 1.1;
    if (bodyRatio >= 0.72 && atrOk) {
      if (candle.close > candle.open && upperWickRatio <= 0.16) {
        return {
          name: 'MOMENTUM_BULLISH',
          direction: 'BULLISH',
          epoch: candle.epoch,
          strength: 0.8,
          rejectionWickRatio: lowerWickRatio,
          bodyRatio,
          description: `Strong bullish momentum candle (${(bodyRatio * 100).toFixed(0)}% body) closing near high.`
        };
      }
      if (candle.close < candle.open && lowerWickRatio <= 0.16) {
        return {
          name: 'MOMENTUM_BEARISH',
          direction: 'BEARISH',
          epoch: candle.epoch,
          strength: 0.8,
          rejectionWickRatio: upperWickRatio,
          bodyRatio,
          description: `Strong bearish momentum candle (${(bodyRatio * 100).toFixed(0)}% body) closing near low.`
        };
      }
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

  /**
   * Scans recent candles to produce chart annotations for valid candlestick patterns.
   */
  public static scanRecentPatterns(
    candles: Candle[],
    maxLookback: number = 60
  ): CandlestickAnnotation[] {
    const results: CandlestickAnnotation[] = [];
    const start = Math.max(2, candles.length - maxLookback);

    const shortMap: Record<string, string> = {
      HAMMER: 'Hammer',
      SHOOTING_STAR: 'Shooting Star',
      BULLISH_ENGULFING: 'Bull Engulf',
      BEARISH_ENGULFING: 'Bear Engulf',
      BULLISH_PIN_BAR: 'Bull Pin',
      BEARISH_PIN_BAR: 'Bear Pin',
      MORNING_STAR: 'Morning Star',
      EVENING_STAR: 'Evening Star',
      STRONG_BULLISH_REJECTION: 'Bull Rej',
      STRONG_BEARISH_REJECTION: 'Bear Rej',
      TWEEZER_BOTTOM: 'Tweezer Bot',
      TWEEZER_TOP: 'Tweezer Top',
      OUTSIDE_BAR: 'Outside Bar',
      INSIDE_BAR: 'Inside Bar',
      MOMENTUM_BULLISH: 'Bull Mom',
      MOMENTUM_BEARISH: 'Bear Mom',
      BREAKOUT_BULLISH: 'Bull Break',
      BREAKOUT_BEARISH: 'Bear Break',
      FAILED_BREAKOUT_BULLISH: 'Bear Trap',
      FAILED_BREAKOUT_BEARISH: 'Bull Trap'
    };

    for (let i = start; i < candles.length; i++) {
      const sig = this.evaluate(candles[i], candles[i - 1], candles[i - 2]);
      if (sig.name !== 'NONE' && sig.strength >= 0.72) {
        results.push({
          epoch: sig.epoch,
          name: sig.name,
          shortLabel: shortMap[sig.name] || sig.name,
          direction: sig.direction,
          price: sig.direction === 'BULLISH' ? candles[i].low : candles[i].high,
          strength: sig.strength
        });
      }
    }
    return results.slice(-8);
  }

  /**
   * Mandatory Momentum Engine:
   * Evaluates decisive candle closes, strong candle bodies, displacement vs ATR,
   * reduced opposing wicks, and multi-candle directional follow-through.
   */
  public static evaluateMomentum(
    candles: Candle[],
    direction: TrendDirection,
    atr: number
  ): MomentumAssessment {
    if (candles.length < 4 || direction === 'NEUTRAL') {
      return {
        passed: false,
        classification: 'WEAK',
        direction,
        score: 0,
        avgBodyRatio: 0,
        opposingWickRatio: 1,
        displacementMultiple: 0,
        followThroughCandles: 0,
        decisiveClose: false,
        reason: 'Insufficient directional bars to classify momentum (Weak).'
      };
    }

    const recent3 = candles.slice(-3);
    const latest = recent3[recent3.length - 1];
    const prev = recent3[recent3.length - 2];

    let bodyRatioSum = 0;
    let opposingWickMax = 0;
    let followThrough = 0;

    for (const c of recent3) {
      const range = Math.max(1e-9, c.high - c.low);
      const body = Math.abs(c.close - c.open);
      const bodyRatio = body / range;

      const isAligned = direction === 'BULLISH' ? c.close > c.open : c.close < c.open;
      if (isAligned) {
        followThrough++;
        bodyRatioSum += bodyRatio;
        const opposingWick =
          direction === 'BULLISH'
            ? c.high - c.close
            : c.close - c.low;
        opposingWickMax = Math.max(opposingWickMax, opposingWick / range);
      }
    }

    const avgBodyRatio = followThrough > 0 ? bodyRatioSum / followThrough : 0;

    const latestRange = Math.max(1e-9, latest.high - latest.low);
    const latestBody = Math.abs(latest.close - latest.open);
    const latestAligned =
      direction === 'BULLISH' ? latest.close > latest.open : latest.close < latest.open;

    const decisiveClose =
      latestAligned &&
      (direction === 'BULLISH'
        ? (latest.high - latest.close) / latestRange <= 0.30
        : (latest.close - latest.low) / latestRange <= 0.30);

    const prevRange = Math.max(1e-9, prev.high - prev.low);
    const prevAligned =
      direction === 'BULLISH' ? prev.close > prev.open : prev.close < prev.open;
    const prevDecisive =
      prevAligned &&
      (direction === 'BULLISH'
        ? (prev.high - prev.close) / prevRange <= 0.30
        : (prev.close - prev.low) / prevRange <= 0.30);

    const effectiveBody = Math.max(latestBody, prevAligned ? Math.abs(prev.close - prev.open) : 0);
    const displacementMultiple = atr > 0 ? effectiveBody / atr : 1.0;

    const hasDecisiveClose = decisiveClose || prevDecisive;
    const strongBodies = avgBodyRatio >= 0.54;
    const lowOpposingWick = opposingWickMax <= 0.32;
    const hasDisplacement = displacementMultiple >= 0.90;
    const hasFollowThrough = followThrough >= 2;

    let score = 0;
    if (hasDecisiveClose) score += 25;
    if (strongBodies) score += 25;
    if (lowOpposingWick) score += 20;
    if (hasDisplacement) score += 15;
    if (hasFollowThrough) score += 15;

    let classification: MomentumClassification;
    if (score >= 80 && hasDecisiveClose && strongBodies) {
      classification = 'STRONG';
    } else if (score >= 55 && hasFollowThrough) {
      classification = 'MODERATE';
    } else if (score >= 30 || latestAligned) {
      classification = 'DEVELOPING';
    } else {
      classification = 'WEAK';
    }

    const passed = classification === 'STRONG' || classification === 'MODERATE';

    const reason = `${classification} ${direction.toLowerCase()} momentum (${score}/100): ${followThrough}/3 bars, ${(avgBodyRatio * 100).toFixed(0)}% avg body, ${displacementMultiple.toFixed(2)}x ATR.`;

    return {
      passed,
      classification,
      direction,
      score,
      avgBodyRatio,
      opposingWickRatio: opposingWickMax,
      displacementMultiple,
      followThroughCandles: followThrough,
      decisiveClose: hasDecisiveClose,
      reason
    };
  }
}
