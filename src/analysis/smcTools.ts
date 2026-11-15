import { computeAtrSeries, detectSwings, getCandleStats } from './swings';
import { confirmedOnly } from './trendlineDetection';
import type { SwingPoint } from './swings';
import type { Candle } from '../types/market';

/**
 * Shared SMC / ICT DETECTION primitives (pure functions — no decisions).
 *
 * Each independent module (SMC/ICT AI, Liquidity AI, FVG & Imbalance AI, Order Block AI)
 * composes these detectors differently and makes its OWN decisions. The detectors only
 * report what the candles actually show; they never label a signal.
 */

export type FvgKind = 'BULLISH' | 'BEARISH';
export type FvgState =
  | 'FRESH'
  | 'APPROACHING'
  | 'TESTED'
  | 'PARTIALLY_MITIGATED'
  | 'FULLY_MITIGATED'
  | 'INVALIDATED'
  | 'IFVG';

export interface Fvg {
  id: string;
  kind: FvgKind;
  upperPrice: number;
  lowerPrice: number;
  /** Consequent encroachment (50% level). */
  ce: number;
  index: number;
  time: number;
  sizeAtr: number;
  displacementAtr: number;
  state: FvgState;
  quality: number;
  reason: string;
}

/**
 * Three-candle fair value gaps. A genuine FVG requires a displacement candle whose body
 * is materially larger than average AND a real gap (candle 3's low above candle 1's high,
 * or vice versa). Ordinary spacing / micro-slivers are rejected.
 */
export function detectFvgs(
  candles: readonly Candle[],
  atr: number,
  precision: number,
  price: number
): Fvg[] {
  const bars = confirmedOnly(candles);
  if (bars.length < 5 || atr <= 0) return [];
  const out: Fvg[] = [];

  for (let i = 1; i < bars.length - 1; i++) {
    const a = bars[i - 1];
    const b = bars[i];
    const c = bars[i + 1];
    const stats = getCandleStats(b);
    const bodyAtr = stats.body / atr;

    // Bullish FVG: gap between candle 1 high and candle 3 low.
    if (c.low > a.high) {
      const lower = a.high;
      const upper = c.low;
      const sizeAtr = (upper - lower) / atr;
      if (sizeAtr < 0.12 || bodyAtr < 1.1 || !stats.isBullish) continue;
      out.push(
        buildFvg('BULLISH', upper, lower, i, b.time, sizeAtr, bodyAtr, bars, price, precision)
      );
    }
    // Bearish FVG: gap between candle 1 low and candle 3 high.
    if (c.high < a.low) {
      const upper = a.low;
      const lower = c.high;
      const sizeAtr = (upper - lower) / atr;
      if (sizeAtr < 0.12 || bodyAtr < 1.1 || !stats.isBearish) continue;
      out.push(
        buildFvg('BEARISH', upper, lower, i, b.time, sizeAtr, bodyAtr, bars, price, precision)
      );
    }
  }

  // Newest first, capped so the chart never accumulates stale imbalances.
  return out.sort((x, y) => y.index - x.index).slice(0, 8);
}

