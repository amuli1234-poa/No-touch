import type { MarketDirection, MomentumAssessment } from '../types/analysis';
import type {
  EngineScanSummary,
  EngineSignal,
  EntryModelCandidate,
  EntryModelId,
  EvaluatedModelOutcome,
  InstrumentAnalysis,
  MarketCondition,
  SignalState,
} from '../types/engine';
import { ENTRY_MODEL_LABELS } from '../types/engine';
import type { Candle, MarketFamily, TimeframeKey } from '../types/market';
import type { InstrumentProfile } from '../types/instrument';
import type { StructureOverlayData } from '../types/structure';
import { buildIndicatorSnapshot } from './indicators';
import { pruneStructureOverlay } from './chartCleanliness';
import { detectModel, type ModelDetectionContext } from './entryModels';
import { assessTargetReachability, detectFalseSignal } from './advancedIntelligence';
import { buildEngineFindings } from './engineFindings';
import { adaptBehaviour, buildInstrumentProfile, isBoomOrCrash, orderModelsForInstrument } from './instrumentIntelligence';
import { analyzeMarketIntelligence } from './marketIntelligence';
import { classifyMarketCondition, CONDITION_MODEL_PRIORITY } from './marketCondition';
import { assessMomentum } from './momentum';
import { detectRangeAnalysis } from './rangeAnalysis';
import { scoreCandidate } from './qualityScore';
import { analyzeMarketStructure } from './structure';
import { detectSupplyDemandZones } from './supplyDemand';
import { detectSupportResistance } from './supportResistance';
import { analyzeStructure, markZoneEntryConfirmed } from './structureEngine';
import { computeAtrSeries, detectSwings } from './swings';
import { detectChartPatterns, detectTrendlines } from './trendlinesAndPatterns';

export interface HtfContext {
  macroCandles?: readonly Candle[];
  structuralCandles?: readonly Candle[];
  macroTfLabel?: TimeframeKey;
  structuralTfLabel?: TimeframeKey;
  /**
   * Confirmed M15 candles used to build the sideways range (range extremes only).
   * When omitted, the analysis timeframe candles are used as the range timeframe.
   */
  rangeCandles?: readonly Candle[];
  /**
   * Confirmed entry-timeframe candles (M5) used to confirm a range-boundary rejection.
   * When omitted, the analysis timeframe candles are used as the entry timeframe.
   */
  entryCandles?: readonly Candle[];
}

export interface AnalyzeInstrumentParams {
  symbol: string;
  displayName: string;
  precision: number;
  marketFamily: MarketFamily;
  timeframe: TimeframeKey;
  candles: readonly Candle[];
  htfContext?: HtfContext;
  dataHealth?: 'HEALTHY' | 'STALE' | 'DISCONNECTED';
  /** Instrument submarket (e.g. 'random_index_1s'), used for per-instrument profiling. */
  submarket?: string;
}

function simpleDirection(candles: readonly Candle[] | undefined, precision: number): MarketDirection {
  if (!candles || candles.length < 25) return 'NEUTRAL';
  const confirmed = candles.slice(0, -1);
  const atrs = computeAtrSeries(confirmed, 14);
  const swings = detectSwings(confirmed, 3, 3);
  return analyzeMarketStructure(confirmed, swings, atrs, precision).direction;
}

function buildBias(direction: MarketDirection): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (direction === 'BULLISH') return 'BULLISH';
  if (direction === 'BEARISH') return 'BEARISH';
  return 'NEUTRAL';
}

/** Derives the signal state from the candidate, condition and momentum (no duration). */
function deriveSignalState(
  condition: MarketCondition,
  momentum: MomentumAssessment,
  published: boolean
): SignalState {
  if (published) return 'CONFIRMED';
  if (condition === 'CHOPPY') return 'SCANNING';
  if (momentum.state === 'OVEREXTENDED' || momentum.isExhausted) return 'AWAITING_CONFIRMATION';
  return 'DEVELOPING';
}

/**
 * EXPLAINABLE ANALYSIS — states why the selected model is the best fit for this
 * instrument and this regime, and why the strongest competing model was not chosen.
 * Purely descriptive: it explains the decision, it does not change it.
 */
