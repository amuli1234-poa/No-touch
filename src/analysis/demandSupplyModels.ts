import type { Candle } from '../types/market';
import type {
  DsCandidate,
  DsConfirmation,
  DsEntryModelId,
  DsSetupStage,
  DsZone,
} from '../types/demandSupply';
import { DS_MODEL_LABELS } from '../types/demandSupply';
import { formatPrice } from '../utils/derivParser';
import { getCandleStats, type SwingPoint } from './swings';
import { confirmedOnly } from './trendlineDetection';

/**
 * DEMAND & SUPPLY SIGNAL ENGINE — independent entry models per side.
 *
 * RISE models work from DEMAND zones, FALL models from SUPPLY zones:
 *   M1  DS_FRESH_REJECTION          — rejection from an untested fresh zone
 *   M2  DS_RETEST_CONTINUATION      — continuation after a first test held
 *   M3  DS_LIQUIDITY_SWEEP_RECLAIM  — sweep beyond the distal edge then reclaim
 *   M4  DS_FVG_CONFLUENCE           — zone with an overlapping fair value gap
 *   M5  DS_ORDER_BLOCK_RETEST       — retest of a zone that caused a BOS
 *   M6  DS_BREAKER_RETEST           — retest of a role-flipped (breaker) zone
 *   M7  DS_M1_BOS_CHOCH             — decisive M1 body breaks M1 structure with the zone
 *   M8  DS_ENGULFING_CONFIRMATION   — M1 engulfing candle at the zone boundary
 *
 * EVERY model requires a confirmed M1 rejection. A zone touch alone never publishes.
 */

/** Minimum total score to publish a demand & supply signal. */
export const DS_PUBLICATION_MIN_SCORE = 85;
/** Wick must probe within this many ATR of the proximal edge to count as a test. */
const TEST_TOLERANCE_ATR = 0.4;
/** The confirmation must be on one of the most recent N confirmed M1 bars. */
const CONFIRM_RECENCY_BARS = 4;
/** Price within this many ATR of the proximal edge is "approaching". */
const APPROACH_ATR = 2.2;
/** Price within this many ATR of the proximal edge is "at the zone". */
const AT_ZONE_ATR = 0.9;

export interface DsModelContext {
  symbol: string;
  precision: number;
  /** Current tracked zones (demand = blue, supply = red). */
  zones: readonly DsZone[];
  /** Confirmed M15 candles (primary zone identification). */
  structureCandles: readonly Candle[];
  /** Confirmed M5 candles (setup development). */
  setupCandles: readonly Candle[];
  /** Confirmed M1 candles (entry confirmation). */
  entryCandles: readonly Candle[];
  structureAtr: number;
  setupAtr: number;
  entryAtr: number;
  structureSwings: readonly SwingPoint[];
}

/**
 * Mandatory entry confirmation on M1: the wick probes the proximal edge (or sweeps beyond
 * the distal edge) and the candle CLOSES back on the correct side with wick dominance and
 * directional close conviction. Used by every model.
 */
