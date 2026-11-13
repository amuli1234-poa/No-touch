import {
  Candle,
  FlipSrAssessment,
  SupportResistanceZone,
  PivotPoint,
  OrderBlock,
  Timeframe,
  ZoneStrength
} from '../types/scanner';

export class SupportResistanceEngine {
  /**
   * Maps Supply & Demand zones classified as STRONG_SUPPLY, WEAK_SUPPLY, STRONG_DEMAND, WEAK_DEMAND.
   * Automatically removes broken/invalidated zones.
   */
  public static mapZones(
    candles: Candle[],
    pivots: PivotPoint[],
    tf: Timeframe,
    tolerancePct: number = 0.0018
  ): SupportResistanceZone[] {
    const rawZones: SupportResistanceZone[] = [];
    if (candles.length === 0 || pivots.length === 0) return rawZones;

    for (const pivot of pivots) {
      const originCandle = candles[pivot.index];
      const zonePrice = pivot.price;

      // Use actual origin wick/body band when available, bounded by tolerance
      let upper = zonePrice * (1 + tolerancePct);
      let lower = zonePrice * (1 - tolerancePct);
      if (originCandle) {
        if (pivot.type === 'HIGH') {
          upper = originCandle.high;
          lower = Math.min(Math.max(originCandle.open, originCandle.close), zonePrice * (1 - tolerancePct * 0.5));
          if (upper - lower < zonePrice * 0.0005) lower = upper * (1 - tolerancePct);
        } else {
          lower = originCandle.low;
          upper = Math.max(Math.min(originCandle.open, originCandle.close), zonePrice * (1 + tolerancePct * 0.5));
          if (upper - lower < zonePrice * 0.0005) upper = lower * (1 + tolerancePct);
        }
      }

      let testCount = 0;
      let broken = false;
      let breakIndex = -1;
      let lastTestEpoch = pivot.epoch;
      let causedDisplacement = false;

      const subsequent = candles.filter((c) => c.epoch > pivot.epoch);
      // Check immediate 3 candles post-pivot for displacement impulse
      for (let i = 0; i < Math.min(3, subsequent.length); i++) {
        const c = subsequent[i];
        const total = c.high - c.low;
        const body = Math.abs(c.close - c.open);
        if (total > 0 && body / total >= 0.62) {
          if (pivot.type === 'HIGH' && c.close < c.open) causedDisplacement = true;
          if (pivot.type === 'LOW' && c.close > c.open) causedDisplacement = true;
        }
      }

      for (let i = 0; i < subsequent.length; i++) {
        const c = subsequent[i];
        const touched = c.high >= lower && c.low <= upper;
        if (touched) {
          testCount++;
          lastTestEpoch = c.epoch;
        }

        // Zone invalidation: candle body closes cleanly beyond zone boundary
        if (pivot.type === 'HIGH' && c.close > upper * 1.0005) {
          broken = true;
          breakIndex = i;
          break;
        }
        if (pivot.type === 'LOW' && c.close < lower * 0.9995) {
          broken = true;
          breakIndex = i;
          break;
        }
      }

      // Detect valid Support/Resistance Flips after a confirmed candle-close break when price retests & rejects from the opposite side
      if (broken && breakIndex >= 0 && breakIndex < subsequent.length - 1) {
        const breakoutCandle = subsequent[breakIndex];
        const postBreak = subsequent.slice(breakIndex + 1);

        // False breakout guard: immediate snapback closing back inside zone on the very next candle
        const nextAfterBreak = postBreak[0];
        const immediateSnapback =
          pivot.type === 'HIGH'
            ? nextAfterBreak && nextAfterBreak.close < lower
            : nextAfterBreak && nextAfterBreak.close > upper;

        if (!immediateSnapback) {
          let flipConfirmed = false;
          let flipBrokenAgain = false;
          let retestEpoch = breakoutCandle.epoch;
          let retestRejection = false;
          let flipTests = 0;

          for (const pc of postBreak) {
            const pcRange = Math.max(1e-9, pc.high - pc.low);
            if (pivot.type === 'HIGH') {
              // Resistance broken -> flipped into Support: retests top edge and closes >= upper * 0.999
              if (pc.low <= upper * 1.0018 && pc.close >= upper * 0.999) {
                flipConfirmed = true;
                flipTests++;
                retestEpoch = pc.epoch;
                const lowerWick = Math.min(pc.open, pc.close) - pc.low;
                if (pc.close >= pc.open || lowerWick / pcRange >= 0.32) {
                  retestRejection = true;
                }
              }
              if (pc.close < lower * 0.9995) {
                flipBrokenAgain = true;
                break;
              }
            } else {
              // Support broken -> flipped into Resistance: retests bottom edge and closes <= lower * 1.001
              if (pc.high >= lower * 0.9982 && pc.close <= lower * 1.001) {
                flipConfirmed = true;
                flipTests++;
                retestEpoch = pc.epoch;
                const upperWick = pc.high - Math.max(pc.open, pc.close);
                if (pc.close <= pc.open || upperWick / pcRange >= 0.32) {
                  retestRejection = true;
                }
              }
              if (pc.close > upper * 1.0005) {
                flipBrokenAgain = true;
                break;
              }
            }
          }

          if (flipConfirmed && !flipBrokenAgain) {
            const flippedType = pivot.type === 'HIGH' ? 'SUPPORT' : 'RESISTANCE';
            const flippedStrength: ZoneStrength =
              flippedType === 'SUPPORT' ? 'STRONG_DEMAND' : 'STRONG_SUPPLY';
            const flipHalf = pivot.price * Math.max(tolerancePct, 0.0015);
            rawZones.push({
              id: `FLIP_${tf}_${pivot.type}_${pivot.epoch}`,
              timeframe: tf,
              type: flippedType,
              strength: flippedStrength,
              tier: 'MAJOR',
              isFlip: true,
              flipType: pivot.type === 'HIGH' ? 'R_TO_S' : 'S_TO_R',
              flipState: 'CONFIRMED_FLIP_RETEST',
              flipLevel: pivot.price,
              breakoutCloseEpoch: breakoutCandle.epoch,
              retestEpoch,
              retestRejection,
              upperPrice: Math.max(pivot.price, pivot.price + flipHalf),
              lowerPrice: Math.min(pivot.price, pivot.price - flipHalf),
              originEpoch: breakoutCandle.epoch,
              testCount: flipTests,
              fresh: flipTests <= 1,
              broken: false,
              causedDisplacement: true,
              lastTestEpoch: retestEpoch
            });
          }
        }
        continue;
      }

      if (broken) continue; // Live invalidation cleanup

      const fresh = testCount <= 1;
      const isStrong = fresh && causedDisplacement;
      const tier: 'MAJOR' | 'MINOR' =
        causedDisplacement || testCount >= 2 || tf === '4h' || tf === '1h' ? 'MAJOR' : 'MINOR';

      let hasBaseFormation = false;
      if (causedDisplacement && pivot.index >= 1) {
        const b1 = candles[pivot.index];
        const b0 = candles[pivot.index - 1];
        const b1Range = Math.max(1e-9, b1.high - b1.low);
        const b0Range = Math.max(1e-9, b0.high - b0.low);
        const b1Compact = Math.abs(b1.close - b1.open) / b1Range <= 0.52 || (b1.close > 0 && Math.abs(b1.close - b1.open) / b1.close <= 0.0045);
        const b0Compact = Math.abs(b0.close - b0.open) / b0Range <= 0.52 || (b0.close > 0 && Math.abs(b0.close - b0.open) / b0.close <= 0.0045);
        if (b1Compact || b0Compact) {
          hasBaseFormation = true;
        }
      }

      const strength: ZoneStrength =
        pivot.type === 'HIGH'
          ? isStrong
            ? 'STRONG_SUPPLY'
            : 'WEAK_SUPPLY'
          : isStrong
          ? 'STRONG_DEMAND'
          : 'WEAK_DEMAND';

      rawZones.push({
        id: `SD_${tf}_${pivot.type}_${pivot.epoch}`,
        timeframe: tf,
        type: pivot.type === 'HIGH' ? 'SUPPLY' : 'DEMAND',
        strength,
        tier,
        isFlip: false,
        hasBaseFormation,
        upperPrice: upper,
        lowerPrice: lower,
        originEpoch: pivot.epoch,
        testCount,
        fresh,
        broken: false,
        causedDisplacement,
        lastTestEpoch
      });
    }

    return this.clusterZones(rawZones).slice(-12);
  }