function buildSignalExplanation(params: {
  candidate: EntryModelCandidate;
  quality: { total: number; tier: string };
  evaluatedModels: readonly EvaluatedModelOutcome[];
  instrument: InstrumentProfile;
  condition: MarketCondition;
}): string {
  const { candidate, quality, evaluatedModels, instrument, condition } = params;
  const preferredRank = instrument.preferredModels.indexOf(candidate.model);
  const fitsInstrument =
    preferredRank >= 0 && !instrument.discouragedModels.includes(candidate.model);

  const lead = fitsInstrument
    ? `${candidate.modelLabel} is a preferred model for ${instrument.label}`
    : `${candidate.modelLabel} is not the top preference for ${instrument.label}, but offered the strongest confirmed structure here`;

  const rival = evaluatedModels
    .filter((m) => m.model !== candidate.model)
    .sort((a, b) => b.score - a.score)[0];
  const rivalClause = rival
    ? rival.qualified
      ? ` It outscored ${rival.modelLabel} (${rival.score}/100), which was also valid.`
      : ` The nearest rival, ${rival.modelLabel} (${rival.score}/100), was rejected: ${
          rival.rejectionReason ?? 'setup not fully confirmed.'
        }`
    : '';

  return `${lead}. Regime is ${condition.replace(/_/g, ' ').toLowerCase()} and ${
    candidate.direction === 'RISE' ? 'long' : 'short'
  } bias is supported by ${candidate.bosChochEvidence.length} structural break(s) with a fresh entry zone. ${candidate.confirmationExplanation} Quality ${quality.total}/100 (${quality.tier}).${rivalClause}`;
}

/**
 * The duration-free signal engine. Analyses one instrument using price action,
 * market structure, momentum and technical confirmation, evaluates every suitable
 * entry model, scores each candidate and selects the single strongest confirmed one.
 */
