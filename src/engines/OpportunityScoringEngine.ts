import {
  ActiveSymbol,
  Candle,
  CandlestickSignal,
  ChartPattern,
  EntryAndTP,
  FibonacciConfluence,
  FlipSrAssessment,
  FVG,
  LiquidityPool,
  MarketCondition,
  MomentumAssessment,
  OpportunityScoreBreakdown,
  OpportunitySignal,
  OpportunityStatus,
  OrderBlock,
  PivotPoint,
  RiseFallDirection,
  SetupQualityTier,
  StepAuditItem,
  StrategySelectionResult,
  StructuralShift,
  SupportResistanceZone,
  TechnicalIndicatorsSnapshot,
  TimeframeAnalysisSummary,
  TradeableRange,
  TradeableRangeBox,
  TrendDirection,
  Trendline
} from '../types/scanner';
import { MarketStructureEngine } from './MarketStructureEngine';
import { SupportResistanceEngine } from './SupportResistanceEngine';
import { CandlestickEngine } from './CandlestickEngine';
import { FvgEngine } from './FvgEngine';
import { TradeableRangeEngine } from './TradeableRangeEngine';
import { TrendlineAndRangeEngine } from './TrendlineAndRangeEngine';
import { TechnicalIndicatorsEngine } from './TechnicalIndicatorsEngine';
import { ChartPatternEngine } from './ChartPatternEngine';
import { MultiStrategyEngine } from './MultiStrategyEngine';

export interface TopDownAnalysisInput {
  symbolInfo: ActiveSymbol;
  c4h: Candle[];
  c1h: Candle[];
  c15m: Candle[];
  c5m: Candle[];
  c1m: Candle[];
  minScoreThreshold?: number;
  fvgMinDisplacement?: number;
}

export class OpportunityScoringEngine {
  /**
   * Returns only fully closed candles for entry/structure confirmation checks,
   * preventing premature signals on unclosed intrabar price fluctuations.
   */
  private static getClosedCandles(candles: Candle[], periodSeconds: number): Candle[] {
    if (candles.length < 4) return candles;
    const currentBucket = Math.floor(Date.now() / 1000 / periodSeconds) * periodSeconds;
    const latest = candles[candles.length - 1];
    if (latest.epoch >= currentBucket) {
      return candles.slice(0, -1);
    }
    return candles;
  }

  private static computeFibonacciConfluence(
    pivots: PivotPoint[],
    currentPrice: number,
    direction: TrendDirection
  ): FibonacciConfluence | undefined {
    if (direction === 'NEUTRAL' || pivots.length < 2) return undefined;
    const highs = pivots.filter((p) => p.type === 'HIGH');
    const lows = pivots.filter((p) => p.type === 'LOW');
    if (highs.length === 0 || lows.length === 0) return undefined;

    const latestHigh = highs[highs.length - 1];
    const latestLow = lows[lows.length - 1];
    const swingHigh = latestHigh.price;
    const swingLow = latestLow.price;
    const span = swingHigh - swingLow;
    if (span <= 0) return undefined;

    const retraceRatio =
      direction === 'BULLISH'
        ? (swingHigh - currentPrice) / span
        : (currentPrice - swingLow) / span;

    let zoneLevel: FibonacciConfluence['zoneLevel'] = 'NONE';
    if (Math.abs(retraceRatio - 0.618) <= 0.06) zoneLevel = '0.618';
    else if (Math.abs(retraceRatio - 0.5) <= 0.055) zoneLevel = '0.500';
    else if (Math.abs(retraceRatio - 0.382) <= 0.055) zoneLevel = '0.382';
    else if (Math.abs(retraceRatio - 0.786) <= 0.055) zoneLevel = '0.786';

    return {
      direction,
      swingHigh,
      swingLow,
      retracementPct: Number((retraceRatio * 100).toFixed(1)),
      zoneLevel,
      inGoldenZone: zoneLevel === '0.500' || zoneLevel === '0.618',
      target1272: direction === 'BULLISH' ? swingLow + span * 1.272 : swingHigh - span * 1.272,
      target1618: direction === 'BULLISH' ? swingLow + span * 1.618 : swingHigh - span * 1.618
    };
  }

