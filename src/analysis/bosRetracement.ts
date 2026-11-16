import type { AiDirection, AiZone } from '../types/aiModule';
import type { Candle, MarketFamily } from '../types/market';
import type {
  BosDealingRange,
  BosEntryRetest,
  BosEntryZone,
  BosEventKind,
  BosEvidenceItem,
  BosLtfConfirmation,
  BosRangePosition,
  BosRejection,
  BosRetracementReadout,
  BosSetupState,
  BosSweep,
} from '../types/bosRetracement';
import { formatPrice } from '../utils/derivParser';
import { detectFvgs, detectLiquidityPools, detectOrderBlocks } from './smcTools';
import { computeAtrSeries, detectSwings, getCandleStats, getRecentAverageBody } from './swings';
import { confirmedOnly } from './trendlineDetection';

/**
 * BOS RETRACEMENT & REJECTION AI.
 *
 * A BOS is a SETUP DETECTOR, never an automatic entry trigger. This module validates the
 * break, locks the dealing range to the protected swing + impulse extreme that produced it,
 * waits for a retracement into the discount / premium (preferably the 62–79% OTE), detects a
 * genuine liquidity sweep and rejection, requires a lower-timeframe market-structure shift,
 * and only then publishes a single entry with a structural stop and an opposing-liquidity
 * target at a configurable minimum reward-to-risk.
 *
 * Every distance is ATR-normalised (never a fixed pip distance) and scaled per market
 * family, so one set of rules adapts across every index and timeframe.
 */

/** Bars after the BOS beyond which the setup expires (no chase). */
export const MAX_BARS_SINCE_BOS = 42;
/** ATR-relative tolerance for "at the zone". */
const ZONE_TOLERANCE_ATR = 0.15;
/** Minimum estimated reward-to-risk for a published trade (configurable). */
export const BOS_DEFAULT_MIN_RR = 1.5;

export interface BosRetracementParams {
  symbol: string;
  precision: number;
  marketFamily: MarketFamily;
  /** M15 structure candles (confirmed only) — where the BOS and dealing range are read. */
  structureCandles: readonly Candle[];
  /** M5 setup candles — used for the rejection/MSS development read. */
  setupCandles?: readonly Candle[];
  /** M3 entry-setup confirmation candles. */
  confirmCandles?: readonly Candle[];
  /** M1 entry candles — the lower-timeframe structure shift is confirmed here. */
  entryCandles?: readonly Candle[];
  /** M7 trend candles — the higher-timeframe alignment gate. */
  trendCandles?: readonly Candle[];
  /** Higher-timeframe directional read (RISE/FALL), or null when indeterminate. */
  htfDirection?: AiDirection | null;
  /** Configurable minimum estimated reward-to-risk (default 2). */
  minRR?: number;
}

/** A validated break of structure (continuation BOS or reversal CHoCH/MSS). */
export interface BosEvent {
  kind: BosEventKind;
  direction: AiDirection;
  brokenLevel: number;
  breakIndex: number;
  breakTime: number;
  /** True when the break candle showed displacement (body ≥ 1.15× average). */
  momentumConfirmed: boolean;
  /** The swing index whose level was broken. */
  brokenSwingIndex: number;
  /** The protected swing (origin) index the impulse launched from. */
  originIndex: number;
  /** The impulse extreme index (high for bullish, low for bearish). */
  extremeIndex: number;
  reason: string;
}

export interface BosTrade {
  direction: AiDirection;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number | null;
  rr: number;
  confirmedBarTime: number;
  reasons: string[];
  confirmations: string[];
}

export interface BosRetracementResult {
  state: BosSetupState;
  event: BosEvent | null;
  readout: BosRetracementReadout | null;
  score: number;
  trade: BosTrade | null;
  /** Chart zones for the current valid setup (dealing range + entry zone). */
  zones: AiZone[];
  statusExplanation: string;
  rejectionReason?: string;
}

/** Per-market volatility scale so noisier families get proportionally wider tolerance. */
function marketVolFactor(family: MarketFamily): number {
  switch (family) {
    case 'JUMP':
      return 1.25;
    case 'STEP':
      return 1.15;
    default:
      return 1;
  }
}