export function analyzeInstrument(params: AnalyzeInstrumentParams): InstrumentAnalysis {
  const {
    symbol,
    displayName,
    precision,
    marketFamily,
    timeframe,
    candles,
    htfContext,
    dataHealth = 'HEALTHY',
    submarket,
  } = params;

  const confirmed = candles.length > 2 ? candles.slice(0, -1) : candles;
  const liveBar = candles.length > 0 ? candles[candles.length - 1] : null;
  const price = liveBar ? liveBar.close : 0;
  const now = Date.now();

  // Per-instrument intelligence (static). Boom/Crash never reach the engine (excluded
  // upstream); the profile drives model preference and behaviour-adaptive sizing.
  const instrument = buildInstrumentProfile({ symbol, submarket, displayName, family: marketFamily });

  const baseEmpty: InstrumentAnalysis = {
    symbol,
    displayName,
    marketFamily,
    precision,
    timeframe,
    price,
    condition: 'CHOPPY',
    conditionExplanation: 'Insufficient confirmed history.',
    bias: 'NEUTRAL',
    structureDirection: 'NEUTRAL',
    structureLabel: 'Awaiting data',
    bosChochEvidence: [],
    momentumSummary: 'N/A',
    indicators: buildIndicatorSnapshot([]),
    htfAlignmentSummary: 'HTF context unavailable',
    evaluatedModels: [],
    bestCandidate: null,
    range: null,
    structure: null,
    intelligence: null,
    instrument,
    findings: null,
    reachability: null,
    falseSignal: null,
    allCandidates: [],
    signal: null,
    dataHealth,
    candlesCount: confirmed.length,
    atr: 0,
    normalizedAtr: 0,
    rejectionReason: 'Insufficient confirmed candle history for structural analysis.',
    lastUpdated: now,
  };

  if (isBoomOrCrash({ symbol, submarket, displayName })) {
    return {
      ...baseEmpty,
      rejectionReason: 'Boom & Crash indices are excluded from this system.',
    };
  }

  if (confirmed.length < 30 || !liveBar || dataHealth !== 'HEALTHY') {
    return {
      ...baseEmpty,
      rejectionReason:
        dataHealth !== 'HEALTHY'
          ? `Live market data feed is ${dataHealth.toLowerCase()}.`
          : 'Fewer than 30 confirmed historical candles available.',
    };
  }

  const atrs = computeAtrSeries(confirmed, 14);
  const atr = atrs[atrs.length - 1] || 1e-6;
  const normalizedAtr = price > 0 ? Number(((atr / price) * 100).toFixed(3)) : 0;
  const swings = detectSwings(confirmed, 3, 3);
  const structure = analyzeMarketStructure(confirmed, swings, atrs, precision);
  const supportResistance = detectSupportResistance(confirmed, swings, atr, precision);
  const supplyDemand = detectSupplyDemandZones(confirmed, atrs, precision);
  const trendlines = detectTrendlines(confirmed, swings, atr, precision);
  const patterns = detectChartPatterns(confirmed, swings, atr, precision);
  const momentum = assessMomentum({
    candles: confirmed,
    atr,
    supportResistance,
    supplyDemand,
  });
  const indicators = buildIndicatorSnapshot(confirmed);

  // Sideways range (range extremes only) is defined on confirmed M15 candles. The
  // entry-timeframe (M5) candles confirm a boundary rejection. When no explicit
  // range/entry series is supplied, fall back to the analysis-timeframe candles.
  const rangeSource = htfContext?.rangeCandles ?? confirmed;
  const range = detectRangeAnalysis(rangeSource, price);
  const entryCandles = htfContext?.entryCandles ?? confirmed;

  // When a validated sideways range exists, its boundaries become the operative
  // support/resistance so targets and available space resolve to the range extremes
  // (buy support → sell resistance, and vice versa). Only present in SIDEWAYS_RANGE.
  const effectiveSupportResistance = range?.valid
    ? [
        {
          id: `range-resistance-${Math.round(range.resistance * 1e4)}`,
          price: range.resistance,
          type: 'resistance' as const,
          touches: range.resistanceTouches,
          firstTouchTime: range.asOfTime,
          lastTouchTime: range.asOfTime,
          status: 'active' as const,
          importance: 'major' as const,
          reason: 'Sideways range high (resistance).',
        },
        {
          id: `range-support-${Math.round(range.support * 1e4)}`,
          price: range.support,
          type: 'support' as const,
          touches: range.supportTouches,
          firstTouchTime: range.asOfTime,
          lastTouchTime: range.asOfTime,
          status: 'active' as const,
          importance: 'major' as const,
          reason: 'Sideways range low (support).',
        },
        ...supportResistance,
      ]
    : supportResistance;

  const classification = classifyMarketCondition(confirmed, structure, momentum, atr, range);

  const macroLabel = htfContext?.macroTfLabel ?? 'H1';
  const structLabel = htfContext?.structuralTfLabel ?? 'M15';
  const macroDir = simpleDirection(htfContext?.macroCandles, precision);
  const structuralDir = simpleDirection(htfContext?.structuralCandles, precision);
  const htfAlignmentSummary = `${macroLabel}: ${macroDir} · ${structLabel}: ${structuralDir} · ${timeframe}: ${structure.direction}`;

  // PHASE 1 + 2 — Market intelligence runs FIRST, before any opportunity is searched
  // for. It reads the whole market independently and can legitimately conclude that no
  // trade is available; opportunity search only proceeds when the read supports it.
  const intelligence = analyzeMarketIntelligence({
    symbol,
    timeframe,
    candles: confirmed,
    precision,
    htfBias: macroDir === 'BULLISH' ? 'bullish' : macroDir === 'BEARISH' ? 'bearish' : 'neutral',
  });

  // Refine the instrument profile from its ACTUAL observed behaviour (realized ATR%
  // and spike frequency), so model preference and sizing adapt to the live instrument.
  const effectiveInstrument = adaptBehaviour(instrument, confirmed, atr);

  const ctx: ModelDetectionContext = {
    symbol,
    timeframe,
    marketFamily,
    precision,
    atr,
    candles: confirmed,
    structure,
    swings,
    supportResistance: effectiveSupportResistance,
    supplyDemand,
    trendlines,
    patterns,
    momentum,
    htfBias: {
      macro: macroDir,
      structural: structuralDir,
      macroLabel,
      structuralLabel: structLabel,
    },
    indicators,
    condition: classification.condition,
    range,
    entryCandles,
  };

  // Evaluate every model appropriate to the current market condition, ORDERED for this
  // specific instrument (its preferred models first). PHASE 3 — opportunity search only
  // runs when the intelligence read supports a trade.
  const conditionModels = CONDITION_MODEL_PRIORITY[classification.condition] as EntryModelId[];
  const modelOrder = orderModelsForInstrument(conditionModels, effectiveInstrument);
  const evaluatedModels: EvaluatedModelOutcome[] = [];
  const allCandidates: EntryModelCandidate[] = [];
  let bestCandidate: EntryModelCandidate | null = null;
  let bestScore = -1;

  if (!intelligence.tradeable) {
    for (const model of modelOrder) {
      evaluatedModels.push({
        model,
        modelLabel: ENTRY_MODEL_LABELS[model],
        direction: null,
        qualified: false,
        score: 0,
        rejectionReason: intelligence.noTradeReason ?? 'Market intelligence: no trade available.',
      });
    }
  } else if (effectiveInstrument.requiresStabilisation) {
    // POST-VOLATILITY STABILISATION (Jump, DEX, Skew Step, Drift Switching, Daily Reset):
    // abnormal movement has not settled — establish fresh structure before any entry.
    for (const model of modelOrder) {
      evaluatedModels.push({
        model,
        modelLabel: ENTRY_MODEL_LABELS[model],
        direction: null,
        qualified: false,
        score: 0,
        rejectionReason: `${effectiveInstrument.label}: awaiting post-volatility stabilisation before entry.`,
      });
    }
  } else {
    for (const model of modelOrder) {
      let candidate: EntryModelCandidate | null = null;
      try {
        candidate = detectModel(ctx, model);
      } catch {
        candidate = null;
      }
      if (!candidate) {
        evaluatedModels.push({
          model,
          modelLabel: ENTRY_MODEL_LABELS[model],
          direction: null,
          qualified: false,
          score: 0,
          rejectionReason: 'Setup not present / incomplete.',
        });
        continue;
      }
      allCandidates.push(candidate);
      const quality = scoreCandidate(candidate);
      evaluatedModels.push({
        model,
        modelLabel: ENTRY_MODEL_LABELS[model],
        direction: candidate.direction,
        qualified: quality.publishable,
        score: quality.total,
        rejectionReason: quality.publishable
          ? undefined
          : quality.total < 85
            ? `Quality ${quality.total}/100 below the 85 publication minimum.`
            : 'Mandatory confirmation conditions not satisfied.',
      });
      if (quality.total > bestScore) {
        bestScore = quality.total;
        bestCandidate = candidate;
      }
    }
  }

  const bestQuality = bestCandidate ? scoreCandidate(bestCandidate) : null;

  // Forward-looking structure & fresh future reaction zones. Only fresh zones reach
  // consumers; a matching published signal promotes its zone to stage 3.
  const structureResult = analyzeStructure({
    candles,
    timeframe,
    precision,
    htfBias:
      macroDir === 'BULLISH' ? 'bullish' : macroDir === 'BEARISH' ? 'bearish' : 'neutral',
  });
  const watchZones =
    (bestQuality?.publishable ?? false) && bestCandidate
      ? markZoneEntryConfirmed(structureResult.activeWatch, {
          direction: bestCandidate.direction,
          entryPrice: bestCandidate.entryPrice,
          atr,
        })
      : structureResult.activeWatch;
  const structureOverlay: StructureOverlayData = {
    bias: structureResult.bias,
    htfBias: macroDir === 'BULLISH' ? 'bullish' : macroDir === 'BEARISH' ? 'bearish' : 'neutral',
    htfTimeframe: htfContext?.macroTfLabel ?? null,
    breaks: structureResult.breaks,
    rejectionZones: structureResult.rejectionZones,
    srBands: structureResult.srBands,
    fvg: structureResult.fvg,
    watchZones,
    testedZones: structureResult.testedWatch,
    summary: structureResult.summary,
  };

  // Clean-chart filter: the scanner's overlay also carries only CURRENT, valid
  // drawings, so a tapped scanner signal shows the same clean structure as the analyser.
  const cleanStructureOverlay = pruneStructureOverlay({
    structure: structureOverlay,
    candles: confirmed,
    atr,
  });

  // TARGET-FIRST + ADVANCED INTELLIGENCE. The leading setup is only publishable once
  // its objective is realistically reachable and no trap pattern is detected.
  const reachability = bestCandidate
    ? assessTargetReachability({
        direction: bestCandidate.direction,
        entryPrice: bestCandidate.entryPrice,
        target1: bestCandidate.target1,
        target2: bestCandidate.target2,
        atr,
        instrument: effectiveInstrument,
        supportResistance,
        supplyDemand,
        intelligence,
      })
    : null;
  const falseSignal = bestCandidate
    ? detectFalseSignal({
        direction: bestCandidate.direction,
        model: bestCandidate.model,
        instrument: effectiveInstrument,
        momentum,
        intelligence,
        structure: cleanStructureOverlay,
        reachability: reachability!,
        condition: classification.condition,
      })
    : null;
  // The four-lens read is always produced when the market has a directional lean, so
  // the panel explains the setup (or the lack of one) rather than going blank.
  const readDirection: 'RISE' | 'FALL' | null = bestCandidate
    ? bestCandidate.direction
    : intelligence?.bias === 'bullish'
      ? 'RISE'
      : intelligence?.bias === 'bearish'
        ? 'FALL'
        : null;
  const findings = readDirection
    ? buildEngineFindings({
        direction: readDirection,
        precision,
        intelligence,
        structure: cleanStructureOverlay,
        momentum,
        indicators,
        supportResistance,
        supplyDemand,
      })
    : null;

  const published =
    (bestQuality?.publishable ?? false) &&
    !(reachability?.blocked ?? false) &&
    !(falseSignal?.flagged ?? false);

  let signal: EngineSignal | null = null;
  // A signal is only produced when a candidate clears the publication gate. Below-gate
  // candidates remain visible in `evaluatedModels`/`bestCandidate` for transparency.
  if (bestCandidate && bestQuality && published) {
    const explanation = buildSignalExplanation({
      candidate: bestCandidate,
      quality: bestQuality,
      evaluatedModels,
      instrument: effectiveInstrument,
      condition: classification.condition,
    });
    signal = {
      id: `${symbol}-${timeframe}-${bestCandidate.model}-${bestCandidate.direction}-${liveBar.time}`,
      symbol,
      displayName,
      marketFamily,
      precision,
      direction: bestCandidate.direction,
      model: bestCandidate.model,
      modelLabel: bestCandidate.modelLabel,
      condition: classification.condition,
      analysisTimeframe: timeframe,
      quality: bestQuality,
      entryPrice: bestCandidate.entryPrice,
      entryZone: [
        Math.min(bestCandidate.entryPrice, bestCandidate.structuralLevelPrice),
        Math.max(bestCandidate.entryPrice, bestCandidate.structuralLevelPrice),
      ],
      invalidationPrice: bestCandidate.invalidationPrice,
      invalidationCondition: bestCandidate.invalidationCondition,
      target1: bestCandidate.target1,
      target2: bestCandidate.target2,
      stopLoss: bestCandidate.stopLoss,
      riskRewardRatio: bestCandidate.riskRewardRatio,
      confirmationExplanation: bestCandidate.confirmationExplanation,
      bosChochEvidence: bestCandidate.bosChochEvidence,
      supportResistance: bestCandidate.supportResistance,
      momentumEvidence: bestCandidate.momentumEvidence,
      reasons: bestCandidate.reasons,
      invalidations: bestCandidate.invalidations,
      availableSpaceAtr: bestCandidate.availableSpaceAtr,
      availableSpaceLabel: bestCandidate.availableSpaceLabel,
      indicators,
      state: deriveSignalState(classification.condition, momentum, published),
      instrumentLabel: effectiveInstrument.label,
      explanation,
      createdAt: now,
      confirmedBarTime: liveBar.time,
      lastUpdated: now,
    };
  }

  const rejectionReason = published
    ? undefined
    : !intelligence.tradeable
      ? `Market intelligence: ${intelligence.noTradeReason ?? 'no trade available.'}`
      : reachability?.blocked
        ? `Target-first: ${reachability.reason}`
        : falseSignal?.flagged
          ? `False-signal guard: ${falseSignal.reason}`
          : classification.condition === 'CHOPPY'
            ? 'Choppy / low-quality market — no high-quality setup.'
            : bestCandidate
              ? `Best candidate scored ${bestQuality?.total ?? 0}/100 — below the 85 publication minimum.`
              : 'No complete entry-model setup present in the current structure.';

  return {
    symbol,
    displayName,
    marketFamily,
    precision,
    timeframe,
    price,
    condition: classification.condition,
    conditionExplanation: classification.explanation,
    bias: buildBias(structure.direction),
    structureDirection: structure.direction,
    structureLabel: structure.structureLabel,
    bosChochEvidence: structure.breaks.map((b) => b.reason),
    momentumSummary: momentum.summary,
    indicators,
    htfAlignmentSummary,
    evaluatedModels,
    bestCandidate,
    range,
    structure: cleanStructureOverlay,
    intelligence,
    instrument: effectiveInstrument,
    findings,
    reachability,
    falseSignal,
    allCandidates,
    signal,
    dataHealth,
    candlesCount: confirmed.length,
    atr,
    normalizedAtr,
    rejectionReason,
    lastUpdated: now,
  };
}

