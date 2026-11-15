import type { SupportResistanceLevel, SupplyDemandZone } from '../types/analysis';
import type { EntryModelCandidate, EntryModelId, MarketCondition, QualityBreakdown } from '../types/engine';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import type { ManagedSignal, TpAdjustment } from '../types/training';
import {
  applyTakeProfit,
  evaluateDynamicTakeProfit,
  isValidTakeProfit,
} from './takeProfit';
import { detectSupplyDemandZones } from './supplyDemand';
import { detectSupportResistance } from './supportResistance';
import { computeAtrSeries, detectSwings } from './swings';

/** Context needed to create and advance a managed signal. */
export interface ManagedSignalContext {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  precision: number;
  condition: MarketCondition;
  quality: QualityBreakdown;
}

export interface CreateManagedSignalParams extends ManagedSignalContext {
  candidate: EntryModelCandidate;
  id: string;
  confirmedBarTime: number;
  createdAt: number;
}

/**
 * Creates a managed signal with a LOCKED entry, entry zone and stop-loss. The initial
 * take-profit is computed at publication from the candidate's structural target.
 */
export function createManagedSignal({
  candidate,
  id,
  confirmedBarTime,
  createdAt,
  ...ctx
}: CreateManagedSignalParams): ManagedSignal {
  const entry = candidate.entryPrice;
  const stopLoss = candidate.stopLoss;
  const initialTp =
    candidate.target1 !== null && candidate.target1 !== entry
      ? candidate.target1
      : candidate.direction === 'RISE'
        ? entry + Math.abs(entry - stopLoss) * 1.8
        : entry - Math.abs(entry - stopLoss) * 1.8;

  const initialHistory: TpAdjustment[] = [
    {
      previous: initialTp,
      next: initialTp,
      timestamp: createdAt,
      reason: 'Initial take-profit at publication, derived from the nearest opposing structure.',
      kind: 'INITIAL',
      barTime: confirmedBarTime,
    },
  ];

  return {
    id,
    market: ctx.symbol,
    symbol: ctx.symbol,
    displayName: ctx.displayName,
    marketFamily: ctx.marketFamily,
    timeframe: ctx.timeframe,
    direction: candidate.direction,
    model: candidate.model,
    modelLabel: candidate.modelLabel,
    condition: ctx.condition,
    quality: ctx.quality,
    entry,
    entryZone: [
      Math.min(entry, candidate.structuralLevelPrice),
      Math.max(entry, candidate.structuralLevelPrice),
    ],
    stopLoss,
    invalidationPrice: candidate.invalidationPrice,
    takeProfit: initialTp,
    tpHistory: initialHistory,
    status: 'PENDING',
    qualityScore: ctx.quality.total,
    riskRewardRatio: candidate.riskRewardRatio,
    explanation: candidate.confirmationExplanation,
    createdAt,
    confirmedBarTime,
    filledAt: null,
    settledAt: null,
    exitPrice: null,
    lastAdvancedBarTime: confirmedBarTime,
    maxFavourableExcursionPct: 0,
    maxAdverseExcursionPct: 0,
    lastUpdated: createdAt,
  };
}

export interface AdvanceContext {
  /** Confirmed candles up to and including the current bar (oldest → newest). */
  candles: readonly Candle[];
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
  precision: number;
  /** Wall-clock timestamp for audit records. */
  now: number;
}

const TERMINAL: ReadonlySet<ManagedSignal['status']> = new Set([
  'MISSED',
  'TARGET_HIT',
  'STOP_HIT',
  'INVALIDATED',
]);

export function isTerminal(status: ManagedSignal['status']): boolean {
  return TERMINAL.has(status);
}

/**
 * Advances a managed signal by exactly one confirmed bar. Entry and stop-loss are
 * never modified; only the take-profit and status change. Intended to be called in
 * chronological order so historical replay matches live behaviour exactly.
 */
