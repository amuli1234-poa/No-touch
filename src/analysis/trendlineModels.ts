import type { SupportResistanceLevel, SupplyDemandZone } from '../types/analysis';
import type { Candle } from '../types/market';
import type {
  TrendlineAlignment,
  TrendlineCandidate,
  TrendlineEntryConfirmation,
  TrendlineEntryConfirmationKind,
  TrendlineEntryModelId,
  TrendlineLine,
  TrendlineMarketCondition,
  TrendlineRejection,
  TrendlineSetupZone,
} from '../types/trendline';
import { TRENDLINE_MODEL_LABELS } from '../types/trendline';
import { formatPrice } from '../utils/derivParser';
import { getCandleStats, type SwingPoint } from './swings';
import { continuationConfirmationScore } from './trendAlignment';
import { linePriceAtTime, confirmedOnly } from './trendlineDetection';

/** Minimum total score required to publish a trendline signal. */
export const TRENDLINE_PUBLICATION_MIN_SCORE = 85;
/** Wick must probe within this many ATR of the boundary to count as a test. */
const TEST_TOLERANCE_ATR = 0.45;
/** Rejection must be confirmed on one of the most recent N confirmed M5 bars. */
const REJECTION_RECENCY_BARS = 3;
/** The M1 precise-entry confirmation must be on one of the most recent N confirmed bars. */
const M1_CONFIRMATION_RECENCY_BARS = 5;

export interface TrendlineModelContext {
  symbol: string;
  precision: number;
  condition: TrendlineMarketCondition;
  /** Trend-alignment verdict — the module only searches the tradable direction. */
  alignment: TrendlineAlignment;
  /** Trend-aligned future setup zones (below price in an uptrend, above in a downtrend). */
  setupZones: readonly TrendlineSetupZone[];
  /** Confirmed M15 candles — structural analysis timeframe. */
  structureCandles: readonly Candle[];
  /** Confirmed M5 candles — setup / rejection timeframe. */
  entryCandles: readonly Candle[];
  /** Confirmed M1 candles — precise entry confirmation timeframe. */
  m1Candles?: readonly Candle[];
  structureAtr: number;
  entryAtr: number;
  /** M1 ATR, when M1 candles are supplied. */
  m1Atr?: number;
  trendlines: readonly TrendlineLine[];
  structureSwings: readonly SwingPoint[];
  structureDirection: 'BULLISH' | 'BEARISH' | 'RANGING' | 'NEUTRAL';
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
  range: { support: number; resistance: number } | null;
  momentumStrongBullish: boolean;
  momentumStrongBearish: boolean;
}

/**
 * Mandatory entry confirmation. A rejection requires the wick to probe the boundary
 * (or sweep beyond it) and the candle to CLOSE back on the correct side, with wick
 * dominance and directional close conviction. Used by every trendline model.
 */