  /**
   * Independent Flip Support & Resistance (Role Reversal) evaluator:
   * - Requires candle closure beyond S/R before accepting breakout/breakdown
   * - Confirms retest + rejection on opposite side
   * - Detects false breakouts (wick pierce without close) & failed retests (close back inside)
   */
  public static evaluateFlipRoleReversal(
    candles: Candle[],
    pivots: PivotPoint[],
    tf: Timeframe,
    currentPrice: number,
    tolerancePct: number = 0.002
  ): FlipSrAssessment {
    const zones = this.mapZones(candles, pivots, tf, tolerancePct);
    const flipZones = zones.filter((z) => z.isFlip && !z.broken);

    let falseBreakoutDetected = false;
    let failedRetestDetected = false;

    const recentCandles = candles.slice(-8);
    // Check recent candles against active S/R zones for wick-only false breakouts
    for (const z of zones) {
      if (z.broken) continue;
      for (const c of recentCandles) {
        if ((z.type === 'RESISTANCE' || z.type === 'SUPPLY') && c.high > z.upperPrice * 1.0005 && c.close <= z.upperPrice) {
          falseBreakoutDetected = true;
        }
        if ((z.type === 'SUPPORT' || z.type === 'DEMAND') && c.low < z.lowerPrice * 0.9995 && c.close >= z.lowerPrice) {
          falseBreakoutDetected = true;
        }
      }
    }

    // Check raw pivots for failed retests (closed beyond pivot, retested, then closed back through)
    for (const pivot of pivots) {
      const upper = pivot.price * (1 + tolerancePct);
      const lower = pivot.price * (1 - tolerancePct);
      const subsequent = candles.filter((c) => c.epoch > pivot.epoch);
      let breakIdx = -1;
      for (let i = 0; i < subsequent.length; i++) {
        const c = subsequent[i];
        if (pivot.type === 'HIGH' && c.close > upper * 1.0005) {
          breakIdx = i;
          break;
        }
        if (pivot.type === 'LOW' && c.close < lower * 0.9995) {
          breakIdx = i;
          break;
        }
      }
      if (breakIdx >= 0 && breakIdx < subsequent.length - 1) {
        const post = subsequent.slice(breakIdx + 1);
        const lastRecentStart = Math.max(0, subsequent.length - 10);
        if (breakIdx >= lastRecentStart - 6) {
          for (const pc of post) {
            if (pivot.type === 'HIGH' && pc.close < lower * 0.9995) {
              failedRetestDetected = true;
              break;
            }
            if (pivot.type === 'LOW' && pc.close > upper * 1.0005) {
              failedRetestDetected = true;
              break;
            }
          }
        }
      }
    }

    const nearDist = (z: SupportResistanceZone) =>
      Math.abs(currentPrice - (z.flipLevel ?? (z.upperPrice + z.lowerPrice) / 2)) /
      Math.max(1e-9, currentPrice);

    const activeBullishFlip =
      flipZones
        .filter((z) => z.flipType === 'R_TO_S' && nearDist(z) <= 0.025)
        .sort((a, b) => nearDist(a) - nearDist(b))[0] || null;

    const activeBearishFlip =
      flipZones
        .filter((z) => z.flipType === 'S_TO_R' && nearDist(z) <= 0.025)
        .sort((a, b) => nearDist(a) - nearDist(b))[0] || null;

    let detail = 'No active Support/Resistance role-reversal flip near price.';
    if (activeBullishFlip) {
      detail = `Confirmed R→S Flip near ${((activeBullishFlip.upperPrice + activeBullishFlip.lowerPrice) / 2).toFixed(2)} (${activeBullishFlip.testCount} retest${activeBullishFlip.testCount > 1 ? 's' : ''}${activeBullishFlip.retestRejection ? ', rejection held' : ''}).`;
    } else if (activeBearishFlip) {
      detail = `Confirmed S→R Flip near ${((activeBearishFlip.upperPrice + activeBearishFlip.lowerPrice) / 2).toFixed(2)} (${activeBearishFlip.testCount} retest${activeBearishFlip.testCount > 1 ? 's' : ''}${activeBearishFlip.retestRejection ? ', rejection held' : ''}).`;
    } else if (falseBreakoutDetected) {
      detail = 'False breakout wick trap detected without candle closure beyond level.';
    } else if (failedRetestDetected) {
      detail = 'Failed retest detected — price closed back inside broken S/R level.';
    }

    return {
      flipZones,
      activeBullishFlip,
      activeBearishFlip,
      falseBreakoutDetected,
      failedRetestDetected,
      detail
    };
  }