function buildFvg(
  kind: FvgKind,
  upper: number,
  lower: number,
  index: number,
  time: number,
  sizeAtr: number,
  displacementAtr: number,
  bars: readonly Candle[],
  price: number,
  precision: number
): Fvg {
  const ce = (upper + lower) / 2;
  let touched = false;
  let filled = 0;
  let invalidated = false;

  for (let i = index + 2; i < bars.length; i++) {
    const bar = bars[i];
    const entered = bar.low <= upper && bar.high >= lower;
    if (entered) touched = true;
    if (kind === 'BULLISH') {
      // Filled as price trades back down into the gap.
      if (bar.low <= ce) filled = Math.max(filled, 1);
      if (bar.low <= lower) filled = 2;
      // Invalidated when price closes decisively below the gap.
      if (bar.close < lower) invalidated = true;
    } else {
      if (bar.high >= ce) filled = Math.max(filled, 1);
      if (bar.high >= upper) filled = 2;
      if (bar.close > upper) invalidated = true;
    }
  }

  let state: FvgState;
  if (invalidated) state = 'IFVG';
  else if (filled === 2) state = 'FULLY_MITIGATED';
  else if (filled === 1) state = 'PARTIALLY_MITIGATED';
  else if (touched) state = 'TESTED';
  else state = 'FRESH';

  // APPROACHING = price within ~1.2× the gap height of the proximal edge but not inside.
  const gapHeight = Math.max(upper - lower, 1e-9);
  const nearEdge =
    kind === 'BULLISH'
      ? price > upper && price - upper < gapHeight * 1.2
      : price < lower && lower - price < gapHeight * 1.2;
  if (state === 'FRESH' && nearEdge) state = 'APPROACHING';

  const quality = Math.max(
    0,
    Math.min(100, Math.round(40 + Math.min(30, sizeAtr * 20) + Math.min(30, displacementAtr * 12)))
  );

  return {
    id: `fvg-${kind.toLowerCase()}-${time}`,
    kind,
    upperPrice: upper,
    lowerPrice: lower,
    ce,
    index,
    time,
    sizeAtr: Number(sizeAtr.toFixed(2)),
    displacementAtr: Number(displacementAtr.toFixed(2)),
    state,
    quality,
    reason: `${kind === 'BULLISH' ? 'Bullish' : 'Bearish'} FVG ${lower.toFixed(
      precision
    )}–${upper.toFixed(precision)} (${sizeAtr.toFixed(2)}× ATR, ${displacementAtr.toFixed(
      2
    )}× displacement) · ${state.replace(/_/g, ' ').toLowerCase()}.`,
  };
}

export interface OrderBlock {
  id: string;
  kind: FvgKind;
  upperPrice: number;
  lowerPrice: number;
  index: number;
  time: number;
  displacementAtr: number;
  mitigated: boolean;
  invalidated: boolean;
  roleReversed: boolean;
  quality: number;
  reason: string;
}

/**
 * Order blocks: the LAST opposing candle before a displacement leg that breaks structure.
 * A valid OB needs a real displacement candle (body ≥ 1.4× average) after it. A broken OB
 * is flagged `roleReversed` (candidate breaker) only when price closed decisively beyond it.
 */
export function detectOrderBlocks(
  candles: readonly Candle[],
  atr: number,
  precision: number,
  price: number
): OrderBlock[] {
  const bars = confirmedOnly(candles);
  if (bars.length < 10 || atr <= 0) return [];
  const out: OrderBlock[] = [];

  for (let i = 2; i < bars.length - 1; i++) {
    const ob = bars[i];
    const disp = bars[i + 1];
    const stats = getCandleStats(disp);
    const bodyAtr = stats.body / atr;
    if (bodyAtr < 1.4) continue;

    const bull = stats.isBullish;
    const obStats = getCandleStats(ob);
    const opposing = bull ? obStats.isBearish : obStats.isBullish;
    if (!opposing) continue;

    const upper = Math.max(ob.open, ob.close);
    const lower = Math.min(ob.open, ob.close);
    if ((upper - lower) / atr > 3) continue; // too large to be a refined block

    let mitigated = false;
    let invalidated = false;
    for (let j = i + 2; j < bars.length; j++) {
      const bar = bars[j];
      if (bar.low <= upper && bar.high >= lower) mitigated = true;
      if (bull ? bar.close < lower : bar.close > upper) invalidated = true;
    }
    const roleReversed = invalidated;

    const quality = Math.max(
      0,
      Math.min(
        100,
        Math.round(50 + Math.min(25, bodyAtr * 12) + (mitigated ? 0 : 15) - (invalidated ? 20 : 0))
      )
    );

    out.push({
      id: `ob-${bull ? 'bull' : 'bear'}-${ob.time}`,
      kind: bull ? 'BULLISH' : 'BEARISH',
      upperPrice: upper,
      lowerPrice: lower,
      index: i,
      time: ob.time,
      displacementAtr: Number(bodyAtr.toFixed(2)),
      mitigated,
      invalidated,
      roleReversed,
      quality,
      reason: `${bull ? 'Bullish' : 'Bearish'} order block ${lower.toFixed(
        precision
      )}–${upper.toFixed(precision)} left by ${bodyAtr.toFixed(2)}× ATR displacement${
        roleReversed ? ' · invalidated → breaker candidate' : mitigated ? ' · mitigated' : ' · fresh'
      }.`,
    });
  }

  void price;
  return out.sort((a, b) => b.index - a.index).slice(0, 8);
}