function lastOf(arr: readonly Candle[]): Candle | null {
  return arr.length ? arr[arr.length - 1] : null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Validates EVERY external BOS using confirmed swing points, decisive candle closes and
 * displacement. Wick-only breaks are ignored. Each event is tagged continuation (agrees
 * with the prior bias) or reversal (CHoCH/MSS). Events are returned oldest → newest.
 */
export function detectBosEvents(
  structure: readonly Candle[],
  atr: number,
  precision: number,
  volFactor = 1
): BosEvent[] {
  if (structure.length < 30 || atr <= 0) return [];
  const swings = detectSwings(structure, 3, 3);
  // A single confirmed high and low is enough to validate a break; requiring more would
  // silently drop genuine early BOS events on short histories.
  if (swings.length < 2) return [];

  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  let bias: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  let activeHigh: (typeof highs)[number] | null = null;
  let activeLow: (typeof lows)[number] | null = null;
  let cursor = 0;
  const brokenHigh = new Set<number>();
  const brokenLow = new Set<number>();
  const events: BosEvent[] = [];

  for (let i = 0; i < structure.length; i++) {
    while (cursor < swings.length && swings[cursor].index <= i - 1) {
      const s = swings[cursor];
      if (s.type === 'high') activeHigh = s;
      else activeLow = s;
      cursor++;
    }
    const bar = structure[i];
    const stats = getCandleStats(bar);
    const avgBody = getRecentAverageBody(structure, i, 14);
    // Displacement gate (ATR-normalised, never a fixed distance).
    const decisive = stats.body >= avgBody * 1.15 && stats.bodyRatio >= 0.42;
    const minBeyond = atr * 0.1 * volFactor;

    if (
      activeHigh &&
      !brokenHigh.has(activeHigh.index) &&
      bar.close > activeHigh.price + minBeyond &&
      stats.isBullish &&
      decisive
    ) {
      brokenHigh.add(activeHigh.index);
      const kind: BosEventKind = bias === 'bearish' ? 'REVERSAL' : 'CONTINUATION';
      events.push(
        buildEvent(
          'RISE',
          kind,
          activeHigh.index,
          activeHigh.price,
          i,
          stats.body >= avgBody * 1.3,
          structure,
          highs,
          lows,
          precision
        )
      );
      bias = 'bullish';
    } else if (
      activeLow &&
      !brokenLow.has(activeLow.index) &&
      bar.close < activeLow.price - minBeyond &&
      stats.isBearish &&
      decisive
    ) {
      brokenLow.add(activeLow.index);
      const kind: BosEventKind = bias === 'bullish' ? 'REVERSAL' : 'CONTINUATION';
      events.push(
        buildEvent(
          'FALL',
          kind,
          activeLow.index,
          activeLow.price,
          i,
          stats.body >= avgBody * 1.3,
          structure,
          highs,
          lows,
          precision
        )
      );
      bias = 'bearish';
    }
  }

  return events;
}

/** The most recent validated BOS event (or null). */
export function detectBosEvent(
  structure: readonly Candle[],
  atr: number,
  precision: number,
  volFactor = 1
): BosEvent | null {
  const events = detectBosEvents(structure, atr, precision, volFactor);
  return events.length ? events[events.length - 1] : null;
}

function buildEvent(
  direction: AiDirection,
  kind: BosEventKind,
  brokenSwingIndex: number,
  brokenLevel: number,
  breakIndex: number,
  momentumConfirmed: boolean,
  structure: readonly Candle[],
  highs: readonly { index: number; price: number }[],
  lows: readonly { index: number; price: number }[],
  precision: number
): BosEvent {
  const bullish = direction === 'RISE';
  // Protected swing = the most recent opposite swing BEFORE the broken one (the origin of
  // the impulse). The impulse extreme is the furthest price reached from the origin to the
  // break candle. Anchors are fixed here and never re-derived.
  const originCandidates = (bullish ? lows : highs).filter((s) => s.index < brokenSwingIndex);
  const origin = originCandidates.length
    ? originCandidates[originCandidates.length - 1]
    : null;
  const fromIndex = origin ? origin.index : Math.max(0, brokenSwingIndex - 30);
  let extremeIndex = breakIndex;
  let extreme = bullish ? -Infinity : Infinity;
  for (let i = fromIndex; i <= breakIndex; i++) {
    const bar = structure[i];
    if (bullish) {
      if (bar.high >= extreme) {
        extreme = bar.high;
        extremeIndex = i;
      }
    } else if (bar.low <= extreme) {
      extreme = bar.low;
      extremeIndex = i;
    }
  }
  return {
    kind,
    direction,
    brokenLevel,
    breakIndex,
    breakTime: structure[breakIndex].time,
    momentumConfirmed,
    brokenSwingIndex,
    originIndex: origin ? origin.index : fromIndex,
    extremeIndex,
    reason: `${bullish ? 'Bullish' : 'Bearish'} ${kind === 'REVERSAL' ? 'CHoCH / MSS' : 'BOS'} — a decisive ${
      bullish ? 'bullish' : 'bearish'
    } close beyond the swing ${bullish ? 'high' : 'low'} at ${formatPrice(brokenLevel, precision)} with displacement (wick-only breaks rejected).`,
  };
}

/**
 * Locks the dealing range to the protected swing (origin) and the impulse extreme that
 * produced the BOS. The anchors come from the event and are never moved arbitrarily.
 */
export function lockDealingRange(
  structure: readonly Candle[],
  event: BosEvent,
  precision: number
): BosDealingRange {
  const bullish = event.direction === 'RISE';
  let high = -Infinity;
  let low = Infinity;
  for (let i = event.originIndex; i <= event.extremeIndex; i++) {
    const bar = structure[i];
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
  }
  // The extreme is the impulse target; the opposite edge is the protected swing extreme.
  const extremePrice = bullish ? high : low;
  const originPrice = bullish ? low : high;
  // Ensure the extremes are consistent even if the scan window clipped them.
  high = Math.max(high, event.brokenLevel, extremePrice);
  low = Math.min(low, event.brokenLevel, originPrice);
  const height = Math.max(1e-9, high - low);
  const equilibrium = (high + low) / 2;
  const ote62 = bullish ? high - height * 0.62 : low + height * 0.62;
  const ote79 = bullish ? high - height * 0.79 : low + height * 0.79;
  return {
    kind: event.kind,
    direction: event.direction,
    high,
    low,
    equilibrium,
    ote62,
    ote79,
    brokenLevel: event.brokenLevel,
    originTime: structure[event.originIndex]?.time ?? structure[0].time,
    extremeTime: structure[event.extremeIndex]?.time ?? structure[structure.length - 1].time,
    breakTime: event.breakTime,
    height,
  };
}

function rangePosition(range: BosDealingRange, price: number): BosRangePosition {
  const rel = (price - range.low) / Math.max(1e-9, range.height);
  if (rel > 0.6) return 'PREMIUM';
  if (rel < 0.4) return 'DISCOUNT';
  return 'EQUILIBRIUM';
}

/**
 * Builds the retracement entry zone: the discount (bullish) / premium (bearish) of the
 * locked range, centred on the preferred 62–79% OTE band, expanded to include any genuine
 * order block or FVG that overlaps that half of the range.
 */
export function buildEntryZone(
  structure: readonly Candle[],
  range: BosDealingRange,
  atr: number,
  precision: number,
  price: number
): BosEntryZone {
  const bullish = range.direction === 'RISE';
  const oteLow = Math.min(range.ote62, range.ote79);
  const oteHigh = Math.max(range.ote62, range.ote79);
  let zoneLow = oteLow;
  let zoneHigh = oteHigh;
  const halfLow = bullish ? range.low : range.equilibrium;
  const halfHigh = bullish ? range.equilibrium : range.high;

  const obs = detectOrderBlocks(structure, atr, precision, price);
  const fvgs = detectFvgs(structure, atr, precision, price);
  let orderBlockOverlap = false;
  let fvgOverlap = false;

  const overlaps = (lo: number, hi: number) => hi >= halfLow && lo <= halfHigh;
  for (const ob of obs) {
    if (ob.kind !== (bullish ? 'BULLISH' : 'BEARISH') || ob.invalidated) continue;
    if (!overlaps(ob.lowerPrice, ob.upperPrice)) continue;
    orderBlockOverlap = true;
    zoneLow = Math.min(zoneLow, clamp(ob.lowerPrice, halfLow, halfHigh));
    zoneHigh = Math.max(zoneHigh, clamp(ob.upperPrice, halfLow, halfHigh));
  }
  for (const fvg of fvgs) {
    if (fvg.kind !== (bullish ? 'BULLISH' : 'BEARISH') || fvg.state === 'IFVG') continue;
    if (!overlaps(fvg.lowerPrice, fvg.upperPrice)) continue;
    fvgOverlap = true;
    zoneLow = Math.min(zoneLow, clamp(fvg.lowerPrice, halfLow, halfHigh));
    zoneHigh = Math.max(zoneHigh, clamp(fvg.upperPrice, halfLow, halfHigh));
  }

  // Clamp the zone strictly inside the discount/premium half so the middle is never entered.
  zoneLow = clamp(zoneLow, halfLow, halfHigh);
  zoneHigh = clamp(zoneHigh, halfLow, halfHigh);
  if (zoneHigh - zoneLow < atr * 0.1) {
    const mid = (zoneLow + zoneHigh) / 2;
    zoneLow = mid - atr * 0.05;
    zoneHigh = mid + atr * 0.05;
  }
  const inOte = zoneHigh >= oteLow && zoneLow <= oteHigh;
  return { low: zoneLow, high: zoneHigh, inOte, orderBlockOverlap, fvgOverlap };
}

function withinZone(zone: BosEntryZone, bar: Candle, atr: number, volFactor: number): boolean {
  const tol = atr * ZONE_TOLERANCE_ATR * volFactor;
  return bar.low <= zone.high + tol && bar.high >= zone.low - tol;
}

/** Detects a genuine sweep of the zone's distal edge (wick beyond, close back inside). */
function detectZoneSweep(
  bars: readonly Candle[],
  zone: BosEntryZone,
  range: BosDealingRange,
  atr: number,
  precision: number,
  volFactor: number
): BosSweep | null {
  const bullish = range.direction === 'RISE';
  const tol = atr * 0.05 * volFactor;
  for (let i = bars.length - 1; i >= Math.max(1, bars.length - 25); i--) {
    const bar = bars[i];
    const stats = getCandleStats(bar);
    if (bullish) {
      const beyond = bar.low < zone.low - tol;
      const closedBack = bar.close > zone.low;
      if (beyond && closedBack && stats.lowerWick >= stats.body * 0.5) {
        return {
          time: bar.time,
          extremePrice: bar.low,
          level: zone.low,
          reason: `Sell-side liquidity swept below ${formatPrice(zone.low, precision)} — the wick raided the lows and price closed back inside (bullish sweep).`,
        };
      }
    } else {
      const beyond = bar.high > zone.high + tol;
      const closedBack = bar.close < zone.high;
      if (beyond && closedBack && stats.upperWick >= stats.body * 0.5) {
        return {
          time: bar.time,
          extremePrice: bar.high,
          level: zone.high,
          reason: `Buy-side liquidity swept above ${formatPrice(zone.high, precision)} — the wick raided the highs and price closed back inside (bearish sweep).`,
        };
      }
    }
  }
  return null;
}

/** A decisive rejection candle at the zone, in the trade direction. */
function detectRejection(
  bars: readonly Candle[],
  zone: BosEntryZone,
  range: BosDealingRange,
  atr: number,
  precision: number,
  volFactor: number,
  afterTime: number
): BosRejection | null {
  const bullish = range.direction === 'RISE';
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    if (bar.time < afterTime) break;
    const stats = getCandleStats(bar);
    const inZone = withinZone(zone, bar, atr, volFactor);
    if (!inZone) continue;
    const bodyAtr = stats.body / atr;
    const directional = bullish
      ? stats.isBullish && stats.closePosition >= 0.6
      : stats.isBearish && stats.closePosition <= 0.4;
    if (directional && bodyAtr >= 0.35) {
      return {
        time: bar.time,
        price: bar.close,
        strength: Number(clamp(stats.closePosition, 0, 1).toFixed(3)),
        bodyAtr: Number(bodyAtr.toFixed(2)),
        reason: `Decisive ${bullish ? 'bullish' : 'bearish'} rejection candle at the ${bullish ? 'discount' : 'premium'} zone (${bodyAtr.toFixed(2)}× ATR body, close conviction ${(stats.closePosition * 100).toFixed(0)}%).`,
      };
    }
    void precision;
  }
  return null;
}