  /**
   * Executes strict Top-Down H4 -> H1 -> M15 -> M5 -> M1 Price-Action Pipeline:
   * - H4: Overall market direction and major structure
   * - H1: Directional confirmation and major supply/demand zones
   * - M15: Setup identification, valid trading range, POIs, and market condition
   * - M5: Setup refinement, liquidity sweeps, BOS/CHoCH, and momentum confirmation
   * - M1: Precise entry confirmation (Entry, Stop Loss, Take Profit)
   */
  public static analyzeTopDown(input: TopDownAnalysisInput): OpportunitySignal | null {
    const { symbolInfo, c4h, c1h, c15m, c5m, c1m } = input;
    const minThreshold = Math.max(75, input.minScoreThreshold ?? 75);
    const minFvgDisp = input.fvgMinDisplacement ?? 0.00025;

    if (c1m.length < 20 || c5m.length < 15 || c15m.length < 10 || c1h.length < 12) {
      return null;
    }

    const currentPrice = c1m[c1m.length - 1].close;

    // 1. H4 — Overall Market Direction & Major Structure
    const h4Available = c4h.length >= 10;
    const h4Pivots = h4Available ? MarketStructureEngine.findPivots(c4h, 2, 2) : [];
    const h4Bias: TrendDirection = h4Available
      ? MarketStructureEngine.getDirectionalBias(h4Pivots, currentPrice)
      : 'NEUTRAL';
    const h4Shifts = h4Available ? MarketStructureEngine.detectAllStructuralShifts(c4h, h4Pivots) : [];
    const h4Condition: MarketCondition = h4Available
      ? MarketStructureEngine.classifyMarketCondition(c4h, h4Pivots, h4Shifts)
      : 'UNCLEAR';
    const h4Zones = h4Available ? SupportResistanceEngine.mapZones(c4h, h4Pivots, '4h', 0.003) : [];

    const h4Summary: TimeframeAnalysisSummary = {
      timeframe: '4h',
      role: 'Overall Market Direction & Structure',
      condition: h4Condition,
      bias: h4Bias,
      structureSummary: h4Available ? `${h4Condition} · ${h4Bias}` : 'Warming H4 history',
      keyNote: h4Available
        ? `${h4Zones.length} macro S&D zones · ${h4Shifts.length} shifts`
        : 'Awaiting ≥10 H4 bars',
      bosCount: h4Shifts.filter((s) => s.type === 'BOS').length,
      chochCount: h4Shifts.filter((s) => s.type === 'CHOCH').length,
      validPoiCount: h4Zones.length
    };

    // 2. H1 — Directional Confirmation & Major Zones
    const h1Pivots = MarketStructureEngine.findPivots(c1h, 2, 2);
    const h1Bias = MarketStructureEngine.getDirectionalBias(h1Pivots, currentPrice);
    const h1Shifts = MarketStructureEngine.detectAllStructuralShifts(c1h, h1Pivots);
    const h1Condition = MarketStructureEngine.classifyMarketCondition(c1h, h1Pivots, h1Shifts);
    const h1Zones = SupportResistanceEngine.mapZones(c1h, h1Pivots, '1h', 0.0025);
    const h1Pools = MarketStructureEngine.evaluateLiquiditySweeps(c1h, h1Pivots);

    const h1Summary: TimeframeAnalysisSummary = {
      timeframe: '1h',
      role: 'Directional Confirmation & Major Zones',
      condition: h1Condition,
      bias: h1Bias,
      structureSummary: `${h1Condition} · ${h1Bias}`,
      keyNote: `${h1Zones.filter((z) => z.fresh).length} fresh H1 zones · ${h1Shifts.length} shifts`,
      bosCount: h1Shifts.filter((s) => s.type === 'BOS').length,
      chochCount: h1Shifts.filter((s) => s.type === 'CHOCH').length,
      validPoiCount: h1Zones.length
    };

    // 3. M15 — Setup Identification & Valid Trading Range
    const m15Pivots = MarketStructureEngine.findPivots(c15m, 2, 2);
    const m15Bias = MarketStructureEngine.getDirectionalBias(m15Pivots, currentPrice);
    const m15Shifts = MarketStructureEngine.detectAllStructuralShifts(c15m, m15Pivots);
    const m15Zones = SupportResistanceEngine.mapZones(c15m, m15Pivots, '15m', 0.002);
    const m15OrderBlocks = SupportResistanceEngine.findOrderBlocks(c15m, '15m');
    const m15Fvgs = FvgEngine.scan(c15m, '15m', minFvgDisp);
    const m15Trendlines = TrendlineAndRangeEngine.detectTrendlines(c15m, m15Pivots, '15m');
    const m15AtrArr = TechnicalIndicatorsEngine.computeAtrSeries(c15m, 14);
    const atr15m =
      m15AtrArr[m15AtrArr.length - 1] ||
      Math.abs(c15m[c15m.length - 1].high - c15m[c15m.length - 1].low);

    const tradingRange = TrendlineAndRangeEngine.validateTradingRange({
      c15m,
      pivots15m: m15Pivots,
      currentPrice,
      atr15m,
      m15Zones,
      m15OrderBlocks,
      m15Fvgs,
      h1Zones
    });

    const m15Summary: TimeframeAnalysisSummary = {
      timeframe: '15m',
      role: 'Setup Identification & Trading Range',
      condition: tradingRange.condition,
      bias: m15Bias,
      structureSummary: tradingRange.isValid
        ? `Valid Range (${tradingRange.currentPosition})`
        : `Invalid / Unclear Range`,
      keyNote: tradingRange.isValid
        ? `${tradingRange.poisInsideRangeCount} POIs inside [${tradingRange.rangeLow.toFixed(2)} - ${tradingRange.rangeHigh.toFixed(2)}]`
        : tradingRange.invalidReason || 'No valid M15 trading range',
      bosCount: m15Shifts.filter((s) => s.type === 'BOS').length,
      chochCount: m15Shifts.filter((s) => s.type === 'CHOCH').length,
      validPoiCount: m15Zones.length + m15OrderBlocks.length
    };

    // 4. M5 — Setup Refinement & Momentum Confirmation (closed bars for confirmed structural shifts)
    const closed5m = this.getClosedCandles(c5m, 300);
    const m5Pivots = MarketStructureEngine.findPivots(closed5m, 2, 2);
    const m5Bias = MarketStructureEngine.getDirectionalBias(m5Pivots, currentPrice);
    const m5Liq = MarketStructureEngine.evaluateLiquiditySweeps(closed5m, m5Pivots);
    const m5Shifts = MarketStructureEngine.detectStructuralShifts(closed5m, m5Pivots);
    const m5AllShifts = MarketStructureEngine.detectAllStructuralShifts(closed5m, m5Pivots);
    const m5Condition = MarketStructureEngine.classifyMarketCondition(closed5m, m5Pivots, m5AllShifts);
    const m5Fvgs = FvgEngine.scan(closed5m, '5m', minFvgDisp);
    const m5OrderBlocks = SupportResistanceEngine.findOrderBlocks(closed5m, '5m');
    const m5Trendlines = TrendlineAndRangeEngine.detectTrendlines(closed5m, m5Pivots, '5m');
    const m5AtrArr = TechnicalIndicatorsEngine.computeAtrSeries(closed5m, 14);
    const atr5m =
      m5AtrArr[m5AtrArr.length - 1] ||
      Math.abs(closed5m[closed5m.length - 1].high - closed5m[closed5m.length - 1].low);
    const { protectedHigh, protectedLow } = MarketStructureEngine.identifyProtectedSwings(
      closed5m,
      m5Pivots,
      m5AllShifts
    );

    // Validated Chart Patterns on M15 & closed M5
    const m5Patterns = ChartPatternEngine.detectConfirmedPatterns(closed5m, m5Pivots, '5m', atr5m);
    const m15Patterns = ChartPatternEngine.detectConfirmedPatterns(c15m, m15Pivots, '15m', atr15m);
    const confirmedPatterns = [...m5Patterns, ...m15Patterns];

    // 5. M1 — Precise Entry Confirmation (Wait for M1 candle close before confirming entry)
    const closed1m = this.getClosedCandles(c1m, 60);
    const m1Pivots = MarketStructureEngine.findPivots(closed1m, 2, 2);
    const m1Bias = MarketStructureEngine.getDirectionalBias(m1Pivots, currentPrice);
    const m1Liq = MarketStructureEngine.evaluateLiquiditySweeps(closed1m, m1Pivots);
    const m1Shifts = MarketStructureEngine.detectStructuralShifts(closed1m, m1Pivots);
    const m1AllShifts = MarketStructureEngine.detectAllStructuralShifts(closed1m, m1Pivots);
    const m1Condition = MarketStructureEngine.classifyMarketCondition(closed1m, m1Pivots, m1AllShifts);
    const m1Fvgs = FvgEngine.scan(closed1m, '1m', minFvgDisp);
    const m1Zones = SupportResistanceEngine.mapZones(closed1m, m1Pivots, '1m', 0.0012);

    const nearestSupport = [...h1Zones, ...m15Zones]
      .filter((z) => (z.type === 'DEMAND' || z.type === 'SUPPORT') && z.upperPrice <= currentPrice * 1.005)
      .sort((a, b) => Math.abs(currentPrice - b.upperPrice) - Math.abs(currentPrice - a.upperPrice))[0];
    const nearestResistance = [...h1Zones, ...m15Zones]
      .filter((z) => (z.type === 'SUPPLY' || z.type === 'RESISTANCE') && z.lowerPrice >= currentPrice * 0.995)
      .sort((a, b) => Math.abs(a.lowerPrice - currentPrice) - Math.abs(b.lowerPrice - currentPrice))[0];

    const latest1m = closed1m[closed1m.length - 1];
    const prior1m1 = closed1m.length >= 2 ? closed1m[closed1m.length - 2] : undefined;
    const prior1m2 = closed1m.length >= 3 ? closed1m[closed1m.length - 3] : undefined;
    const reversal1m = CandlestickEngine.evaluate(latest1m, prior1m1, prior1m2, {
      supportLevel: nearestSupport?.upperPrice,
      resistanceLevel: nearestResistance?.lowerPrice,
      atr: atr5m * 0.45
    });

    const latest5m = closed5m[closed5m.length - 1];
    const prior5m1 = closed5m.length >= 2 ? closed5m[closed5m.length - 2] : undefined;
    const prior5m2 = closed5m.length >= 3 ? closed5m[closed5m.length - 3] : undefined;
    const reversal5m = CandlestickEngine.evaluate(latest5m, prior5m1, prior5m2, {
      supportLevel: nearestSupport?.upperPrice,
      resistanceLevel: nearestResistance?.lowerPrice,
      atr: atr5m
    });

    const candlestickAnnotations = CandlestickEngine.scanRecentPatterns(closed5m, 45);
    const activeShift5m = m5Shifts.length > 0 ? m5Shifts[m5Shifts.length - 1] : null;
    const activeShift1m = m1Shifts.length > 0 ? m1Shifts[m1Shifts.length - 1] : null;
    const allSweeps = [...h1Pools.sweeps, ...m5Liq.sweeps, ...m1Liq.sweeps];

    // Candidate Direction: Top-down priority ensuring lower TF refines HTF rather than opposing it
    let candidateDir: TrendDirection =
      h1Bias !== 'NEUTRAL'
        ? h1Bias
        : h4Bias !== 'NEUTRAL'
        ? h4Bias
        : activeShift5m?.direction && activeShift5m.direction !== 'NEUTRAL'
        ? activeShift5m.direction
        : m15Bias;

    // Allow reversal direction when market condition is explicitly REVERSING with confirmed sweep/CHoCH or confirmed reversal chart pattern
    const topPattern = confirmedPatterns[0] || null;
    if (
      (tradingRange.condition === 'REVERSING' || m5Condition === 'REVERSING') &&
      activeShift5m?.type === 'CHOCH' &&
      activeShift5m.confirmedByClose &&
      activeShift5m.direction !== 'NEUTRAL'
    ) {
      candidateDir = activeShift5m.direction;
    } else if (candidateDir === 'NEUTRAL' && topPattern && topPattern.direction !== 'NEUTRAL') {
      candidateDir = topPattern.direction;
    } else if (candidateDir === 'NEUTRAL' && allSweeps.length > 0) {
      candidateDir = allSweeps[allSweeps.length - 1].type === 'SELLSIDE' ? 'BULLISH' : 'BEARISH';
    } else if (candidateDir === 'NEUTRAL' && activeShift1m && activeShift1m.direction !== 'NEUTRAL') {
      candidateDir = activeShift1m.direction;
    }

    // Overall Market Condition (UPTRENDING | DOWNTRENDING | CONSOLIDATING | REVERSING | UNCLEAR)
    let overallCondition: MarketCondition = tradingRange.condition;
    if (
      h4Available &&
      h4Bias !== 'NEUTRAL' &&
      h1Bias !== 'NEUTRAL' &&
      h4Bias !== h1Bias &&
      tradingRange.condition !== 'REVERSING'
    ) {
      overallCondition = 'UNCLEAR';
    } else if (overallCondition === 'CONSOLIDATING' && (h1Condition === 'UPTRENDING' || h1Condition === 'DOWNTRENDING')) {
      overallCondition = tradingRange.breakoutState === 'INSIDE_RANGE' ? 'CONSOLIDATING' : h1Condition;
    }

    // Secondary Technical Indicators on M5 refinement context
    const indicators = TechnicalIndicatorsEngine.evaluateSnapshot(c5m, candidateDir);
    const atr = atr5m;
    const atrRatio = currentPrice > 0 ? atr / currentPrice : 0;
    const volRegime: 'LOW' | 'MEDIUM' | 'HIGH' =
      atrRatio > 0.0035 ? 'HIGH' : atrRatio > 0.0018 ? 'MEDIUM' : 'LOW';

    // Momentum & Displacement Classification (Strong | Moderate | Weak | Developing)
    // Contributes 15% weighted score without independently vetoing an otherwise valid setup.
    const m5Momentum = CandlestickEngine.evaluateMomentum(c5m, candidateDir, atr);
    const m1AtrArr = TechnicalIndicatorsEngine.computeAtrSeries(c1m, 14);
    const atr1m = m1AtrArr[m1AtrArr.length - 1] || atr * 0.45;
    const m1Momentum = CandlestickEngine.evaluateMomentum(c1m, candidateDir, atr1m);

    const combinedMomScore = Math.round(m5Momentum.score * 0.65 + m1Momentum.score * 0.35);
    const classification =
      combinedMomScore >= 80
        ? 'STRONG'
        : combinedMomScore >= 55
        ? 'MODERATE'
        : combinedMomScore >= 30
        ? 'DEVELOPING'
        : 'WEAK';
    const momentumPassed = classification === 'STRONG' || classification === 'MODERATE';

    const momentum: MomentumAssessment = {
      passed: momentumPassed,
      classification,
      direction: candidateDir,
      score: combinedMomScore,
      avgBodyRatio: (m5Momentum.avgBodyRatio + m1Momentum.avgBodyRatio) / 2,
      opposingWickRatio: Math.max(m5Momentum.opposingWickRatio, m1Momentum.opposingWickRatio),
      displacementMultiple: m5Momentum.displacementMultiple,
      followThroughCandles: Math.min(m5Momentum.followThroughCandles, m1Momentum.followThroughCandles),
      decisiveClose: m5Momentum.decisiveClose || m1Momentum.decisiveClose,
      reason: `${classification} momentum (M5 ${m5Momentum.classification} · M1 ${m1Momentum.classification}, ${combinedMomScore}/100).`
    };

    const m5Summary: TimeframeAnalysisSummary = {
      timeframe: '5m',
      role: 'Setup Refinement & Momentum',
      condition: m5Condition,
      bias: m5Bias,
      structureSummary: activeShift5m
        ? `${activeShift5m.type} (${activeShift5m.direction}) · ${m5Momentum.passed ? 'Mom OK' : 'Wait'}`
        : `${m5Condition} · ${m5Momentum.passed ? 'Mom OK' : 'No Mom'}`,
      keyNote: `${m5Liq.sweeps.length} sweeps · ${m5Fvgs.filter((f) => !f.completelyFilled).length} open FVGs`,
      bosCount: m5AllShifts.filter((s) => s.type === 'BOS').length,
      chochCount: m5AllShifts.filter((s) => s.type === 'CHOCH').length,
      validPoiCount: m5OrderBlocks.length
    };

    // M1 Refined Entry Trigger (confirmed by M1 candle rejection/engulfing or M1 structural shift)
    const m1EntryConfirmed =
      candidateDir !== 'NEUTRAL' &&
      (reversal1m.direction === candidateDir ||
        (activeShift1m !== null &&
          activeShift1m.confirmedByClose &&
          activeShift1m.direction === candidateDir));

    const m1Summary: TimeframeAnalysisSummary = {
      timeframe: '1m',
      role: 'Precise Entry Confirmation',
      condition: m1Condition,
      bias: m1Bias,
      structureSummary: m1EntryConfirmed
        ? `Trigger Confirmed (${reversal1m.name !== 'NONE' ? reversal1m.name.replace(/_/g, ' ') : 'M1 Shift'})`
        : `Awaiting M1 Trigger (${m1Momentum.passed ? 'Mom OK' : 'No Mom'})`,
      keyNote: m1Momentum.reason,
      bosCount: m1AllShifts.filter((s) => s.type === 'BOS').length,
      chochCount: m1AllShifts.filter((s) => s.type === 'CHOCH').length,
      validPoiCount: m1Zones.length
    };

    // Valid POIs from H1 major zones + M15 setup zones/OBs/FVGs inside trading range
    const rangeLowBound = tradingRange.rangeLow * 0.998;
    const rangeHighBound = tradingRange.rangeHigh * 1.002;
    const relevantZones = [...h1Zones, ...m15Zones].filter(
      (z) =>
        !z.broken &&
        z.lowerPrice <= rangeHighBound &&
        z.upperPrice >= rangeLowBound &&
        (candidateDir === 'BULLISH'
          ? z.type === 'DEMAND' || z.type === 'SUPPORT'
          : z.type === 'SUPPLY' || z.type === 'RESISTANCE')
    );
    const relevantObs = m15OrderBlocks.filter(
      (ob) =>
        ob.valid &&
        ob.lowerPrice <= rangeHighBound &&
        ob.upperPrice >= rangeLowBound &&
        (candidateDir === 'BULLISH' ? ob.type === 'BULLISH_OB' : ob.type === 'BEARISH_OB')
    );
    const relevantFvgs = [...m15Fvgs, ...m5Fvgs].filter(
      (f) => !f.completelyFilled && f.direction === candidateDir
    );

    const nearZone = relevantZones.some(
      (z) => Math.abs(currentPrice - (z.upperPrice + z.lowerPrice) / 2) / currentPrice <= 0.009
    );
    const nearOb = relevantObs.some(
      (ob) => Math.abs(currentPrice - (ob.upperPrice + ob.lowerPrice) / 2) / currentPrice <= 0.009
    );
    const nearFvg = relevantFvgs.some(
      (f) => Math.abs(currentPrice - f.midpoint) / currentPrice <= 0.007
    );
    const atRangeBoundary =
      tradingRange.isValid &&
      ((candidateDir === 'BULLISH' && Math.abs(currentPrice - tradingRange.rangeLow) / currentPrice <= 0.0045) ||
        (candidateDir === 'BEARISH' && Math.abs(currentPrice - tradingRange.rangeHigh) / currentPrice <= 0.0045) ||
        tradingRange.breakoutState !== 'INSIDE_RANGE');

    const activePoiInsideRange = nearZone || nearOb || nearFvg || atRangeBoundary;
    const hasFreshZone = relevantZones.some((z) => z.fresh);

    const flip15m = SupportResistanceEngine.evaluateFlipRoleReversal(
      c15m,
      m15Pivots,
      '15m',
      currentPrice,
      0.002
    );
    const flipH1 = SupportResistanceEngine.evaluateFlipRoleReversal(
      c1h,
      h1Pivots,
      '1h',
      currentPrice,
      0.0025
    );
    const flipSrAssessment: FlipSrAssessment = {
      flipZones: [...flipH1.flipZones, ...flip15m.flipZones],
      activeBullishFlip: flip15m.activeBullishFlip || flipH1.activeBullishFlip,
      activeBearishFlip: flip15m.activeBearishFlip || flipH1.activeBearishFlip,
      falseBreakoutDetected: flip15m.falseBreakoutDetected,
      failedRetestDetected: flip15m.failedRetestDetected,
      detail:
        flip15m.activeBullishFlip || flip15m.activeBearishFlip
          ? flip15m.detail
          : flipH1.activeBullishFlip || flipH1.activeBearishFlip
          ? flipH1.detail
          : flip15m.detail
    };

    const alignedFlipZone =
      candidateDir === 'BULLISH'
        ? flipSrAssessment.activeBullishFlip
        : candidateDir === 'BEARISH'
        ? flipSrAssessment.activeBearishFlip
        : null;
    const flipRejectionOk =
      Boolean(alignedFlipZone?.retestRejection) ||
      (reversal1m.direction === candidateDir && reversal1m.name !== 'NONE') ||
      (reversal5m.direction === candidateDir && reversal5m.name !== 'NONE');

    const srFlipDetected =
      !flipSrAssessment.falseBreakoutDetected &&
      !flipSrAssessment.failedRetestDetected &&
      (Boolean(alignedFlipZone && flipRejectionOk) || relevantZones.some((z) => z.isFlip));
    const hasStrongPoi =
      relevantZones.some((z) => z.strength.startsWith('STRONG')) ||
      relevantObs.some((ob) => ob.strength.startsWith('STRONG'));

    const combinedZones = [...h4Zones, ...h1Zones, ...m15Zones, ...m1Zones];
    const combinedObs = [...m15OrderBlocks, ...m5OrderBlocks];
    const combinedFvgs = [...m15Fvgs, ...m5Fvgs, ...m1Fvgs].filter((f) => !f.completelyFilled);
    const combinedTrendlines = [...m15Trendlines, ...m5Trendlines];
    const activeFvg =
      combinedFvgs.find((f) => f.direction === candidateDir && !f.completelyFilled) ||
      combinedFvgs[combinedFvgs.length - 1] ||
      null;
    const combinedPools: LiquidityPool[] = [
      ...h1Pools.restingPools,
      ...m5Liq.restingPools,
      ...allSweeps
    ].slice(-14);
    const combinedShifts: StructuralShift[] = [...m5AllShifts, ...m1AllShifts].slice(-10);

    // Aligned confirmed chart pattern
    const alignedPattern =
      confirmedPatterns.find((p) => p.direction === candidateDir) || topPattern || undefined;

    // Fibonacci retracement confluence
    const fibConfluence = this.computeFibonacciConfluence(m15Pivots, currentPrice, candidateDir);

    // Trendline event detection (Bounce / Breakout / Retest aligned with candidate direction)
    const activeTrendlineSignal = combinedTrendlines.find(
      (tl) =>
        (tl.event === 'BOUNCE' && tl.direction === candidateDir) ||
        (tl.event === 'BREAKOUT' &&
          ((candidateDir === 'BULLISH' && tl.direction === 'BEARISH') ||
            (candidateDir === 'BEARISH' && tl.direction === 'BULLISH') ||
            tl.direction === 'HORIZONTAL')) ||
        (tl.event === 'RETEST' && tl.retested)
    );
    const trendlineEventLabel = activeTrendlineSignal
      ? `${activeTrendlineSignal.direction} Trendline ${activeTrendlineSignal.event}`
      : undefined;

    // Opposing Strong S/R Zone Protection: Avoid entering directly into strong opposing supply/demand
    const blockingOpposingZone = [...h4Zones, ...h1Zones, ...m15Zones].find((z) => {
      if (z.broken) return false;
      const isStrongOrMajor = z.strength.startsWith('STRONG') || z.tier === 'MAJOR' || z.isFlip;
      if (!isStrongOrMajor) return false;
      if (candidateDir === 'BULLISH' && (z.type === 'SUPPLY' || z.type === 'RESISTANCE')) {
        const dist = z.lowerPrice - currentPrice;
        return dist >= -atr * 0.15 && dist <= atr * 0.9;
      }
      if (candidateDir === 'BEARISH' && (z.type === 'DEMAND' || z.type === 'SUPPORT')) {
        const dist = currentPrice - z.upperPrice;
        return dist >= -atr * 0.15 && dist <= atr * 0.9;
      }
      return false;
    });

    // Extended move check (never chase extended moves)
    const extendedMove =
      tradingRange.breakoutState === 'EXTENDED' ||
      (candidateDir === 'BULLISH' && indicators.rsi14 >= 78 && !nearZone && !nearFvg) ||
      (candidateDir === 'BEARISH' && indicators.rsi14 <= 22 && !nearZone && !nearFvg);

    let tradeableRange: TradeableRange | null = null;
    if (m5Pivots.length >= 2 && activeFvg) {
      tradeableRange = TradeableRangeEngine.calculate(
        candidateDir,
        m5Pivots[m5Pivots.length - 2],
        m5Pivots[m5Pivots.length - 1],
        activeFvg,
        currentPrice,
        volRegime,
        h1Bias === candidateDir || h4Bias === candidateDir
      );
    }

    const relevantSweep = allSweeps.find(
      (s) =>
        (candidateDir === 'BULLISH' && s.type === 'SELLSIDE') ||
        (candidateDir === 'BEARISH' && s.type === 'BUYSIDE')
    );

    const activeShift = activeShift5m || activeShift1m;

    // 6. Select Most Suitable Strategy from the Expanded Rise & Fall Strategy Suite
    const selectedStrategy = this.selectBestStrategy({
      condition: overallCondition,
      candidateDir,
      tradingRange,
      nearFvg,
      activeFvg,
      nearZone,
      hasFreshZone,
      nearOb,
      relevantSweep: Boolean(relevantSweep),
      activeShift5m,
      m1EntryConfirmed,
      momentumPassed,
      srFlipDetected,
      trendlineEvent: activeTrendlineSignal?.event || null,
      confirmedPattern: alignedPattern?.direction === candidateDir ? alignedPattern : null,
      fibConfluence
    });

    // 7. Weighted Confluence Scoring (20 / 20 / 20 / 15 / 15 / 10) + Mandatory Validation
    const evaluation = this.evaluateConfluence({
      candidateDir,
      marketCondition: overallCondition,
      selectedStrategy,
      h4Bias,
      h1Bias,
      m15Bias,
      m5Bias,
      h4Available,
      tradingRange,
      activePoiInsideRange,
      hasStrongPoi,
      sweepIdentified: Boolean(relevantSweep),
      activeShift5m,
      activeShift1m,
      reversal5m,
      reversal1m,
      m1EntryConfirmed,
      momentum,
      indicators,
      minThreshold,
      confirmedPattern: alignedPattern?.direction === candidateDir ? alignedPattern : undefined,
      fibConfluence,
      srFlipDetected,
      trendlineSignal: activeTrendlineSignal,
      blockedByOpposingZone: Boolean(blockingOpposingZone),
      extendedMove
    });

    // 8. Compute Entry, Stop Loss, and Take Profit ONLY when all mandatory gates pass
    const entryAndTp = this.computeEntrySlAndTp({
      confirmed: evaluation.confirmed,
      direction: candidateDir,
      currentPrice,
      atr,
      activeFvg,
      tradingRange,
      tradeableRange,
      relevantObs,
      allZones: combinedZones,
      pools: combinedPools,
      rejectionReasons: evaluation.rejectionReasons
    });

    const finalConfirmed = evaluation.confirmed && entryAndTp.confirmed;
    const riseFallLabel: RiseFallDirection = finalConfirmed
      ? candidateDir === 'BULLISH'
        ? 'BUY / RISE'
        : 'SELL / FALL'
      : 'WAIT';

    // 9. Intelligent 6-State Market Classification & Independent Multi-Strategy Evaluation
    const { regime: marketRegime, label: marketRegimeLabel } =
      MultiStrategyEngine.classifyDetailedRegime({
        overallCondition,
        h4Bias,
        h1Bias,
        tradingRange,
        adx14: indicators.adx14,
        confirmedPatterns,
        activeShift5m,
        trendlines: combinedTrendlines,
        sweepDetected: Boolean(relevantSweep)
      });

    const expectedHoldingTime = MultiStrategyEngine.estimateHoldingTime(
      entryAndTp.entryPrice ?? currentPrice,
      entryAndTp.takeProfit,
      atr
    );

    const timeframesUsed: ('4H' | '1H' | '15M' | '5M' | '1M')[] = [
      ...(h4Available ? (['4H'] as const) : []),
      '1H',
      '15M',
      '5M',
      '1M'
    ];

    const strategySetups = MultiStrategyEngine.evaluateAllStrategies(
      {
        overallCondition,
        candidateDir,
        currentPrice,
        atr,
        h4Bias,
        h1Bias,
        m15Bias,
        m5Bias,
        h4Available,
        tradingRange,
        momentum,
        indicators,
        baseConfluenceScore: evaluation.breakdown.total,
        htfAligned: evaluation.checks.htfAligned,
        activePoiInsideRange,
        m1EntryConfirmed,
        blockedByOpposingZone: Boolean(blockingOpposingZone),
        extendedMove,
        entryPrice: entryAndTp.entryPrice,
        stopLoss: entryAndTp.invalidationLevel,
        takeProfit: entryAndTp.takeProfit,
        riskRewardRatio: entryAndTp.riskRewardRatio,
        zones: combinedZones,
        orderBlocks: combinedObs,
        fvgs: combinedFvgs,
        trendlines: combinedTrendlines,
        confirmedPatterns,
        activeShift5m,
        activeShift1m,
        reversal5m,
        reversal1m,
        sweepDetected: Boolean(relevantSweep),
        srFlipDetected,
        flipAssessment: flipSrAssessment,
        fibConfluence,
        protectedHigh,
        protectedLow
      },
      marketRegime
    );

    const stepAudit: StepAuditItem[] = [
      {
        step: 1,
        name: 'Market Condition Clarity',
        passed: overallCondition !== 'UNCLEAR',
        detail: `Regime: ${marketRegimeLabel} (${overallCondition})`
      },
      {
        step: 2,
        name: 'Strategy Selection (Multi-Strategy Fit)',
        passed: selectedStrategy.matched,
        detail: `${selectedStrategy.label} — ${selectedStrategy.rationale}`
      },
      {
        step: 3,
        name: 'Valid M15 Trading Range',
        passed: tradingRange.isValid,
        detail: tradingRange.isValid
          ? `${tradingRange.breakoutState} [${tradingRange.rangeLow.toFixed(2)} - ${tradingRange.rangeHigh.toFixed(2)}]`
          : tradingRange.invalidReason || 'Invalid M15 trading range'
      },
      {
        step: 4,
        name: 'Meaningful POI & Market Structure',
        passed: activePoiInsideRange && evaluation.checks.structureOk,
        detail: `${activePoiInsideRange ? 'Active POI inside range' : 'No active POI'} · ${activeShift5m ? `M5 ${activeShift5m.type}` : 'No M5 shift'}`
      },
      {
        step: 5,
        name: 'Multi-Timeframe Alignment (H4 → M1)',
        passed: evaluation.checks.htfAligned,
        detail: `H4 ${h4Bias} · H1 ${h1Bias} · M15 ${m15Bias} · M5 ${m5Bias}`
      },
      {
        step: 6,
        name: 'Momentum Classification (Weighted 15%)',
        passed: momentum.classification !== 'WEAK',
        detail: `${momentum.classification} — ${momentum.reason} (Does not independently block valid setups)`
      },
      {
        step: 7,
        name: 'Confirmed M1 Price-Action Entry Trigger',
        passed: m1EntryConfirmed,
        detail: m1EntryConfirmed
          ? `M1 confirmed (${reversal1m.name !== 'NONE' ? reversal1m.name : 'M1 shift'})`
          : 'Awaiting M1 price-action trigger (never chase price)'
      },
      {
        step: 8,
        name: 'Confluence ≥75% & Sufficient Room to TP',
        passed: finalConfirmed,
        detail: finalConfirmed
          ? `${evaluation.breakdown.total}% confluence · RR ${entryAndTp.riskRewardRatio}:1`
          : `${evaluation.breakdown.total}% confluence · Signal withheld (WAITING FOR SETUP)`
      }
    ];

    let setupTier: SetupQualityTier = 'AVOID';
    if (finalConfirmed) {
      setupTier = 'HIGH_QUALITY';
    } else if (
      overallCondition !== 'UNCLEAR' &&
      tradingRange.isValid &&
      evaluation.breakdown.total >= 60 &&
      candidateDir !== 'NEUTRAL'
    ) {
      setupTier = 'DEVELOPING';
    } else if (evaluation.breakdown.total >= 40) {
      setupTier = 'WEAK';
    } else {
      setupTier = 'AVOID';
    }

    const status: OpportunityStatus =
      setupTier === 'HIGH_QUALITY'
        ? 'QUALIFIED'
        : setupTier === 'DEVELOPING'
        ? 'WATCHLIST'
        : 'WAITING';

    return {
      id: `${symbolInfo.symbol}_${Date.now()}`,
      symbol: symbolInfo.symbol,
      displayName: symbolInfo.displayName,
      is1s: symbolInfo.is1s,
      currentPrice,
      pipSize: symbolInfo.pipSize,
      status,
      setupTier,
      marketCondition: overallCondition,
      marketRegime,
      marketRegimeLabel,
      selectedStrategy,
      riseFallLabel,
      detectedEpoch: Math.floor(Date.now() / 1000),
      direction: candidateDir,
      score: evaluation.breakdown,
      timeframeMatrix: {
        h4: h4Summary,
        h1: h1Summary,
        m15: m15Summary,
        m5: m5Summary,
        m1: m1Summary
      },
      tradingRange,
      momentum,
      indicators,
      entryAndTp,
      tradeableRange: tradeableRange || undefined,
      activeFvg: activeFvg || undefined,
      allFvgs: combinedFvgs.slice(-8),
      reversalPattern: reversal1m.name !== 'NONE' ? reversal1m : reversal5m,
      candlestickAnnotations,
      marketShift: activeShift || undefined,
      structuralShifts: combinedShifts,
      sweptPool: relevantSweep,
      liquidityPools: combinedPools,
      zones: combinedZones,
      orderBlocks: combinedObs,
      trendlines: combinedTrendlines.slice(0, 4),
      confirmedPattern: alignedPattern,
      fibConfluence,
      srFlipDetected,
      flipSrAssessment,
      trendlineEvent: trendlineEventLabel,
      candleCloseConfirmed: m1EntryConfirmed,
      protectedHigh,
      protectedLow,
      expectedHoldingTime,
      timeframesUsed,
      confirmationReasons: evaluation.rankingReasons,
      strategySetups,
      stepAudit,
      rejectionReasons: evaluation.rejectionReasons,
      rankingReasons: evaluation.rankingReasons,
      explanation: evaluation.explanation,
      volatilityRegime: volRegime,
      atr
    };
  }