export type LiquiditySide = 'BSL' | 'SSL';

export interface LiquidityPool {
  id: string;
  side: LiquiditySide;
  price: number;
  upperPrice: number;
  lowerPrice: number;
  /** Number of swing points forming the pool (≥2 = equal highs/lows). */
  touches: number;
  time: number;
  swept: boolean;
  sweptTime: number | null;
  /** Weak highs/lows are untested and thus more likely to be raided. */
  weak: boolean;
  reason: string;
}

/**
 * Liquidity pools: clustered swing highs (buy-side) and swing lows (sell-side). Equal
 * highs/lows (≥2 swing points within tolerance) are the strongest pools. A pool is swept
 * when a wick trades through it; genuinely raided only if price then closes back inside.
 */
export function detectLiquidityPools(
  candles: readonly Candle[],
  atr: number,
  precision: number,
  price: number
): LiquidityPool[] {
  const bars = confirmedOnly(candles);
  if (bars.length < 20 || atr <= 0) return [];
  const swings = detectSwings(bars, 3, 3);
  const tolerance = atr * 0.25;

  const cluster = (points: SwingPoint[], side: LiquiditySide): LiquidityPool[] => {
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const pools: LiquidityPool[] = [];
    let group: SwingPoint[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const prices = group.map((g) => g.price);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const upper = Math.max(...prices) + atr * 0.08;
      const lower = Math.min(...prices) - atr * 0.08;
      const fromIndex = Math.max(...group.map((g) => g.index)) + 1;
      let swept = false;
      let sweptTime: number | null = null;
      for (let i = fromIndex; i < bars.length; i++) {
        const bar = bars[i];
        const breached = side === 'BSL' ? bar.high > upper : bar.low < lower;
        if (breached) {
          swept = true;
          sweptTime = bar.time;
        }
      }
      const weak = side === 'BSL' ? price < avg : price > avg;
      pools.push({
        id: `liq-${side.toLowerCase()}-${Math.round(avg * 1e4)}`,
        side,
        price: avg,
        upperPrice: upper,
        lowerPrice: lower,
        touches: group.length,
        time: Math.max(...group.map((g) => g.time)),
        swept,
        sweptTime,
        weak,
        reason:
          side === 'BSL'
            ? `${group.length >= 2 ? 'Equal-high' : 'Swing-high'} buy-side liquidity at ${avg.toFixed(
                precision
              )}${weak ? ' (weak high — untested above price)' : ''}${swept ? ' · swept' : ''}.`
            : `${group.length >= 2 ? 'Equal-low' : 'Swing-low'} sell-side liquidity at ${avg.toFixed(
                precision
              )}${weak ? ' (weak low — untested below price)' : ''}${swept ? ' · swept' : ''}.`,
      });
      group = [];
    };

    for (const p of sorted) {
      if (group.length === 0 || Math.abs(p.price - group[group.length - 1].price) <= tolerance) {
        group.push(p);
      } else {
        flush();
        group = [p];
      }
    }
    flush();
    return pools.filter((p) => p.touches >= 1);
  };

  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');
  const pools = [...cluster(highs, 'BSL'), ...cluster(lows, 'SSL')];

  // Keep the most relevant pools: unswept first, then nearest to price.
  return pools
    .sort((a, b) => {
      if (a.swept !== b.swept) return a.swept ? 1 : -1;
      return Math.abs(a.price - price) - Math.abs(b.price - price);
    })
    .slice(0, 8);
}