/**
 * The lower-timeframe market-structure shift: a decisive close through the most recent
 * minor swing (the highest high / lowest low of the bars immediately before it) with
 * displacement, in the original BOS direction. Reading the recent bar range (rather than a
 * pivot that may not exist on a monotonic retracement) keeps the confirmation honest.
 */
function detectLtfMss(
  entry: readonly Candle[],
  direction: AiDirection,
  atr: number,
  precision: number,
  afterTime: number
): BosLtfConfirmation | null {
  const bullish = direction === 'RISE';
  const bars = entry.filter((c) => c.time >= afterTime);
  if (bars.length < 2) return null;
  const K = 3;

  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    const prior = bars.slice(Math.max(0, i - K), i);
    if (prior.length < 1) continue;
    const level = bullish
      ? Math.max(...prior.map((b) => b.high))
      : Math.min(...prior.map((b) => b.low));
    const stats = getCandleStats(bar);
    const bodyAtr = stats.body / atr;
    const beyond = bullish ? bar.close - level : level - bar.close;
    const directional = bullish ? stats.isBullish : stats.isBearish;
    if (directional && beyond >= atr * 0.1 && bodyAtr >= 0.3) {
      return {
        timeframe: 'M1',
        level,
        time: bar.time,
        displacementAtr: Number(bodyAtr.toFixed(2)),
        reason: `Lower-timeframe MSS — a decisive ${bullish ? 'bullish' : 'bearish'} close through the recent minor ${bullish ? 'high' : 'low'} at ${formatPrice(level, precision)} with ${bodyAtr.toFixed(2)}× ATR displacement confirms the reversal in the original BOS direction.`,
      };
    }
  }
  return null;
}

