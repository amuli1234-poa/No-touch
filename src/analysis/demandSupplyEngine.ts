import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import type {
  DsCandidate,
  DsInstrumentAnalysis,
  DsScanSummary,
  DsSignal,
  DsSignalStatus,
  DsTimeframeRead,
  DsZone,
} from '../types/demandSupply';
import { analyzeMarketStructure } from './structure';
import { detectFairValueGaps } from './structureEngine';
import { computeAtrSeries, detectSwings } from './swings';
import { confirmedOnly } from './trendlineDetection';
import { detectDsZones } from './demandSupplyDetection';
import { detectDsCandidate, isDsPublishable } from './demandSupplyModels';
import { applyFlips, trackDsZones, zoneInPlay } from './demandSupplyZones';
import { aiAtr, ladderTimeframeReads, readAiCondition } from './aiCommon';
import { AI_TIMEFRAME_KEYS } from '../config/deriv';

export interface AnalyzeDsParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  /** Confirmed M15 candles (primary supply/demand identification). */
  structureCandles: readonly Candle[];
  /** Confirmed M7 candles (trend & market-structure confirmation). Optional. */
  trendCandles?: readonly Candle[];
  /** Confirmed M5 candles (zone refinement + setup development). */
  setupCandles: readonly Candle[];
  /** Confirmed M3 candles (entry-setup confirmation). Optional. */
  confirmCandles?: readonly Candle[];
  /** Confirmed M1 candles (rejection + entry confirmation). */
  entryCandles: readonly Candle[];
  /** ALL TEN analysis timeframes for this index (M30/M15/M10/M7/M6/M5/M4/M3/M2/M1). */
  candlesByTimeframe?: Partial<Record<TimeframeKey, readonly Candle[]>>;
  dataHealth?: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
}

const STRUCTURE_TF: TimeframeKey = 'M15';
const TREND_TF: TimeframeKey = 'M7';
const SETUP_TF: TimeframeKey = 'M5';
const CONFIRM_TF: TimeframeKey = 'M3';
const ENTRY_TF: TimeframeKey = 'M1';

/**
 * M7 (trend & structure) and M3 (entry-setup confirmation) reads for the Demand & Supply
 * AI. Present only when those series were supplied, so a timeframe is never fabricated.
 */
function optionalDsTimeframeReads(params: AnalyzeDsParams): {
  m7: DsTimeframeRead | null;
  m3: DsTimeframeRead | null;
} {
  const build = (
    candles: readonly Candle[] | undefined,
    timeframe: TimeframeKey,
    label: string,
    role: string
  ): DsTimeframeRead | null => {
    if (!candles) return null;
    const confirmed = confirmedOnly(candles);
    if (confirmed.length < 30) {
      return { timeframe, label, detail: `Insufficient ${timeframe} data.`, tone: 'neutral' };
    }
    const read = readAiCondition(confirmed, aiAtr(confirmed));
    const tone: DsTimeframeRead['tone'] =
      read.bias === 'bullish'
        ? 'bull'
        : read.bias === 'bearish'
          ? 'bear'
          : read.condition === 'RANGING' || read.condition === 'CONSOLIDATION'
            ? 'warn'
            : 'neutral';
    return { timeframe, label, detail: `${role} — ${read.detail}`, tone };
  };
  return {
    m7: build(params.trendCandles, 'M7', 'M7 trend & structure', 'Trend & structure'),
    m3: build(params.confirmCandles, 'M3', 'M3 confirmation', 'Entry-setup confirmation'),
  };
}

function atrOf(candles: readonly Candle[]): number {
  const series = computeAtrSeries(candles, 14);
  return series[series.length - 1] || 1e-6;
}

/**
 * The DEMAND & SUPPLY AI engine — fully independent of the price-action engine and the
 * Trendline AI.
 *
 *  - M15 identifies the primary demand / supply zones (DBR/RBR/RBD/DBD + displacement).
 *  - M7 reads the trend and market structure for context.
 *  - M5 refines the zones and develops the setup.
 *  - M3 confirms the entry setup.
 *  - M1 confirms the rejection entry (mandatory for every model).
 *  - A signal is only published when a confirmed M1 rejection clears the 85/100 gate.
 */