export function advanceManagedSignal(
  signal: ManagedSignal,
  bar: Candle,
  ctx: AdvanceContext
): ManagedSignal {
  if (isTerminal(signal.status)) return signal;
  if (bar.time <= signal.lastAdvancedBarTime) return signal;

  const isRise = signal.direction === 'RISE';
  const atrs = computeAtrSeries(ctx.candles, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const last = ctx.candles[ctx.candles.length - 1];

  // ---- PENDING: wait for the entry zone to be filled, or expire/invalidate ----
  if (signal.status === 'PENDING') {
    const invalidated = isRise ? bar.close < signal.stopLoss : bar.close > signal.stopLoss;
    if (invalidated) {
      return {
        ...signal,
        status: 'INVALIDATED',
        settledAt: bar.time,
        exitPrice: bar.close,
        lastAdvancedBarTime: bar.time,
        lastUpdated: ctx.now,
      };
    }

    const zoneLow = signal.entryZone[0];
    const zoneHigh = signal.entryZone[1];
    const touched = bar.low <= zoneHigh && bar.high >= zoneLow;
    if (touched) {
      return {
        ...signal,
        status: 'ACTIVE',
        filledAt: bar.time,
        lastAdvancedBarTime: bar.time,
        lastUpdated: ctx.now,
      };
    }

    // Price moved beyond the entry opportunity without filling → MISSED (never chase).
    const missedBuffer = atr * 0.5;
    const ranAway = isRise
      ? bar.low > zoneHigh + missedBuffer
      : bar.high < zoneLow - missedBuffer;
    if (ranAway) {
      return {
        ...signal,
        status: 'MISSED',
        settledAt: bar.time,
        lastAdvancedBarTime: bar.time,
        lastUpdated: ctx.now,
      };
    }
    return { ...signal, lastAdvancedBarTime: bar.time, lastUpdated: ctx.now };
  }

  // ---- ACTIVE: track excursions, settle target/stop, then adjust TP at the close ----
  let mfe = signal.maxFavourableExcursionPct;
  let mae = signal.maxAdverseExcursionPct;
  const entry = signal.entry;
  if (entry > 0) {
    const favourablePct = isRise
      ? ((bar.high - entry) / entry) * 100
      : ((entry - bar.low) / entry) * 100;
    const adversePct = isRise
      ? ((entry - bar.low) / entry) * 100
      : ((bar.high - entry) / entry) * 100;
    mfe = Math.max(mfe, Math.max(0, favourablePct));
    mae = Math.max(mae, Math.max(0, adversePct));
  }

  // Stop-loss first (conservative: a bar spanning both levels is a loss).
  const hitStop = isRise ? bar.low <= signal.stopLoss : bar.high >= signal.stopLoss;
  if (hitStop) {
    return {
      ...signal,
      status: 'STOP_HIT',
      settledAt: bar.time,
      exitPrice: signal.stopLoss,
      maxFavourableExcursionPct: Number(mfe.toFixed(3)),
      maxAdverseExcursionPct: Number(mae.toFixed(3)),
      lastAdvancedBarTime: bar.time,
      lastUpdated: ctx.now,
    };
  }

  // Then target, using the take-profit in force during this bar.
  const hitTarget = isRise ? bar.high >= signal.takeProfit : bar.low <= signal.takeProfit;
  if (hitTarget) {
    return {
      ...signal,
      status: 'TARGET_HIT',
      settledAt: bar.time,
      exitPrice: signal.takeProfit,
      maxFavourableExcursionPct: Number(mfe.toFixed(3)),
      maxAdverseExcursionPct: Number(mae.toFixed(3)),
      lastAdvancedBarTime: bar.time,
      lastUpdated: ctx.now,
    };
  }

  // Finally, adjust the dynamic take-profit at the bar close (affects future bars only).
  let nextTp = signal.takeProfit;
  let nextHistory = signal.tpHistory;
  const evaluation = evaluateDynamicTakeProfit({
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    candles: ctx.candles,
    supportResistance: ctx.supportResistance,
    supplyDemand: ctx.supplyDemand,
    precision: ctx.precision,
    marketPrice: last.close,
  });
  if (evaluation) {
    const applied = applyTakeProfit(
      {
        direction: signal.direction,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
      },
      evaluation.newTakeProfit,
      evaluation.reason,
      last.close,
      ctx.now,
      bar.time,
      signal.tpHistory
    );
    if (applied) {
      nextTp = applied.signal.takeProfit;
      nextHistory = applied.history;
    }
  }

  return {
    ...signal,
    takeProfit: nextTp,
    tpHistory: nextHistory,
    maxFavourableExcursionPct: Number(mfe.toFixed(3)),
    maxAdverseExcursionPct: Number(mae.toFixed(3)),
    lastAdvancedBarTime: bar.time,
    lastUpdated: ctx.now,
  };
}

/** Sanity guard used by tests/live: a signal's TP must never cross its locked entry/SL. */
export function assertSignalIntegrity(signal: ManagedSignal): boolean {
  const t = signal.direction === 'RISE';
  if (t) {
    return signal.stopLoss < signal.entry && signal.takeProfit > signal.entry;
  }
  return signal.stopLoss > signal.entry && signal.takeProfit < signal.entry;
}

/** Guards a live TP change against the locked entry/stop-loss and current price. */
export function liveTakeProfitIsValid(
  signal: ManagedSignal,
  newTp: number,
  marketPrice: number
): boolean {
  return isValidTakeProfit(
    {
      direction: signal.direction,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
    },
    newTp,
    marketPrice
  );
}

/** Trailing window (bars) used to recompute structure while advancing live signals. */
const LIVE_STRUCT_WINDOW = 140;

/**
 * Advances a set of managed signals against the latest confirmed candle series,
 * using the same rules as the historical replay. Entry and stop-loss stay locked.
 */
export function advanceManagedSignalsLive(
  signals: readonly ManagedSignal[],
  candles: readonly Candle[],
  precision: number,
  now: number
): ManagedSignal[] {
  if (candles.length < 25) return signals as ManagedSignal[];
  const confirmed = candles.length > 1 ? candles.slice(0, -1) : candles; // drop the forming bar
  const windowStart = Math.max(0, confirmed.length - LIVE_STRUCT_WINDOW);
  const window = confirmed.slice(windowStart);
  const atrs = computeAtrSeries(window, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const swings = detectSwings(window, 3, 3);
  const supportResistance = detectSupportResistance(window, swings, atr, precision);
  const supplyDemand = detectSupplyDemandZones(window, atrs, precision);

  const fresh = confirmed.filter((c) => c.time > 0);
  return signals.map((signal) => {
    if (isTerminal(signal.status)) return signal;
    const startIdx = fresh.findIndex((c) => c.time > signal.lastAdvancedBarTime);
    if (startIdx === -1) return signal;
    let current = signal;
    for (let i = startIdx; i < fresh.length; i++) {
      current = advanceManagedSignal(current, fresh[i], {
        candles: fresh.slice(0, i + 1),
        supportResistance,
        supplyDemand,
        precision,
        now,
      });
      if (isTerminal(current.status)) break;
    }
    return current;
  });
}

/**
 * Creates a managed signal from a live feed item (scanner / analyser / co-analysis).
 * The entry, entry zone and stop-loss are LOCKED here; the take-profit is seeded from
 * the item's target and thereafter evolves dynamically.
 */
export function managedSignalFromFeed(item: {
  id: string;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  direction: 'RISE' | 'FALL';
  model: EntryModelId | null;
  modelLabel: string | null;
  condition: MarketCondition;
  quality: QualityBreakdown | null;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number | null;
  takeProfit2: number | null;
  confidence: number;
  createdAt: number;
  explanation?: string;
  invalidationPrice?: number;
}): ManagedSignal {
  const isRise = item.direction === 'RISE';
  const entry = item.entryPrice;
  const stopLoss = item.stopLoss;
  const risk = Math.abs(entry - stopLoss) || entry * 0.005 || 1e-6;
  const fallbackTp = isRise ? entry + risk * 1.8 : entry - risk * 1.8;
  const initialTp = item.takeProfit1 !== null && item.takeProfit1 !== entry ? item.takeProfit1 : fallbackTp;
  const quality: QualityBreakdown =
    item.quality ??
    {
      structure: 0,
      levelZone: 0,
      entryConfirmation: 0,
      momentum: 0,
      multiTimeframe: 0,
      availableSpace: 0,
      total: item.confidence,
      tier: 'HIGH_QUALITY',
      publishable: true,
    };

  return {
    id: item.id,
    market: item.symbol,
    symbol: item.symbol,
    displayName: item.displayName,
    marketFamily: item.marketFamily,
    timeframe: item.timeframe,
    direction: item.direction,
    model: item.model ?? 'MODEL_2_BREAKOUT_AND_RETEST',
    modelLabel: item.modelLabel ?? 'Confirmed Setup',
    condition: item.condition,
    quality,
    entry,
    entryZone: [Math.min(entry, stopLoss), Math.max(entry, stopLoss)],
    stopLoss,
    invalidationPrice: item.invalidationPrice ?? stopLoss,
    takeProfit: initialTp,
    tpHistory: [
      {
        previous: initialTp,
        next: initialTp,
        timestamp: item.createdAt,
        reason: 'Initial take-profit at publication, derived from the nearest opposing structure.',
        kind: 'INITIAL',
        barTime: Math.floor(item.createdAt / 1000),
      },
    ],
    status: 'PENDING',
    qualityScore: quality.total,
    riskRewardRatio: Number((Math.abs(initialTp - entry) / risk).toFixed(2)),
    explanation: item.explanation ?? 'Confirmed setup from the shared analysis engine.',
    createdAt: item.createdAt,
    confirmedBarTime: Math.floor(item.createdAt / 1000),
    filledAt: null,
    settledAt: null,
    exitPrice: null,
    lastAdvancedBarTime: Math.floor(item.createdAt / 1000),
    maxFavourableExcursionPct: 0,
    maxAdverseExcursionPct: 0,
    lastUpdated: item.createdAt,
  };
}
