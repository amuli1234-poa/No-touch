import type {
  ChartPatternStructure,
  SupportResistanceLevel,
  SupplyDemandZone,
  TradeSignalCard,
  TrendlineStructure,
} from '../types/analysis';
import { formatPrice } from '../utils/derivParser';

interface SignalCalculationsParams {
  direction: 'RISE' | 'FALL';
  entryPrice: number;
  invalidationPrice: number;
  atr: number;
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
  trendlines: readonly TrendlineStructure[];
  patterns: readonly ChartPatternStructure[];
  precision: number;
}

export function computeTradeTargetsAndStopLoss({
  direction,
  entryPrice,
  invalidationPrice,
  atr,
  supportResistance,
  supplyDemand,
  trendlines,
  patterns,
  precision,
}: SignalCalculationsParams): {
  takeProfit1: number;
  takeProfit2: number;
  stopLoss: number;
  riskRewardRatio: number;
} {
  const isRise = direction === 'RISE';
  const buffer = Math.max(atr * 0.35, 1e-6);

  // Stop Loss calculation (structural invalidation + buffer)
  let stopLoss = invalidationPrice;
  if (isRise) {
    if (stopLoss >= entryPrice) {
      stopLoss = entryPrice - Math.max(atr * 1.5, buffer * 3);
    } else {
      stopLoss = Math.min(stopLoss, entryPrice - atr * 0.5);
    }
  } else {
    if (stopLoss <= entryPrice) {
      stopLoss = entryPrice + Math.max(atr * 1.5, buffer * 3);
    } else {
      stopLoss = Math.max(stopLoss, entryPrice + atr * 0.5);
    }
  }

  const risk = Math.abs(entryPrice - stopLoss);

  // Take Profit calculation from actual opposing structures
  let tp1Candidate: number | null = null;
  let tp2Candidate: number | null = null;

  if (isRise) {
    const opposingLevels = supportResistance
      .filter((l) => l.status === 'active' && l.type === 'resistance' && l.price > entryPrice)
      .sort((a, b) => a.price - b.price);

    const opposingZones = supplyDemand
      .filter((z) => z.status !== 'invalidated' && z.type === 'supply' && z.lowerPrice > entryPrice)
      .sort((a, b) => a.lowerPrice - b.lowerPrice);

    const patternTarget = patterns.find(
      (p) => p.confirmed && p.bias === 'bullish' && p.necklinePrice && p.necklinePrice > entryPrice
    )?.necklinePrice;

    const trendlineTarget = trendlines.find(
      (t) => t.direction === 'bearish' && !t.broken
    )?.endPrice;

    const candidates = [
      opposingLevels[0]?.price,
      opposingZones[0]?.lowerPrice,
      patternTarget,
      trendlineTarget,
    ].filter((p): p is number => typeof p === 'number' && p > entryPrice);

    candidates.sort((a, b) => a - b);

    if (candidates.length > 0) {
      tp1Candidate = candidates[0] - buffer;
      tp2Candidate = candidates.length > 1 ? candidates[1] - buffer : tp1Candidate + risk * 2.2;
    } else {
      tp1Candidate = entryPrice + Math.max(risk * 1.6, atr * 2.2);
      tp2Candidate = entryPrice + Math.max(risk * 2.8, atr * 3.8);
    }
  } else {
    const opposingLevels = supportResistance
      .filter((l) => l.status === 'active' && l.type === 'support' && l.price < entryPrice)
      .sort((a, b) => b.price - a.price);

    const opposingZones = supplyDemand
      .filter((z) => z.status !== 'invalidated' && z.type === 'demand' && z.upperPrice < entryPrice)
      .sort((a, b) => b.upperPrice - a.upperPrice);

    const patternTarget = patterns.find(
      (p) => p.confirmed && p.bias === 'bearish' && p.necklinePrice && p.necklinePrice < entryPrice
    )?.necklinePrice;

    const candidates = [
      opposingLevels[0]?.price,
      opposingZones[0]?.upperPrice,
      patternTarget,
    ].filter((p): p is number => typeof p === 'number' && p < entryPrice);

    candidates.sort((a, b) => b - a);

    if (candidates.length > 0) {
      tp1Candidate = candidates[0] + buffer;
      tp2Candidate = candidates.length > 1 ? candidates[1] + buffer : tp1Candidate - risk * 2.2;
    } else {
      tp1Candidate = entryPrice - Math.max(risk * 1.6, atr * 2.2);
      tp2Candidate = entryPrice - Math.max(risk * 2.8, atr * 3.8);
    }
  }

  const takeProfit1 = Number(tp1Candidate.toFixed(precision));
  const takeProfit2 = Number(tp2Candidate.toFixed(precision));
  const roundedStopLoss = Number(stopLoss.toFixed(precision));

  const reward = Math.abs(takeProfit1 - entryPrice);
  const riskRewardRatio = risk > 0 ? Number((reward / risk).toFixed(2)) : 1.5;

  return {
    takeProfit1,
    takeProfit2,
    stopLoss: roundedStopLoss,
    riskRewardRatio,
  };
}