export function analyzeDsInstrument(params: AnalyzeDsParams): DsInstrumentAnalysis {
  const {
    symbol,
    displayName,
    precision,
    marketFamily,
    structureCandles,
    setupCandles,
    entryCandles,
    dataHealth = 'HEALTHY',
  } = params;

  const structure = confirmedOnly(structureCandles);
  const setup = confirmedOnly(setupCandles);
  const liveSetupBar = setupCandles.length > 0 ? setupCandles[setupCandles.length - 1] : null;
  const price = liveSetupBar
    ? liveSetupBar.close
    : structure.length > 0
      ? structure[structure.length - 1].close
      : 0;
  const now = Date.now();

  const baseTimeframes: DsTimeframeRead[] = [
    { timeframe: 'M30', label: 'M30 major trend', detail: 'Awaiting confirmed M30 data.', tone: 'neutral' },
    { timeframe: 'M15', label: 'M15 zones', detail: 'Awaiting confirmed M15 structure.', tone: 'neutral' },
    { timeframe: 'M10', label: 'M10 intermediate structure', detail: 'Awaiting confirmed M10 data.', tone: 'neutral' },
    { timeframe: 'M7', label: 'M7 trend & structure', detail: 'Awaiting confirmed M7 data.', tone: 'neutral' },
    { timeframe: 'M6', label: 'M6 intermediate structure', detail: 'Awaiting confirmed M6 data.', tone: 'neutral' },
    { timeframe: 'M5', label: 'M5 setup', detail: 'Awaiting M5 data.', tone: 'neutral' },
    { timeframe: 'M4', label: 'M4 supporting structure', detail: 'Awaiting confirmed M4 data.', tone: 'neutral' },
    { timeframe: 'M3', label: 'M3 confirmation', detail: 'Awaiting confirmed M3 data.', tone: 'neutral' },
    { timeframe: 'M2', label: 'M2 entry refinement', detail: 'Awaiting confirmed M2 data.', tone: 'neutral' },
    { timeframe: 'M1', label: 'M1 confirmation', detail: 'Awaiting M1 data.', tone: 'neutral' },
  ];

  const empty: DsInstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    status: 'ANALYSING',
    statusExplanation: 'Insufficient confirmed candles for demand & supply analysis.',
    timeframes: baseTimeframes,
    zones: [],
    freshDemand: null,
    freshSupply: null,
    activeZone: null,
    bestCandidate: null,
    signal: null,
    allCandidates: [],
    futureWatchZones: [],
    demandSupplyBalance: 'BALANCED',
    atr: 0,
    dataHealth,
    lastUpdated: now,
    rejectionReason:
      dataHealth !== 'HEALTHY'
        ? `Live market data feed is ${dataHealth.toLowerCase()}.`
        : 'Insufficient confirmed candles for demand & supply analysis.',
  };

  if (structure.length < 30 || setup.length < 20 || dataHealth !== 'HEALTHY') {
    return empty;
  }

  const structureAtr = atrOf(structure);
  const setupAtr = atrOf(setup);
  const entryAtr = atrOf(entryCandles);
  const swings = detectSwings(structure, 3, 3);
  const marketStructure = analyzeMarketStructure(
    structure,
    swings,
    computeAtrSeries(structure, 14),
    precision
  );
  const fvgs = detectFairValueGaps(structure, structureAtr, precision);

  const rawZones = detectDsZones({
    structureCandles: structure,
    refinementCandles: setup,
    structureAtr,
    precision,
    swings,
    breaks: marketStructure.breaks,
    fvgs,
  });

  // First pass establishes the zones (without opposing-zone context), the second pass
  // re-scores each zone with the real room to the nearest opposing level.
  const firstPass = trackDsZones({
    raw: rawZones,
    candles: structure,
    atr: structureAtr,
    precision,
    htfDirection: marketStructure.direction,
  });
  const zones = applyFlips(
    trackDsZones({
      raw: rawZones,
      candles: structure,
      atr: structureAtr,
      precision,
      htfDirection: marketStructure.direction,
      opposingZones: firstPass,
    })
  );

  const demandZones = zones.filter((z) => z.type === 'demand');
  const supplyZones = zones.filter((z) => z.type === 'supply');
  const demandQuality = demandZones.reduce((a, z) => a + z.score.total, 0);
  const supplyQuality = supplyZones.reduce((a, z) => a + z.score.total, 0);
  const demandSupplyBalance: DsInstrumentAnalysis['demandSupplyBalance'] =
    demandQuality > supplyQuality * 1.25
      ? 'DEMAND_DOMINANT'
      : supplyQuality > demandQuality * 1.25
        ? 'SUPPLY_DOMINANT'
        : 'BALANCED';

  const freshDemand = demandZones.find((z) => z.state === 'FRESH') ?? null;
  const freshSupply = supplyZones.find((z) => z.state === 'FRESH') ?? null;
  const activeZone = zones.find((z) => zoneInPlay(z, price, setupAtr)) ?? null;
  // FUTURE watch zones: still ahead of price and untouched — where price may react NEXT.
  const futureWatchZones = zones
    .filter((z) => z.isFutureWatch)
    .sort((a, b) => a.distanceAtr - b.distanceAtr)
    .slice(0, 4);

  const ctx = {
    symbol,
    precision,
    zones,
    structureCandles: structure,
    setupCandles,
    entryCandles,
    structureAtr,
    setupAtr,
    entryAtr,
    structureSwings: swings,
  };

  const candidate = detectDsCandidate(ctx);
  const allCandidates: DsCandidate[] = candidate ? [candidate] : [];
  const publishable = candidate ? isDsPublishable(candidate) : false;

  let signal: DsSignal | null = null;
  if (candidate && publishable) {
    signal = buildSignal({
      candidate,
      symbol,
      displayName,
      marketFamily,
      precision,
      confirmedBarTime: liveSetupBar ? liveSetupBar.time : candidate.setupTime,
      now,
    });
  }

  const { status, statusExplanation } = deriveStatus({
    zones,
    freshDemand,
    freshSupply,
    activeZone,
    candidate,
    publishable,
    price,
    setupAtr,
    demandSupplyBalance,
  });

  const { m7: m7Read, m3: m3Read } = optionalDsTimeframeReads(params);
  const timeframes: DsTimeframeRead[] = [
    {
      timeframe: 'M15',
      label: 'M15 zones',
      detail: buildM15Detail(zones, demandSupplyBalance),
      tone: demandSupplyBalance === 'DEMAND_DOMINANT' ? 'bull' : demandSupplyBalance === 'SUPPLY_DOMINANT' ? 'bear' : 'neutral',
    },
    ...(m7Read ? [m7Read] : []),
    {
      timeframe: 'M5',
      label: 'M5 setup',
      detail: candidate
        ? `${candidate.setupStage.replace(/_/g, ' ').toLowerCase()} — ${candidate.m5Setup}`
        : activeZone
          ? `price ${activeZone.type === 'demand' ? 'at demand' : 'at supply'} (${activeZone.formationLabel})`
          : 'no zone in play — waiting for price to reach a valid zone',
      tone: candidate ? 'bull' : activeZone ? 'warn' : 'neutral',
    },
    ...(m3Read ? [m3Read] : []),
    {
      timeframe: 'M1',
      label: 'M1 confirmation',
      detail: candidate?.confirmation.confirmed
        ? candidate.confirmation.reason
        : 'no confirmed M1 rejection yet — a zone touch alone is not an entry',
      tone: candidate?.confirmation.confirmed ? (candidate.direction === 'RISE' ? 'bull' : 'bear') : 'warn',
    },
  ];
  // Surface the remaining ten-timeframe ladder reads (M30/M10/M6/M4/M2) the engine read.
  {
    const seen = new Set(timeframes.map((r) => r.timeframe));
    for (const extra of ladderTimeframeReads(params.candlesByTimeframe)) {
      if (seen.has(extra.timeframe)) continue;
      seen.add(extra.timeframe);
      timeframes.push({ timeframe: extra.timeframe, label: extra.label, detail: extra.detail, tone: extra.tone });
    }
    timeframes.sort(
      (a, b) => AI_TIMEFRAME_KEYS.indexOf(a.timeframe) - AI_TIMEFRAME_KEYS.indexOf(b.timeframe)
    );
  }

  const rejectionReason = publishable
    ? undefined
    : candidate
      ? `Best demand & supply candidate scored ${candidate.score}/100 — below the ${85} publication minimum.`
      : activeZone
        ? `Price is working with a ${activeZone.formationLabel} ${activeZone.type} zone — waiting for a confirmed M1 rejection.`
        : zones.length === 0
          ? 'No valid demand or supply zone within range on the current M15 structure.'
          : 'No zone in play and no confirmed M1 rejection — waiting.';

  return {
    symbol,
    displayName,
    marketFamily,
    precision,
    price,
    status,
    statusExplanation,
    timeframes,
    zones,
    freshDemand,
    freshSupply,
    activeZone,
    bestCandidate: candidate,
    signal,
    allCandidates,
    futureWatchZones,
    demandSupplyBalance,
    atr: structureAtr,
    dataHealth,
    lastUpdated: now,
    rejectionReason,
  };
}