  /**
   * Detects valid refined Order Blocks (last opposing candle before strong displacement).
   * Automatically removes invalidated order blocks.
   */
  public static findOrderBlocks(candles: Candle[], timeframe: Timeframe): OrderBlock[] {
    const obs: OrderBlock[] = [];
    if (candles.length < 6) return obs;

    for (let i = 1; i < candles.length - 2; i++) {
      const base = candles[i];
      const imp1 = candles[i + 1];
      const imp2 = candles[i + 2];

      const imp1Body = Math.abs(imp1.close - imp1.open);
      const imp1Range = imp1.high - imp1.low;
      const imp1Ratio = imp1Range > 0 ? imp1Body / imp1Range : 0;

      // Bullish Order Block: last bearish candle before strong bullish displacement closing above base high
      if (
        base.close < base.open &&
        imp1.close > imp1.open &&
        imp1Ratio >= 0.6 &&
        imp1.close > base.high &&
        imp2.close > base.high
      ) {
        const subsequent = candles.slice(i + 2);
        let mitigated = false;
        let broken = false;

        for (const c of subsequent) {
          if (c.low <= base.high && c.close >= base.low) mitigated = true;
          if (c.close < base.low) {
            broken = true;
            break;
          }
        }

        if (!broken) {
          obs.push({
            id: `OB_BULL_${timeframe}_${base.epoch}`,
            timeframe,
            type: 'BULLISH_OB',
            strength: mitigated ? 'WEAK_DEMAND' : 'STRONG_DEMAND',
            upperPrice: base.high,
            lowerPrice: base.low,
            epoch: base.epoch,
            mitigated,
            valid: true
          });
        }
      }

      // Bearish Order Block: last bullish candle before strong bearish displacement closing below base low
      if (
        base.close > base.open &&
        imp1.close < imp1.open &&
        imp1Ratio >= 0.6 &&
        imp1.close < base.low &&
        imp2.close < base.low
      ) {
        const subsequent = candles.slice(i + 2);
        let mitigated = false;
        let broken = false;

        for (const c of subsequent) {
          if (c.high >= base.low && c.close <= base.high) mitigated = true;
          if (c.close > base.high) {
            broken = true;
            break;
          }
        }

        if (!broken) {
          obs.push({
            id: `OB_BEAR_${timeframe}_${base.epoch}`,
            timeframe,
            type: 'BEARISH_OB',
            strength: mitigated ? 'WEAK_SUPPLY' : 'STRONG_SUPPLY',
            upperPrice: base.high,
            lowerPrice: base.low,
            epoch: base.epoch,
            mitigated,
            valid: true
          });
        }
      }
    }

    return obs.slice(-6);
  }