/**
 * Ranks every analysed instrument and selects the SINGLE strongest confirmed signal.
 * A market is never chosen merely for moving fast — only a publishable (>= 85) setup
 * with clean structure and confirmed entry can win.
 */
export function selectStrongestSignal(
  analyses: readonly InstrumentAnalysis[],
  timeframe: TimeframeKey,
  familyCounts: Record<'VOLATILITY' | 'JUMP' | 'STEP' | 'RANGE_BREAK', number>,
  previousWinnerSymbol?: string | null
): EngineScanSummary {
  const confirmed = analyses.filter((a) => a.signal !== null && a.signal.quality.publishable);
  const sorted = [...confirmed].sort((a, b) => {
    const sa = a.signal?.quality.total ?? 0;
    const sb = b.signal?.quality.total ?? 0;
    if (sb !== sa) return sb - sa;
    const ra = a.signal?.riskRewardRatio ?? 0;
    const rb = b.signal?.riskRewardRatio ?? 0;
    return rb - ra;
  });

  const winnerAnalysis = sorted.length > 0 ? sorted[0] : null;
  const winner = winnerAnalysis?.signal ?? null;

  const reasonCounts = new Map<string, number>();
  for (const a of analyses) {
    if (a.rejectionReason) {
      reasonCounts.set(a.rejectionReason, (reasonCounts.get(a.rejectionReason) ?? 0) + 1);
    }
  }
  const topRejectionReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count} market${count > 1 ? 's' : ''})`);

  const developingCount = analyses.filter(
    (a) => a.signal !== null && !a.signal.quality.publishable
  ).length;

  const statusBanner = winner
    ? `SINGLE BEST SIGNAL CONFIRMED — ${winner.displayName} ${winner.direction}`
    : 'NO HIGH-QUALITY SETUP — WAITING FOR CONFIRMATION.';

  return {
    winner,
    winnerAnalysis,
    scannedCount: analyses.length,
    confirmedCount: confirmed.length,
    developingCount,
    familyCounts: {
      VOLATILITY: familyCounts.VOLATILITY ?? 0,
      JUMP: familyCounts.JUMP ?? 0,
      STEP: familyCounts.STEP ?? 0,
      RANGE_BREAK: familyCounts.RANGE_BREAK ?? 0,
    },
    topRejectionReasons,
    scannedAt: Date.now(),
    timeframe,
    statusBanner,
  };
}