function buildM15Detail(
  zones: readonly DsZone[],
  balance: DsInstrumentAnalysis['demandSupplyBalance']
): string {
  const demand = zones.filter((z) => z.type === 'demand').length;
  const supply = zones.filter((z) => z.type === 'supply').length;
  if (demand === 0 && supply === 0) return 'no valid zones — structure is not producing clean imbalances';
  const balanceText =
    balance === 'DEMAND_DOMINANT' ? 'demand dominant' : balance === 'SUPPLY_DOMINANT' ? 'supply dominant' : 'balanced';
  return `${demand} demand · ${supply} supply zone${demand + supply === 1 ? '' : 's'} (${balanceText})`;
}

function deriveStatus(params: {
  zones: readonly DsZone[];
  freshDemand: DsZone | null;
  freshSupply: DsZone | null;
  activeZone: DsZone | null;
  candidate: DsCandidate | null;
  publishable: boolean;
  price: number;
  setupAtr: number;
  demandSupplyBalance: DsInstrumentAnalysis['demandSupplyBalance'];
}): { status: DsSignalStatus; statusExplanation: string } {
  const { zones, freshDemand, freshSupply, activeZone, candidate, publishable } = params;

  if (candidate && publishable) {
    return {
      status: candidate.direction === 'RISE' ? 'RISE_CONFIRMED' : 'FALL_CONFIRMED',
      statusExplanation: `${candidate.modelLabel} confirmed on M1 — ${candidate.direction} signal published (score ${candidate.score}/100).`,
    };
  }

  if (candidate && !publishable) {
    return {
      status: 'WAITING_FOR_CONFIRMATION',
      statusExplanation: `Setup detected but scored ${candidate.score}/100 — below the 85 publication gate.`,
    };
  }

  if (activeZone) {
    const isDemand = activeZone.type === 'demand';
    return {
      status: isDemand ? 'WATCHING_DEMAND' : 'WATCHING_SUPPLY',
      statusExplanation: `Price is working with a ${activeZone.formationLabel} ${
        isDemand ? 'demand' : 'supply'
      } zone (quality ${activeZone.score.total}/100) — waiting for a confirmed M1 rejection.`,
    };
  }

  if (freshDemand || freshSupply) {
    const zone = freshDemand ?? freshSupply;
    const isDemand = zone!.type === 'demand';
    return {
      status: isDemand ? 'FRESH_DEMAND_FOUND' : 'FRESH_SUPPLY_FOUND',
      statusExplanation: `Fresh ${isDemand ? 'demand' : 'supply'} zone detected at ${zone!.formationLabel} (quality ${
        zone!.score.total
      }/100) — not yet in play, no entry until price returns and rejects.`,
    };
  }

  if (zones.length > 0) {
    return {
      status: 'ANALYSING',
      statusExplanation: `${zones.length} valid zone${zones.length === 1 ? '' : 's'} tracked, none in play yet.`,
    };
  }

  return {
    status: 'NO_VALID_SETUP',
    statusExplanation: 'No valid demand or supply zone on the current M15 structure.',
  };
}