  /**
   * Automatically selects the single best-fitting Rise & Fall setup model
   * from the 10 price-action strategies based on detected market context. Never forces a fit.
   */
  public static selectBestStrategy(params: {
    condition: MarketCondition;
    candidateDir: TrendDirection;
    tradingRange: TradeableRangeBox;
    nearFvg: boolean;
    activeFvg: FVG | null;
    nearZone: boolean;
    hasFreshZone: boolean;
    nearOb: boolean;
    relevantSweep: boolean;
    activeShift5m: StructuralShift | null;
    m1EntryConfirmed: boolean;
    momentumPassed: boolean;
    srFlipDetected?: boolean;
    trendlineEvent?: 'BOUNCE' | 'BREAKOUT' | 'RETEST' | 'INTACT' | null;
    confirmedPattern?: ChartPattern | null;
    fibConfluence?: FibonacciConfluence;
  }): StrategySelectionResult {
    if (params.condition === 'UNCLEAR' || params.candidateDir === 'NEUTRAL') {
      return {
        strategy: 'NONE',
        label: 'Wait — Unclear Market Structure',
        rationale: 'Market condition is unclear or conflicting; stand aside.',
        matched: false
      };
    }

    // 1. Consolidation / Range Breakout
    if (
      (params.candidateDir === 'BULLISH' && params.tradingRange.breakoutState === 'BULLISH_BREAKOUT_RETEST') ||
      (params.candidateDir === 'BEARISH' && params.tradingRange.breakoutState === 'BEARISH_BREAKOUT_RETEST') ||
      (params.condition === 'CONSOLIDATING' && params.tradingRange.breakoutState !== 'INSIDE_RANGE')
    ) {
      return {
        strategy: 'CONSOLIDATION_BREAKOUT',
        label: 'Consolidation Breakout',
        rationale: 'Confirmed breakout from valid M15 range or consolidation zone.',
        matched: true
      };
    }

    // 2. Chart Pattern Recognition
    if (params.confirmedPattern && params.confirmedPattern.confirmedByClose) {
      return {
        strategy: 'CHART_PATTERN',
        label: `Chart Pattern (${params.confirmedPattern.label})`,
        rationale: params.confirmedPattern.description,
        matched: true
      };
    }

    // 3. Trendline Continuation
    if (
      params.trendlineEvent === 'BOUNCE' ||
      params.trendlineEvent === 'RETEST' ||
      ((params.condition === 'UPTRENDING' && params.candidateDir === 'BULLISH') ||
       (params.condition === 'DOWNTRENDING' && params.candidateDir === 'BEARISH'))
    ) {
      return {
        strategy: 'TRENDLINE_CONTINUATION',
        label: 'Trendline Continuation',
        rationale: `Price reacting cleanly with validated trend continuation or trendline bounce.`,
        matched: true
      };
    }

    // 4. Support & Resistance Reversal / Flip
    if (params.srFlipDetected) {
      return {
        strategy: 'FLIP_SUPPORT_RESISTANCE',
        label: 'Support & Resistance Reversal / Flip',
        rationale: `Confirmed Support/Resistance role-reversal level with breakout close and retest rejection.`,
        matched: true
      };
    }

    // 5. Supply & Demand
    if (params.nearZone || params.hasFreshZone || params.nearFvg || params.nearOb) {
      return {
        strategy: 'SUPPLY_DEMAND_REACTION',
        label: 'Supply & Demand',
        rationale: `Price retracing into fresh Supply/Demand or Order Block zone with reaction.`,
        matched: true
      };
    }

    // 6. Support & Resistance Breakout
    if (params.trendlineEvent === 'BREAKOUT' || params.relevantSweep) {
      return {
        strategy: 'SR_BREAKOUT_RETEST',
        label: 'Support & Resistance Breakout',
        rationale: `Support/Resistance breakout or liquidity sweep followed by structural confirmation.`,
        matched: true
      };
    }

    return {
      strategy: 'NONE',
      label: 'No Strategy Conditions Met',
      rationale: 'Price is not exhibiting a clean, validated trigger for any strategy model.',
      matched: false
    };
  }

