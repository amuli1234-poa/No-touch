import type { SupplyDemandZone, ZoneStatus } from '../types/analysis';
import type { Candle } from '../types/market';
import { formatPrice } from '../utils/derivParser';
import { getCandleStats, getRecentAverageBody } from './swings';

export function detectSupplyDemandZones(
  candles: readonly Candle[],
  atrs: readonly number[],
  precision: number
): SupplyDemandZone[] {
  if (candles.length < 25) return [];

  const candidates: SupplyDemandZone[] = [];

  for (let i = 14; i < candles.length - 2; i++) {
    const base = candles[i];
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];
    const atr = Math.max(atrs[i] || 1e-6, 1e-9);
    const avgBody = getRecentAverageBody(candles, i, 14);

    const baseStats = getCandleStats(base);
    const next1Stats = getCandleStats(next1);
    const next2Stats = getCandleStats(next2);

    // Base candle should be relatively compact before strong displacement
    const isCompactBase = baseStats.body <= avgBody * 1.15;
    if (!isCompactBase) continue;

    // Bullish Demand Zone: compact base followed by strong upward displacement
    const bullishMove = next2.close - base.low;
    const isBullishImpulse =
      next1Stats.isBullish &&
      next1Stats.body >= avgBody * 1.45 &&
      next1Stats.closePosition >= 0.65 &&
      (next2.close > next1.high || next2Stats.isBullish) &&
      bullishMove >= atr * 1.4;

    if (isBullishImpulse) {
      const lowerPrice = Math.min(base.low, next1.low);
      const upperPrice = Math.max(base.open, base.close);
      if (upperPrice > lowerPrice) {
        candidates.push({
          id: `demand-${base.time}`,
          type: 'demand',
          upperPrice,
          lowerPrice,
          originTime: base.time,
          originIndex: i,
          status: 'fresh',
          touches: 0,
          displacementAtr: Number((bullishMove / atr).toFixed(2)),
          reason: `DEMAND ZONE (${formatPrice(lowerPrice, precision)}–${formatPrice(
            upperPrice,
            precision
          )}) — Strong bullish displacement (${(bullishMove / atr).toFixed(1)}x ATR) originated here.`,
        });
      }
      continue;
    }

    // Bearish Supply Zone: compact base followed by strong downward displacement
    const bearishMove = base.high - next2.close;
    const isBearishImpulse =
      next1Stats.isBearish &&
      next1Stats.body >= avgBody * 1.45 &&
      next1Stats.closePosition <= 0.35 &&
      (next2.close < next1.low || next2Stats.isBearish) &&
      bearishMove >= atr * 1.4;

    if (isBearishImpulse) {
      const upperPrice = Math.max(base.high, next1.high);
      const lowerPrice = Math.min(base.open, base.close);
      if (upperPrice > lowerPrice) {
        candidates.push({
          id: `supply-${base.time}`,
          type: 'supply',
          upperPrice,
          lowerPrice,
          originTime: base.time,
          originIndex: i,
          status: 'fresh',
          touches: 0,
          displacementAtr: Number((bearishMove / atr).toFixed(2)),
          reason: `SUPPLY ZONE (${formatPrice(lowerPrice, precision)}–${formatPrice(
            upperPrice,
            precision
          )}) — Strong bearish displacement (${(bearishMove / atr).toFixed(1)}x ATR) originated here.`,
        });
      }
    }
  }

  // Evaluate zone lifecycle (fresh / tested / invalidated) after formation + 2 bars
  const evaluated: SupplyDemandZone[] = [];

  for (const zone of candidates) {
    let status: ZoneStatus = 'fresh';
    let touches = 0;

    for (let j = zone.originIndex + 3; j < candles.length; j++) {
      const bar = candles[j];

      if (zone.type === 'demand') {
        if (bar.close < zone.lowerPrice) {
          status = 'invalidated';
          break;
        }
        if (bar.low <= zone.upperPrice && bar.high >= zone.lowerPrice) {
          touches++;
          if (status === 'fresh') status = 'tested';
        }
      } else {
        if (bar.close > zone.upperPrice) {
          status = 'invalidated';
          break;
        }
        if (bar.high >= zone.lowerPrice && bar.low <= zone.upperPrice) {
          touches++;
          if (status === 'fresh') status = 'tested';
        }
      }
    }

    if (touches >= 3 && status !== 'invalidated') {
      // Exhausted multi-retest zones are weaker; keep status 'tested'
      status = 'tested';
    }

    const statusTag =
      status === 'fresh'
        ? 'Fresh (unmitigated)'
        : status === 'tested'
          ? `Tested (${touches}x)`
          : 'Invalidated';

    evaluated.push({
      ...zone,
      status,
      touches,
      reason: `${zone.reason.split('—')[0].trim()} [${statusTag}] — ${zone.reason
        .split('—')[1]
        .trim()}`,
    });
  }

  const latestClose = candles[candles.length - 1].close;

  // Keep most recent fresh & tested zones closest to price, plus up to 1 recently invalidated zone for differentiation
  const active = evaluated
    .filter((z) => z.status !== 'invalidated')
    .sort((a, b) => {
      const distA = Math.abs((a.upperPrice + a.lowerPrice) / 2 - latestClose);
      const distB = Math.abs((b.upperPrice + b.lowerPrice) / 2 - latestClose);
      return distA - distB;
    })
    .slice(0, 4);

  const recentInvalidated = evaluated
    .filter((z) => z.status === 'invalidated')
    .slice(-1);

  return [...active, ...recentInvalidated];
}