/** A confirmation FVG the entry prefers to retest (nearest to the confirmation). */
function findEntryRetest(
  structure: readonly Candle[],
  direction: AiDirection,
  atr: number,
  precision: number,
  price: number,
  afterTime: number
): BosEntryRetest | null {
  const fvgs = detectFvgs(structure, atr, precision, price);
  const bullish = direction === 'RISE';
  const match = fvgs
    .filter(
      (f) =>
        f.kind === (bullish ? 'BULLISH' : 'BEARISH') &&
        f.state !== 'IFVG' &&
        f.time >= afterTime
    )
    .sort((a, b) => b.time - a.time)[0];
  if (!match) return null;
  return { low: match.lowerPrice, high: match.upperPrice, time: match.time };
}

/** Opposing liquidity target: the nearest unswept pool beyond the entry. */
function opposingLiquidityTarget(
  structure: readonly Candle[],
  direction: AiDirection,
  atr: number,
  precision: number,
  price: number,
  entry: number
): number | null {
  const pools = detectLiquidityPools(structure, atr, precision, price);
  const bullish = direction === 'RISE';
  const forward = pools
    .filter((p) => (bullish ? p.side === 'BSL' && p.price > entry : p.side === 'SSL' && p.price < entry))
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  return forward.length ? forward[0].price : null;
}

