import type {
  ChartPatternStructure,
  SupportResistanceLevel,
  SupplyDemandZone,
  TradeSignalCard,
  TrendlineStructure,
} from '../types/analysis';
import { formatPrice } from '../utils/derivParser';
import { resolveTargets } from './aiCommon';

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

  // Take Profit calculation from actual opposing structures. The ladder is anchored to the
  // ACTUAL entry and filtered to the reward side, so a nearby opposing level can never place
  // TP1 back across the entry.
  const opposingLevels = supportResistance
    .filter((l) =>
      isRise
        ? l.status === 'active' && l.type === 'resistance' && l.price > entryPrice
        : l.status === 'active' && l.type === 'support' && l.price < entryPrice
    )
    .sort((a, b) => (isRise ? a.price - b.price : b.price - a.price));

  const opposingZones = supplyDemand
    .filter((z) =>
      isRise
        ? z.status !== 'invalidated' && z.type === 'supply' && z.lowerPrice > entryPrice
        : z.status !== 'invalidated' && z.type === 'demand' && z.upperPrice < entryPrice
    )
    .sort((a, b) => (isRise ? a.lowerPrice - b.lowerPrice : b.upperPrice - a.upperPrice));

  const patternTarget = patterns.find(
    (p) =>
      p.confirmed &&
      p.bias === (isRise ? 'bullish' : 'bearish') &&
      p.necklinePrice != null &&
      (isRise ? p.necklinePrice > entryPrice : p.necklinePrice < entryPrice)
  )?.necklinePrice;

  // A bearish, unbroken trendline sits overhead and is a long target only (unchanged from the
  // original RISE-only behaviour).
  const trendlineTarget = isRise
    ? trendlines.find((t) => t.direction === 'bearish' && !t.broken)?.endPrice
    : undefined;

  const candidates = [
    opposingLevels[0]?.price,
    isRise ? opposingZones[0]?.lowerPrice : opposingZones[0]?.upperPrice,
    patternTarget,
    trendlineTarget,
  ];

  const ladder = resolveTargets(direction, entryPrice, candidates, risk > 0 ? risk : atr);
  const takeProfit1 = Number(ladder[0].toFixed(precision));
  const takeProfit2 = Number(ladder[1].toFixed(precision));
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
