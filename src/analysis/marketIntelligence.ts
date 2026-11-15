import type { Candle, TimeframeKey } from '../types/market';
import type {
  IntelligenceReport,
  IntelligenceScenario,
  LiquidityPool,
  MajorSwing,
  MajorZone,
  MarketIntelligence,
} from '../types/intelligence';
import { formatPrice } from '../utils/derivParser';
import { detectMajorSwings, detectMajorTrendlines, detectMajorZones } from './majorStructure';
import { detectSupplyDemandZones } from './supplyDemand';
import { analyzeStructure } from './structureEngine';
import { computeAtrSeries } from './swings';

/**
 * PHASE 1 + PHASE 2 — Market Intelligence.
 *
 * This module reads the WHOLE current market independently of any signal: direction,
 * major structure, major/strong swings, BOS/CHOCH, major support/resistance and
 * supply/demand zones, fresh fair value gaps, liquidity pools and sweeps, rejection
 * zones and displacement, trendline validity and the market condition. It then draws
 * its own conclusion (bias, key levels, strongest zones, liquidity objectives, bullish
 * and bearish scenarios with invalidations, and no-trade areas).
 *
 * It NEVER invents a level and can legitimately conclude that no trade is available.
 * Signal generation is a separate, later stage that consumes this report.
 */