  private static clusterZones(zones: SupportResistanceZone[]): SupportResistanceZone[] {
    if (zones.length <= 1) return zones;
    const sorted = [...zones].sort((a, b) => a.lowerPrice - b.lowerPrice);
    const clustered: SupportResistanceZone[] = [];

    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      if (next.lowerPrice <= current.upperPrice && next.type === current.type && Boolean(next.isFlip) === Boolean(current.isFlip)) {
        const isStrong =
          current.strength.startsWith('STRONG') || next.strength.startsWith('STRONG');
        current = {
          ...current,
          upperPrice: Math.max(current.upperPrice, next.upperPrice),
          lowerPrice: Math.min(current.lowerPrice, next.lowerPrice),
          testCount: current.testCount + next.testCount,
          fresh: current.fresh && next.fresh,
          causedDisplacement: current.causedDisplacement || next.causedDisplacement,
          retestRejection: current.retestRejection || next.retestRejection,
          strength:
            current.type === 'SUPPLY' || current.type === 'RESISTANCE'
              ? isStrong && current.fresh && next.fresh
                ? 'STRONG_SUPPLY'
                : 'WEAK_SUPPLY'
              : isStrong && current.fresh && next.fresh
              ? 'STRONG_DEMAND'
              : 'WEAK_DEMAND'
        };
      } else {
        clustered.push(current);
        current = next;
      }
    }
    clustered.push(current);
    return clustered;
  }
}
