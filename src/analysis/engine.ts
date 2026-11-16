import type {
  AnalysisRunState,
  ChartOverlayData,
  ConfluenceFactor,
  FullAnalysisReport,
  LiquiditySweepEvent,
  MarketDirection,
  MultiTimeframeCandles,
  MultiTimeframeSummary,
  SignalDecisionState,
  SignalQualityTier,
  SignalSnapshot,
  StructureBreakEvent,
  TimeframeAnalysisSummary,
  TradeSignalCard,
} from '../types/analysis';
import type { SignalState } from '../types/engine';
import type { MajorTrendline, MajorZone } from '../types/intelligence';
import type { StructureOverlayData } from '../types/structure';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import { classifyMarketFamily } from '../utils/derivParser';
import { pruneOverlaysForLiveChart } from './chartCleanliness';
import { buildIndicatorSnapshot } from './indicators';
import { analyzeInstrument } from './signalEngine';
import { assessMomentum } from './momentum';
import { analyzeMarketStructure } from './structure';
import { analyzeMarketIntelligence } from './marketIntelligence';
import { detectMajorSwings, detectMajorTrendlines, detectMajorZones } from './majorStructure';
import { analyzeStructure, markZoneEntryConfirmed } from './structureEngine';
import { detectSupplyDemandZones } from './supplyDemand';
import { detectSupportResistance } from './supportResistance';
import { computeAtrSeries, detectSwings } from './swings';
import { detectChartPatterns, detectTrendlines } from './trendlinesAndPatterns';

const TOP_DOWN_ORDER: readonly TimeframeKey[] = ['H4', 'H1', 'M15', 'M7', 'M5', 'M3', 'M1'];

interface SingleTimeframeDetails {
  summary: TimeframeAnalysisSummary;
  atr: number;
  swings: ReturnType<typeof detectSwings>;
  supportResistance: ReturnType<typeof detectSupportResistance>;
  supplyDemand: ReturnType<typeof detectSupplyDemandZones>;
  breaks: StructureBreakEvent[];
  latestBreak: StructureBreakEvent | null;
  liquiditySweeps: LiquiditySweepEvent[];
  trendlines: ReturnType<typeof detectTrendlines>;
  patterns: ReturnType<typeof detectChartPatterns>;
  majorTrendlines: MajorTrendline[];
  majorZones: MajorZone[];
}

