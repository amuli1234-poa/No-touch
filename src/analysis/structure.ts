import type {
  LiquiditySweepEvent,
  MarketDirection,
  StructureBreakEvent,
  SwingPoint,
} from '../types/analysis';
import type { Candle } from '../types/market';
import { formatPrice } from '../utils/derivParser';
import { getCandleStats, getRecentAverageBody } from './swings';

export interface StructureAnalysisResult {
  direction: MarketDirection;
  structureLabel: string;
  breaks: StructureBreakEvent[];
  latestBreak: StructureBreakEvent | null;
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
  liquiditySweeps: LiquiditySweepEvent[];
  swingStructureSequence: {
    hh: boolean;
    hl: boolean;
    lh: boolean;
    ll: boolean;
  };
}

export function analyzeMarketStructure(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  atrs: readonly number[],
  precision: number
): StructureAnalysisResult {
  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  const lastSwingHigh = highs.length > 0 ? highs[highs.length - 1] : null;
  const lastSwingLow = lows.length > 0 ? lows[lows.length - 1] : null;

  if (candles.length < 20 || highs.length < 2 || lows.length < 2) {
    return {
      direction: 'NEUTRAL',
      structureLabel: 'Insufficient swing structure',
      breaks: [],
      latestBreak: null,
      lastSwingHigh,
      lastSwingLow,
      liquiditySweeps: [],
      swingStructureSequence: { hh: false, hl: false, lh: false, ll: false },
    };
  }

  // Label swing points with HH, HL, LH, LL
  for (let i = 1; i < highs.length; i++) {
    highs[i].swingLabel = highs[i].price > highs[i - 1].price ? 'HH' : 'LH';
  }
  for (let i = 1; i < lows.length; i++) {
    lows[i].swingLabel = lows[i].price > lows[i - 1].price ? 'HL' : 'LL';
  }

  let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  const breaks: StructureBreakEvent[] = [];
  const liquiditySweeps: LiquiditySweepEvent[] = [];

  let activeHigh: SwingPoint | null = null;
  let activeLow: SwingPoint | null = null;
  const brokenHighIndices = new Set<number>();
  const brokenLowIndices = new Set<number>();
  const sweptHighIndices = new Set<number>();
  const sweptLowIndices = new Set<number>();

  let swingCursor = 0;

  for (let i = 0; i < candles.length; i++) {
    while (swingCursor < swings.length && swings[swingCursor].index <= i - 1) {
      const s = swings[swingCursor];
      if (s.type === 'high') {
        activeHigh = s;
      } else {
        activeLow = s;
      }
      swingCursor++;
    }

    const bar = candles[i];
    const atr = atrs[i] || 1e-6;
    const stats = getCandleStats(bar);
    const avgBody = getRecentAverageBody(candles, i, 14);
    const hasMeaningfulClose =
      stats.body >= avgBody * 0.75 && stats.bodyRatio >= 0.42;

    // Check for Liquidity Sweeps (Wick poked beyond swing high/low, but candle closed back inside)
    if (
      activeHigh &&
      !brokenHighIndices.has(activeHigh.index) &&
      !sweptHighIndices.has(activeHigh.index) &&
      bar.high > activeHigh.price + atr * 0.02 &&
      bar.close < activeHigh.price &&
      stats.upperWick >= stats.body * 0.75
    ) {
      sweptHighIndices.add(activeHigh.index);
      liquiditySweeps.push({
        id: `sweep-high-${bar.time}`,
        type: 'BEARISH_SWEEP',
        time: bar.time,
        index: i,
        sweepPrice: bar.high,
        reversalClosePrice: bar.close,
        sweptLevel: activeHigh.price,
        reason: `Buy-side liquidity swept above ${formatPrice(activeHigh.price, precision)}; price rejected and closed back inside.`,
      });
    }

    if (
      activeLow &&
      !brokenLowIndices.has(activeLow.index) &&
      !sweptLowIndices.has(activeLow.index) &&
      bar.low < activeLow.price - atr * 0.02 &&
      bar.close > activeLow.price &&
      stats.lowerWick >= stats.body * 0.75
    ) {
      sweptLowIndices.add(activeLow.index);
      liquiditySweeps.push({
        id: `sweep-low-${bar.time}`,
        type: 'BULLISH_SWEEP',
        time: bar.time,
        index: i,
        sweepPrice: bar.low,
        reversalClosePrice: bar.close,
        sweptLevel: activeLow.price,
        reason: `Sell-side liquidity swept below ${formatPrice(activeLow.price, precision)}; price rejected and closed back inside.`,
      });
    }

    // Genuine BOS / CHOCH requires full candle close beyond swing level (not just a wick touch)
    if (
      activeHigh &&
      !brokenHighIndices.has(activeHigh.index) &&
      bar.close > activeHigh.price + atr * 0.03 &&
      stats.isBullish &&
      hasMeaningfulClose
    ) {
      brokenHighIndices.add(activeHigh.index);
      const isChoch = bias === 'bearish';
      const kind: 'BOS' | 'CHOCH' = isChoch ? 'CHOCH' : 'BOS';
      const levelStr = formatPrice(activeHigh.price, precision);
      const momentumConfirmed =
        stats.body >= avgBody * 1.15 && stats.closePosition >= 0.7;

      breaks.push({
        id: `${kind.toLowerCase()}-bull-${bar.time}`,
        kind,
        direction: 'bullish',
        time: bar.time,
        index: i,
        price: bar.close,
        brokenLevel: activeHigh.price,
        momentumConfirmed,
        reason: isChoch
          ? `BULLISH CHOCH — Price broke bearish lower-high structure at ${levelStr} with strong close.`
          : `BULLISH BOS — Price closed above previous significant swing high at ${levelStr}.`,
      });
      bias = 'bullish';
    } else if (
      activeLow &&
      !brokenLowIndices.has(activeLow.index) &&
      bar.close < activeLow.price - atr * 0.03 &&
      stats.isBearish &&
      hasMeaningfulClose
    ) {
      brokenLowIndices.add(activeLow.index);
      const isChoch = bias === 'bullish';
      const kind: 'BOS' | 'CHOCH' = isChoch ? 'CHOCH' : 'BOS';
      const levelStr = formatPrice(activeLow.price, precision);
      const momentumConfirmed =
        stats.body >= avgBody * 1.15 && stats.closePosition <= 0.3;

      breaks.push({
        id: `${kind.toLowerCase()}-bear-${bar.time}`,
        kind,
        direction: 'bearish',
        time: bar.time,
        index: i,
        price: bar.close,
        brokenLevel: activeLow.price,
        momentumConfirmed,
        reason: isChoch
          ? `BEARISH CHOCH — Price broke bullish higher-low structure at ${levelStr} with strong close.`
          : `BEARISH BOS — Price closed below previous significant swing low at ${levelStr}.`,
      });
      bias = 'bearish';
    }
  }

  // Evaluate swing sequence from last two swing highs and swing lows
  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];
  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];

  const hh = h2.price > h1.price;
  const hl = l2.price > l1.price;
  const lh = h2.price < h1.price;
  const ll = l2.price < l1.price;

  const latestBreak = breaks.length > 0 ? breaks[breaks.length - 1] : null;
  let direction: MarketDirection = 'RANGING';
  let structureLabel = 'Consolidating / Ranging';

  if (hh && hl) {
    direction = 'BULLISH';
    structureLabel = 'Higher Highs & Higher Lows (HH / HL)';
  } else if (lh && ll) {
    direction = 'BEARISH';
    structureLabel = 'Lower Highs & Lower Lows (LH / LL)';
  } else if (latestBreak && candles.length - 1 - latestBreak.index <= 18) {
    direction = latestBreak.direction === 'bullish' ? 'BULLISH' : 'BEARISH';
    structureLabel =
      latestBreak.kind === 'CHOCH'
        ? `${latestBreak.direction === 'bullish' ? 'Bullish' : 'Bearish'} Shift after CHOCH`
        : `${latestBreak.direction === 'bullish' ? 'Bullish' : 'Bearish'} Continuation (BOS)`;
  } else if (hh && !ll) {
    direction = 'BULLISH';
    structureLabel = 'Bullish Bias (Higher High intact)';
  } else if (ll && !hh) {
    direction = 'BEARISH';
    structureLabel = 'Bearish Bias (Lower Low intact)';
  } else {
    direction = 'RANGING';
    structureLabel = 'Ranging / Mixed Swings';
  }

  return {
    direction,
    structureLabel,
    breaks: breaks.slice(-6),
    latestBreak,
    lastSwingHigh,
    lastSwingLow,
    liquiditySweeps: liquiditySweeps.slice(-4),
    swingStructureSequence: { hh, hl, lh, ll },
  };
}
