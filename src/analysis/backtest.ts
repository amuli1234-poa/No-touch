import type { EntryModelCandidate, EntryModelId, MarketCondition } from '../types/engine';
import { ENTRY_MODEL_LABELS } from '../types/engine';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import type {
  BacktestReport,
  BacktestStats,
  BacktestTrade,
  EquityPoint,
  ManagedSignal,
} from '../types/training';
import { analyzeInstrument } from './signalEngine';
import { scoreCandidate } from './qualityScore';
import {
  advanceManagedSignal,
  createManagedSignal,
  isTerminal,
} from './signalManagement';
import { detectSupplyDemandZones } from './supplyDemand';
import { detectSupportResistance } from './supportResistance';
import { computeAtrSeries, detectSwings } from './swings';

/** Minimum confirmed bars required before a setup may be evaluated. */
const WARMUP_BARS = 60;
/** Trailing window (bars) used to recompute structure during the forward replay. */
const STRUCT_WINDOW = 140;
/** Trailing window (bars) handed to the engine at each evaluation step. */
const ANALYSIS_WINDOW = 220;
/** Fraction of evaluable bars treated as in-sample; the remainder is out-of-sample. */
const IN_SAMPLE_FRACTION = 0.7;

export interface BacktestParams {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  timeframe: TimeframeKey;
  model: EntryModelId;
  candles: readonly Candle[];
}

export interface RunParams {
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  timeframe: TimeframeKey;
  candles: readonly Candle[];
}

interface DetectedCandidate {
  barIndex: number;
  candidate: EntryModelCandidate;
  condition: MarketCondition;
}