  /**
   * Weighted Confluence System (Exact Specification Weights):
   * - Market structure: 20%
   * - Valid range and POI: 20%
   * - Price action confirmation: 20%
   * - Momentum and displacement: 15%
   * - Multi-timeframe alignment: 15%
   * - Technical confirmation: 10%
   */
  public static evaluateConfluence(params: {
    candidateDir: TrendDirection;
    marketCondition: MarketCondition;
    selectedStrategy: StrategySelectionResult;
    h4Bias: TrendDirection;
    h1Bias: TrendDirection;
    m15Bias: TrendDirection;
    m5Bias: TrendDirection;
    h4Available: boolean;
    tradingRange: TradeableRangeBox;
    activePoiInsideRange: boolean;
    hasStrongPoi: boolean;
    sweepIdentified: boolean;
    activeShift5m: StructuralShift | null;
    activeShift1m: StructuralShift | null;
    reversal5m: CandlestickSignal;
    reversal1m: CandlestickSignal;
    m1EntryConfirmed: boolean;
    momentum: MomentumAssessment;
    indicators: TechnicalIndicatorsSnapshot;
    minThreshold?: number;
    confirmedPattern?: ChartPattern;
    fibConfluence?: FibonacciConfluence;
    srFlipDetected?: boolean;
    trendlineSignal?: Trendline;
    blockedByOpposingZone?: boolean;
    extendedMove?: boolean;
  }): {
    breakdown: OpportunityScoreBreakdown;
    confirmed: boolean;
    checks: { htfAligned: boolean; structureOk: boolean };
    rejectionReasons: string[];
    rankingReasons: string[];
    explanation: string;
  } {
    const minThreshold = Math.max(75, params.minThreshold ?? 75);
    const rejectionReasons: string[] = [];
    const rankingReasons: string[] = [];

    const breakdown: OpportunityScoreBreakdown = {
      marketStructure: 0,
      rangeAndPoi: 0,
      priceActionConfirmation: 0,
      momentumAndDisplacement: 0,
      multiTimeframeAlignment: 0,
      technicalConfirmation: 0,
      total: 0
    };

    const dir = params.candidateDir;

    // 1. Market Structure — 20%
    const shift5mOk =
      params.activeShift5m !== null &&
      params.activeShift5m.confirmedByClose &&
      params.activeShift5m.direction === dir;
    const patternOk = Boolean(params.confirmedPattern && params.confirmedPattern.confirmedByClose);

    if (params.marketCondition === 'UNCLEAR') {
      breakdown.marketStructure = 0;
      rejectionReasons.push('Market condition is UNCLEAR — standing aside until structure resolves.');
    } else if (shift5mOk && (params.sweepIdentified || patternOk)) {
      breakdown.marketStructure = 20;
      rankingReasons.push(
        patternOk
          ? `${params.activeShift5m!.type} + ${params.confirmedPattern!.label} confirmed`
          : `${params.activeShift5m!.type} confirmed after liquidity sweep`
      );
    } else if (shift5mOk) {
      breakdown.marketStructure = Math.min(20, 15 + (params.trendlineSignal ? 3 : 0));
      rankingReasons.push(`M5 ${params.activeShift5m!.type} structural confirmation`);
    } else if (patternOk) {
      breakdown.marketStructure = 14;
      rankingReasons.push(`${params.confirmedPattern!.label} confirmed by candle close`);
    } else if (params.sweepIdentified) {
      breakdown.marketStructure = 8;
      rejectionReasons.push('Supporting market structure incomplete: awaiting BOS/CHoCH candle close.');
    } else {
      rejectionReasons.push('Missing supporting market structure (no confirmed BOS/CHoCH).');
    }

    // 2. Valid Range and POI — 20%
    const pdFavorable =
      (dir === 'BULLISH' && params.tradingRange.currentPosition !== 'PREMIUM') ||
      (dir === 'BEARISH' && params.tradingRange.currentPosition !== 'DISCOUNT');

    if (params.tradingRange.isValid) {
      let rp = 10;
      if (params.activePoiInsideRange) rp += params.hasStrongPoi ? 7 : 5;
      if (pdFavorable) rp += 2;
      if (params.srFlipDetected) {
        rp += 2;
        rankingReasons.push('S/R flip defense confirmed');
      }
      if (params.fibConfluence && params.fibConfluence.inGoldenZone) {
        rp += 2;
        rankingReasons.push(`Fib ${params.fibConfluence.zoneLevel} retracement confluence`);
      }
      breakdown.rangeAndPoi = Math.min(20, rp);
      rankingReasons.push(`Valid M15 range (${params.tradingRange.poisInsideRangeCount} POIs)`);
      if (!params.activePoiInsideRange) {
        rejectionReasons.push('No meaningful POI reaction inside the valid M15 trading range.');
      }
    } else {
      breakdown.rangeAndPoi = 0;
      rejectionReasons.push(
        `Invalid Trading Range: ${params.tradingRange.invalidReason || 'No valid M15 trading range.'}`
      );
    }

    if (params.blockedByOpposingZone) {
      rejectionReasons.push('Strong opposing Support/Resistance zone directly blocks entry path.');
    }
    if (params.extendedMove) {
      rejectionReasons.push('Price has made an extended move — awaiting pullback rather than chasing.');
    }

    // 3. Price Action Confirmation — 20% (requires closed M1 trigger)
    let paScore = 0;
    if (params.m1EntryConfirmed) paScore += 10;
    if (params.reversal1m.name !== 'NONE' && params.reversal1m.direction === dir) paScore += 6;
    if (params.reversal5m.name !== 'NONE' && params.reversal5m.direction === dir) paScore += 4;
    if (params.activeShift1m && params.activeShift1m.confirmedByClose && params.activeShift1m.direction === dir) {
      paScore += 4;
    }
    if (patternOk) paScore += 3;
    breakdown.priceActionConfirmation = Math.min(20, paScore);
    if (params.m1EntryConfirmed) {
      rankingReasons.push('Closed M1 price-action entry trigger confirmed');
    } else {
      rejectionReasons.push('Awaiting closed M1 price-action confirmation candle.');
    }

    // 4. Momentum and Displacement — 15% (Strong/Moderate/Developing/Weak; contributes weight without solo veto)
    breakdown.momentumAndDisplacement = Math.round((params.momentum.score / 100) * 15);
    rankingReasons.push(`${params.momentum.classification} momentum (${params.momentum.score}/100)`);

    // 5. Multi-Timeframe Alignment — 15%
    const h4Supports = params.h4Bias === dir || (params.h4Bias === 'NEUTRAL' && !params.h4Available);
    const h4NotOpposing =
      !params.h4Available ||
      params.h4Bias === dir ||
      params.h4Bias === 'NEUTRAL' ||
      params.marketCondition === 'REVERSING';
    const h1Aligned = params.h1Bias === dir;
    const h1NotOpposing =
      params.h1Bias === dir ||
      params.h1Bias === 'NEUTRAL' ||
      params.marketCondition === 'REVERSING';
    const m15Aligned = params.m15Bias === dir;
    const m5Aligned = params.m5Bias === dir;

    const htfAligned =
      dir !== 'NEUTRAL' &&
      h4NotOpposing &&
      h1NotOpposing &&
      (h1Aligned || h4Supports || params.marketCondition === 'REVERSING');

    let mtfScore = 0;
    if (h4Supports && h1Aligned) mtfScore += 9;
    else if (htfAligned) mtfScore += 6;
    if (m15Aligned) mtfScore += 3;
    if (m5Aligned) mtfScore += 3;
    breakdown.multiTimeframeAlignment = Math.min(15, mtfScore);

    if (!htfAligned) {
      rejectionReasons.push('Conflicting multi-timeframe direction between H4/H1 and lower timeframes.');
    }

    // 6. Technical Confirmation — 10% (EMA 20/50, MACD, RSI 14, ADX, ATR, Bollinger Bands — supporting only)
    let techScore = 0;
    const ind = params.indicators;
    if (ind.technicalVerdict === dir && dir !== 'NEUTRAL') techScore += 3;
    else if (ind.emaBias === dir && dir !== 'NEUTRAL') techScore += 2;
    if (ind.macdBias === dir && dir !== 'NEUTRAL') techScore += 2;
    if (ind.adx14 >= 20) techScore += 2;
    if (
      (dir === 'BULLISH' && ind.rsi14 >= 45 && ind.rsi14 <= 74) ||
      (dir === 'BEARISH' && ind.rsi14 <= 55 && ind.rsi14 >= 26)
    ) {
      techScore += 2;
    }
    if (
      (dir === 'BULLISH' && ind.bbPosition !== 'UPPER_BAND') ||
      (dir === 'BEARISH' && ind.bbPosition !== 'LOWER_BAND')
    ) {
      techScore += 1;
    }
    breakdown.technicalConfirmation = Math.min(10, techScore);

    breakdown.total =
      breakdown.marketStructure +
      breakdown.rangeAndPoi +
      breakdown.priceActionConfirmation +
      breakdown.momentumAndDisplacement +
      breakdown.multiTimeframeAlignment +
      breakdown.technicalConfirmation;

    if (!params.selectedStrategy.matched) {
      rejectionReasons.push(params.selectedStrategy.rationale);
    }

    const structureConfirmed = shift5mOk || patternOk;

    const confirmed =
      dir !== 'NEUTRAL' &&
      params.marketCondition !== 'UNCLEAR' &&
      params.selectedStrategy.matched &&
      htfAligned &&
      params.tradingRange.isValid &&
      params.activePoiInsideRange &&
      structureConfirmed &&
      params.m1EntryConfirmed &&
      !params.blockedByOpposingZone &&
      !params.extendedMove &&
      breakdown.total >= minThreshold;

    const riseOrFall = dir === 'BULLISH' ? 'Buy / Rise' : 'Sell / Fall';
    const explanation = confirmed
      ? `${riseOrFall} via ${params.selectedStrategy.label} (${breakdown.total}% setup confluence — not guaranteed probability). ${params.selectedStrategy.rationale}`
      : rejectionReasons[0] || `Setup at ${breakdown.total}% confluence — standing by (WAIT) until all mandatory checks pass.`;

    return {
      breakdown,
      confirmed,
      checks: {
        htfAligned,
        structureOk: structureConfirmed
      },
      rejectionReasons,
      rankingReasons,
      explanation
    };
  }