function analyzeSingleTimeframe(
  timeframe: TimeframeKey,
  rawCandles: readonly Candle[],
  precision: number
): SingleTimeframeDetails | null {
  const confirmed = rawCandles.length > 2 ? rawCandles.slice(0, -1) : rawCandles;
  if (confirmed.length < 25) return null;

  const atrs = computeAtrSeries(confirmed, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const swings = detectSwings(confirmed, 3, 3);
  const supportResistance = detectSupportResistance(confirmed, swings, atr, precision);
  const structure = analyzeMarketStructure(confirmed, swings, atrs, precision);
  const supplyDemand = detectSupplyDemandZones(confirmed, atrs, precision);
  const trendlines = detectTrendlines(confirmed, swings, atr, precision);
  const patterns = detectChartPatterns(confirmed, swings, atr, precision);

  // MAJOR structure (clean-chart layer): major swings → major trendlines + S/R zones.
  const majorSwings = detectMajorSwings(confirmed, atrs, atr);
  const majorTrendlines = detectMajorTrendlines(confirmed, majorSwings, atr, precision);
  const majorZones = detectMajorZones(confirmed, majorSwings, atr, precision);

  const keySupport =
    supportResistance.find((l) => l.type === 'support' && l.status === 'active')?.price ??
    structure.lastSwingLow?.price ??
    null;
  const keyResistance =
    supportResistance.find((l) => l.type === 'resistance' && l.status === 'active')?.price ??
    structure.lastSwingHigh?.price ??
    null;

  const freshZonesCount = supplyDemand.filter((z) => z.status === 'fresh').length;
  const notes: string[] = [`${timeframe} structure: ${structure.structureLabel}`];
  if (structure.latestBreak) notes.push(structure.latestBreak.reason);
  if (freshZonesCount > 0) {
    notes.push(`${freshZonesCount} fresh supply/demand zone${freshZonesCount > 1 ? 's' : ''} active.`);
  }

  return {
    summary: {
      timeframe,
      direction: structure.direction,
      structureLabel: structure.structureLabel,
      candleCount: confirmed.length,
      keySupport,
      keyResistance,
      latestBreak: structure.latestBreak,
      freshZonesCount,
      notes,
    },
    atr,
    swings,
    supportResistance,
    supplyDemand,
    breaks: structure.breaks,
    latestBreak: structure.latestBreak,
    liquiditySweeps: structure.liquiditySweeps,
    trendlines,
    patterns,
    majorTrendlines,
    majorZones,
  };
}

/**
 * Picks the analysis timeframe hierarchy from the CHART the user is viewing — never
 * from a contract duration. The viewed timeframe is the setup timeframe; the higher
 * and lower timeframes provide context and precision entry respectively.
 */
export function deriveMultiTimeframe(viewed: TimeframeKey): MultiTimeframeSummary {
  switch (viewed) {
    case 'H4':
      return {
        macroTf: 'H4',
        structuralTf: 'H4',
        setupTf: 'H4',
        entryTf: 'H1',
        rationale: 'H4 view: H4 defines trend and setup; H1 refines the entry trigger.',
      };
    case 'H1':
      return {
        macroTf: 'H4',
        structuralTf: 'H1',
        setupTf: 'H1',
        entryTf: 'M15',
        rationale: 'H1 view: H4 major trend → H1 structure and setup → M15 entry trigger.',
      };
    case 'M15':
      return {
        macroTf: 'H1',
        structuralTf: 'M15',
        setupTf: 'M15',
        entryTf: 'M5',
        rationale: 'M15 view: H1 trend → M15 structure and setup → M5 entry trigger.',
      };
    case 'M7':
      return {
        macroTf: 'M15',
        structuralTf: 'M7',
        setupTf: 'M7',
        entryTf: 'M3',
        rationale: 'M7 view: M15 bias → M7 structure and setup → M3 entry confirmation.',
      };
    case 'M5':
      return {
        macroTf: 'H1',
        structuralTf: 'M15',
        setupTf: 'M5',
        entryTf: 'M1',
        rationale: 'M5 view: H1 trend → M15 zones → M5 setup → M1 precision entry.',
      };
    case 'M3':
      return {
        macroTf: 'M15',
        structuralTf: 'M5',
        setupTf: 'M3',
        entryTf: 'M1',
        rationale: 'M3 view: M15 bias → M5 setup → M3 entry confirmation → M1 execution.',
      };
    case 'M1':
    default:
      return {
        macroTf: 'M15',
        structuralTf: 'M5',
        setupTf: 'M1',
        entryTf: 'M1',
        rationale: 'M1 view: M15 trend → M5 structure → M1 setup and entry.',
      };
  }
}

function tierToSetupQuality(
  tier: 'EXCEPTIONAL' | 'HIGH_QUALITY' | 'DEVELOPING' | 'REJECTED' | undefined
): SignalQualityTier {
  if (tier === 'EXCEPTIONAL') return 'EXCEPTIONAL';
  if (tier === 'HIGH_QUALITY') return 'HIGH QUALITY';
  if (tier === 'DEVELOPING') return 'DEVELOPING';
  return 'INVALID SETUP';
}

export interface RunTopDownAnalysisParams {
  symbol: string;
  marketName: string;
  marketFamily?: MarketFamily;
  activeTimeframe: TimeframeKey;
  precision: number;
  multiTimeframeCandles: MultiTimeframeCandles;
  previousSignal?: TradeSignalCard | null;
  /** Original scanner/analyser evidence to reproduce verbatim on the chart. */
  snapshot?: SignalSnapshot | null;
}

/**
 * Depth engine: top-down price-action analysis of whichever chart the user opened.
 * Fully duration-free. Returns a report whose signal (when present) carries model,
 * condition, 100-point quality and structural entry/invalidation/targets.
 */
export function runTopDownPriceActionAnalysis({
  symbol,
  marketName,
  marketFamily: explicitFamily,
  activeTimeframe,
  precision,
  multiTimeframeCandles,
  previousSignal,
  snapshot,
}: RunTopDownAnalysisParams): FullAnalysisReport {
  const marketFamily = explicitFamily ?? classifyMarketFamily(symbol, '', marketName);
  const multiTimeframe = deriveMultiTimeframe(activeTimeframe);

  const activeRaw = multiTimeframeCandles[activeTimeframe] ?? [];
  const liveBar = activeRaw.length > 0 ? activeRaw[activeRaw.length - 1] : null;
  const confirmed = activeRaw.length > 2 ? activeRaw.slice(0, -1) : activeRaw;
  const latestConfirmedBar = confirmed.length > 0 ? confirmed[confirmed.length - 1] : null;

  const perTfDetails: Partial<Record<TimeframeKey, SingleTimeframeDetails>> = {};
  const topDownSummaries: Partial<Record<TimeframeKey, TimeframeAnalysisSummary>> = {};

  for (const tf of TOP_DOWN_ORDER) {
    const series = multiTimeframeCandles[tf];
    if (!series || series.length < 25) continue;
    const detail = analyzeSingleTimeframe(tf, series, precision);
    if (detail) {
      perTfDetails[tf] = detail;
      topDownSummaries[tf] = detail.summary;
    }
  }

  const activeDetail = perTfDetails[activeTimeframe];
  const emptyOverlays: ChartOverlayData = {
    supportResistance: [],
    supplyDemand: [],
    structureBreaks: [],
    liquiditySweeps: [],
    trendlines: [],
    patterns: [],
    swingPoints: [],
    majorTrendlines: [],
    majorZones: [],
    range: null,
    entryZone: null,
    breakoutRetest: null,
    signal: null,
    structure: null,
  };

  if (!activeDetail || !latestConfirmedBar || !liveBar) {
    return {
      symbol,
      marketName,
      marketFamily,
      timeframe: activeTimeframe,
      precision,
      multiTimeframe,
      analyzedAt: Date.now(),
      confirmedBarTime: latestConfirmedBar?.time ?? 0,
      runState: 'WAITING FOR CONFIRMATION',
      signalStatus: 'WAIT',
      signalState: 'SCANNING',
      bosConfirmationPrice: null,
      overallDirection: 'NEUTRAL',
      marketCondition: 'CHOPPY',
      conditionExplanation: 'Awaiting sufficient confirmed candle history.',
      htfConflictNote: null,
      htfAlignmentSummary: 'HTF context unavailable',
      currentStructureSummary: 'Insufficient confirmed candles for structural analysis.',
      momentum: assessMomentum({
        candles: confirmed,
        atr: 0,
        supportResistance: [],
        supplyDemand: [],
      }),
      indicators: buildIndicatorSnapshot([]),
      topDownSummaries,
      overlays: emptyOverlays,
      liquiditySweeps: [],
      intelligence: null,
      findings: null,
      reachability: null,
      falseSignal: null,
      recommendedDirection: 'WAIT',
      setupQuality: 'INVALID SETUP',
      developingCandidate: null,
      evaluatedModels: [],
      confluenceScore: 0,
      maxConfluenceScore: 0,
      confluenceFactors: [],
      whyThisSetup: [],
      entryTriggerText: 'Awaiting confirmed multi-timeframe candle data.',
      invalidationText: 'N/A',
      noSetupMessage: 'NO HIGH-QUALITY SETUP — WAITING FOR CONFIRMATION.',
      snapshot: snapshot ?? null,
    };
  }

  // Reuse the same duration-free engine the scanner uses — identical rules, scoring and
  // signal logic — with higher-timeframe context supplied for multi-timeframe scoring.
  const analysis = analyzeInstrument({
    symbol,
    displayName: marketName,
    precision,
    marketFamily,
    timeframe: activeTimeframe,
    candles: activeRaw,
    htfContext: {
      macroCandles: multiTimeframeCandles[multiTimeframe.macroTf],
      structuralCandles: multiTimeframeCandles[multiTimeframe.structuralTf],
      macroTfLabel: multiTimeframe.macroTf,
      structuralTfLabel: multiTimeframe.structuralTf,
      // The sideways range is defined on M15; the boundary rejection is confirmed on M5.
      rangeCandles: multiTimeframeCandles.M15 ?? activeRaw,
      entryCandles: multiTimeframeCandles.M5 ?? activeRaw,
    },
  });

  const momentum = assessMomentum({
    candles: confirmed,
    atr: activeDetail.atr,
    supportResistance: activeDetail.supportResistance,
    supplyDemand: activeDetail.supplyDemand,
  });

  const htfMacroDir =
    topDownSummaries[multiTimeframe.macroTf]?.direction ?? 'NEUTRAL';
  const htfStructDir =
    topDownSummaries[multiTimeframe.structuralTf]?.direction ?? 'NEUTRAL';
  const activeDir = analysis.structureDirection;

  let htfConflictNote: string | null = null;
  if (analysis.signal) {
    const want = analysis.signal.direction === 'RISE' ? 'BULLISH' : 'BEARISH';
    if (htfMacroDir !== want && htfStructDir !== want && htfMacroDir !== 'NEUTRAL') {
      htfConflictNote = `Setup opposes both ${multiTimeframe.macroTf} (${htfMacroDir}) and ${multiTimeframe.structuralTf} (${htfStructDir}) higher-timeframe structure.`;
    }
  }

  const confluenceFactors: ConfluenceFactor[] = [
    {
      label: 'Confirmed Entry Model',
      satisfied: analysis.signal !== null,
      detail: analysis.signal ? analysis.signal.modelLabel : 'No complete entry model present.',
    },
    {
      label: 'Market Structure',
      satisfied: analysis.structureDirection !== 'NEUTRAL' && analysis.structureDirection !== 'RANGING',
      detail: analysis.structureLabel,
    },
    {
      label: 'Momentum Confirmation',
      satisfied: momentum.state === 'STRONG_BULLISH' || momentum.state === 'STRONG_BEARISH',
      detail: momentum.summary,
    },
    {
      label: 'Entry Location & Confirmation',
      satisfied: (analysis.bestCandidate?.scores.entryConfirmation ?? 0) >= 18,
      detail: analysis.bestCandidate?.confirmationExplanation ?? 'Awaiting confirmed entry location.',
    },
    {
      label: 'Available Movement Space',
      satisfied: (analysis.signal?.availableSpaceAtr ?? 0) >= 0.8,
      detail: analysis.signal?.availableSpaceLabel ?? 'Insufficient room before opposing structure.',
    },
    {
      label: 'Multi-Timeframe Context',
      satisfied: (analysis.bestCandidate?.scores.multiTimeframe ?? 0) >= 7,
      detail: analysis.htfAlignmentSummary,
    },
  ];
  const confluenceScore = confluenceFactors.filter((f) => f.satisfied).length;

  const published = analysis.signal !== null;
  const qualityTier = analysis.signal?.quality.tier;

  let signal: TradeSignalCard | null = null;
  if (analysis.signal) {
    const s = analysis.signal;
    signal = {
      id: s.id,
      direction: s.direction,
      marketName,
      symbol,
      marketFamily,
      timeframe: activeTimeframe,
      model: s.model,
      modelLabel: s.modelLabel,
      signalStatus: s.state === 'INVALIDATED' ? 'INVALIDATED' : 'CONFIRMED',
      state: s.state,
      condition: s.condition,
      bosConfirmationPrice:
        s.bosChochEvidence.length > 0 ? s.entryPrice : latestConfirmedBar.high,
      structuralLevelPrice: analysis.bestCandidate?.structuralLevelPrice ?? s.entryPrice,
      retestPrice: analysis.bestCandidate?.retestPrice ?? null,
      retestTime: analysis.bestCandidate?.retestTime ?? null,
      entryTrigger: `Enter on ${s.direction} once the ${s.modelLabel} confirmation holds at ${s.entryPrice}.`,
      entryPrice: s.entryPrice,
      entryCandleTime: latestConfirmedBar.time,
      invalidationPrice: s.invalidationPrice,
      invalidationCondition: s.invalidationCondition,
      takeProfit1: s.target1 ?? s.entryPrice,
      takeProfit2: s.target2 ?? s.entryPrice,
      stopLoss: s.stopLoss,
      riskRewardRatio: s.riskRewardRatio,
      availableSpaceAtr: s.availableSpaceAtr,
      availableSpaceLabel: s.availableSpaceLabel,
      reasons: s.reasons,
      invalidations: s.invalidations,
      confirmationExplanation: s.confirmationExplanation,
      bosChochEvidence: s.bosChochEvidence,
      momentumEvidence: s.momentumEvidence,
      quality: s.quality,
      confluenceScore,
      maxConfluenceScore: confluenceFactors.length,
      confluenceFactors,
      instrumentLabel: s.instrumentLabel,
      explanation: s.explanation,
    };
  }

  const liveInvalidated =
    signal !== null &&
    ((signal.direction === 'RISE' && liveBar.close < signal.invalidationPrice) ||
      (signal.direction === 'FALL' && liveBar.close > signal.invalidationPrice));

  const previousInvalidated =
    previousSignal != null &&
    previousSignal.symbol === symbol &&
    ((previousSignal.direction === 'RISE' && liveBar.close < previousSignal.invalidationPrice) ||
      (previousSignal.direction === 'FALL' && liveBar.close > previousSignal.invalidationPrice));

  let runState: AnalysisRunState;
  let signalStatus: SignalDecisionState;
  let recommendedDirection: 'RISE' | 'FALL' | 'WAIT';
  let signalState: SignalState;

  if (published && signal && (liveInvalidated || previousInvalidated)) {
    runState = 'SETUP INVALIDATED';
    signalStatus = 'INVALIDATED';
    signalState = 'INVALIDATED';
    recommendedDirection = 'WAIT';
  } else if (published && signal) {
    runState = signal.direction === 'RISE' ? 'VALID RISE SETUP' : 'VALID FALL SETUP';
    signalStatus = 'CONFIRMED';
    signalState = signal.state;
    recommendedDirection = signal.direction;
  } else {
    runState = 'NO VALID SETUP';
    signalStatus = 'WAIT';
    signalState = analysis.signal?.state ?? 'SCANNING';
    recommendedDirection = 'WAIT';
  }

  const developingCandidate =
    !published && analysis.bestCandidate
      ? {
          model: analysis.bestCandidate.model,
          modelLabel: analysis.bestCandidate.modelLabel,
          direction: analysis.bestCandidate.direction,
          score: analysis.bestCandidate.scores.structure +
            analysis.bestCandidate.scores.levelZone +
            analysis.bestCandidate.scores.entryConfirmation +
            analysis.bestCandidate.scores.momentum +
            analysis.bestCandidate.scores.multiTimeframe +
            analysis.bestCandidate.scores.availableSpace,
          confirmationExplanation: analysis.bestCandidate.confirmationExplanation,
          condition: analysis.condition,
        }
      : null;

  const whyThisSetup = published && signal ? [...signal.reasons] : [...analysis.evaluatedModels
    .filter((m) => m.rejectionReason)
    .slice(0, 4)
    .map((m) => `${m.modelLabel}: ${m.rejectionReason}`)];

  const entryZone =
    published && signal
      ? {
          low: Math.min(signal.entryPrice, signal.structuralLevelPrice),
          high: Math.max(signal.entryPrice, signal.structuralLevelPrice),
          label:
            signal.direction === 'RISE'
              ? 'Entry zone · buy the retest'
              : 'Entry zone · sell the retest',
        }
      : null;

  // Forward-looking structure layer: valid BOS/CHOCH, swing trendlines, rejection and
  // S/R bands, and fresh future reaction zones. Higher timeframes set the bias; the
  // active timeframe refines structure and zones. Only fresh zones reach the chart.
  const structureResult = analyzeStructure({
    candles: activeRaw,
    timeframe: activeTimeframe,
    precision,
    htfBias: htfMacroDir === 'BULLISH' ? 'bullish' : htfMacroDir === 'BEARISH' ? 'bearish' : 'neutral',
  });

  // Promote a matching watch zone to stage 3 only when a published, quality-gated
  // signal confirms the entry inside/near that zone.
  const activeAtr = activeDetail.atr > 0 ? activeDetail.atr : 1e-6;
  const watchZones =
    published && signal
      ? markZoneEntryConfirmed(structureResult.activeWatch, {
          direction: signal.direction,
          entryPrice: signal.entryPrice,
          atr: activeAtr,
        })
      : structureResult.activeWatch;

  const structure: StructureOverlayData = {
    bias: structureResult.bias,
    htfBias: htfMacroDir === 'BULLISH' ? 'bullish' : htfMacroDir === 'BEARISH' ? 'bearish' : 'neutral',
    htfTimeframe: multiTimeframe.macroTf,
    breaks: structureResult.breaks,
    rejectionZones: structureResult.rejectionZones,
    srBands: structureResult.srBands,
    fvg: structureResult.fvg,
    watchZones,
    testedZones: structureResult.testedWatch,
    summary: structureResult.summary,
  };

  // PHASE 1 + 2 — Market intelligence for the active timeframe: the independent read
  // of the whole market, produced before any opportunity was searched for. The analyser
  // reuses the engine's intelligence so the panel and the chart never disagree.
  const intelligence =
    analysis.intelligence ??
    analyzeMarketIntelligence({
      symbol,
      timeframe: activeTimeframe,
      candles: activeRaw,
      precision,
      htfBias:
        htfMacroDir === 'BULLISH' ? 'bullish' : htfMacroDir === 'BEARISH' ? 'bearish' : 'neutral',
    });

  // Clean-chart filter: keep only CURRENT, valid drawings on the visible canvas.
  // Historical analysis (structure, swings, sweeps) is unaffected — it stays in the
  // report and the internal ledgers; only the drawn overlays are pruned.
  const rawOverlays: ChartOverlayData = {
    supportResistance: activeDetail.supportResistance,
    supplyDemand: activeDetail.supplyDemand,
    structureBreaks: activeDetail.breaks,
    liquiditySweeps: activeDetail.liquiditySweeps,
    trendlines: activeDetail.trendlines,
    patterns: activeDetail.patterns,
    swingPoints: activeDetail.swings,
    majorTrendlines: activeDetail.majorTrendlines,
    majorZones: activeDetail.majorZones,
    range: analysis.range,
    entryZone,
    breakoutRetest: null,
    signal,
    structure,
  };
  const overlays = pruneOverlaysForLiveChart({
    overlays: rawOverlays,
    candles: confirmed,
    atr: activeDetail.atr,
  });

  return {
    symbol,
    marketName,
    marketFamily,
    timeframe: activeTimeframe,
    precision,
    multiTimeframe,
    analyzedAt: Date.now(),
    confirmedBarTime: latestConfirmedBar.time,
    runState,
    signalStatus,
    signalState,
    bosConfirmationPrice: signal?.bosConfirmationPrice ?? null,
    overallDirection: activeDir,
    marketCondition: analysis.condition,
    conditionExplanation: analysis.conditionExplanation,
    htfConflictNote,
    htfAlignmentSummary: analysis.htfAlignmentSummary,
    currentStructureSummary: analysis.structureLabel,
    momentum,
    indicators: analysis.indicators,
    topDownSummaries,
    overlays,
    liquiditySweeps: activeDetail.liquiditySweeps,
    intelligence,
    findings: analysis.findings,
    reachability: analysis.reachability,
    falseSignal: analysis.falseSignal,
    recommendedDirection,
    setupQuality: published ? tierToSetupQuality(qualityTier) : 'INVALID SETUP',
    developingCandidate,
    evaluatedModels: analysis.evaluatedModels,
    confluenceScore,
    maxConfluenceScore: confluenceFactors.length,
    confluenceFactors,
    whyThisSetup,
    entryTriggerText:
      published && signal
        ? signal.entryTrigger
        : 'NO HIGH-QUALITY SETUP — WAITING FOR CONFIRMATION. Confirmed structure and a complete entry model are required before a signal is published.',
    invalidationText:
      published && signal
        ? signal.invalidationCondition
        : 'No active setup to invalidate.',
    noSetupMessage: 'NO HIGH-QUALITY SETUP — WAITING FOR CONFIRMATION.',
    snapshot: snapshot ?? null,
  };
}