function buildSignal(params: {
  candidate: DsCandidate;
  symbol: string;
  displayName: string;
  marketFamily: MarketFamily;
  precision: number;
  confirmedBarTime: number;
  now: number;
}): DsSignal {
  const { candidate, symbol, displayName, marketFamily, precision, confirmedBarTime, now } = params;
  return {
    id: `ds-${symbol}-${candidate.model}-${candidate.direction}-${confirmedBarTime}`,
    symbol,
    displayName,
    marketFamily,
    precision,
    direction: candidate.direction,
    model: candidate.model,
    modelLabel: candidate.modelLabel,
    structureTimeframe: STRUCTURE_TF,
    trendTimeframe: TREND_TF,
    setupTimeframe: SETUP_TF,
    confirmTimeframe: CONFIRM_TF,
    entryTimeframe: ENTRY_TF,
    score: candidate.score,
    zoneQuality: candidate.zone.score.total,
    entryPrice: candidate.entryPrice,
    entryZoneLow: candidate.entryZoneLow,
    entryZoneHigh: candidate.entryZoneHigh,
    stopLoss: candidate.stopLoss,
    takeProfit1: candidate.takeProfit1,
    takeProfit2: candidate.takeProfit2,
    takeProfit3: candidate.takeProfit3,
    invalidationPrice: candidate.invalidationPrice,
    invalidationCondition: candidate.invalidationCondition,
    riskRewardRatio: candidate.riskRewardRatio,
    zone: candidate.zone,
    confirmation: candidate.confirmation,
    setupStage: candidate.setupStage,
    reasons: candidate.reasons,
    confirmations: candidate.confirmations,
    m15Context: candidate.m15Context,
    m5Setup: candidate.m5Setup,
    m1Confirmation: candidate.m1Confirmation,
    status: 'CONFIRMED',
    createdAt: now,
    confirmedBarTime,
    lastUpdated: now,
  };
}