function buildZoneOverlays(
  range: BosDealingRange,
  zone: BosEntryZone,
  state: BosSetupState,
  precision: number
): AiZone[] {
  const dir = range.direction;
  const zones: AiZone[] = [
    {
      id: `bos-range-${range.breakTime}`,
      direction: dir,
      label: 'DEALING RANGE',
      upperPrice: range.high,
      lowerPrice: range.low,
      quality: 80,
      fresh: true,
      watch: true,
      reason: `${range.kind === 'REVERSAL' ? 'Reversal CHoCH/MSS' : 'Continuation BOS'} dealing range locked to the protected swing and impulse extreme. 50% equilibrium ${formatPrice(range.equilibrium, precision)}.`,
    },
    {
      id: `bos-entry-zone-${range.breakTime}`,
      direction: dir,
      label: state === 'CONFIRMED' ? 'ENTRY ZONE' : 'ENTRY ZONE (WATCH)',
      upperPrice: zone.high,
      lowerPrice: zone.low,
      quality: zone.inOte ? 88 : 76,
      fresh: true,
      watch: state !== 'CONFIRMED',
      reason: `Retracement ${dir === 'RISE' ? 'discount' : 'premium'} zone${zone.inOte ? ' inside the preferred 62–79% OTE' : ''}${
        zone.orderBlockOverlap ? ' · overlaps a valid order block' : ''
      }${zone.fvgOverlap ? ' · overlaps a fair value gap' : ''}.`,
    },
  ];
  return zones;
}

function scoreSetup(params: {
  event: BosEvent;
  inZone: boolean;
  inOte: boolean;
  orderBlockOverlap: boolean;
  fvgOverlap: boolean;
  sweep: BosSweep | null;
  rejection: BosRejection | null;
  ltf: BosLtfConfirmation | null;
  htfAligned: boolean;
  rr: number;
  minRR: number;
}): number {
  let score = 40;
  if (params.event.momentumConfirmed) score += 8;
  if (params.event.kind === 'REVERSAL') score += 4;
  if (params.inZone) score += 6;
  if (params.inOte) score += 6;
  if (params.orderBlockOverlap) score += 5;
  if (params.fvgOverlap) score += 5;
  if (params.sweep) score += 6;
  if (params.rejection) score += 8;
  if (params.ltf) score += 10;
  if (params.htfAligned) score += 8;
  if (params.rr >= params.minRR) score += 10;
  return clamp(Math.round(score), 0, 100);
}


interface EvaluatedSetup {
  event: BosEvent;
  range: BosDealingRange;
  zone: BosEntryZone;
  state: BosSetupState;
  outcomeReason: string | null;
  evidence: BosEvidenceItem[];
  sweep: BosSweep | null;
  rejection: BosRejection | null;
  ltf: BosLtfConfirmation | null;
  retest: BosEntryRetest | null;
  rr: number | null;
  trade: BosTrade | null;
  score: number;
  barsSinceBos: number;
}

