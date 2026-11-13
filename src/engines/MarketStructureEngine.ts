import {
  Candle,
  PivotPoint,
  LiquidityPool,
  ProtectedSwing,
  StructuralShift,
  TrendDirection,
  MarketCondition
} from '../types/scanner';

export class MarketStructureEngine {
  /**
   * Identifies fractal swing highs and swing lows using a symmetric rolling window
   * and tags HH / HL / LH / LL sequence labels.
   */
  public static findPivots(candles: Candle[], leftLeg: number = 3, rightLeg: number = 3): PivotPoint[] {
    const pivots: PivotPoint[] = [];
    const len = candles.length;
    if (len < leftLeg + rightLeg + 1) return pivots;

    let lastHigh: number | null = null;
    let lastLow: number | null = null;

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
        const tag =
          lastHigh === null
            ? undefined
            : Math.abs(center.high - lastHigh) / lastHigh < 0.0005
            ? 'EQH'
            : center.high > lastHigh
            ? 'HH'
            : 'LH';
        lastHigh = center.high;

        pivots.push({
          index: i,
          epoch: center.epoch,
          price: center.high,
          type: 'HIGH',
          isSwept: false,
          structureTag: tag
        });
      }
      if (isLow) {
        const tag =
          lastLow === null
            ? undefined
            : Math.abs(center.low - lastLow) / lastLow < 0.0005
            ? 'EQL'
            : center.low > lastLow
            ? 'HL'
            : 'LL';
        lastLow = center.low;

        pivots.push({
          index: i,
          epoch: center.epoch,
          price: center.low,
          type: 'LOW',
          isSwept: false,
          structureTag: tag
        });
      }
    }
    return pivots;
  }

  /**
   * Detects Equal Highs (EQH -> BSL) and Equal Lows (EQL -> SSL) liquidity resting levels,
   * plus confirmed liquidity sweeps where price wicks beyond a swing level and closes back inside.
   */
  public static evaluateLiquiditySweeps(
    candles: Candle[],
    pivots: PivotPoint[]
  ): { sweeps: LiquidityPool[]; restingPools: LiquidityPool[]; updatedPivots: PivotPoint[] } {
    const sweeps: LiquidityPool[] = [];
    const restingPools: LiquidityPool[] = [];
    const updated = pivots.map((p) => ({ ...p }));

    const highs = updated.filter((p) => p.type === 'HIGH');
    const lows = updated.filter((p) => p.type === 'LOW');

    // Equal Highs (BSL)
    for (let i = 1; i < highs.length; i++) {
      const prev = highs[i - 1];
      const curr = highs[i];
      if (Math.abs(curr.price - prev.price) / prev.price <= 0.0012) {
        restingPools.push({
          id: `EQH_${curr.epoch}`,
          type: 'BUYSIDE',
          label: 'EQH',
          priceLevel: (prev.price + curr.price) / 2,
          epochEstablished: curr.epoch,
          swept: false
        });
      }
    }

    // Equal Lows (SSL)
    for (let i = 1; i < lows.length; i++) {
      const prev = lows[i - 1];
      const curr = lows[i];
      if (Math.abs(curr.price - prev.price) / prev.price <= 0.0012) {
        restingPools.push({
          id: `EQL_${curr.epoch}`,
          type: 'SELLSIDE',
          label: 'EQL',
          priceLevel: (prev.price + curr.price) / 2,
          epochEstablished: curr.epoch,
          swept: false
        });
      }
    }

    // Add latest unswept external BSL/SSL swing pools
    if (highs.length > 0) {
      const topHigh = highs[highs.length - 1];
      restingPools.push({
        id: `BSL_TOP_${topHigh.epoch}`,
        type: 'BUYSIDE',
        label: 'BSL',
        priceLevel: topHigh.price,
        epochEstablished: topHigh.epoch,
        swept: false
      });
    }
    if (lows.length > 0) {
      const botLow = lows[lows.length - 1];
      restingPools.push({
        id: `SSL_BOT_${botLow.epoch}`,
        type: 'SELLSIDE',
        label: 'SSL',
        priceLevel: botLow.price,
        epochEstablished: botLow.epoch,
        swept: false
      });
    }

    for (const p of updated) {
      const followingCandles = candles.filter((c) => c.epoch > p.epoch);

      for (const c of followingCandles) {
        if (p.type === 'LOW') {
          if (c.low < p.price && c.close >= p.price) {
            p.isSwept = true;
            p.sweepEpoch = c.epoch;
            sweeps.push({
              id: `SSL_${p.epoch}`,
              type: 'SELLSIDE',
              label: p.structureTag === 'EQL' ? 'EQL' : 'SSL',
              priceLevel: p.price,
              epochEstablished: p.epoch,
              swept: true,
              sweptEpoch: c.epoch
            });
            break;
          }
          if (c.close < p.price) break;
        } else if (p.type === 'HIGH') {
          if (c.high > p.price && c.close <= p.price) {
            p.isSwept = true;
            p.sweepEpoch = c.epoch;
            sweeps.push({
              id: `BSL_${p.epoch}`,
              type: 'BUYSIDE',
              label: p.structureTag === 'EQH' ? 'EQH' : 'BSL',
              priceLevel: p.price,
              epochEstablished: p.epoch,
              swept: true,
              sweptEpoch: c.epoch
            });
            break;
          }
          if (c.close > p.price) break;
        }
      }
    }

    return { sweeps, restingPools, updatedPivots: updated };
  }

  /**
   * Scans historical swings and candles to distinguish BOS (continuation) vs CHoCH (reversal)
   * confirmed strictly by candle body close + displacement.
   */
  public static detectAllStructuralShifts(candles: Candle[], pivots: PivotPoint[]): StructuralShift[] {
    const rawBreaks: {
      direction: 'BULLISH' | 'BEARISH';
      brokenLevel: number;
      breakEpoch: number;
      originEpoch: number;
      bodyRatio: number;
    }[] = [];
    if (candles.length < 3 || pivots.length < 2) return [];

    const highs = pivots.filter((p) => p.type === 'HIGH');
    const lows = pivots.filter((p) => p.type === 'LOW');

    for (const h of highs) {
      const breaker = candles.find(
        (c) =>
          c.epoch > h.epoch &&
          c.close > h.price &&
          c.close > c.open &&
          (c.high - c.low > 0 ? Math.abs(c.close - c.open) / (c.high - c.low) >= 0.5 : false)
      );
      if (breaker) {
        const bodyRatio = Math.abs(breaker.close - breaker.open) / Math.max(1e-9, breaker.high - breaker.low);
        rawBreaks.push({
          direction: 'BULLISH',
          brokenLevel: h.price,
          breakEpoch: breaker.epoch,
          originEpoch: h.epoch,
          bodyRatio
        });
      }
    }

    for (const l of lows) {
      const breaker = candles.find(
        (c) =>
          c.epoch > l.epoch &&
          c.close < l.price &&
          c.close < c.open &&
          (c.high - c.low > 0 ? Math.abs(c.close - c.open) / (c.high - c.low) >= 0.5 : false)
      );
      if (breaker) {
        const bodyRatio = Math.abs(breaker.close - breaker.open) / Math.max(1e-9, breaker.high - breaker.low);
        rawBreaks.push({
          direction: 'BEARISH',
          brokenLevel: l.price,
          breakEpoch: breaker.epoch,
          originEpoch: l.epoch,
          bodyRatio
        });
      }
    }

    rawBreaks.sort((a, b) => a.breakEpoch - b.breakEpoch);

    let runningBias: TrendDirection = 'NEUTRAL';
    return rawBreaks.map((brk) => {
      const shiftType: 'BOS' | 'CHOCH' =
        runningBias === brk.direction ? 'BOS' : 'CHOCH';
      runningBias = brk.direction;
      return {
        type: shiftType,
        direction: brk.direction,
        brokenLevel: brk.brokenLevel,
        breakEpoch: brk.breakEpoch,
        originEpoch: brk.originEpoch,
        confirmedByClose: true,
        displacementScore: Math.min(1.0, brk.bodyRatio),
        candleBodyRatio: brk.bodyRatio
      };
    });
  }

  /**
   * Detects recent structural shifts (BOS and CHoCH) on the latest candles/pivots.
   */
  public static detectStructuralShifts(candles: Candle[], pivots: PivotPoint[]): StructuralShift[] {
    const shifts: StructuralShift[] = [];
    if (candles.length < 2 || pivots.length === 0) return shifts;

    const highs = pivots.filter((p) => p.type === 'HIGH');
    const lows = pivots.filter((p) => p.type === 'LOW');
    if (highs.length === 0 || lows.length === 0) return shifts;

    const recentHigh = highs[highs.length - 1];
    const recentLow = lows[lows.length - 1];

    // Check recent 3 closed/active candles for confirmed break beyond latest swing
    const recentCandles = candles.slice(-3);
    const bias = this.getDirectionalBias(pivots, candles[candles.length - 1].close);

    for (const candle of recentCandles) {
      const candleBody = Math.abs(candle.close - candle.open);
      const totalRange = candle.high - candle.low;
      const displacement = totalRange > 0 ? candleBody / totalRange : 0;

      if (recentHigh && candle.epoch >= recentHigh.epoch && candle.close > recentHigh.price) {
        if (displacement >= 0.52 && candle.close > candle.open) {
          shifts.push({
            type: bias === 'BULLISH' ? 'BOS' : 'CHOCH',
            direction: 'BULLISH',
            brokenLevel: recentHigh.price,
            breakEpoch: candle.epoch,
            originEpoch: recentHigh.epoch,
            confirmedByClose: true,
            displacementScore: Math.min(1.0, displacement),
            candleBodyRatio: displacement
          });
        }
      }

      if (recentLow && candle.epoch >= recentLow.epoch && candle.close < recentLow.price) {
        if (displacement >= 0.52 && candle.close < candle.open) {
          shifts.push({
            type: bias === 'BEARISH' ? 'BOS' : 'CHOCH',
            direction: 'BEARISH',
            brokenLevel: recentLow.price,
            breakEpoch: candle.epoch,
            originEpoch: recentLow.epoch,
            confirmedByClose: true,
            displacementScore: Math.min(1.0, displacement),
            candleBodyRatio: displacement
          });
        }
      }
    }

    if (shifts.length > 0) return shifts;

    // Fallback to historical structural shifts if latest candle broke earlier swing
    return this.detectAllStructuralShifts(candles, pivots).slice(-3);
  }

  /**
   * Determines overall directional bias from pivots and recent trend structure.
   */
  public static getDirectionalBias(pivots: PivotPoint[], currentPrice: number): TrendDirection {
    if (pivots.length < 4) return 'NEUTRAL';

    const recent = pivots.slice(-6);
    const highs = recent.filter((p) => p.type === 'HIGH');
    const lows = recent.filter((p) => p.type === 'LOW');

    if (highs.length >= 2 && lows.length >= 2) {
      const hLast = highs[highs.length - 1].price;
      const hPrev = highs[highs.length - 2].price;
      const lLast = lows[lows.length - 1].price;
      const lPrev = lows[lows.length - 2].price;

      const higherHigh = hLast > hPrev;
      const higherLow = lLast > lPrev;
      if (higherHigh && higherLow && currentPrice >= lLast) {
        return 'BULLISH';
      }

      const lowerHigh = hLast < hPrev;
      const lowerLow = lLast < lPrev;
      if (lowerHigh && lowerLow && currentPrice <= hLast) {
        return 'BEARISH';
      }

      // Transition bias if price closed beyond last pivot strongly
      if (currentPrice > hLast && lLast >= lPrev * 0.999) return 'BULLISH';
      if (currentPrice < lLast && hLast <= hPrev * 1.001) return 'BEARISH';
    }

    return 'NEUTRAL';
  }

  /**
   * Classifies market condition explicitly into:
   * UPTRENDING, DOWNTRENDING, CONSOLIDATING, REVERSING, or UNCLEAR.
   */
  public static classifyMarketCondition(
    candles: Candle[],
    pivots: PivotPoint[],
    shifts?: StructuralShift[]
  ): MarketCondition {
    if (candles.length < 10 || pivots.length < 3) return 'UNCLEAR';

    const latest = candles[candles.length - 1];
    const recentShifts = shifts ?? this.detectAllStructuralShifts(candles, pivots);
    const latestShift = recentShifts.length > 0 ? recentShifts[recentShifts.length - 1] : null;
    const prevShift = recentShifts.length > 1 ? recentShifts[recentShifts.length - 2] : null;

    // 1. Check for erratic whipsaw / unclear conflicting structure
    if (
      latestShift &&
      prevShift &&
      latestShift.direction !== prevShift.direction &&
      candles.findIndex((c) => c.epoch === latestShift.breakEpoch) >= candles.length - 3 &&
      candles.findIndex((c) => c.epoch === prevShift.breakEpoch) >= candles.length - 6
    ) {
      return 'UNCLEAR';
    }

    const bias = this.getDirectionalBias(pivots, latest.close);

    // 2. Reversing: recent confirmed CHoCH against prior structure
    if (latestShift && latestShift.type === 'CHOCH' && latestShift.confirmedByClose) {
      const shiftAgeBars = candles.length - 1 - candles.findIndex((c) => c.epoch === latestShift.breakEpoch);
      if (shiftAgeBars >= 0 && shiftAgeBars <= 6) {
        return 'REVERSING';
      }
    }

    // 3. Clear Uptrend or Downtrend
    if (bias === 'BULLISH') return 'UPTRENDING';
    if (bias === 'BEARISH') return 'DOWNTRENDING';

    // 4. Consolidating: bounded swing highs & lows without runaway chop
    const highs = pivots.filter((p) => p.type === 'HIGH').slice(-3);
    const lows = pivots.filter((p) => p.type === 'LOW').slice(-3);
    if (highs.length >= 2 && lows.length >= 2) {
      const maxH = Math.max(...highs.map((h) => h.price));
      const minL = Math.min(...lows.map((l) => l.price));
      const rangeSpan = maxH - minL;
      if (
        rangeSpan > 0 &&
        latest.close <= maxH * 1.002 &&
        latest.close >= minL * 0.998
      ) {
        return 'CONSOLIDATING';
      }
    }

    return 'UNCLEAR';
  }

  /**
   * Identifies the active unbroken Protected Swing High and Protected Swing Low
   * from genuine market structure, updating automatically when a close breaks them.
   */
  public static identifyProtectedSwings(
    candles: Candle[],
    pivots: PivotPoint[],
    shifts?: StructuralShift[]
  ): { protectedHigh: ProtectedSwing | null; protectedLow: ProtectedSwing | null } {
    if (candles.length < 5 || pivots.length === 0) {
      return { protectedHigh: null, protectedLow: null };
    }

    const recentShifts = shifts ?? this.detectAllStructuralShifts(candles, pivots);
    const highs = pivots.filter((p) => p.type === 'HIGH');
    const lows = pivots.filter((p) => p.type === 'LOW');

    // A swing high remains protected until a subsequent candle body closes above it
    let protectedHigh: ProtectedSwing | null = null;
    for (let i = highs.length - 1; i >= 0; i--) {
      const h = highs[i];
      const broken = candles.some((c) => c.epoch > h.epoch && c.close > h.price);
      if (!broken) {
        protectedHigh = {
          type: 'HIGH',
          price: h.price,
          epoch: h.epoch,
          label: `Protected High`
        };
        break;
      }
    }

    // If the most recent bearish shift originated from a slightly earlier unbroken high, prefer that structural origin
    const latestBearShift = [...recentShifts].reverse().find((s) => s.direction === 'BEARISH');
    if (latestBearShift && latestBearShift.originEpoch) {
      const originHigh = highs.find((h) => h.epoch >= (latestBearShift.originEpoch || 0));
      if (originHigh && !candles.some((c) => c.epoch > originHigh.epoch && c.close > originHigh.price)) {
        protectedHigh = {
          type: 'HIGH',
          price: originHigh.price,
          epoch: originHigh.epoch,
          label: `Protected High`
        };
      }
    }

    // A swing low remains protected until a subsequent candle body closes below it
    let protectedLow: ProtectedSwing | null = null;
    for (let i = lows.length - 1; i >= 0; i--) {
      const l = lows[i];
      const broken = candles.some((c) => c.epoch > l.epoch && c.close < l.price);
      if (!broken) {
        protectedLow = {
          type: 'LOW',
          price: l.price,
          epoch: l.epoch,
          label: `Protected Low`
        };
        break;
      }
    }

    const latestBullShift = [...recentShifts].reverse().find((s) => s.direction === 'BULLISH');
    if (latestBullShift && latestBullShift.originEpoch) {
      const originLow = lows.find((l) => l.epoch >= (latestBullShift.originEpoch || 0));
      if (originLow && !candles.some((c) => c.epoch > originLow.epoch && c.close < originLow.price)) {
        protectedLow = {
          type: 'LOW',
          price: originLow.price,
          epoch: originLow.epoch,
          label: `Protected Low`
        };
      }
    }

    return { protectedHigh, protectedLow };
  }
}
