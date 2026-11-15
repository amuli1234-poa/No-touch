import type { SupportResistanceLevel, SwingPoint } from '../types/analysis';
import type { Candle } from '../types/market';
import { formatPrice } from '../utils/derivParser';

interface LevelCluster {
  prices: number[];
  times: number[];
  highCount: number;
  lowCount: number;
}

export function detectSupportResistance(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  atr: number,
  precision: number
): SupportResistanceLevel[] {
  if (candles.length < 20 || swings.length < 2 || atr <= 0) {
    return [];
  }

  const tolerance = Math.max(atr * 0.45, 1e-6);
  const clusters: LevelCluster[] = [];

  for (const s of swings) {
    let matched: LevelCluster | null = null;
    let bestDist = Infinity;

    for (const c of clusters) {
      const avg = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
      const dist = Math.abs(s.price - avg);
      if (dist <= tolerance && dist < bestDist) {
        bestDist = dist;
        matched = c;
      }
    }

    if (matched) {
      matched.prices.push(s.price);
      matched.times.push(s.time);
      if (s.type === 'high') matched.highCount++;
      else matched.lowCount++;
    } else {
      clusters.push({
        prices: [s.price],
        times: [s.time],
        highCount: s.type === 'high' ? 1 : 0,
        lowCount: s.type === 'low' ? 1 : 0,
      });
    }
  }

  const latestClose = candles[candles.length - 1].close;
  const levels: SupportResistanceLevel[] = [];

  for (const c of clusters) {
    // Never draw arbitrary levels: require at least 2 confirmed swing reactions
    if (c.prices.length < 2) continue;

    const avgPrice = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
    const firstTouchTime = Math.min(...c.times);
    const lastTouchTime = Math.max(...c.times);
    const isSupport = latestClose >= avgPrice;
    const type: 'support' | 'resistance' = isSupport ? 'support' : 'resistance';

    // Check if recent candles cleanly broke and stayed across this level
    const recentSlice = candles.slice(-3);
    const broken =
      type === 'support'
        ? recentSlice.every((bar) => bar.close < avgPrice - atr * 0.2)
        : recentSlice.every((bar) => bar.close > avgPrice + atr * 0.2);

    const importance: 'major' | 'minor' = c.prices.length >= 3 ? 'major' : 'minor';
    const priceLabel = formatPrice(avgPrice, precision);
    const reason =
      type === 'support'
        ? `${importance.toUpperCase()} SUPPORT — Price repeatedly reacted upward from ${priceLabel} (${c.prices.length} touches).`
        : `${importance.toUpperCase()} RESISTANCE — Price repeatedly rejected downward from ${priceLabel} (${c.prices.length} touches).`;

    levels.push({
      id: `sr-${type}-${Math.round(avgPrice * 1e4)}`,
      price: avgPrice,
      type,
      touches: c.prices.length,
      firstTouchTime,
      lastTouchTime,
      status: broken ? 'broken' : 'active',
      importance,
      reason,
    });
  }

  // Keep the most relevant nearby levels (max 2 active supports + max 2 active resistances)
  const activeSupports = levels
    .filter((l) => l.status === 'active' && l.type === 'support')
    .sort((a, b) => {
      const scoreA = a.touches * 2 - Math.abs(latestClose - a.price) / atr;
      const scoreB = b.touches * 2 - Math.abs(latestClose - b.price) / atr;
      return scoreB - scoreA;
    })
    .slice(0, 2);

  const activeResistances = levels
    .filter((l) => l.status === 'active' && l.type === 'resistance')
    .sort((a, b) => {
      const scoreA = a.touches * 2 - Math.abs(latestClose - a.price) / atr;
      const scoreB = b.touches * 2 - Math.abs(latestClose - b.price) / atr;
      return scoreB - scoreA;
    })
    .slice(0, 2);

  return [...activeResistances, ...activeSupports].sort((a, b) => b.price - a.price);
}
