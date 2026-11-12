import { Candle, SupportResistanceZone, PivotPoint } from '../types/scanner';

export class SupportResistanceEngine {
  /**
   * Identifies major horizontal Support & Resistance / Supply & Demand zones from fractal pivots.
   * Clusters nearby levels and counts tests/rejections.
   */
  public static mapZones(
    candles: Candle[],
    pivots: PivotPoint[],
    tf: '5m' | '2m',
    tolerancePct: number = 0.0018 // 0.18% zone width
  ): SupportResistanceZone[] {
    const rawZones: SupportResistanceZone[] = [];
    if (candles.length === 0 || pivots.length === 0) return rawZones;

    for (const pivot of pivots) {
      const zonePrice = pivot.price;
      const upper = zonePrice * (1 + tolerancePct);
      const lower = zonePrice * (1 - tolerancePct);

      let testCount = 0;
      let broken = false;
      let lastTestEpoch = pivot.epoch;

      const subsequent = candles.filter((c) => c.epoch > pivot.epoch);
      for (const c of subsequent) {
        const touched = c.high >= lower && c.low <= upper;
        if (touched) {
          testCount++;
          lastTestEpoch = c.epoch;
        }

        // Zone invalidation: a candle closes firmly beyond the opposite threshold
        if (pivot.type === 'HIGH' && c.close > upper * 1.001) {
          broken = true;
        }
        if (pivot.type === 'LOW' && c.close < lower * 0.999) {
          broken = true;
        }
      }

      rawZones.push({
        id: `SR_${tf}_${pivot.type}_${pivot.epoch}`,
        timeframe: tf,
        type: pivot.type === 'HIGH' ? 'RESISTANCE' : 'SUPPORT',
        upperPrice: upper,
        lowerPrice: lower,
        testCount,
        fresh: testCount <= 1,
        broken,
        lastTestEpoch
      });
    }

    // Keep active valid zones and cluster overlapping zones
    const active = rawZones.filter((z) => !z.broken);
    return this.clusterZones(active);
  }

  /**
   * Clusters adjacent zones to prevent redundant visual clutter.
   */
  private static clusterZones(zones: SupportResistanceZone[]): SupportResistanceZone[] {
    if (zones.length <= 1) return zones;
    const sorted = [...zones].sort((a, b) => a.lowerPrice - b.lowerPrice);
    const clustered: SupportResistanceZone[] = [];

    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      // Check overlap
      if (next.lowerPrice <= current.upperPrice && next.type === current.type) {
        // Merge
        current = {
          ...current,
          upperPrice: Math.max(current.upperPrice, next.upperPrice),
          lowerPrice: Math.min(current.lowerPrice, next.lowerPrice),
          testCount: current.testCount + next.testCount,
          fresh: current.fresh && next.fresh
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