export interface SweepEvent {
  id: string;
  side: LiquiditySide;
  /** Genuine sweep = wick beyond the level then close back inside. */
  genuine: boolean;
  time: number;
  level: number;
  extremePrice: number;
  closePrice: number;
  /** True when a body-close breakout followed (not a sweep — a real break). */
  bodyBreakout: boolean;
  followedByDisplacement: boolean;
  reason: string;
}

/**
 * Classifies liquidity events at the pools: genuine sweep (wick raid + close back),
 * wick-only grab, body-close breakout, or a sweep followed by displacement.
 */
export function detectSweeps(
  candles: readonly Candle[],
  pools: readonly LiquidityPool[],
  atr: number,
  precision: number
): SweepEvent[] {
  const bars = confirmedOnly(candles);
  if (bars.length < 10 || atr <= 0) return [];
  const events: SweepEvent[] = [];

  for (const pool of pools) {
    for (let i = bars.length - 20; i < bars.length; i++) {
      if (i < 1) continue;
      const bar = bars[i];
      const stats = getCandleStats(bar);
      const next = bars[i + 1];
      if (pool.side === 'BSL') {
        const beyond = bar.high > pool.upperPrice;
        if (!beyond) continue;
        const bodyBreak = stats.isBullish && bar.close > pool.upperPrice;
        const closedBack = bar.close < pool.upperPrice;
        const disp = next ? getCandleStats(next).body / atr : 0;
        events.push({
          id: `sweep-bsl-${bar.time}`,
          side: 'BSL',
          genuine: closedBack,
          time: bar.time,
          level: pool.upperPrice,
          extremePrice: bar.high,
          closePrice: bar.close,
          bodyBreakout: bodyBreak,
          followedByDisplacement: disp >= 1.2,
          reason: closedBack
            ? `Buy-side liquidity raided at ${pool.upperPrice.toFixed(
                precision
              )} — wick swept the highs and closed back below (bearish sweep).`
            : bodyBreak
              ? `Buy-side liquidity broken with a body close above ${pool.upperPrice.toFixed(
                  precision
                )} — genuine breakout, not a sweep.`
              : `Wick probed buy-side liquidity at ${pool.upperPrice.toFixed(precision)}.`,
        });
      } else {
        const beyond = bar.low < pool.lowerPrice;
        if (!beyond) continue;
        const bodyBreak = stats.isBearish && bar.close < pool.lowerPrice;
        const closedBack = bar.close > pool.lowerPrice;
        const disp = next ? getCellBody(next, atr) : 0;
        events.push({
          id: `sweep-ssl-${bar.time}`,
          side: 'SSL',
          genuine: closedBack,
          time: bar.time,
          level: pool.lowerPrice,
          extremePrice: bar.low,
          closePrice: bar.close,
          bodyBreakout: bodyBreak,
          followedByDisplacement: disp >= 1.2,
          reason: closedBack
            ? `Sell-side liquidity raided at ${pool.lowerPrice.toFixed(
                precision
              )} — wick swept the lows and closed back above (bullish sweep).`
            : bodyBreak
              ? `Sell-side liquidity broken with a body close below ${pool.lowerPrice.toFixed(
                  precision
                )} — genuine breakdown, not a sweep.`
              : `Wick probed sell-side liquidity at ${pool.lowerPrice.toFixed(precision)}.`,
        });
      }
    }
  }

  return events.sort((a, b) => b.time - a.time).slice(0, 6);
}

function getCellBody(bar: Candle, atr: number): number {
  return getCandleStats(bar).body / atr;
}

/** ATR helper re-export so module engines import from one place. */
export function smcAtr(candles: readonly Candle[]): number {
  const bars = confirmedOnly(candles);
  if (bars.length === 0) return 1e-6;
  const series = computeAtrSeries(bars, 14);
  return series[series.length - 1] || 1e-6;
}
