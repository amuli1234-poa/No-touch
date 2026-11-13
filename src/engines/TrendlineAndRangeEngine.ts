import {
  Candle,
  FVG,
  MarketCondition,
  OrderBlock,
  PivotPoint,
  SupportResistanceZone,
  Timeframe,
  TradeableRangeBox,
  Trendline
} from '../types/scanner';
import { MarketStructureEngine } from './MarketStructureEngine';

export class TrendlineAndRangeEngine {
  /**
   * Detects valid bullish (ascending support), bearish (descending resistance), and horizontal
   * trendlines along with live bounce, breakout, and retest events.
   */
  public static detectTrendlines(
    candles: Candle[],
    pivots: PivotPoint[],
    timeframe: Timeframe
  ): Trendline[] {
    const trendlines: Trendline[] = [];
    if (candles.length < 15 || pivots.length < 4) return trendlines;

    const latestCandle = candles[candles.length - 1];
    const recent3Epochs = new Set(candles.slice(-3).map((c) => c.epoch));
    const lows = pivots.filter((p) => p.type === 'LOW').slice(-6);
    const highs = pivots.filter((p) => p.type === 'HIGH').slice(-6);

    // 1. Ascending (Bullish) Trendlines
    for (let i = 0; i < lows.length - 1; i++) {
      const p1 = lows[i];
      const p2 = lows[lows.length - 1];
      if (p2.price <= p1.price || p2.epoch <= p1.epoch) continue;

      const slope = (p2.price - p1.price) / (p2.epoch - p1.epoch);
      let touches = 2;
      let broken = false;
      let breakEpoch = 0;
      let falseBreakout = false;
      let retested = false;
      let bouncedRecently = false;

      const spanCandles = candles.filter((c) => c.epoch > p1.epoch);
      for (const c of spanCandles) {
        const linePrice = p1.price + slope * (c.epoch - p1.epoch);
        const tol = linePrice * 0.0013;

        if (!broken && c.epoch > p2.epoch && Math.abs(c.low - linePrice) <= tol && c.close > linePrice) {
          touches++;
          retested = true;
          if (recent3Epochs.has(c.epoch)) bouncedRecently = true;
        }
        if (!broken && c.low < linePrice - tol && c.close >= linePrice) {
          falseBreakout = true;
          if (recent3Epochs.has(c.epoch)) bouncedRecently = true;
        }
        if (!broken && c.close < linePrice - tol * 1.5) {
          broken = true;
          breakEpoch = c.epoch;
        } else if (broken && c.high >= linePrice - tol && c.close <= linePrice + tol * 0.5) {
          retested = true;
        }
      }

      const projectedEndPrice = p1.price + slope * (latestCandle.epoch - p1.epoch);
      if (!broken) {
        trendlines.push({
          id: `TL_BULL_${timeframe}_${p1.epoch}_${p2.epoch}`,
          timeframe,
          direction: 'BULLISH',
          startEpoch: p1.epoch,
          startPrice: p1.price,
          endEpoch: latestCandle.epoch,
          endPrice: projectedEndPrice,
          touches,
          broken: false,
          retested,
          falseBreakout,
          event: bouncedRecently ? 'BOUNCE' : retested ? 'RETEST' : 'INTACT',
          slopePerSecond: slope
        });
        break;
      } else if (recent3Epochs.has(breakEpoch) || retested) {
        trendlines.push({
          id: `TL_BULL_BRK_${timeframe}_${p1.epoch}_${p2.epoch}`,
          timeframe,
          direction: 'BULLISH',
          startEpoch: p1.epoch,
          startPrice: p1.price,
          endEpoch: latestCandle.epoch,
          endPrice: projectedEndPrice,
          touches,
          broken: true,
          retested,
          falseBreakout,
          event: retested ? 'RETEST' : 'BREAKOUT',
          slopePerSecond: slope
        });
        break;
      }
    }

    // 2. Descending (Bearish) Trendlines
    for (let i = 0; i < highs.length - 1; i++) {
      const p1 = highs[i];
      const p2 = highs[highs.length - 1];
      if (p2.price >= p1.price || p2.epoch <= p1.epoch) continue;

      const slope = (p2.price - p1.price) / (p2.epoch - p1.epoch);
      let touches = 2;
      let broken = false;
      let breakEpoch = 0;
      let falseBreakout = false;
      let retested = false;
      let bouncedRecently = false;

      const spanCandles = candles.filter((c) => c.epoch > p1.epoch);
      for (const c of spanCandles) {
        const linePrice = p1.price + slope * (c.epoch - p1.epoch);
        const tol = linePrice * 0.0013;

        if (!broken && c.epoch > p2.epoch && Math.abs(c.high - linePrice) <= tol && c.close < linePrice) {
          touches++;
          retested = true;
          if (recent3Epochs.has(c.epoch)) bouncedRecently = true;
        }
        if (!broken && c.high > linePrice + tol && c.close <= linePrice) {
          falseBreakout = true;
          if (recent3Epochs.has(c.epoch)) bouncedRecently = true;
        }
        if (!broken && c.close > linePrice + tol * 1.5) {
          broken = true;
          breakEpoch = c.epoch;
        } else if (broken && c.low <= linePrice + tol && c.close >= linePrice - tol * 0.5) {
          retested = true;
        }
      }

      const projectedEndPrice = p1.price + slope * (latestCandle.epoch - p1.epoch);
      if (!broken) {
        trendlines.push({
          id: `TL_BEAR_${timeframe}_${p1.epoch}_${p2.epoch}`,
          timeframe,
          direction: 'BEARISH',
          startEpoch: p1.epoch,
          startPrice: p1.price,
          endEpoch: latestCandle.epoch,
          endPrice: projectedEndPrice,
          touches,
          broken: false,
          retested,
          falseBreakout,
          event: bouncedRecently ? 'BOUNCE' : retested ? 'RETEST' : 'INTACT',
          slopePerSecond: slope
        });
        break;
      } else if (recent3Epochs.has(breakEpoch) || retested) {
        trendlines.push({
          id: `TL_BEAR_BRK_${timeframe}_${p1.epoch}_${p2.epoch}`,
          timeframe,
          direction: 'BEARISH',
          startEpoch: p1.epoch,
          startPrice: p1.price,
          endEpoch: latestCandle.epoch,
          endPrice: projectedEndPrice,
          touches,
          broken: true,
          retested,
          falseBreakout,
          event: retested ? 'RETEST' : 'BREAKOUT',
          slopePerSecond: slope
        });
        break;
      }
    }

    // 3. Horizontal Trendlines (Flat structural ceilings / floors)
    const findHorizontal = (pts: PivotPoint[], isHigh: boolean) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[pts.length - 1];
        if (p2.index - p1.index < 5) continue;
        const diffPct = Math.abs(p2.price - p1.price) / Math.max(1e-9, p1.price);
        if (diffPct > 0.0014) continue;

        const level = (p1.price + p2.price) / 2;
        const tol = level * 0.0013;
        let broken = false;
        let breakEpoch = 0;
        let bouncedRecently = false;

        for (const c of candles.filter((bar) => bar.epoch > p2.epoch)) {
          if (isHigh) {
            if (Math.abs(c.high - level) <= tol && c.close < level && recent3Epochs.has(c.epoch)) {
              bouncedRecently = true;
            }
            if (c.close > level + tol * 1.2) {
              broken = true;
              breakEpoch = c.epoch;
              break;
            }
          } else {
            if (Math.abs(c.low - level) <= tol && c.close > level && recent3Epochs.has(c.epoch)) {
              bouncedRecently = true;
            }
            if (c.close < level - tol * 1.2) {
              broken = true;
              breakEpoch = c.epoch;
              break;
            }
          }
        }

        if (!broken || recent3Epochs.has(breakEpoch)) {
          trendlines.push({
            id: `TL_HORIZ_${isHigh ? 'H' : 'L'}_${timeframe}_${p1.epoch}_${p2.epoch}`,
            timeframe,
            direction: 'HORIZONTAL',
            startEpoch: p1.epoch,
            startPrice: level,
            endEpoch: latestCandle.epoch,
            endPrice: level,
            touches: 2,
            broken,
            retested: false,
            falseBreakout: false,
            event: broken ? 'BREAKOUT' : bouncedRecently ? 'BOUNCE' : 'INTACT',
            slopePerSecond: 0
          });
          break;
        }
      }
    };

    findHorizontal(highs, true);
    findHorizontal(lows, false);

    return trendlines;
  }

  /**
   * Mandatory Valid Trading Range Validator (M15 structural range + POIs inside/retesting range).
   * Rejects unclear, compressed, or POI-empty trading ranges.
   */
  public static validateTradingRange(params: {
    c15m: Candle[];
    pivots15m: PivotPoint[];
    currentPrice: number;
    atr15m: number;
    m15Zones: SupportResistanceZone[];
    m15OrderBlocks: OrderBlock[];
    m15Fvgs: FVG[];
    h1Zones?: SupportResistanceZone[];
  }): TradeableRangeBox {
    const {
      c15m,
      pivots15m,
      currentPrice,
      atr15m,
      m15Zones,
      m15OrderBlocks,
      m15Fvgs,
      h1Zones = []
    } = params;

    if (c15m.length < 10) {
      return {
        timeframe: '15m',
        isValid: false,
        invalidReason: 'Insufficient M15 candles (<10) to establish a valid trading range.',
        condition: 'UNCLEAR',
        rangeHigh: currentPrice,
        rangeLow: currentPrice,
        equilibrium: currentPrice,
        premiumZone: [currentPrice, currentPrice],
        discountZone: [currentPrice, currentPrice],
        currentPosition: 'EQUILIBRIUM',
        breakoutState: 'INSIDE_RANGE',
        poisInsideRangeCount: 0,
        startEpoch: c15m[0]?.epoch || 0,
        endEpoch: c15m[c15m.length - 1]?.epoch || 0
      };
    }

    const latest = c15m[c15m.length - 1];
    const shifts15m = MarketStructureEngine.detectAllStructuralShifts(c15m, pivots15m);
    const condition: MarketCondition = MarketStructureEngine.classifyMarketCondition(
      c15m,
      pivots15m,
      shifts15m
    );
    const highs = pivots15m.filter((p) => p.type === 'HIGH');
    const lows = pivots15m.filter((p) => p.type === 'LOW');

    let rangeHigh: number;
    let rangeLow: number;
    let startEpoch: number;

    if (highs.length > 0 && lows.length > 0) {
      const recentHighs = highs.slice(-2);
      const recentLows = lows.slice(-2);
      rangeHigh = Math.max(...recentHighs.map((h) => h.price));
      rangeLow = Math.min(...recentLows.map((l) => l.price));
      startEpoch = Math.min(recentHighs[0].epoch, recentLows[0].epoch);
    } else {
      const recent = c15m.slice(-20);
      rangeHigh = Math.max(...recent.map((c) => c.high));
      rangeLow = Math.min(...recent.map((c) => c.low));
      startEpoch = recent[0].epoch;
    }

    if (rangeHigh <= rangeLow) {
      const recent = c15m.slice(-20);
      rangeHigh = Math.max(...recent.map((c) => c.high));
      rangeLow = Math.min(...recent.map((c) => c.low));
      startEpoch = recent[0].epoch;
    }

    const width = Math.max(0, rangeHigh - rangeLow);
    const widthPct = currentPrice > 0 ? width / currentPrice : 0;
    const minAtrWidth = atr15m > 0 ? atr15m * 1.15 : currentPrice * 0.0009;
    const equilibrium = (rangeHigh + rangeLow) / 2;
    const eqTol = width * 0.06;

    const currentPosition: TradeableRangeBox['currentPosition'] =
      Math.abs(currentPrice - equilibrium) <= eqTol
        ? 'EQUILIBRIUM'
        : currentPrice > equilibrium
        ? 'PREMIUM'
        : 'DISCOUNT';

    // Detect Breakout & Retest state near range boundaries
    let breakoutState: TradeableRangeBox['breakoutState'] = 'INSIDE_RANGE';
    const retestTol = Math.max(atr15m * 0.55, width * 0.14);
    const prevCandles = c15m.slice(-5, -1);
    const brokeAbove = prevCandles.some((c) => c.close > rangeHigh);
    const brokeBelow = prevCandles.some((c) => c.close < rangeLow);

    if (brokeAbove && Math.abs(currentPrice - rangeHigh) <= retestTol && currentPrice >= rangeHigh - retestTol * 0.5) {
      breakoutState = 'BULLISH_BREAKOUT_RETEST';
    } else if (brokeBelow && Math.abs(currentPrice - rangeLow) <= retestTol && currentPrice <= rangeLow + retestTol * 0.5) {
      breakoutState = 'BEARISH_BREAKOUT_RETEST';
    } else if (currentPrice > rangeHigh + retestTol || currentPrice < rangeLow - retestTol) {
      breakoutState = 'EXTENDED';
    }

    // Check POIs inside (or directly bounding) the M15 trading range
    const minBound = rangeLow * 0.998;
    const maxBound = rangeHigh * 1.002;
    const zonesInRange = [...m15Zones, ...h1Zones].filter(
      (z) => !z.broken && z.lowerPrice <= maxBound && z.upperPrice >= minBound
    );
    const obsInRange = m15OrderBlocks.filter(
      (ob) => ob.valid && ob.lowerPrice <= maxBound && ob.upperPrice >= minBound
    );
    const fvgsInRange = m15Fvgs.filter(
      (f) => !f.completelyFilled && f.lowerBoundary <= maxBound && f.upperBoundary >= minBound
    );
    const poisInsideRangeCount = zonesInRange.length + obsInRange.length + fvgsInRange.length;

    let isValid = true;
    let invalidReason: string | undefined;

    if (condition === 'UNCLEAR') {
      isValid = false;
      invalidReason = 'Market structure is unclear/erratic; no clean tradeable range.';
    } else if (highs.length === 0 || lows.length === 0) {
      isValid = false;
      invalidReason = 'M15 swing high/low boundaries are unclear; no structural trading range.';
    } else if (width < minAtrWidth || widthPct < 0.0008) {
      isValid = false;
      invalidReason = 'M15 trading range is too narrow/compressed to offer clean room to TP.';
    } else if (breakoutState === 'EXTENDED') {
      isValid = false;
      invalidReason = 'Price is over-extended outside M15 trading range without a valid retest.';
    } else if (poisInsideRangeCount === 0) {
      isValid = false;
      invalidReason = 'No valid M15/H1 POIs (S&D, Order Block, or FVG) established inside the range.';
    }

    return {
      timeframe: '15m',
      isValid,
      invalidReason,
      condition,
      rangeHigh,
      rangeLow,
      equilibrium,
      premiumZone: [equilibrium, rangeHigh],
      discountZone: [rangeLow, equilibrium],
      currentPosition,
      breakoutState,
      poisInsideRangeCount,
      startEpoch,
      endEpoch: latest.epoch
    };
  }
}