export function analyzeMarketIntelligence(params: {
  symbol: string;
  timeframe: TimeframeKey;
  candles: readonly Candle[];
  precision: number;
  htfBias?: 'bullish' | 'bearish' | 'neutral';
}): MarketIntelligence {
  const { symbol, timeframe, precision, htfBias = 'neutral' } = params;
  // Confirmed candles only — the forming bar never defines structure.
  const confirmed = params.candles.length > 2 ? params.candles.slice(0, -1) : [...params.candles];
  const empty = buildEmpty(symbol, timeframe, confirmed);

  if (confirmed.length < 30) return empty;

  const atrs = computeAtrSeries(confirmed, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const price = confirmed[confirmed.length - 1].close;

  // 2/3/4 — major structure and major/strong swings.
  const majorSwings = detectMajorSwings(confirmed, atrs, atr);
  const strongHighs = majorSwings.filter((s) => s.type === 'high' && s.tier === 'strong').map((s) => s.price);
  const strongLows = majorSwings.filter((s) => s.type === 'low' && s.tier === 'strong').map((s) => s.price);

  // 11 — major trendline validity.
  const trendlines = detectMajorTrendlines(confirmed, majorSwings, atr, precision);

  // 5/6/8/9/10 — BOS/CHOCH, rejection zones, FVG and liquidity sweeps.
  const structure = analyzeStructure({
    candles: confirmed,
    timeframe,
    precision,
    htfBias,
  });

  // 7 — supply & demand zones.
  const supplyDemand = detectSupplyDemandZones(confirmed, atrs, precision);

  // 6 — major support/resistance zones (rectangles).
  const zones = detectMajorZones(confirmed, majorSwings, atr, precision);

  // 9 — resting liquidity pools above major highs / below major lows.
  const liquidityPools = buildLiquidityPools(majorSwings, confirmed, atr, structure.rejectedSweeps);

  // 10 — dominant displacement from the most recent break.
  const lastBreak = structure.breaks[structure.breaks.length - 1];
  const displacement = lastBreak
    ? { direction: lastBreak.direction, atr: lastBreak.displacementAtr }
    : null;

  const bias = deriveBias(structure.bias, htfBias, majorSwings, trendlines, price, zones);
  const efficiency = directionalEfficiency(confirmed);
  const { condition, conditionExplanation } = classifyIntelligenceCondition(
    structure,
    majorSwings,
    trendlines,
    zones,
    atr,
    efficiency
  );

  const report = buildReport({
    price,
    atr,
    precision,
    bias,
    majorSwings,
    zones,
    trendlines,
    liquidityPools,
    structure,
  });

  const { tradeable, noTradeReason } = assessTradeability(condition, report, price);

  return {
    symbol,
    timeframe,
    asOfTime: confirmed[confirmed.length - 1].time,
    price,
    atr,
    bias,
    condition,
    conditionExplanation,
    majorSwings,
    strongHighs,
    strongLows,
    breaks: structure.breaks,
    trendlines,
    zones,
    supplyDemand,
    fvg: structure.fvg,
    liquidityPools,
    liquiditySweeps: structure.rejectedSweeps,
    rejectionZones: structure.rejectionZones,
    displacement,
    report,
    tradeable,
    noTradeReason,
  };
}

function buildEmpty(symbol: string, timeframe: TimeframeKey, candles: readonly Candle[]): MarketIntelligence {
  const price = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const scenario = (direction: 'bullish' | 'bearish'): IntelligenceScenario => ({
    direction,
    summary: 'Insufficient confirmed structure.',
    trigger: 'Awaiting confirmed candles.',
    targets: [],
    invalidation: 'N/A',
    invalidationPrice: null,
  });
  return {
    symbol,
    timeframe,
    asOfTime: candles.length > 0 ? candles[candles.length - 1].time : 0,
    price,
    atr: 0,
    bias: 'neutral',
    condition: 'TRANSITIONING',
    conditionExplanation: 'Insufficient confirmed candles for market intelligence.',
    majorSwings: [],
    strongHighs: [],
    strongLows: [],
    breaks: [],
    trendlines: [],
    zones: [],
    supplyDemand: [],
    fvg: [],
    liquidityPools: [],
    liquiditySweeps: [],
    rejectionZones: [],
    displacement: null,
    report: {
      biasSummary: 'Neutral — insufficient structure.',
      structuralLevels: [],
      strongestZones: [],
      liquidityObjectives: [],
      bullishScenario: scenario('bullish'),
      bearishScenario: scenario('bearish'),
      noTradeAreas: [],
    },
    tradeable: false,
    noTradeReason: 'Insufficient confirmed history.',
  };
}

function deriveBias(
  structureBias: 'bullish' | 'bearish' | 'neutral',
  htfBias: 'bullish' | 'bearish' | 'neutral',
  majors: readonly MajorSwing[],
  trendlines: readonly { direction: 'bullish' | 'bearish' }[],
  price: number,
  zones: readonly MajorZone[]
): 'bullish' | 'bearish' | 'neutral' {
  let score = 0;
  if (structureBias === 'bullish') score += 2;
  if (structureBias === 'bearish') score -= 2;
  if (htfBias === 'bullish') score += 1;
  if (htfBias === 'bearish') score -= 1;

  // Latest major swing labels.
  const lastHigh = [...majors].reverse().find((m) => m.type === 'high');
  const lastLow = [...majors].reverse().find((m) => m.type === 'low');
  if (lastHigh?.label === 'HH') score += 1;
  if (lastHigh?.label === 'LH') score -= 1;
  if (lastLow?.label === 'HL') score += 1;
  if (lastLow?.label === 'LL') score -= 1;

  for (const tl of trendlines) {
    if (tl.direction === 'bullish') score += 1;
    else score -= 1;
  }

  // Price relative to the nearest major zone.
  const support = zones
    .filter((z) => z.role === 'support' && (z.upperPrice + z.lowerPrice) / 2 < price)
    .sort((a, b) => b.upperPrice - a.upperPrice)[0];
  const resistance = zones
    .filter((z) => z.role === 'resistance' && (z.upperPrice + z.lowerPrice) / 2 > price)
    .sort((a, b) => a.lowerPrice - b.lowerPrice)[0];
  if (support && resistance) {
    const dSup = price - support.upperPrice;
    const dRes = resistance.lowerPrice - price;
    if (dSup < dRes) score += 1;
    else score -= 1;
  }

  if (score >= 2) return 'bullish';
  if (score <= -2) return 'bearish';
  return 'neutral';
}

/** Net directional travel / total travel over the confirmed window (0..1). */
function directionalEfficiency(candles: readonly Candle[]): number {
  const window = Math.min(60, candles.length);
  const slice = candles.slice(-window);
  if (slice.length < 5) return 0;
  const net = Math.abs(slice[slice.length - 1].close - slice[0].close);
  let travel = 0;
  for (let i = 1; i < slice.length; i++) {
    travel += Math.abs(slice[i].close - slice[i - 1].close);
  }
  return travel > 0 ? net / travel : 0;
}

function classifyIntelligenceCondition(
  structure: ReturnType<typeof analyzeStructure>,
  majors: readonly MajorSwing[],
  trendlines: readonly { valid: boolean }[],
  zones: readonly MajorZone[],
  atr: number,
  efficiency: number
): { condition: MarketIntelligence['condition']; conditionExplanation: string } {
  const highs = majors.filter((m) => m.type === 'high');
  const lows = majors.filter((m) => m.type === 'low');
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const lh = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price;
  const hl = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
  const ll = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price;
  const trending = (hh && hl) || (lh && ll);
  const hasValidTrendline = trendlines.some((t) => t.valid);

  // Ranging: opposing zones bracket price with no directional sequence.
  const activeZones = zones.filter((z) => z.freshness === 'FRESH' || z.freshness === 'TESTED');
  const bracketed =
    activeZones.some((z) => z.role === 'resistance') &&
    activeZones.some((z) => z.role === 'support') &&
    activeZones.length >= 2;

  if (trending && hasValidTrendline) {
    return {
      condition: 'TRENDING',
      conditionExplanation: `Major structure is directional (${
        hh && hl ? 'higher highs & higher lows' : 'lower highs & lower lows'
      }) with a valid major trendline — trending market.`,
    };
  }
  if (trending) {
    return {
      condition: 'TRENDING',
      conditionExplanation: `Major structure is directional (${
        hh && hl ? 'bullish' : 'bearish'
      } sequence) — trending market.`,
    };
  }
  // Clean, high-efficiency directional travel without clean swing labels is still a
  // trend (e.g. a smooth one-way walk with few pivots).
  if (efficiency >= 0.5) {
    const dirWord =
      structure.bias === 'bearish' ? 'bearish' : structure.bias === 'bullish' ? 'bullish' : 'directional';
    return {
      condition: 'TRENDING',
      conditionExplanation: `High directional efficiency (${(efficiency * 100).toFixed(
        0
      )}%) — ${dirWord} trending market.`,
    };
  }
  if (structure.breaks.length > 0 && bracketed) {
    return {
      condition: 'TRANSITIONING',
      conditionExplanation:
        'A recent structural break against a bracketed range — the market is transitioning.',
    };
  }
  if (bracketed) {
    return {
      condition: 'RANGING',
      conditionExplanation: 'Price is bracketed between major support and resistance zones — ranging market.',
    };
  }
  if (structure.breaks.length > 0) {
    return {
      condition: 'TRANSITIONING',
      conditionExplanation:
        'A recent BOS/CHOCH without a fully established trend — the market is transitioning.',
    };
  }
  return {
    condition: 'TRANSITIONING',
    conditionExplanation: 'No clean directional sequence or bracketed range — mixed structure.',
  };
}

function buildLiquidityPools(
  majors: readonly MajorSwing[],
  candles: readonly Candle[],
  atr: number,
  sweeps: readonly { sweptLevel: number }[]
): LiquidityPool[] {
  const price = candles[candles.length - 1].close;
  const pools: LiquidityPool[] = [];
  const seen = new Set<number>();

  for (const m of majors) {
    const key = Math.round(m.price * 100);
    if (seen.has(key)) continue;
    seen.add(key);
    const swept = sweeps.some((s) => Math.abs(s.sweptLevel - m.price) <= atr * 0.5);
    pools.push({
      id: `lp-${m.type}-${m.time}`,
      side: m.type === 'high' ? 'above' : 'below',
      price: m.price,
      time: m.time,
      kind: m.type === 'high' ? 'major-high' : 'major-low',
      swept,
      distanceAtr: Number((Math.abs(m.price - price) / Math.max(atr, 1e-9)).toFixed(2)),
      reason: `${
        m.type === 'high' ? 'Buy-side' : 'Sell-side'
      } liquidity resting at the major ${m.type} ${formatPrice(m.price, 2)}.`,
    });
  }
  return pools;
}

function buildReport(params: {
  price: number;
  atr: number;
  precision: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  majorSwings: readonly MajorSwing[];
  zones: readonly MajorZone[];
  trendlines: readonly { direction: 'bullish' | 'bearish'; valid: boolean; currentPrice: number }[];
  liquidityPools: readonly LiquidityPool[];
  structure: ReturnType<typeof analyzeStructure>;
}): IntelligenceReport {
  const { price, atr, precision, bias, zones, liquidityPools } = params;

  const structuralLevels = zones
    .map((z) => ({
      label: `${z.roleReversed ? `broken ${z.type}→${z.role}` : z.role} ${
        z.strength
      } (${z.reactions}x)`,
      price: Number(((z.upperPrice + z.lowerPrice) / 2).toFixed(precision)),
      kind: (z.role === 'support' ? 'support' : 'resistance') as 'support' | 'resistance',
    }))
    .sort((a, b) => b.price - a.price);

  const strongestZones = [...zones]
    .sort((a, b) => {
      const rank = { strong: 3, moderate: 2, weak: 1 };
      const s = rank[b.strength] - rank[a.strength];
      if (s !== 0) return s;
      return b.reactions - a.reactions;
    })
    .slice(0, 3);

  const nearestAbove = [...liquidityPools]
    .filter((p) => p.price > price && !p.swept)
    .sort((a, b) => a.price - b.price)[0];
  const nearestBelow = [...liquidityPools]
    .filter((p) => p.price < price && !p.swept)
    .sort((a, b) => b.price - a.price)[0];

  const nearestSupport = zones
    .filter((z) => z.role === 'support' && (z.upperPrice + z.lowerPrice) / 2 <= price)
    .sort((a, b) => b.upperPrice - a.upperPrice)[0];
  const nearestResistance = zones
    .filter((z) => z.role === 'resistance' && (z.upperPrice + z.lowerPrice) / 2 >= price)
    .sort((a, b) => a.lowerPrice - b.lowerPrice)[0];

  const bullishScenario: IntelligenceScenario = {
    direction: 'bullish',
    summary: nearestSupport
      ? `A bullish case needs a hold of the major support at ${formatPrice(
          nearestSupport.lowerPrice,
          precision
        )}–${formatPrice(nearestSupport.upperPrice, precision)} and a reclaim of structure.`
      : 'A bullish case needs a fresh higher low and a break of the nearest resistance.',
    trigger: nearestResistance
      ? `Reclaim and close above the major resistance ${formatPrice(
          nearestResistance.upperPrice,
          precision
        )}.`
      : 'Break of the most recent major swing high.',
    targets: [nearestAbove?.price ?? nearestResistance?.upperPrice ?? price + atr * 2].filter(
      (t): t is number => typeof t === 'number'
    ),
    invalidation: nearestSupport
      ? `Decisive close below ${formatPrice(nearestSupport.lowerPrice, precision)}.`
      : 'A decisive close below the most recent major swing low.',
    invalidationPrice: nearestSupport?.lowerPrice ?? null,
  };

  const bearishScenario: IntelligenceScenario = {
    direction: 'bearish',
    summary: nearestResistance
      ? `A bearish case needs rejection from the major resistance at ${formatPrice(
          nearestResistance.lowerPrice,
          precision
        )}–${formatPrice(nearestResistance.upperPrice, precision)}.`
      : 'A bearish case needs a lower high and a break of the nearest support.',
    trigger: nearestSupport
      ? `Lose and close below the major support ${formatPrice(nearestSupport.lowerPrice, precision)}.`
      : 'Break of the most recent major swing low.',
    targets: [nearestBelow?.price ?? nearestSupport?.lowerPrice ?? price - atr * 2].filter(
      (t): t is number => typeof t === 'number'
    ),
    invalidation: nearestResistance
      ? `Decisive close above ${formatPrice(nearestResistance.upperPrice, precision)}.`
      : 'A decisive close above the most recent major swing high.',
    invalidationPrice: nearestResistance?.upperPrice ?? null,
  };

  // No-trade areas: a genuine chop band only forms when opposing zones sit close
  // together (little reaction room between them). Wide zones get a separate note.
  const noTradeAreas: IntelligenceReport['noTradeAreas'] = [];
  if (nearestSupport && nearestResistance) {
    const midLow = nearestSupport.upperPrice;
    const midHigh = nearestResistance.lowerPrice;
    const gap = midHigh - midLow;
    if (gap > 0 && gap < atr * 5) {
      // The middle 40% of the gap is the no-trade zone; the outer 30% each side is
      // the reaction band where a trade is still viable.
      const band = gap * 0.4;
      const center = (midHigh + midLow) / 2;
      noTradeAreas.push({
        upperPrice: center + band / 2,
        lowerPrice: center - band / 2,
        label: 'No-trade band — between opposing zones',
      });
    }
  }
  for (const z of zones) {
    const h = z.upperPrice - z.lowerPrice;
    if (h > atr * 1.2) {
      noTradeAreas.push({
        upperPrice: z.upperPrice,
        lowerPrice: z.lowerPrice,
        label: `Zone too wide (${(h / atr).toFixed(1)}× ATR) — wait for an edge reaction`,
      });
    }
  }

  const biasSummary =
    bias === 'bullish'
      ? 'Bullish bias — major structure and reactions favour the upside.'
      : bias === 'bearish'
        ? 'Bearish bias — major structure and reactions favour the downside.'
        : 'Neutral bias — no directional edge; wait for structure to resolve.';

  return {
    biasSummary,
    structuralLevels,
    strongestZones,
    liquidityObjectives: liquidityPools.filter((p) => !p.swept).slice(0, 4),
    bullishScenario,
    bearishScenario,
    noTradeAreas,
  };
}

function assessTradeability(
  condition: MarketIntelligence['condition'],
  report: IntelligenceReport,
  price: number
): { tradeable: boolean; noTradeReason: string | null } {
  if (condition === 'TRANSITIONING') {
    return {
      tradeable: false,
      noTradeReason: 'Market is transitioning — no clean structural edge right now.',
    };
  }
  // Price sitting inside a no-trade band means there is nothing worth trading yet.
  const inNoTrade = report.noTradeAreas.find(
    (a) => price >= a.lowerPrice && price <= a.upperPrice
  );
  if (inNoTrade) {
    return { tradeable: false, noTradeReason: inNoTrade.label };
  }
  return { tradeable: true, noTradeReason: null };
}
