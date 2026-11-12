import { Candle, PivotPoint, LiquidityPool, StructuralShift, TrendDirection } from '../types/scanner';

export class MarketStructureEngine {
  /**
   * Identifies fractal swing highs and swing lows using a symmetric rolling window.
   */
  public static findPivots(candles: Candle[], leftLeg: number = 3, rightLeg: number = 3): PivotPoint[] {
    const pivots: PivotPoint[] = [];
    const len = candles.length;
    if (len < leftLeg + rightLeg + 1) return pivots;

    for (let i = leftLeg; i < len - rightLeg; i++) {
      const center = candles[i];
      let isHigh = true;
      let isLow = true;

      for (let j = i - leftLeg; j <= i + rightLeg; j++) {
        if (j === i) continue;
        if (candles[j].high >= center.high) isHigh = false;
        if (candles[j].low <= center.low) isLow = false;
      }

      if (isHigh) {
        pivots.push({
          index: i,
          epoch: center.epoch,
          price: center.high,
          type: 'HIGH',
          isSwept: false
        });
      }
      if (isLow) {
        pivots.push({
          index: i,
          epoch: center.epoch,
          price: center.low,
          type: 'LOW',
          isSwept: false
        });
      }
    }
    return pivots;
  }

  /**
   * Distinguishes a liquidity sweep from a genuine structural break.
   * A liquidity sweep occurs when price wicks beyond a swing level but fails to close beyond it.
   */
  public static evaluateLiquiditySweeps(
    candles: Candle[],
    pivots: PivotPoint[]
  ): { sweeps: LiquidityPool[]; updatedPivots: PivotPoint[] } {
    const sweeps: LiquidityPool[] = [];
    const updated = pivots.map((p) => ({ ...p }));

    for (const p of updated) {
      const followingCandles = candles.filter((c) => c.epoch > p.epoch);

      for (const c of followingCandles) {
        if (p.type === 'LOW') {
          // Sell-side Liquidity: Low went below pivot price, but close remained ABOVE pivot price
          if (c.low < p.price && c.close >= p.price) {
            p.isSwept = true;
            p.sweepEpoch = c.epoch;
            sweeps.push({
              id: `SSL_${p.epoch}`,
              type: 'SELLSIDE',
              priceLevel: p.price,
              epochEstablished: p.epoch,
              swept: true,
              sweptEpoch: c.epoch
            });
            break;
          }
        } else if (p.type === 'HIGH') {
          // Buy-side Liquidity: High went above pivot price, but close remained BELOW pivot price
          if (c.high > p.price && c.close <= p.price) {
            p.isSwept = true;
            p.sweepEpoch = c.epoch;
            sweeps.push({
              id: `BSL_${p.epoch}`,
              type: 'BUYSIDE',
              priceLevel: p.price,
              epochEstablished: p.epoch,
              swept: true,
              sweptEpoch: c.epoch
            });
            break;
          }
        }
      }
    }

    return { sweeps, updatedPivots: updated };
  }

  /**
   * Detects genuine structural shifts (BOS and CHoCH) validated by meaningful candle closes
   * and displacement strength.
   */
  public static detectStructuralShifts(candles: Candle[], pivots: PivotPoint[]): StructuralShift[] {
    const shifts: StructuralShift[] = [];
    if (candles.length < 2 || pivots.length === 0) return shifts;

    const highs = pivots.filter((p) => p.type === 'HIGH');
    const lows = pivots.filter((p) => p.type === 'LOW');
    if (highs.length === 0 || lows.length === 0) return shifts;

    const recentHigh = highs[highs.length - 1];
    const recentLow = lows[lows.length - 1];
    const latestCandle = candles[candles.length - 1];

    // Bullish CHoCH: Candle closes strictly ABOVE meaningful prior swing high with displacement
    if (recentHigh && latestCandle.close > recentHigh.price) {
      const candleBody = Math.abs(latestCandle.close - latestCandle.open);
      const totalRange = latestCandle.high - latestCandle.low;
      const displacement = totalRange > 0 ? candleBody / totalRange : 0;

      // Candle must close strong (at least 55% body of total range)
      if (displacement >= 0.55 && latestCandle.close > latestCandle.open) {
        shifts.push({
          type: 'CHOCH',
          direction: 'BULLISH',
          brokenLevel: recentHigh.price,
          breakEpoch: latestCandle.epoch,
          confirmedByClose: true,
          displacementScore: Math.min(1.0, displacement),
          candleBodyRatio: displacement
        });
      }
    }

    // Bearish CHoCH: Candle closes strictly BELOW meaningful prior swing low with displacement
    if (recentLow && latestCandle.close < recentLow.price) {
      const candleBody = Math.abs(latestCandle.close - latestCandle.open);
      const totalRange = latestCandle.high - latestCandle.low;
      const displacement = totalRange > 0 ? candleBody / totalRange : 0;

      if (displacement >= 0.55 && latestCandle.close < latestCandle.open) {
        shifts.push({
          type: 'CHOCH',
          direction: 'BEARISH',
          brokenLevel: recentLow.price,
          breakEpoch: latestCandle.epoch,
          confirmedByClose: true,
          displacementScore: Math.min(1.0, displacement),
          candleBodyRatio: displacement
        });
      }
    }

    return shifts;
  }

  /**
   * Determines overall directional bias from pivots and recent trend structure.
   */
  public static getDirectionalBias(pivots: PivotPoint[], currentPrice: number): TrendDirection {
    if (pivots.length < 4) return 'NEUTRAL';

    const recent = pivots.slice(-4);
    const highs = recent.filter((p) => p.type === 'HIGH');
    const lows = recent.filter((p) => p.type === 'LOW');

    if (highs.length >= 2 && lows.length >= 2) {
      const higherHigh = highs[highs.length - 1].price > highs[highs.length - 2].price;
      const higherLow = lows[lows.length - 1].price > lows[lows.length - 2].price;

      if (higherHigh && higherLow && currentPrice > lows[lows.length - 1].price) {
        return 'BULLISH';
      }

      const lowerHigh = highs[highs.length - 1].price < highs[highs.length - 2].price;
      const lowerLow = lows[lows.length - 1].price < lows[lows.length - 2].price;

      if (lowerHigh && lowerLow && currentPrice < highs[highs.length - 1].price) {
        return 'BEARISH';
      }
    }

    return 'NEUTRAL';
  }
}