/** Evaluates ONE BOS event through the full retracement → rejection → confirmation lifecycle. */
function evaluateEvent(
  structure: readonly Candle[],
  event: BosEvent,
  atr: number,
  precision: number,
  volFactor: number,
  price: number,
  ltfSource: readonly Candle[],
  htfDirection: AiDirection | null,
  minRR: number
): EvaluatedSetup {
  const range = lockDealingRange(structure, event, precision);
  const zone = buildEntryZone(structure, range, atr, precision, price);
  const bullish = event.direction === 'RISE';
  const barsSinceBos = structure.length - 1 - event.breakIndex;
  const afterBreak = structure.slice(event.breakIndex + 1);
  const htfAligned = htfDirection === event.direction;
  const htfOpposed = htfDirection !== null && htfDirection !== event.direction;

  const evidence: BosEvidenceItem[] = [];
  const push = (label: string, detail: string, satisfied: boolean) =>
    evidence.push({ label, detail, satisfied });

  // Structural invalidation: a close back through the protected swing flips the setup.
  const invalidated = afterBreak.some((b) => (bullish ? b.close < range.low : b.close > range.high));
  // Opposing structure shift: a fresh counter-break after the BOS.
  const opposingShift =
    afterBreak.length >= 30 ? detectBosEvent(afterBreak, atr, precision, volFactor) : null;
  const opposing = opposingShift !== null && opposingShift.direction !== event.direction;

  const retraced = afterBreak.some((b) => withinZone(zone, b, atr, volFactor));
  const lastBar = lastOf(structure);
  const inZoneNow = lastBar ? withinZone(zone, lastBar, atr, volFactor) : false;
  const sweep = detectZoneSweep(afterBreak, zone, range, atr, precision, volFactor);
  const rejection = detectRejection(afterBreak, zone, range, atr, precision, volFactor, event.breakTime);
  const ltf = rejection
    ? detectLtfMss(ltfSource, event.direction, atr, precision, rejection.time)
    : null;
  const retest = ltf
    ? findEntryRetest(structure, event.direction, atr, precision, price, ltf.time)
    : null;

  push('BOS validated', event.reason, true);
  push(
    'Dealing range locked',
    `Range ${formatPrice(range.low, precision)}–${formatPrice(range.high, precision)} (equilibrium ${formatPrice(range.equilibrium, precision)}) anchored to the protected swing and impulse extreme.`,
    true
  );
  push(
    `${bullish ? 'Discount' : 'Premium'} retracement`,
    retraced
      ? `Price retraced into the ${bullish ? 'discount' : 'premium'} entry zone (${formatPrice(zone.low, precision)}–${formatPrice(zone.high, precision)})${zone.inOte ? ' inside the preferred 62–79% OTE' : ''}.`
      : `Waiting for price to retrace into the ${bullish ? 'discount' : 'premium'} entry zone (${formatPrice(zone.low, precision)}–${formatPrice(zone.high, precision)}).`,
    retraced
  );
  push(
    'Order block / FVG confluence',
    zone.orderBlockOverlap || zone.fvgOverlap
      ? `${zone.orderBlockOverlap ? 'Valid order block' : ''}${zone.orderBlockOverlap && zone.fvgOverlap ? ' and ' : ''}${zone.fvgOverlap ? 'fair value gap' : ''} overlaps the entry zone.`
      : 'No order block or FVG overlaps the zone (optional confluence).',
    zone.orderBlockOverlap || zone.fvgOverlap
  );
  push('Liquidity sweep', sweep ? sweep.reason : 'No genuine sweep of the zone extreme yet.', sweep !== null);
  push(
    'Decisive rejection',
    rejection ? rejection.reason : 'No decisive rejection candle at the zone yet.',
    rejection !== null
  );
  push(
    'Lower-timeframe MSS',
    ltf ? ltf.reason : 'Awaiting the lower-timeframe market-structure shift.',
    ltf !== null
  );
  push(
    'HTF alignment',
    htfDirection === null
      ? 'No higher-timeframe directional read — treated as neutral.'
      : htfAligned
        ? `Higher-timeframe read agrees (${htfDirection}).`
        : `Higher-timeframe read (${htfDirection}) opposes the setup.`,
    !htfOpposed
  );

  // --- Determine the lifecycle state. ---
  let state: BosSetupState;
  let outcomeReason: string | null = null;
  if (invalidated) {
    state = 'INVALIDATED';
    outcomeReason = `Price closed back through the protected swing at ${formatPrice(bullish ? range.low : range.high, precision)} — the structure that produced the BOS is broken.`;
  } else if (opposing) {
    state = 'INVALIDATED';
    outcomeReason = 'Opposing structure shift after the BOS — the setup no longer qualifies.';
  } else if (barsSinceBos > MAX_BARS_SINCE_BOS) {
    state = 'EXPIRED';
    outcomeReason = `No confirmed entry within ${MAX_BARS_SINCE_BOS} bars of the BOS — the setup expired rather than chasing a missed retracement.`;
  } else if (ltf) {
    state = 'CONFIRMED';
  } else if (rejection) {
    state = 'CONFIRMATION';
  } else if (sweep) {
    state = 'REJECTION';
  } else if (inZoneNow || retraced) {
    state = 'IN_ZONE';
  } else {
    state = 'WAITING_FOR_PULLBACK';
  }

  // --- Build the trade only on a full confirmation. ---
  let trade: BosTrade | null = null;
  let rr: number | null = null;
  if (state === 'CONFIRMED' && rejection && ltf) {
    const entryPrice = retest ? (retest.low + retest.high) / 2 : rejection.price;
    const stop = bullish
      ? Math.min(sweep?.extremePrice ?? rejection.price, rejection.price) - atr * 0.3 * volFactor
      : Math.max(sweep?.extremePrice ?? rejection.price, rejection.price) + atr * 0.3 * volFactor;
    const liquidityTarget = opposingLiquidityTarget(
      structure,
      event.direction,
      atr,
      precision,
      price,
      entryPrice
    );
    const risk = Math.abs(entryPrice - stop);
    const structural = [
      liquidityTarget,
      bullish ? range.high : range.low,
      bullish ? entryPrice + risk * 2 : entryPrice - risk * 2,
      bullish ? entryPrice + risk * 3 : entryPrice - risk * 3,
      bullish ? entryPrice + risk * 5 : entryPrice - risk * 5,
    ].filter((v): v is number => v !== null && Number.isFinite(v));
    const forward = structural
      // TP1 must sit at least 1R beyond the entry — a liquidity pool hugging the entry is
      // not a target. This keeps the reward side genuinely tradable.
      .filter((p) => (bullish ? p > entryPrice + risk : p < entryPrice - risk))
      .sort((a, b) => (bullish ? a - b : b - a));
    const tp1 = forward[0] ?? (bullish ? entryPrice + risk * 2 : entryPrice - risk * 2);
    const tp2 =
      forward.find((p) => (bullish ? p > tp1 : p < tp1)) ??
      (bullish ? entryPrice + risk * 3 : entryPrice - risk * 3);
    const tp3 = forward.find((p) => (bullish ? p > tp2 : p < tp2)) ?? null;
    rr = risk > 0 ? Number((Math.abs(tp1 - entryPrice) / risk).toFixed(2)) : 0;
    trade = {
      direction: event.direction,
      entry: entryPrice,
      stop,
      tp1,
      tp2,
      tp3,
      rr,
      confirmedBarTime: ltf.time,
      reasons: [
        event.reason,
        `${event.kind === 'REVERSAL' ? 'Reversal' : 'Continuation'} dealing range locked to the protected swing and impulse extreme; price retraced into the ${bullish ? 'discount' : 'premium'}${zone.inOte ? ' (preferred 62–79% OTE)' : ''}.`,
        sweep ? sweep.reason : 'Zone extreme held without a sweep.',
        rejection.reason,
        ltf.reason,
        retest
          ? `Entry prefers the retest of the confirmation FVG at ${formatPrice((retest.low + retest.high) / 2, precision)}.`
          : 'Entry taken at the rejection close.',
      ],
      confirmations: [
        'External BOS validated on a decisive close (not a wick)',
        `${bullish ? 'Discount' : 'Premium'} retracement into the locked dealing range`,
        sweep ? 'Genuine liquidity sweep' : 'Zone extreme defended',
        'Decisive rejection candle',
        'Lower-timeframe MSS confirmation',
        `Estimated R:R ${rr.toFixed(2)} ≥ ${minRR}`,
      ],
    };
  }

  // Every mandatory condition must pass before a signal is released (quality over quantity).
  const mandatory =
    retraced &&
    sweep !== null &&
    rejection !== null &&
    ltf !== null &&
    !htfOpposed &&
    rr !== null &&
    rr >= minRR;
  if (state === 'CONFIRMED' && !mandatory) {
    state = 'CONFIRMATION';
    trade = null;
    outcomeReason =
      'Confirmed structure shift, but a mandatory condition (sweep, HTF alignment or minimum R:R) is unmet — standing aside.';
  }

  const score = scoreSetup({
    event,
    inZone: retraced,
    inOte: zone.inOte,
    orderBlockOverlap: zone.orderBlockOverlap,
    fvgOverlap: zone.fvgOverlap,
    sweep,
    rejection,
    ltf,
    htfAligned,
    rr: rr ?? 0,
    minRR,
  });

  return {
    event,
    range,
    zone,
    state,
    outcomeReason,
    evidence,
    sweep,
    rejection,
    ltf,
    retest,
    rr,
    trade,
    score,
    barsSinceBos,
  };
}