function structuresAt(window: readonly Candle[], precision: number) {
  const atrs = computeAtrSeries(window, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const swings = detectSwings(window, 3, 3);
  const supportResistance = detectSupportResistance(window, swings, atr, precision);
  const supplyDemand = detectSupplyDemandZones(window, atrs, precision);
  return { supportResistance, supplyDemand };
}

export interface StaticTargets {
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number | null;
}

/** Derives the static structural targets a setup published with (never invented). */
function staticTargetsFor(candidate: EntryModelCandidate, finalTp: number): StaticTargets {
  const entry = candidate.entryPrice;
  const risk = Math.abs(entry - candidate.stopLoss);
  const isRise = candidate.direction === 'RISE';
  const tp1 = candidate.target1 ?? finalTp;
  const tp2 = candidate.target2 ?? (isRise ? entry + risk * 3 : entry - risk * 3);
  const tp3 = isRise ? entry + risk * 5 : entry - risk * 5;
  return { takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3 };
}

/** Replays one detected setup forward using the SAME management logic as live. */
function simulateSignal(
  signal: ManagedSignal,
  startIndex: number,
  candles: readonly Candle[],
  precision: number,
  targets: StaticTargets
): { signal: ManagedSignal; settlementIndex: number; highestTargetReached: 0 | 1 | 2 | 3; ambiguous: boolean } {
  let current = signal;
  let idx = startIndex;
  let highestTargetReached: 0 | 1 | 2 | 3 = 0;
  let ambiguous = false;
  const isRise = signal.direction === 'RISE';
  const targetList = [targets.takeProfit1, targets.takeProfit2, targets.takeProfit3].filter(
    (v): v is number => v !== null
  );
  for (; idx < candles.length; idx++) {
    const bar = candles[idx];
    const windowStart = Math.max(0, idx - STRUCT_WINDOW);
    const window = candles.slice(windowStart, idx + 1);
    const { supportResistance, supplyDemand } = structuresAt(window, precision);
    current = advanceManagedSignal(current, bar, {
      candles: candles.slice(0, idx + 1),
      supportResistance,
      supplyDemand,
      precision,
      now: bar.time * 1000,
    });

    // Track static-target achievement independently of the dynamic take-profit.
    if (current.status === 'ACTIVE' || current.status === 'PENDING') {
      const hits = targetList.filter((t) => (isRise ? bar.high >= t : bar.low <= t));
      if (hits.length > highestTargetReached) {
        highestTargetReached = hits.length as 0 | 1 | 2 | 3;
      }
      // If the stop and a target were both touched inside one candle the sequence is
      // unknowable — flag the trade rather than assuming a favourable order.
      const stopTouched = isRise ? bar.low <= current.stopLoss : bar.high >= current.stopLoss;
      if (stopTouched && hits.length > 0) ambiguous = true;
    }

    if (isTerminal(current.status)) {
      return { signal: current, settlementIndex: idx, highestTargetReached, ambiguous };
    }
  }
  return { signal: current, settlementIndex: idx, highestTargetReached, ambiguous };
}

function realizedRr(signal: ManagedSignal): number | null {
  const risk = Math.abs(signal.entry - signal.stopLoss);
  if (risk <= 0) return null;
  if (signal.status === 'TARGET_HIT' && signal.exitPrice !== null) {
    return Number((Math.abs(signal.exitPrice - signal.entry) / risk).toFixed(3));
  }
  if (signal.status === 'STOP_HIT') return -1;
  return null;
}

function toTrade(
  signal: ManagedSignal,
  barsHeld: number,
  targets: StaticTargets,
  highestTargetReached: 0 | 1 | 2 | 3,
  ambiguous: boolean
): BacktestTrade {
  return {
    id: signal.id,
    symbol: signal.symbol,
    displayName: signal.displayName,
    marketFamily: signal.marketFamily,
    timeframe: signal.timeframe,
    model: signal.model,
    modelLabel: signal.modelLabel,
    direction: signal.direction,
    condition: signal.condition,
    qualityScore: signal.qualityScore,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    finalTakeProfit: signal.takeProfit,
    exitPrice: signal.exitPrice,
    status: signal.status,
    realizedRr: realizedRr(signal),
    maxFavourableExcursionPct: signal.maxFavourableExcursionPct,
    maxAdverseExcursionPct: signal.maxAdverseExcursionPct,
    barsHeld,
    confirmedBarTime: signal.confirmedBarTime,
    settledBarTime: signal.settledAt,
    tpAdjustments: signal.tpHistory.filter((t) => t.kind !== 'INITIAL'),
    takeProfit1: targets.takeProfit1,
    takeProfit2: targets.takeProfit2,
    takeProfit3: targets.takeProfit3,
    highestTargetReached,
    ambiguous,
  };
}

/** Builds performance statistics from a chronological list of trades. Never fabricates. */
export function computeBacktestStats(trades: readonly BacktestTrade[]): BacktestStats {
  const totalSetups = trades.length;
  const filled = trades.filter(
    (t) => t.status === 'TARGET_HIT' || t.status === 'STOP_HIT'
  );
  const wins = filled.filter((t) => t.status === 'TARGET_HIT').length;
  const losses = filled.filter((t) => t.status === 'STOP_HIT').length;
  const missed = trades.filter((t) => t.status === 'MISSED').length;
  const invalidated = trades.filter((t) => t.status === 'INVALIDATED').length;

  const settled = wins + losses;
  const winRatePercent =
    settled > 0 ? Number(((wins / settled) * 100).toFixed(1)) : null;

  const rrs = filled
    .map((t) => t.realizedRr)
    .filter((r): r is number => r !== null);
  const averageRr =
    rrs.length > 0 ? Number((rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(3)) : null;

  // Max consecutive losses (STOP_HIT) in chronological order.
  let maxConsecutiveLosses = 0;
  let streak = 0;
  for (const t of trades) {
    if (t.status === 'STOP_HIT') {
      streak++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
    } else if (t.status === 'TARGET_HIT') {
      streak = 0;
    }
  }

  // Max drawdown (in R) over the realized equity curve.
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const t of trades) {
    if (t.realizedRr === null) continue;
    equity += t.realizedRr;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  const mfes = filled.map((t) => t.maxFavourableExcursionPct);
  const maes = filled.map((t) => t.maxAdverseExcursionPct);
  const avgFavourablePct =
    mfes.length > 0
      ? Number((mfes.reduce((a, b) => a + b, 0) / mfes.length).toFixed(3))
      : null;
  const avgAdversePct =
    maes.length > 0
      ? Number((maes.reduce((a, b) => a + b, 0) / maes.length).toFixed(3))
      : null;

  const grossWin = filled
    .filter((t) => t.status === 'TARGET_HIT' && t.realizedRr !== null)
    .reduce((a, t) => a + (t.realizedRr ?? 0), 0);
  const grossLoss = filled
    .filter((t) => t.status === 'STOP_HIT')
    .reduce((a, t) => a + Math.abs(t.realizedRr ?? 0), 0);
  const profitFactor = grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : null;

  return {
    totalSetups,
    filledTrades: filled.length,
    wins,
    losses,
    missed,
    invalidated,
    winRatePercent,
    averageRr,
    maxConsecutiveLosses,
    maxDrawdownR: Number(maxDrawdownR.toFixed(3)),
    avgFavourablePct,
    avgAdversePct,
    profitFactor,
  };
}

function buildEquityCurve(trades: readonly BacktestTrade[]): EquityPoint[] {
  const curve: EquityPoint[] = [];
  let equity = 0;
  let peak = 0;
  let index = 0;
  for (const t of trades) {
    if (t.realizedRr === null) continue;
    equity += t.realizedRr;
    peak = Math.max(peak, equity);
    curve.push({
      index: index++,
      barTime: t.settledBarTime ?? t.confirmedBarTime,
      equityR: Number(equity.toFixed(3)),
      drawdownR: Number((peak - equity).toFixed(3)),
    });
  }
  return curve;
}

/** Runs the engine once per bar and buckets every detected candidate by model. */
function detectAllModels(
  params: RunParams,
  models: readonly EntryModelId[]
): Map<EntryModelId, DetectedCandidate[]> {
  const { symbol, displayName, precision, marketFamily, timeframe, candles } = params;
  const wanted = new Set(models);
  const buckets = new Map<EntryModelId, DetectedCandidate[]>();
  for (const model of models) buckets.set(model, []);
  const evaluableEnd = candles.length - 1;

  if (candles.length <= WARMUP_BARS + 5) return buckets;

  for (let i = WARMUP_BARS; i <= evaluableEnd; i++) {
    const start = Math.max(0, i + 1 - ANALYSIS_WINDOW);
    const history = candles.slice(start, i + 1); // bar i is the forming bar; no future bars
    if (history.length < WARMUP_BARS) continue;
    let analysis;
    try {
      analysis = analyzeInstrument({
        symbol,
        displayName,
        precision,
        marketFamily,
        timeframe,
        candles: history,
      });
    } catch {
      continue;
    }
    for (const candidate of analysis.allCandidates) {
      if (!wanted.has(candidate.model)) continue;
      buckets.get(candidate.model)!.push({
        barIndex: i,
        candidate,
        condition: analysis.condition,
      });
    }
  }
  return buckets;
}

function assembleReport(
  params: RunParams,
  model: EntryModelId,
  detected: readonly DetectedCandidate[]
): BacktestReport {
  const { symbol, displayName, marketFamily, timeframe, candles, precision } = params;
  const notes: string[] = [];
  const modelLabel = ENTRY_MODEL_LABELS[model];
  if (candles.length === 0) {
    const empty = computeBacktestStats([]);
    notes.push('No candles were supplied — nothing to evaluate.');
    return {
      symbol,
      displayName,
      marketFamily,
      timeframe,
      model,
      modelLabel,
      totalBars: 0,
      warmupBars: WARMUP_BARS,
      inSampleBars: 0,
      outOfSampleBars: 0,
      splitBarTime: 0,
      inSample: empty,
      outOfSample: empty,
      overall: empty,
      trades: [],
      equityCurve: [],
      notes,
    };
  }
  const evaluableEnd = candles.length - 1;

  const trades: BacktestTrade[] = [];
  let openUntil = -1;
  for (const hit of detected) {
    if (hit.barIndex <= openUntil) continue; // one open position per model at a time
    const quality = scoreCandidate(hit.candidate);
    const signal = createManagedSignal({
      candidate: hit.candidate,
      id: `${symbol}-${timeframe}-${model}-${candles[hit.barIndex].time}`,
      confirmedBarTime: candles[hit.barIndex].time,
      createdAt: candles[hit.barIndex].time * 1000,
      symbol,
      displayName,
      marketFamily,
      timeframe,
      precision,
      condition: hit.condition,
      quality,
    });
    const targets = staticTargetsFor(hit.candidate, signal.takeProfit);
    const { signal: settled, settlementIndex, highestTargetReached, ambiguous } = simulateSignal(
      signal,
      hit.barIndex + 1,
      candles,
      precision,
      targets
    );
    trades.push(
      toTrade(
        settled,
        Math.max(0, settlementIndex - hit.barIndex),
        targets,
        highestTargetReached,
        ambiguous
      )
    );
    openUntil = isTerminal(settled.status) ? settlementIndex : evaluableEnd;
  }

  const warmupTime = candles[Math.min(WARMUP_BARS, candles.length - 1)].time;
  const lastTime = candles[evaluableEnd].time;
  const splitTime = warmupTime + (lastTime - warmupTime) * IN_SAMPLE_FRACTION;
  const inSampleTrades = trades.filter((t) => t.confirmedBarTime <= splitTime);
  const outOfSampleTrades = trades.filter((t) => t.confirmedBarTime > splitTime);

  notes.push(
    `Chronological replay of ${candles.length} real Deriv candles; each setup evaluated only from candles already closed at that bar (no look-ahead).`
  );
  notes.push(
    `Take-profit decisions replay the live management rules bar-by-bar; entry and stop-loss are locked at publication.`
  );
  notes.push(
    `In-sample = first ${(IN_SAMPLE_FRACTION * 100).toFixed(0)}% of bars; out-of-sample = remaining ${(100 - IN_SAMPLE_FRACTION * 100).toFixed(0)}%.`
  );
  if (trades.length < 20) {
    notes.push(
      `Only ${trades.length} setup(s) found — treat all rates as directional context, not statistical proof.`
    );
  }

  return {
    symbol,
    displayName,
    marketFamily,
    timeframe,
    model,
    modelLabel,
    totalBars: candles.length,
    warmupBars: WARMUP_BARS,
    inSampleBars: Math.max(0, Math.floor((candles.length - WARMUP_BARS) * IN_SAMPLE_FRACTION)),
    outOfSampleBars: Math.max(
      0,
      Math.ceil((candles.length - WARMUP_BARS) * (1 - IN_SAMPLE_FRACTION))
    ),
    splitBarTime: splitTime,
    inSample: computeBacktestStats(inSampleTrades),
    outOfSample: computeBacktestStats(outOfSampleTrades),
    overall: computeBacktestStats(trades),
    trades,
    equityCurve: buildEquityCurve(trades),
    notes,
  };
}

/** Backtests a single model over one instrument/timeframe. */
export function backtestModel(params: BacktestParams): BacktestReport {
  const buckets = detectAllModels(params, [params.model]);
  return assembleReport(params, params.model, buckets.get(params.model) ?? []);
}

/**
 * Backtests several models over one instrument/timeframe in a single chronological
 * pass. The engine is evaluated once per bar and every selected model is scored from
 * that same snapshot, so independent per-model results share one no-look-ahead replay.
 */
export function backtestModels(
  params: RunParams,
  models: readonly EntryModelId[]
): BacktestReport[] {
  const buckets = detectAllModels(params, models);
  return models.map((model) => assembleReport(params, model, buckets.get(model) ?? []));
}
