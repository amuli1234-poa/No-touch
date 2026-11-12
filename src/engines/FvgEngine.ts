import { Candle, FVG, Timeframe } from '../types/scanner';

export class FvgEngine {
  /**
   * Scans series for valid 3-candle Fair Value Gaps.
   * Filters out insignificant candle noise by requiring displacement on candle 2.
   */
  public static scan(
    candles: Candle[],
    timeframe: Timeframe,
    minDisplacementPct: number = 0.0003 // 0.03% min gap size
  ): FVG[] {
    const fvgs: FVG[] = [];
    if (candles.length < 3) return fvgs;

    for (let i = 2; i < candles.length; i++) {
      const c1 = candles[i - 2];
      const c2 = candles[i - 1]; // Imbalance candle
      const c3 = candles[i];

      const c2Body = Math.abs(c2.close - c2.open);
      const c2Total = c2.high - c2.low;
      const displacementRatio = c2Total > 0 ? c2Body / c2Total : 0;

      // Require displacement candle to have solid body (at least 55% body ratio)
      if (displacementRatio < 0.55) continue;

      const subsequentCandles = candles.slice(i + 1);

      // Bullish FVG: Candle 3 Low > Candle 1 High
      if (c3.low > c1.high) {
        const gapSize = c3.low - c1.high;
        const gapPct = gapSize / c2.close;

        if (gapPct >= minDisplacementPct) {
          const midpoint = c1.high + gapSize / 2;
          const { fillPct, fullyFilled, partiallyFilled } = this.calculateMitigation(
            'BULLISH',
            c1.high,
            c3.low,
            subsequentCandles
          );

          fvgs.push({
            id: `FVG_BULL_${timeframe}_${c2.epoch}`,
            timeframe,
            direction: 'BULLISH',
            candle1Epoch: c1.epoch,
            candle2Epoch: c2.epoch,
            candle3Epoch: c3.epoch,
            upperBoundary: c3.low,
            lowerBoundary: c1.high,
            midpoint,
            size: gapSize,
            sizePercent: gapPct * 100,
            displacementPips: c2Body,
            partialFilled: partiallyFilled,
            fillPercentage: fillPct,
            completelyFilled: fullyFilled,
            fresh: fillPct === 0
          });
        }
      }

      // Bearish FVG: Candle 3 High < Candle 1 Low
      if (c3.high < c1.low) {
        const gapSize = c1.low - c3.high;
        const gapPct = gapSize / c2.close;

        if (gapPct >= minDisplacementPct) {
          const midpoint = c3.high + gapSize / 2;
          const { fillPct, fullyFilled, partiallyFilled } = this.calculateMitigation(
            'BEARISH',
            c3.high,
            c1.low,
            subsequentCandles
          );

          fvgs.push({
            id: `FVG_BEAR_${timeframe}_${c2.epoch}`,
            timeframe,
            direction: 'BEARISH',
            candle1Epoch: c1.epoch,
            candle2Epoch: c2.epoch,
            candle3Epoch: c3.epoch,
            upperBoundary: c1.low,
            lowerBoundary: c3.high,
            midpoint,
            size: gapSize,
            sizePercent: gapPct * 100,
            displacementPips: c2Body,
            partialFilled: partiallyFilled,
            fillPercentage: fillPct,
            completelyFilled: fullyFilled,
            fresh: fillPct === 0
          });
        }
      }
    }

    return fvgs;
  }

  /**
   * Tracks how deep subsequent candles penetrated into the imbalance.
   */
  private static calculateMitigation(
    direction: 'BULLISH' | 'BEARISH',
    lowerBound: number,
    upperBound: number,
    subsequent: Candle[]
  ): { fillPct: number; fullyFilled: boolean; partiallyFilled: boolean } {
    const totalHeight = upperBound - lowerBound;
    if (totalHeight <= 0 || subsequent.length === 0) {
      return { fillPct: 0, fullyFilled: false, partiallyFilled: false };
    }

    let maxPenetration = 0;

    for (const c of subsequent) {
      if (direction === 'BULLISH') {
        if (c.low < upperBound) {
          const depth = upperBound - Math.max(c.low, lowerBound);
          if (depth > maxPenetration) maxPenetration = depth;
        }
        if (c.low <= lowerBound) {
          return { fillPct: 100, fullyFilled: true, partiallyFilled: true };
        }
      } else {
        if (c.high > lowerBound) {
          const depth = Math.min(c.high, upperBound) - lowerBound;
          if (depth > maxPenetration) maxPenetration = depth;
        }
        if (c.high >= upperBound) {
          return { fillPct: 100, fullyFilled: true, partiallyFilled: true };
        }
      }
    }

    const fillPct = Math.min(100, Math.round((maxPenetration / totalHeight) * 100));
    return {
      fillPct,
      fullyFilled: fillPct >= 100,
      partiallyFilled: fillPct > 0
    };
  }
}