const STATE_RANK: Record<BosSetupState, number> = {
  CONFIRMED: 6,
  CONFIRMATION: 5,
  REJECTION: 4,
  IN_ZONE: 3,
  WAITING_FOR_PULLBACK: 2,
  BOS_DETECTED: 1,
  INVALIDATED: 0,
  EXPIRED: 0,
};

/**
 * Evaluates the full BOS retracement & rejection lifecycle for one instrument. Pure — it
 * reads candles and returns the CURRENT valid setup, its evidence and (only when every
 * mandatory condition passes) a single confirmed trade.
 *
 * At most ONE signal is ever produced: the most advanced still-valid BOS event wins
 * (CONFIRMED > CONFIRMATION > REJECTION > IN_ZONE > WAITING_FOR_PULLBACK), so a market
 * never emits two competing entries for the same break.
 */
export function evaluateBosRetracement(params: BosRetracementParams): BosRetracementResult {
  const {
    precision,
    marketFamily,
    structureCandles,
    setupCandles = [],
    entryCandles = [],
    htfDirection = null,
    minRR = BOS_DEFAULT_MIN_RR,
  } = params;
  const volFactor = marketVolFactor(marketFamily);
  const structure = confirmedOnly(structureCandles);
  const setup = confirmedOnly(setupCandles);
  const entry = confirmedOnly(entryCandles);
  const lastStructure = lastOf(structure);
  const price = lastOf(entry)?.close ?? lastOf(setup)?.close ?? lastStructure?.close ?? 0;

  const empty: BosRetracementResult = {
    state: 'INVALIDATED',
    event: null,
    readout: null,
    score: 0,
    trade: null,
    zones: [],
    statusExplanation: 'Insufficient confirmed candles for a structure read.',
    rejectionReason: 'Not enough data.',
  };

  if (structure.length < 30) return empty;
  const atrs = computeAtrSeries(structure, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  if (atr <= 0) return empty;

  const events = detectBosEvents(structure, atr, precision, volFactor);
  if (events.length === 0) {
    return {
      ...empty,
      statusExplanation:
        'No validated break of structure — wick-only pokes and indecisive closes are ignored.',
      rejectionReason: 'No valid BOS event.',
    };
  }

  const ltfSource = entry.length >= 10 ? entry : setup;
  const evaluated = events.map((event) =>
    evaluateEvent(structure, event, atr, precision, volFactor, price, ltfSource, htfDirection, minRR)
  );

  // Rank by advancement so only the CURRENT valid setup is ever shown.
  const live = evaluated.filter((e) => e.state !== 'INVALIDATED' && e.state !== 'EXPIRED');
  const pool = live.length > 0 ? live : evaluated;
  const chosen = pool.reduce((best, cur) => {
    if (STATE_RANK[cur.state] !== STATE_RANK[best.state]) {
      return STATE_RANK[cur.state] > STATE_RANK[best.state] ? cur : best;
    }
    if (cur.trade && !best.trade) return cur;
    return cur.event.breakIndex > best.event.breakIndex ? cur : best;
  }, pool[0]);

  const readout: BosRetracementReadout = {
    state: chosen.state,
    kind: chosen.event.kind,
    direction: chosen.event.direction,
    range: chosen.range,
    position: rangePosition(chosen.range, price),
    entryZone: chosen.zone,
    sweep: chosen.sweep,
    rejection: chosen.rejection,
    ltf: chosen.ltf,
    retest: chosen.retest,
    rr: chosen.rr,
    evidence: chosen.evidence,
    outcomeReason: chosen.outcomeReason,
    barsSinceBos: chosen.barsSinceBos,
  };

  return {
    state: chosen.state,
    event: chosen.event,
    readout,
    score: chosen.score,
    trade: chosen.trade,
    zones: buildZoneOverlays(chosen.range, chosen.zone, chosen.state, precision),
    statusExplanation: buildStatusExplanation(
      chosen.state,
      chosen.event,
      chosen.range,
      chosen.zone,
      precision,
      chosen.outcomeReason
    ),
    rejectionReason: chosen.trade ? undefined : chosen.outcomeReason ?? undefined,
  };
}

function buildStatusExplanation(
  state: BosSetupState,
  event: BosEvent,
  range: BosDealingRange,
  zone: BosEntryZone,
  precision: number,
  outcomeReason: string | null
): string {
  const dir = event.direction === 'RISE' ? 'bullish' : 'bearish';
  const zoneText = `${formatPrice(zone.low, precision)}–${formatPrice(zone.high, precision)}`;
  switch (state) {
    case 'BOS_DETECTED':
      return `${dir} BOS detected at ${formatPrice(event.brokenLevel, precision)}.`;
    case 'WAITING_FOR_PULLBACK':
      return `${dir} BOS at ${formatPrice(event.brokenLevel, precision)} — waiting for price to retrace into the ${event.direction === 'RISE' ? 'discount' : 'premium'} zone (${zoneText}).`;
    case 'IN_ZONE':
      return `Price is inside the retracement zone (${zoneText}) — awaiting a liquidity sweep and rejection.`;
    case 'REJECTION':
      return 'Genuine sweep at the zone extreme — awaiting a decisive rejection candle.';
    case 'CONFIRMATION':
      return 'Rejection printed — awaiting the lower-timeframe market-structure shift to confirm the reversal.';
    case 'CONFIRMED':
      return `Confirmed ${dir} entry after the retracement, sweep, rejection and lower-timeframe MSS (equilibrium ${formatPrice(range.equilibrium, precision)}).`;
    case 'INVALIDATED':
      return outcomeReason ?? 'Setup invalidated.';
    case 'EXPIRED':
      return outcomeReason ?? 'Setup expired.';
    default:
      return 'BOS retracement setup.';
  }
}