  private static computeEntrySlAndTp(params: {
    confirmed: boolean;
    direction: TrendDirection;
    currentPrice: number;
    atr: number;
    activeFvg: FVG | null;
    tradingRange: TradeableRangeBox;
    tradeableRange: TradeableRange | null;
    relevantObs: OrderBlock[];
    allZones: SupportResistanceZone[];
    pools: LiquidityPool[];
    rejectionReasons: string[];
  }): EntryAndTP {
    if (!params.confirmed || params.direction === 'NEUTRAL') {
      return {
        confirmed: false,
        status: 'WAIT',
        direction: params.direction,
        waitReason:
          params.rejectionReasons[0] ||
          'Awaiting valid M15 range, meaningful POI, M5 momentum, and M1 confirmation.'
      };
    }

    const dir = params.direction;
    const price = params.currentPrice;
    const minDist = Math.max(params.atr * 1.2, price * 0.001);

    let entryPrice = price;
    let entryRationale = 'M1 confirmed entry trigger';

    if (params.activeFvg && params.activeFvg.direction === dir) {
      const distPct = Math.abs(price - params.activeFvg.midpoint) / price;
      if (distPct <= 0.003) {
        entryPrice =
          dir === 'BULLISH'
            ? Math.min(price, params.activeFvg.upperBoundary)
            : Math.max(price, params.activeFvg.lowerBoundary);
        entryRationale = `M1 entry at ${params.activeFvg.timeframe.toUpperCase()} FVG retracement`;
      }
    } else if (params.relevantObs.length > 0) {
      const ob = params.relevantObs[params.relevantObs.length - 1];
      const obMid = (ob.upperPrice + ob.lowerPrice) / 2;
      if (Math.abs(price - obMid) / price <= 0.004) {
        entryPrice = dir === 'BULLISH' ? ob.upperPrice : ob.lowerPrice;
        entryRationale = 'M1 entry at M15 Order Block POI';
      }
    }

    let stopLoss =
      params.tradeableRange?.invalidationLevel ??
      (dir === 'BULLISH' ? entryPrice - params.atr * 1.6 : entryPrice + params.atr * 1.6);

    if (dir === 'BULLISH' && stopLoss >= entryPrice - params.atr * 0.5) {
      stopLoss = entryPrice - Math.max(params.atr * 1.4, entryPrice * 0.001);
    }
    if (dir === 'BEARISH' && stopLoss <= entryPrice + params.atr * 0.5) {
      stopLoss = entryPrice + Math.max(params.atr * 1.4, entryPrice * 0.001);
    }

    let takeProfit: number | undefined;
    let takeProfit2: number | undefined;
    let tpRationale = '';
    let tp2Rationale = '';
    const minTpDist = Math.max(minDist, Math.abs(entryPrice - stopLoss) * 1.2);

    if (dir === 'BULLISH') {
      const candidates: { level: number; label: string }[] = [];
      if (params.tradingRange.rangeHigh >= entryPrice + minTpDist) {
        candidates.push({ level: params.tradingRange.rangeHigh, label: 'M15 Range High target' });
      }
      for (const p of params.pools) {
        if (p.type === 'BUYSIDE' && p.priceLevel >= entryPrice + minTpDist) {
          candidates.push({ level: p.priceLevel, label: `Opposing ${p.label || 'BSL'} liquidity` });
        }
      }
      for (const z of params.allZones) {
        if ((z.type === 'SUPPLY' || z.type === 'RESISTANCE') && z.lowerPrice >= entryPrice + minTpDist) {
          candidates.push({ level: z.lowerPrice, label: `Opposing ${z.timeframe.toUpperCase()} Supply` });
        }
      }
      candidates.sort((a, b) => a.level - b.level);
      if (candidates.length > 0) {
        takeProfit = candidates[0].level;
        tpRationale = candidates[0].label;
        if (candidates.length > 1) {
          takeProfit2 = candidates[1].level;
          tp2Rationale = candidates[1].label;
        } else {
          const risk = Math.abs(entryPrice - stopLoss);
          takeProfit2 = entryPrice + risk * 3.0;
          tp2Rationale = '3.0R measured expansion target';
        }
      } else {
        const risk = Math.abs(entryPrice - stopLoss);
        takeProfit = entryPrice + risk * 2.0;
        tpRationale = '2.0R measured range projection';
        takeProfit2 = entryPrice + risk * 3.0;
        tp2Rationale = '3.0R measured expansion target';
      }
    } else {
      const candidates: { level: number; label: string }[] = [];
      if (params.tradingRange.rangeLow <= entryPrice - minTpDist) {
        candidates.push({ level: params.tradingRange.rangeLow, label: 'M15 Range Low target' });
      }
      for (const p of params.pools) {
        if (p.type === 'SELLSIDE' && p.priceLevel <= entryPrice - minTpDist) {
          candidates.push({ level: p.priceLevel, label: `Opposing ${p.label || 'SSL'} liquidity` });
        }
      }
      for (const z of params.allZones) {
        if ((z.type === 'DEMAND' || z.type === 'SUPPORT') && z.upperPrice <= entryPrice - minTpDist) {
          candidates.push({ level: z.upperPrice, label: `Opposing ${z.timeframe.toUpperCase()} Demand` });
        }
      }
      candidates.sort((a, b) => b.level - a.level);
      if (candidates.length > 0) {
        takeProfit = candidates[0].level;
        tpRationale = candidates[0].label;
        if (candidates.length > 1) {
          takeProfit2 = candidates[1].level;
          tp2Rationale = candidates[1].label;
        } else {
          const risk = Math.abs(stopLoss - entryPrice);
          takeProfit2 = entryPrice - risk * 3.0;
          tp2Rationale = '3.0R measured expansion target';
        }
      } else {
        const risk = Math.abs(stopLoss - entryPrice);
        takeProfit = entryPrice - risk * 2.0;
        tpRationale = '2.0R measured range projection';
        takeProfit2 = entryPrice - risk * 3.0;
        tp2Rationale = '3.0R measured expansion target';
      }
    }

    const riskDist = Math.max(1e-9, Math.abs(entryPrice - stopLoss));
    const rewardDist = Math.abs((takeProfit ?? entryPrice) - entryPrice);
    const rr = Number((rewardDist / riskDist).toFixed(2));

    if (rr < 1.2) {
      return {
        confirmed: false,
        status: 'WAIT',
        direction: dir,
        waitReason: `Insufficient room to TP (RR ${rr}:1 below 1.2:1 minimum).`
      };
    }

    return {
      confirmed: true,
      status: 'CONFIRMED_ENTRY',
      direction: dir,
      entryPrice,
      entryRationale,
      takeProfit,
      takeProfit2,
      tpRationale,
      tp2Rationale,
      invalidationLevel: stopLoss,
      riskRewardRatio: rr
    };
  }
}