/** Selects the single strongest confirmed demand & supply signal across the scan. */
export function selectStrongestDs(
  analyses: readonly DsInstrumentAnalysis[]
): DsScanSummary {
  const confirmed = analyses.filter((a) => a.signal !== null);
  const opportunities = confirmed
    .map((a) => a.signal as DsSignal)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.riskRewardRatio - a.riskRewardRatio;
    });

  const winner = opportunities[0] ?? null;
  const winnerAnalysis = winner
    ? confirmed.find((a) => a.signal?.id === winner.id) ?? null
    : null;

  const anyZones = analyses.some((a) => a.zones.length > 0);
  return {
    winner,
    winnerAnalysis,
    opportunities,
    scannedCount: analyses.length,
    confirmedCount: confirmed.length,
    scannedAt: Date.now(),
    statusBanner: winner
      ? `DEMAND & SUPPLY SIGNAL CONFIRMED — ${winner.displayName} ${winner.direction} · ${winner.modelLabel}`
      : anyZones
        ? 'ZONES TRACKED — NO CONFIRMED M1 REJECTION YET (WAITING).'
        : 'NO VALID DEMAND OR SUPPLY ZONE ACROSS SCANNED MARKETS.',
    structureTimeframe: STRUCTURE_TF,
    setupTimeframe: SETUP_TF,
    entryTimeframe: ENTRY_TF,
  };
}

/** Derives a managed signal's lifecycle from fresh M1 candles. */
export function dsSignalStatus(
  signal: DsSignal,
  candles: readonly Candle[]
): DsSignal['status'] {
  if (candles.length === 0) return signal.status;
  const isRise = signal.direction === 'RISE';
  for (const bar of candles) {
    if (bar.time < signal.confirmedBarTime) continue;
    const hitStop = isRise ? bar.close < signal.stopLoss : bar.close > signal.stopLoss;
    if (hitStop) return 'INVALIDATED';
    const hitTarget = isRise ? bar.high >= signal.takeProfit1 : bar.low <= signal.takeProfit1;
    if (hitTarget) return 'COMPLETED';
  }
  return signal.status === 'CONFIRMED' ? 'ACTIVE' : signal.status;
}

export { DS_MODEL_LABELS, DS_MODEL_IDS } from '../types/demandSupply';