export function detectDsRejection(params: {
  entryCandles: readonly Candle[];
  /** The edge the wick must probe (proximal edge, or the sweep extreme). */
  boundaryPrice: number;
  direction: 'RISE' | 'FALL';
  atr: number;
  recencyBars?: number;
}): DsConfirmation {
  const { boundaryPrice, direction, atr } = params;
  const confirmed = confirmedOnly(params.entryCandles);
  const none: DsConfirmation = {
    confirmed: false,
    kind: 'NONE',
    timeframe: 'M1',
    time: 0,
    wickPrice: 0,
    close: 0,
    strength: 0,
    reason: `No confirmed M1 ${direction === 'RISE' ? 'bullish' : 'bearish'} rejection at the zone yet.`,
  };
  if (confirmed.length < 3) return none;

  const recency = params.recencyBars ?? CONFIRM_RECENCY_BARS;
  const tol = Math.max(atr * TEST_TOLERANCE_ATR, 1e-6);
  const start = Math.max(0, confirmed.length - recency);

  for (let i = confirmed.length - 1; i >= start; i--) {
    const bar = confirmed[i];
    const stats = getCandleStats(bar);
    if (direction === 'RISE') {
      const touched = bar.low <= boundaryPrice + tol;
      const reclaimed = bar.close > boundaryPrice;
      const bullish = stats.isBullish && stats.closePosition >= 0.55;
      const wickDominant = stats.lowerWick >= stats.body * 0.5 || stats.closePosition >= 0.65;
      if (touched && reclaimed && bullish && wickDominant) {
        const strength = clamp01(
          0.4 * Math.min(1, stats.lowerWick / Math.max(1e-9, stats.body)) +
            0.35 * stats.closePosition +
            0.25 * Math.min(1, stats.body / Math.max(1e-9, atr))
        );
        return {
          confirmed: true,
          kind: 'BULLISH_REJECTION',
          timeframe: 'M1',
          time: bar.time,
          wickPrice: bar.low,
          close: bar.close,
          strength: Number(strength.toFixed(3)),
          reason: `Confirmed M1 bullish rejection — wick probed the zone near ${formatPrice(
            boundaryPrice,
            2
          )} and price closed back above it.`,
        };
      }
    } else {
      const touched = bar.high >= boundaryPrice - tol;
      const reclaimed = bar.close < boundaryPrice;
      const bearish = stats.isBearish && stats.closePosition <= 0.45;
      const wickDominant = stats.upperWick >= stats.body * 0.5 || stats.closePosition <= 0.35;
      if (touched && reclaimed && bearish && wickDominant) {
        const strength = clamp01(
          0.4 * Math.min(1, stats.upperWick / Math.max(1e-9, stats.body)) +
            0.35 * (1 - stats.closePosition) +
            0.25 * Math.min(1, stats.body / Math.max(1e-9, atr))
        );
        return {
          confirmed: true,
          kind: 'BEARISH_REJECTION',
          timeframe: 'M1',
          time: bar.time,
          wickPrice: bar.high,
          close: bar.close,
          strength: Number(strength.toFixed(3)),
          reason: `Confirmed M1 bearish rejection — wick probed the zone near ${formatPrice(
            boundaryPrice,
            2
          )} and closed back below it.`,
        };
      }
    }
  }
  return none;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * M5 setup development for a zone, independent of the M1 confirmation. Describes where
 * price is relative to the zone so the panel can show a live status.
 */
export function evaluateSetupStage(
  zone: DsZone,
  setupCandles: readonly Candle[],
  setupAtr: number,
  price: number
): DsSetupStage {
  const dist = Math.abs(price - zone.proximalPrice);
  if (dist > setupAtr * APPROACH_ATR) return 'NONE';
  if (dist > setupAtr * AT_ZONE_ATR) return 'PRICE_APPROACHING';

  const confirmed = confirmedOnly(setupCandles);
  if (confirmed.length === 0) return 'AT_ZONE';
  const last = confirmed[confirmed.length - 1];
  const stats = getCandleStats(last);
  const isDemand = zone.type === 'demand';
  const touched = isDemand
    ? last.low <= zone.upperPrice + setupAtr * TEST_TOLERANCE_ATR
    : last.high >= zone.lowerPrice - setupAtr * TEST_TOLERANCE_ATR;
  if (!touched) return 'AT_ZONE';

  const directional = isDemand
    ? stats.isBullish && stats.closePosition >= 0.55
    : stats.isBearish && stats.closePosition <= 0.45;
  return directional ? 'READY_FOR_CONFIRMATION' : 'SETUP_DEVELOPING';
}

interface RawDsDetection {
  model: DsEntryModelId;
  direction: 'RISE' | 'FALL';
  zone: DsZone;
  confirmation: DsConfirmation;
  /** Price level the stop sits just beyond. */
  invalidationAnchor: number;
  setupStage: DsSetupStage;
  reasons: string[];
  confirmations: string[];
}

/**
 * Evaluates every model across the current zones and returns the strongest candidate
 * that carries a CONFIRMED M1 rejection. Zone touches without confirmation never qualify.
 */
export function detectDsCandidate(ctx: DsModelContext): DsCandidate | null {
  const confirmedEntry = confirmedOnly(ctx.entryCandles);
  const confirmedSetup = confirmedOnly(ctx.setupCandles);
  if (confirmedEntry.length < 5 || confirmedSetup.length < 5) return null;
  const last = confirmedSetup[confirmedSetup.length - 1];

  const raw = detectRaw(ctx, last);
  if (!raw) return null;
  if (!raw.confirmation.confirmed) return null;
  return finalize(ctx, raw);
}

function detectRaw(ctx: DsModelContext, lastSetup: Candle): RawDsDetection | null {
  const { zones, setupAtr, entryAtr, structureSwings } = ctx;
  if (zones.length === 0) return null;

  // Nearest zones first so the closest opportunity wins.
  const ordered = [...zones].sort((a, b) => a.distanceAtr - b.distanceAtr);

  for (const zone of ordered) {
    const isDemand = zone.type === 'demand';
    const direction: 'RISE' | 'FALL' = isDemand ? 'RISE' : 'FALL';
    const proximal = zone.proximalPrice;
    const near = Math.abs(lastSetup.close - proximal) <= setupAtr * APPROACH_ATR;
    if (!near) continue;

    const rejection = detectDsRejection({
      entryCandles: ctx.entryCandles,
      boundaryPrice: proximal,
      direction,
      atr: entryAtr,
    });
    if (!rejection.confirmed) continue;

    const setupStage = evaluateSetupStage(zone, ctx.setupCandles, setupAtr, lastSetup.close);
    const zonePhrase = `${zone.formationLabel} ${isDemand ? 'demand' : 'supply'} zone`;

    // ---- M3: liquidity sweep & reclaim (a wick swept beyond the distal edge) ----
    const swept = confirmedOnly(ctx.entryCandles).some((b) =>
      isDemand
        ? b.low < zone.distalPrice - entryAtr * 0.05 && b.close > zone.distalPrice
        : b.high > zone.distalPrice + entryAtr * 0.05 && b.close < zone.distalPrice
    );
    if (swept) {
      return {
        model: 'DS_LIQUIDITY_SWEEP_RECLAIM',
        direction,
        zone,
        confirmation: rejection,
        invalidationAnchor: isDemand
          ? Math.min(zone.distalPrice, rejection.wickPrice)
          : Math.max(zone.distalPrice, rejection.wickPrice),
        setupStage,
        reasons: [
          zone.reason,
          `Liquidity swept beyond the distal edge at ${formatPrice(zone.distalPrice, ctx.precision)} and price reclaimed the zone.`,
          rejection.reason,
        ],
        confirmations: [`M1 sweep & reclaim of the ${zonePhrase}`, rejection.reason],
      };
    }

    // ---- M6: breaker (role-flipped zone) retest ----
    if (zone.flipped) {
      return {
        model: 'DS_BREAKER_RETEST',
        direction,
        zone,
        confirmation: rejection,
        invalidationAnchor: zone.distalPrice,
        setupStage,
        reasons: [
          zone.reason,
          `Role-flipped breaker zone retested from the ${
            direction === 'RISE' ? 'upside' : 'downside'
          } near ${formatPrice(proximal, ctx.precision)} and held.`,
          rejection.reason,
        ],
        confirmations: [`Breaker block retested and held (M5)`, rejection.reason],
      };
    }

    // ---- M5: order block (zone that caused a BOS) retest ----
    if (zone.causedBos) {
      return {
        model: 'DS_ORDER_BLOCK_RETEST',
        direction,
        zone,
        confirmation: rejection,
        invalidationAnchor: zone.distalPrice,
        setupStage,
        reasons: [
          zone.reason,
          `This zone produced the break of structure — retested as an order block at ${formatPrice(
            proximal,
            ctx.precision
          )}.`,
          rejection.reason,
        ],
        confirmations: [`BOS-originating order block retested (M15 → M5)`, rejection.reason],
      };
    }

    // ---- M4: FVG confluence ----
    if (zone.hasFvgConfluence && zone.fvg) {
      return {
        model: 'DS_FVG_CONFLUENCE',
        direction,
        zone,
        confirmation: rejection,
        invalidationAnchor: zone.distalPrice,
        setupStage,
        reasons: [
          zone.reason,
          `Price delivered into the zone with a same-direction fair value gap at ${formatPrice(
            zone.fvg.lowerPrice,
            ctx.precision
          )}–${formatPrice(zone.fvg.upperPrice, ctx.precision)}.`,
          rejection.reason,
        ],
        confirmations: [`Zone + FVG confluence (M15) with M1 rejection`, rejection.reason],
      };
    }

    // ---- M7: M1 BOS / CHOCH — a decisive M1 body breaks M1 structure with the zone ----
    const confirmedEntry = confirmedOnly(ctx.entryCandles);
    const confirmIdx = confirmedEntry.findIndex((b) => b.time === rejection.time);
    if (confirmIdx > 2) {
      const bar = confirmedEntry[confirmIdx];
      const barStats = getCandleStats(bar);
      const priorWindow = confirmedEntry.slice(Math.max(0, confirmIdx - 8), confirmIdx);
      const priorHigh = priorWindow.length > 0 ? Math.max(...priorWindow.map((b) => b.high)) : null;
      const priorLow = priorWindow.length > 0 ? Math.min(...priorWindow.map((b) => b.low)) : null;
      const decisiveBody = barStats.body >= entryAtr * 1.0;
      const brokeUp = priorHigh !== null && bar.close > priorHigh + entryAtr * 0.25;
      const brokeDown = priorLow !== null && bar.close < priorLow - entryAtr * 0.25;
      const bosWithTrend = isDemand ? brokeUp && decisiveBody : brokeDown && decisiveBody;
      if (bosWithTrend) {
        return {
          model: 'DS_M1_BOS_CHOCH',
          direction,
          zone,
          confirmation: rejection,
          invalidationAnchor: zone.distalPrice,
          setupStage,
          reasons: [
            zone.reason,
            `A decisive M1 ${isDemand ? 'bullish' : 'bearish'} body broke M1 ${
              isDemand ? 'resistance' : 'support'
            } (BOS / CHOCH) out of the zone.`,
            rejection.reason,
          ],
          confirmations: [`M1 ${isDemand ? 'bullish' : 'bearish'} BOS / CHOCH confirmation`, rejection.reason],
        };
      }
    }

    // ---- M8: Engulfing confirmation — an M1 engulfing candle at the zone boundary ----
    const engIdx = confirmedOnly(ctx.entryCandles).findIndex((b) => b.time === rejection.time);
    if (engIdx > 0) {
      const bar = confirmedOnly(ctx.entryCandles)[engIdx];
      const prev = confirmedOnly(ctx.entryCandles)[engIdx - 1];
      const barStats = getCandleStats(bar);
      const prevStats = getCandleStats(prev);
      const engulfing = isDemand
        ? barStats.isBullish && prevStats.isBearish && bar.close >= prev.open && bar.open <= prev.close
        : barStats.isBearish && prevStats.isBullish && bar.close <= prev.open && bar.open >= prev.close;
      if (engulfing && barStats.body >= entryAtr * 0.8) {
        return {
          model: 'DS_ENGULFING_CONFIRMATION',
          direction,
          zone,
          confirmation: rejection,
          invalidationAnchor: zone.distalPrice,
          setupStage,
          reasons: [
            zone.reason,
            `A strong M1 ${isDemand ? 'bullish' : 'bearish'} engulfing candle confirmed the reaction at the zone boundary.`,
            rejection.reason,
          ],
          confirmations: [`M1 ${isDemand ? 'bullish' : 'bearish'} engulfing confirmation`, rejection.reason],
        };
      }
    }

    // ---- M2: retest continuation (zone already tested once and held) ----
    if (zone.state === 'TESTED' || zone.touches >= 1) {
      return {
        model: 'DS_RETEST_CONTINUATION',
        direction,
        zone,
        confirmation: rejection,
        invalidationAnchor: zone.distalPrice,
        setupStage,
        reasons: [
          zone.reason,
          `Zone already held on a first test (${zone.touches}×) — continuation retest at ${formatPrice(
            proximal,
            ctx.precision
          )}.`,
          rejection.reason,
        ],
        confirmations: [`First test held; retest continuation confirmed on M1`, rejection.reason],
      };
    }

    // ---- M1: fresh zone rejection (untested) ----
    void structureSwings;
    return {
      model: 'DS_FRESH_REJECTION',
      direction,
      zone,
      confirmation: rejection,
      invalidationAnchor: zone.distalPrice,
      setupStage,
      reasons: [
        zone.reason,
        `Fresh, untested ${zonePhrase} rejected price at ${formatPrice(proximal, ctx.precision)}.`,
        rejection.reason,
      ],
      confirmations: [`Untested fresh zone (M15) with M1 rejection`, rejection.reason],
    };
  }

  return null;
}

/** Resolves TP1 / TP2 / TP3 from the opposing zones and structural swings (never invented). */
function resolveTargets(
  ctx: DsModelContext,
  zone: DsZone,
  entryPrice: number,
  stopLoss: number
): { tp1: number; tp2: number; tp3: number | null } {
  const isRise = zone.type === 'demand';
  const risk = Math.abs(entryPrice - stopLoss) || ctx.entryAtr;
  const candidates: number[] = [];

  for (const other of ctx.zones) {
    if (other.id === zone.id) continue;
    const opposing = isRise ? other.type === 'supply' : other.type === 'demand';
    if (!opposing) continue;
    const edge = isRise ? other.lowerPrice : other.upperPrice;
    if (isRise && edge > entryPrice) candidates.push(edge);
    if (!isRise && edge < entryPrice) candidates.push(edge);
  }
  for (const s of ctx.structureSwings) {
    if (isRise && s.type === 'high' && s.price > entryPrice) candidates.push(s.price);
    if (!isRise && s.type === 'low' && s.price < entryPrice) candidates.push(s.price);
  }

  candidates.sort((a, b) => (isRise ? a - b : b - a));
  const minReward = risk * 1.2;
  const usable = candidates.filter(
    (c) => Math.abs(c - entryPrice) >= minReward && Math.abs(c - entryPrice) <= risk * 8
  );

  const fallback1 = isRise ? entryPrice + risk * 1.6 : entryPrice - risk * 1.6;
  const fallback2 = isRise ? entryPrice + risk * 2.6 : entryPrice - risk * 2.6;
  const tp1 = usable[0] ?? fallback1;
  const tp2 = usable[1] ?? (isRise ? Math.max(tp1, fallback2) : Math.min(tp1, fallback2));
  // TP3 is only offered when a real structural level supports it (no invented extension).
  const tp3 = usable[2] ?? null;
  return { tp1, tp2, tp3 };
}

function finalize(ctx: DsModelContext, raw: RawDsDetection): DsCandidate {
  const { precision, entryAtr, setupAtr, structureAtr } = ctx;
  const isRise = raw.direction === 'RISE';
  const entryPrice = raw.confirmation.close;

  // Stop sits just beyond the distal edge with an ATR buffer (zone invalidation).
  const buffer = Math.max(entryAtr * 0.5, structureAtr * 0.2);
  const stopLoss = isRise ? raw.invalidationAnchor - buffer : raw.invalidationAnchor + buffer;
  const { tp1, tp2, tp3 } = resolveTargets(ctx, raw.zone, entryPrice, stopLoss);
  const risk = Math.abs(entryPrice - stopLoss) || setupAtr;

  const score = scoreCandidate(raw, entryPrice, stopLoss, tp1);

  const entryZoneLow = Number(Math.min(raw.zone.proximalPrice, raw.zone.distalPrice).toFixed(precision));
  const entryZoneHigh = Number(Math.max(raw.zone.proximalPrice, raw.zone.distalPrice).toFixed(precision));

  const m15Context = `${raw.zone.formationLabel} ${raw.zone.type.toUpperCase()} zone · quality ${
    raw.zone.score.total
  }/100 · ${raw.zone.state.replace(/_/g, ' ').toLowerCase()}`;
  const m5Setup = `${raw.setupStage.replace(/_/g, ' ').toLowerCase()} at ${formatPrice(
    raw.zone.proximalPrice,
    precision
  )}`;
  const m1Confirmation = raw.confirmation.reason;

  return {
    model: raw.model,
    modelLabel: DS_MODEL_LABELS[raw.model],
    direction: raw.direction,
    zone: raw.zone,
    setupTime: raw.confirmation.time,
    entryPrice: Number(entryPrice.toFixed(precision)),
    entryZoneLow,
    entryZoneHigh,
    stopLoss: Number(stopLoss.toFixed(precision)),
    takeProfit1: Number(tp1.toFixed(precision)),
    takeProfit2: Number(tp2.toFixed(precision)),
    takeProfit3: tp3 === null ? null : Number(tp3.toFixed(precision)),
    invalidationPrice: Number(stopLoss.toFixed(precision)),
    invalidationCondition: `A close beyond ${formatPrice(
      stopLoss,
      precision
    )} invalidates the ${raw.zone.type} zone setup.`,
    riskRewardRatio:
      risk > 0 ? Number((Math.abs(tp1 - entryPrice) / risk).toFixed(2)) : 1.5,
    confirmation: raw.confirmation,
    setupStage: raw.setupStage,
    score,
    reasons: raw.reasons,
    confirmations: raw.confirmations,
    m15Context,
    m5Setup,
    m1Confirmation,
  };
}

/**
 * 100-point technical score: zone quality (55) + M1 confirmation strength (25) + space to
 * target (20). Zone quality already encodes formation, displacement, freshness, BOS and FVG.
 */
function scoreCandidate(
  raw: RawDsDetection,
  entryPrice: number,
  stopLoss: number,
  takeProfit: number
): number {
  const zoneQuality = raw.zone.score.total * 0.55;
  const confirmationScore = raw.confirmation.strength * 100 * 0.25;
  const risk = Math.abs(entryPrice - stopLoss) || 1e-9;
  const reward = Math.abs(takeProfit - entryPrice);
  const rr = reward / risk;
  const spaceScore = rr >= 2 ? 20 : rr >= 1.5 ? 15 : rr >= 1 ? 9 : 3;
  const stageBonus = raw.setupStage === 'READY_FOR_CONFIRMATION' ? 3 : 0;
  return Math.round(Math.min(100, zoneQuality + confirmationScore + spaceScore + stageBonus));
}

export function isDsPublishable(candidate: DsCandidate): boolean {
  return (
    candidate.score >= DS_PUBLICATION_MIN_SCORE &&
    candidate.confirmation.confirmed &&
    candidate.zone.score.total >= 55
  );
}