export function detectTrendlineRejection(params: {
  entryCandles: readonly Candle[];
  boundaryPrice: number;
  direction: 'RISE' | 'FALL';
  atr: number;
  recencyBars?: number;
}): TrendlineRejection {
  const { boundaryPrice, direction, atr } = params;
  const confirmed = confirmedOnly(params.entryCandles);
  const none: TrendlineRejection = {
    confirmed: false,
    kind: 'NONE',
    time: 0,
    wickPrice: 0,
    close: 0,
    strength: 0,
    reason: `No confirmed M5 ${direction === 'RISE' ? 'bullish' : 'bearish'} rejection at the trendline yet.`,
  };
  if (confirmed.length < 3) return none;

  const recency = params.recencyBars ?? REJECTION_RECENCY_BARS;
  const tol = Math.max(atr * TEST_TOLERANCE_ATR, 1e-6);
  const start = Math.max(0, confirmed.length - recency);

  let best: TrendlineRejection = none;
  for (let i = confirmed.length - 1; i >= start; i--) {
    const bar = confirmed[i];
    const stats = getCandleStats(bar);
    if (direction === 'RISE') {
      const touched = bar.low <= boundaryPrice + tol;
      const reclaimed = bar.close > boundaryPrice;
      const bullish = stats.isBullish && stats.closePosition >= 0.55;
      const wickDominant = stats.lowerWick >= stats.body * 0.6 || stats.closePosition >= 0.65;
      if (touched && reclaimed && bullish && wickDominant) {
        const strength = clamp01(
          0.4 * Math.min(1, stats.lowerWick / Math.max(1e-9, stats.body)) +
            0.35 * stats.closePosition +
            0.25 * Math.min(1, stats.body / Math.max(1e-9, atr))
        );
        return {
          confirmed: true,
          kind: 'BULLISH_REJECTION',
          time: bar.time,
          wickPrice: bar.low,
          close: bar.close,
          strength: Number(strength.toFixed(3)),
          reason: `Confirmed M5 bullish rejection — wick probed the trendline near ${formatPrice(
            boundaryPrice,
            2
          )} and price closed back above it.`,
        };
      }
    } else {
      const touched = bar.high >= boundaryPrice - tol;
      const reclaimed = bar.close < boundaryPrice;
      const bearish = stats.isBearish && stats.closePosition <= 0.45;
      const wickDominant = stats.upperWick >= stats.body * 0.6 || stats.closePosition <= 0.35;
      if (touched && reclaimed && bearish && wickDominant) {
        const strength = clamp01(
          0.4 * Math.min(1, stats.upperWick / Math.max(1e-9, stats.body)) +
            0.35 * (1 - stats.closePosition) +
            0.25 * Math.min(1, stats.body / Math.max(1e-9, atr))
        );
        return {
          confirmed: true,
          kind: 'BEARISH_REJECTION',
          time: bar.time,
          wickPrice: bar.high,
          close: bar.close,
          strength: Number(strength.toFixed(3)),
          reason: `Confirmed M5 bearish rejection — wick probed the trendline near ${formatPrice(
            boundaryPrice,
            2
          )} and price closed back below it.`,
        };
      }
    }
  }
  return best;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

const NO_ENTRY_CONFIRMATION: TrendlineEntryConfirmation = {
  confirmed: false,
  kind: 'NONE',
  timeframe: 'M1',
  time: 0,
  close: 0,
  strength: 0,
  agreesWithTrend: false,
  reason: 'No confirmed M1 entry trigger (engulfing / BOS / micro-rejection) yet.',
};

/**
 * M1 PRECISE-ENTRY CONFIRMATION — the lowest timeframe in the top-down chain.
 *
 * The M5 rejection establishes the setup; this refines it to an exact entry trigger on
 * M1. A trigger is one of:
 *   - a strong bullish / bearish ENGULFING candle,
 *   - a micro BOS (M1 close beyond the recent M1 swing extreme) WITH the trend,
 *   - a micro rejection (wick probes back to the boundary and closes away from it).
 *
 * The trigger must AGREE with the higher-timeframe direction (`direction`) unless a
 * validated reversal has flipped the bias — an M1 trigger is never allowed to override
 * an opposing higher-timeframe trend. When it contradicts the trend it is reported as
 * unconfirmed with `agreesWithTrend: false`.
 */
export function detectTrendlineEntryConfirmation(params: {
  m1Candles: readonly Candle[];
  direction: 'RISE' | 'FALL';
  boundaryPrice: number;
  atr: number;
  /** A validated reversal flips the bias, letting the M1 trigger stand on its own. */
  reversalValidated?: boolean;
  recencyBars?: number;
}): TrendlineEntryConfirmation {
  const { direction, boundaryPrice, atr } = params;
  const confirmed = confirmedOnly(params.m1Candles);
  if (confirmed.length < 4) {
    return { ...NO_ENTRY_CONFIRMATION, reason: 'Awaiting enough confirmed M1 candles for an entry trigger.' };
  }

  const recency = params.recencyBars ?? M1_CONFIRMATION_RECENCY_BARS;
  const start = Math.max(1, confirmed.length - recency);
  const isRise = direction === 'RISE';
  const tol = Math.max(atr * TEST_TOLERANCE_ATR, 1e-6);

  // Recent M1 swing extremes for the micro-BOS trigger (bars before the trigger window).
  const lookback = confirmed.slice(Math.max(0, start - 12), start);
  const priorHigh = lookback.length > 0 ? Math.max(...lookback.map((b) => b.high)) : null;
  const priorLow = lookback.length > 0 ? Math.min(...lookback.map((b) => b.low)) : null;

  let best: TrendlineEntryConfirmation | null = null;
  for (let i = confirmed.length - 1; i >= start; i--) {
    const bar = confirmed[i];
    const prev = confirmed[i - 1];
    const stats = getCandleStats(bar);
    const prevStats = getCandleStats(prev);
    const bullishTrigger = isRise;
    const agrees = bullishTrigger ? stats.isBullish : stats.isBearish;
    if (!agrees) continue;

    const closeConviction = bullishTrigger
      ? Math.max(0, Math.min(1, (stats.closePosition - 0.5) / 0.4))
      : Math.max(0, Math.min(1, (0.5 - stats.closePosition) / 0.4));
    const bodyVsAtr = Math.min(1, stats.body / Math.max(1e-9, atr));

    // 1) Engulfing: the trigger body engulfs the prior bar and closes with conviction.
    const engulfing = bullishTrigger
      ? stats.isBullish && prevStats.isBearish && bar.close >= prev.open && bar.open <= prev.close
      : stats.isBearish && prevStats.isBullish && bar.close <= prev.open && bar.open >= prev.close;

    // 2) Micro BOS: M1 close beyond the recent M1 swing extreme, with the trend.
    const bos = bullishTrigger
      ? priorHigh !== null && bar.close > priorHigh
      : priorLow !== null && bar.close < priorLow;

    // 3) Micro rejection: wick probes the boundary, closes away from it with conviction.
    const probedBoundary = bullishTrigger
      ? bar.low <= boundaryPrice + tol
      : bar.high >= boundaryPrice - tol;
    const closedAway = bullishTrigger ? bar.close > boundaryPrice : bar.close < boundaryPrice;
    const microRejection = probedBoundary && closedAway && closeConviction >= 0.25;

    if (!engulfing && !bos && !microRejection) continue;

    const kind: TrendlineEntryConfirmationKind = engulfing
      ? bullishTrigger
        ? 'BULLISH_ENGULFING'
        : 'BEARISH_ENGULFING'
      : bos
        ? bullishTrigger
          ? 'BULLISH_BOS'
          : 'BEARISH_BOS'
        : 'MICRO_REJECTION';

    const kindBonus = engulfing ? 0.25 : bos ? 0.2 : 0;
    const strength = clamp01(0.45 * closeConviction + 0.3 * bodyVsAtr + kindBonus);

    const kindText =
      kind === 'BULLISH_ENGULFING'
        ? 'bullish engulfing'
        : kind === 'BEARISH_ENGULFING'
          ? 'bearish engulfing'
          : kind === 'BULLISH_BOS'
            ? 'bullish micro BOS'
            : kind === 'BEARISH_BOS'
              ? 'bearish micro BOS'
              : 'micro rejection';

    best = {
      confirmed: true,
      kind,
      timeframe: 'M1',
      time: bar.time,
      close: bar.close,
      strength: Number(strength.toFixed(3)),
      agreesWithTrend: true,
      reason: `Confirmed M1 ${kindText} — ${
        bullishTrigger ? 'price closed back above' : 'price closed back below'
      } the ${formatPrice(boundaryPrice, 2)} boundary with directional conviction.`,
    };
    break;
  }

  if (best) return best;
  return {
    ...NO_ENTRY_CONFIRMATION,
    agreesWithTrend: params.reversalValidated ?? false,
    reason: `No confirmed M1 ${isRise ? 'bullish' : 'bearish'} entry trigger within the last ${recency} bars.`,
  };
}

interface RawTrendlineDetection {
  model: TrendlineEntryModelId;
  direction: 'RISE' | 'FALL';
  trendline: TrendlineLine;
  trendlinePriceAtEntry: number;
  rejection: TrendlineRejection;
  /** The trend-aligned setup zone this detection reacted from (T1 only). */
  zone: TrendlineSetupZone | null;
  /** Price level the stop sits just beyond (trendline or sweep wick). */
  invalidationAnchor: number;
  reasons: string[];
  confirmations: string[];
}

/**
 * Evaluates the trendline models for the current structure and returns the strongest
 * candidate that (a) is aligned with the dominant trend and (b) carries a CONFIRMED
 * rejection. Counter-trend and unconfirmed setups are never returned.
 */
export function detectTrendlineCandidate(
  ctx: TrendlineModelContext
): TrendlineCandidate | null {
  const allowed = ctx.alignment.tradableDirection;
  // WAIT: no dominant trend (ranging / unclear) or an unconfirmed trend — never force an
  // entry, and never trade against the trend.
  if (!allowed) return null;

  const raw = detectRaw(ctx, allowed);
  if (!raw) return null;
  if (!raw.rejection.confirmed) return null;
  if (raw.direction !== allowed) return null;
  return finalize(ctx, raw);
}

function detectRaw(
  ctx: TrendlineModelContext,
  allowed: 'RISE' | 'FALL'
): RawTrendlineDetection | null {
  const { entryCandles, entryAtr, trendlines, structureSwings, setupZones } = ctx;
  const confirmedEntry = confirmedOnly(entryCandles);
  if (confirmedEntry.length < 6) return null;
  const last = confirmedEntry[confirmedEntry.length - 1];

  const validSupport = trendlines.filter((l) => l.valid && l.kind === 'support');
  const validResistance = trendlines.filter((l) => l.valid && l.kind === 'resistance');
  const brokenSupport = trendlines
    .filter((l) => l.broken && l.kind === 'support')
    .sort((a, b) => (b.breakTime ?? 0) - (a.breakTime ?? 0));
  const brokenResistance = trendlines
    .filter((l) => l.broken && l.kind === 'resistance')
    .sort((a, b) => (b.breakTime ?? 0) - (a.breakTime ?? 0));

  // ---- T1: Trend-aligned rejection at a future setup zone ----
  // Only zones on the trend side of price are considered (below in an uptrend, above in
  // a downtrend), and only the trend direction is ever produced.
  for (const zone of setupZones) {
    if (zone.direction !== allowed) continue;
    const boundary = zone.projectedPrice;
    const near = Math.abs(last.close - boundary) <= entryAtr * 1.8;
    if (!near) continue;
    const rejection = detectTrendlineRejection({
      entryCandles,
      boundaryPrice: boundary,
      direction: allowed,
      atr: entryAtr,
    });
    if (!rejection.confirmed) continue;
    const line =
      zone.trendline ?? syntheticLine(boundary, allowed === 'RISE' ? 'support' : 'resistance');
    return {
      model: 'TRENDLINE_REJECTION',
      direction: allowed,
      trendline: line,
      trendlinePriceAtEntry: boundary,
      rejection,
      zone,
      invalidationAnchor: rejection.wickPrice,
      reasons: [
        zone.reason,
        `Price pulled into the ${zone.label.toLowerCase()} near ${formatPrice(
          boundary,
          ctx.precision
        )}.`,
        rejection.reason,
      ],
      confirmations: [
        `${zone.freshness} ${zone.source.replace(/-/g, ' ')} zone (M15)`,
        rejection.reason,
      ],
    };
  }

  // ---- T2/T3: Trendline breakout, and breakout & retest — only WITH the trend ----
  const breakCandidates = [
    ...brokenResistance.map((l) => ({ line: l, direction: 'RISE' as const })),
    ...brokenSupport.map((l) => ({ line: l, direction: 'FALL' as const })),
  ].filter((c) => c.direction === allowed);
  const recentBreak = (line: TrendlineLine): boolean =>
    line.breakTime !== undefined &&
    ctx.structureCandles.filter((b) => b.time > (line.breakTime ?? 0)).length <= 10;

  // T3 — the broken line was retested from the other side and held (checked first so a
  // genuine retest is reported as Break & Retest rather than a plain breakout).
  for (const { line, direction } of breakCandidates) {
    if (!recentBreak(line)) continue;
    const boundary = linePriceAtTime(line, last.time);
    const retested = confirmedEntry.some((b) =>
      direction === 'RISE'
        ? b.low <= boundary + entryAtr * 0.5 && b.close >= boundary
        : b.high >= boundary - entryAtr * 0.5 && b.close <= boundary
    );
    if (!retested) continue;
    const rejection = detectTrendlineRejection({
      entryCandles,
      boundaryPrice: boundary,
      direction,
      atr: entryAtr,
    });
    if (!rejection.confirmed) continue;
    return {
      model: 'TRENDLINE_BREAKOUT_RETEST',
      direction,
      trendline: line,
      trendlinePriceAtEntry: boundary,
      rejection,
      zone: null,
      invalidationAnchor: boundary,
      reasons: [
        line.reason,
        `Broken trendline retested from the ${
          direction === 'RISE' ? 'upside' : 'downside'
        } near ${formatPrice(boundary, ctx.precision)} and held.`,
        rejection.reason,
      ],
      confirmations: [`Broken M15 ${line.kind} trendline retested and held`, rejection.reason],
    };
  }

  // T2 — a fresh break with a confirming rejection (no prior retest needed).
  for (const { line, direction } of breakCandidates) {
    if (!recentBreak(line)) continue;
    const boundary = linePriceAtTime(line, last.time);
    const rejection = detectTrendlineRejection({
      entryCandles,
      boundaryPrice: boundary,
      direction,
      atr: entryAtr,
    });
    if (!rejection.confirmed) continue;
    return {
      model: 'TRENDLINE_BREAKOUT',
      direction,
      trendline: line,
      trendlinePriceAtEntry: boundary,
      rejection,
      zone: null,
      invalidationAnchor: boundary,
      reasons: [
        line.reason,
        `Break confirmed on M15 and price rejected the broken trendline near ${formatPrice(
          boundary,
          ctx.precision
        )}.`,
        rejection.reason,
      ],
      confirmations: [
        `M15 ${line.kind} trendline broken with a decisive close`,
        rejection.reason,
      ],
    };
  }

  // ---- T4: Liquidity sweep & reclaim — only in the trend direction ----
  const swings = structureSwings;
  const lastHigh = [...swings].filter((s) => s.type === 'high').pop() ?? null;
  const lastLow = [...swings].filter((s) => s.type === 'low').pop() ?? null;
  if (lastLow && allowed === 'RISE') {
    const swept = confirmedEntry
      .slice(-REJECTION_RECENCY_BARS - 2)
      .some((b) => b.low < lastLow.price - entryAtr * 0.05 && b.close > lastLow.price);
    if (swept) {
      const line = validSupport[0] ?? brokenSupport[0] ?? null;
      const boundary = lastLow.price;
      const rejection = detectTrendlineRejection({
        entryCandles,
        boundaryPrice: boundary,
        direction: 'RISE',
        atr: entryAtr,
      });
      if (rejection.confirmed) {
        return {
          model: 'TRENDLINE_LIQUIDITY_SWEEP_RECLAIM',
          direction: 'RISE',
          trendline: line ?? syntheticLine(boundary, 'support'),
          trendlinePriceAtEntry: boundary,
          rejection,
          zone: null,
          invalidationAnchor: Math.min(lastLow.price, rejection.wickPrice),
          reasons: [
            `Sell-side liquidity swept below the M15 swing low at ${formatPrice(
              lastLow.price,
              ctx.precision
            )} and price reclaimed the level.`,
            rejection.reason,
          ],
          confirmations: [
            'M5 wick swept the swing low and closed back above it',
            rejection.reason,
          ],
        };
      }
    }
  }
  if (lastHigh && allowed === 'FALL') {
    const swept = confirmedEntry
      .slice(-REJECTION_RECENCY_BARS - 2)
      .some((b) => b.high > lastHigh.price + entryAtr * 0.05 && b.close < lastHigh.price);
    if (swept) {
      const line = validResistance[0] ?? brokenResistance[0] ?? null;
      const boundary = lastHigh.price;
      const rejection = detectTrendlineRejection({
        entryCandles,
        boundaryPrice: boundary,
        direction: 'FALL',
        atr: entryAtr,
      });
      if (rejection.confirmed) {
        return {
          model: 'TRENDLINE_LIQUIDITY_SWEEP_RECLAIM',
          direction: 'FALL',
          trendline: line ?? syntheticLine(boundary, 'resistance'),
          trendlinePriceAtEntry: boundary,
          rejection,
          zone: null,
          invalidationAnchor: Math.max(lastHigh.price, rejection.wickPrice),
          reasons: [
            `Buy-side liquidity swept above the M15 swing high at ${formatPrice(
              lastHigh.price,
              ctx.precision
            )} and price reclaimed the level.`,
            rejection.reason,
          ],
          confirmations: [
            'M5 wick swept the swing high and closed back below it',
            rejection.reason,
          ],
        };
      }
    }
  }

  void ctx.structureDirection;
  void ctx.condition;
  return null;
}

function syntheticLine(price: number, kind: 'support' | 'resistance'): TrendlineLine {
  return {
    id: `tl-sweep-${kind}-${Math.round(price * 1e4)}`,
    kind,
    trend: 'horizontal',
    startTime: 0,
    startPrice: price,
    endTime: 0,
    endPrice: price,
    slopePerSec: 0,
    touches: 2,
    touchPoints: [],
    valid: true,
    invalidReason: '',
    broken: false,
    currentPrice: price,
    reason: `Horizontal ${kind} level from the swept swing extreme.`,
  };
}

function finalize(ctx: TrendlineModelContext, raw: RawTrendlineDetection): TrendlineCandidate {
  const { precision, entryAtr, structureAtr } = ctx;
  const entryPrice = raw.rejection.close;
  const isRise = raw.direction === 'RISE';

  // Stop-loss sits just beyond the rejection wick / trendline with an ATR buffer.
  const buffer = Math.max(entryAtr * 0.5, structureAtr * 0.25);
  const stopLoss = isRise ? raw.invalidationAnchor - buffer : raw.invalidationAnchor + buffer;

  // Target: nearest opposing structural level (opposite trendline / range boundary /
  // swing extreme). Falls back to a measured 1.8R move when no level is present.
  const takeProfit = resolveTarget(ctx, raw, entryPrice, stopLoss);

  const confirmation = continuationConfirmationScore({
    entryCandles: ctx.entryCandles,
    direction: raw.direction,
    rejectionBarTime: raw.rejection.time,
    continuationBos: ctx.alignment.continuationBos,
    atr: entryAtr,
  });
  const continuationBos = ctx.alignment.continuationBos;

  // M1 precise-entry confirmation (top-down third timeframe). When the M1 feed is
  // available the trigger is REQUIRED; when it is not, the M5 rejection stands in as
  // the entry trigger so the module still functions on reduced data.
  const m1Provided = confirmedOnly(ctx.m1Candles ?? []).length >= 4;
  const entryConfirmation: TrendlineEntryConfirmation = m1Provided
    ? detectTrendlineEntryConfirmation({
        m1Candles: ctx.m1Candles ?? [],
        direction: raw.direction,
        boundaryPrice: raw.trendlinePriceAtEntry,
        atr: ctx.m1Atr && ctx.m1Atr > 0 ? ctx.m1Atr : entryAtr,
        reversalValidated: ctx.alignment.reversalConfirmed,
      })
    : {
        confirmed: true,
        kind: 'MICRO_REJECTION',
        timeframe: 'M1',
        time: raw.rejection.time,
        close: raw.rejection.close,
        strength: raw.rejection.strength,
        agreesWithTrend: true,
        reason: 'M1 feed unavailable — the confirmed M5 rejection is used as the entry trigger.',
      };

  const scores = scoreTrendline(ctx, raw, entryPrice, stopLoss, takeProfit, confirmation.score);

  const m15Context = `M15 ${ctx.condition.replace(/_/g, ' ').toLowerCase()} · ${ctx.alignment.reason}`;
  const m5Confirmation = continuationBos
    ? `${raw.rejection.reason} ${continuationBos}`
    : raw.rejection.reason;
  const m1Confirmation = entryConfirmation.reason;

  return {
    model: raw.model,
    modelLabel: TRENDLINE_MODEL_LABELS[raw.model],
    direction: raw.direction,
    trendline: raw.trendline,
    trendlinePriceAtEntry: raw.trendlinePriceAtEntry,
    entryPrice: Number(entryPrice.toFixed(precision)),
    stopLoss: Number(stopLoss.toFixed(precision)),
    takeProfit: Number(takeProfit.toFixed(precision)),
    invalidationPrice: Number(stopLoss.toFixed(precision)),
    invalidationCondition: `Close beyond ${formatPrice(
      stopLoss,
      precision
    )} invalidates the trendline setup.`,
    riskRewardRatio:
      Math.abs(entryPrice - stopLoss) > 0
        ? Number((Math.abs(takeProfit - entryPrice) / Math.abs(entryPrice - stopLoss)).toFixed(2))
        : 1.5,
    rejection: raw.rejection,
    zone: raw.zone,
    entryConfirmation,
    continuationBos,
    scores,
    reasons: continuationBos ? [...raw.reasons, continuationBos] : raw.reasons,
    confirmations: [...raw.confirmations, confirmation.detail, entryConfirmation.reason],
    m15Context,
    m5Confirmation,
    m1Confirmation,
  };
}

function resolveTarget(
  ctx: TrendlineModelContext,
  raw: RawTrendlineDetection,
  entryPrice: number,
  stopLoss: number
): number {
  const isRise = raw.direction === 'RISE';
  const risk = Math.abs(entryPrice - stopLoss) || ctx.entryAtr;
  const candidates: number[] = [];

  for (const l of ctx.trendlines) {
    if (l.id === raw.trendline.id) continue;
    const priceAt = linePriceAtTime(
      l,
      raw.rejection.time || ctx.structureCandles[ctx.structureCandles.length - 1]?.time || 0
    );
    if (isRise && l.kind === 'resistance' && priceAt > entryPrice) candidates.push(priceAt);
    if (!isRise && l.kind === 'support' && priceAt < entryPrice) candidates.push(priceAt);
  }
  if (ctx.range) {
    if (isRise && ctx.range.resistance > entryPrice) candidates.push(ctx.range.resistance);
    if (!isRise && ctx.range.support < entryPrice) candidates.push(ctx.range.support);
  }
  // Opposing supply / demand gives a realistic objective.
  for (const zone of ctx.supplyDemand) {
    if (zone.status === 'invalidated') continue;
    const center = (zone.upperPrice + zone.lowerPrice) / 2;
    if (isRise && zone.type === 'supply' && center > entryPrice) candidates.push(center);
    if (!isRise && zone.type === 'demand' && center < entryPrice) candidates.push(center);
  }
  const swingTarget = ctx.structureSwings
    .filter((s) =>
      isRise ? s.type === 'high' && s.price > entryPrice : s.type === 'low' && s.price < entryPrice
    )
    .map((s) => s.price);
  candidates.push(...swingTarget);

  if (candidates.length === 0) {
    return isRise ? entryPrice + risk * 1.8 : entryPrice - risk * 1.8;
  }
  candidates.sort((a, b) => (isRise ? a - b : b - a));
  // Prefer the nearest opposing structure that still offers a tradeable reward (>= 1.2R)
  // and is not unrealistically far (> 6R). Fall back to a measured 1.8R move otherwise.
  const minReward = risk * 1.2;
  const usable = candidates.find(
    (c) => Math.abs(c - entryPrice) >= minReward && Math.abs(c - entryPrice) <= risk * 6
  );
  if (usable !== undefined) return usable;
  return isRise ? entryPrice + risk * 1.8 : entryPrice - risk * 1.8;
}

/**
 * 100-point technical score, trend-continuation weighted:
 *   trendline/zone quality (20), rejection strength (20), trend alignment (15),
 *   zone freshness (15), confirmation incl. continuation BOS (20), space to target (10).
 */
function scoreTrendline(
  ctx: TrendlineModelContext,
  raw: RawTrendlineDetection,
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  confirmation: number
): TrendlineCandidate['scores'] {
  const line = raw.trendline;
  const zone = raw.zone;

  // Zone/line quality: an untested zone plus a sloping (not flat) line scores highest.
  const baseQuality = zone ? (zone.untested ? 14 : 11) : 12;
  const trendlineQuality = Math.min(
    20,
    baseQuality + Math.min(4, line.touches * 1.5) + (line.trend !== 'horizontal' ? 2 : 0)
  );

  const rejectionStrength = Math.min(20, 11 + Math.round(raw.rejection.strength * 9));

  // Trend alignment: full marks when the setup continues a CONFIRMED dominant trend.
  const trendAlignment = ctx.alignment.trendConfirmed ? 15 : 10;

  const zoneFreshness = zone
    ? zone.freshness === 'FRESH'
      ? 15
      : zone.freshness === 'TESTED'
        ? 11
        : 6
    : 11;

  const confirmationScore = Math.min(20, Math.round(confirmation * 20));

  const risk = Math.abs(entryPrice - stopLoss) || ctx.entryAtr;
  const reward = Math.abs(takeProfit - entryPrice);
  const rr = reward / risk;
  const spaceToTarget = rr >= 2 ? 10 : rr >= 1.5 ? 8 : rr >= 1 ? 5 : 2;

  const total =
    trendlineQuality +
    rejectionStrength +
    trendAlignment +
    zoneFreshness +
    confirmationScore +
    spaceToTarget;

  return {
    trendlineQuality,
    rejectionStrength,
    trendAlignment,
    zoneFreshness,
    confirmation: confirmationScore,
    spaceToTarget,
    total,
  };
}

/**
 * A candidate is publishable only when it clears the 85 gate with a real M5 rejection
 * AND a confirmed M1 entry trigger that agrees with the higher-timeframe direction.
 */
export function isPublishable(candidate: TrendlineCandidate): boolean {
  return (
    candidate.scores.total >= TRENDLINE_PUBLICATION_MIN_SCORE &&
    candidate.rejection.confirmed &&
    candidate.entryConfirmation.confirmed &&
    candidate.entryConfirmation.agreesWithTrend
  );
}
