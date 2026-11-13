import {
  CandlestickSignal,
  ChartPattern,
  DetailedMarketRegime,
  FibonacciConfluence,
  FlipSrAssessment,
  FVG,
  MarketCondition,
  MomentumAssessment,
  OrderBlock,
  ProtectedSwing,
  StrategySetupCandidate,
  StructuralShift,
  SupportResistanceZone,
  TechnicalIndicatorsSnapshot,
  TradeableRangeBox,
  TrendDirection,
  Trendline
} from '../types/scanner';

export interface MultiStrategyEvalInput {
  overallCondition: MarketCondition;
  candidateDir: TrendDirection;
  currentPrice: number;
  atr: number;
  h4Bias: TrendDirection;
  h1Bias: TrendDirection;
  m15Bias: TrendDirection;
  m5Bias: TrendDirection;
  h4Available: boolean;
  tradingRange: TradeableRangeBox;
  momentum: MomentumAssessment;
  indicators: TechnicalIndicatorsSnapshot;
  baseConfluenceScore: number;
  htfAligned: boolean;
  activePoiInsideRange: boolean;
  m1EntryConfirmed: boolean;
  blockedByOpposingZone: boolean;
  extendedMove: boolean;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskRewardRatio?: number;
  zones: SupportResistanceZone[];
  orderBlocks: OrderBlock[];
  fvgs: FVG[];
  trendlines: Trendline[];
  confirmedPatterns: ChartPattern[];
  activeShift5m: StructuralShift | null;
  activeShift1m: StructuralShift | null;
  reversal5m: CandlestickSignal;
  reversal1m: CandlestickSignal;
  sweepDetected: boolean;
  srFlipDetected: boolean;
  flipAssessment?: FlipSrAssessment;
  fibConfluence?: FibonacciConfluence;
  protectedHigh?: ProtectedSwing | null;
  protectedLow?: ProtectedSwing | null;
}

export class MultiStrategyEngine {
  public static formatRegimeLabel(regime: DetailedMarketRegime): string {
    switch (regime) {
      case 'STRONG_UPTREND':
        return 'Strong Uptrend';
      case 'STRONG_DOWNTREND':
        return 'Strong Downtrend';
      case 'BREAKOUT_DEVELOPING':
        return 'Breakout Developing';
      case 'POTENTIAL_REVERSAL':
        return 'Potential Reversal';
      case 'RANGE_BOUND':
        return 'Range-Bound';
      case 'CONSOLIDATION':
      default:
        return 'Consolidation';
    }
  }

  public static classifyDetailedRegime(params: {
    overallCondition: MarketCondition;
    h4Bias: TrendDirection;
    h1Bias: TrendDirection;
    tradingRange: TradeableRangeBox;
    adx14: number;
    confirmedPatterns: ChartPattern[];
    activeShift5m: StructuralShift | null;
    trendlines: Trendline[];
    sweepDetected: boolean;
  }): { regime: DetailedMarketRegime; label: string } {
    const hasBreakoutPattern = params.confirmedPatterns.some((p) =>
      [
        'ASCENDING_TRIANGLE',
        'DESCENDING_TRIANGLE',
        'SYMMETRICAL_TRIANGLE',
        'RECTANGLE',
        'BULL_FLAG',
        'BEAR_FLAG',
        'BULL_PENNANT',
        'BEAR_PENNANT'
      ].includes(p.type)
    );
    const hasReversalPattern = params.confirmedPatterns.some((p) =>
      [
        'DOUBLE_TOP',
        'DOUBLE_BOTTOM',
        'HEAD_AND_SHOULDERS',
        'INVERSE_HEAD_AND_SHOULDERS',
        'RISING_WEDGE',
        'FALLING_WEDGE'
      ].includes(p.type)
    );
    const hasTrendlineBreak = params.trendlines.some(
      (t) => t.event === 'BREAKOUT' || t.event === 'RETEST'
    );

    let regime: DetailedMarketRegime = 'CONSOLIDATION';

    if (
      params.overallCondition === 'REVERSING' ||
      hasReversalPattern ||
      (params.sweepDetected && params.activeShift5m?.type === 'CHOCH')
    ) {
      regime = 'POTENTIAL_REVERSAL';
    } else if (
      params.tradingRange.breakoutState === 'BULLISH_BREAKOUT_RETEST' ||
      params.tradingRange.breakoutState === 'BEARISH_BREAKOUT_RETEST' ||
      hasBreakoutPattern ||
      hasTrendlineBreak
    ) {
      regime = 'BREAKOUT_DEVELOPING';
    } else if (
      params.overallCondition === 'UPTRENDING' &&
      (params.h1Bias === 'BULLISH' || params.h4Bias === 'BULLISH' || params.adx14 >= 20)
    ) {
      regime = 'STRONG_UPTREND';
    } else if (
      params.overallCondition === 'DOWNTRENDING' &&
      (params.h1Bias === 'BEARISH' || params.h4Bias === 'BEARISH' || params.adx14 >= 20)
    ) {
      regime = 'STRONG_DOWNTREND';
    } else if (
      params.tradingRange.isValid &&
      params.tradingRange.breakoutState === 'INSIDE_RANGE'
    ) {
      regime = 'RANGE_BOUND';
    } else {
      regime = 'CONSOLIDATION';
    }

    return {
      regime,
      label: this.formatRegimeLabel(regime)
    };
  }

  public static estimateHoldingTime(
    entryPrice: number | undefined,
    takeProfit: number | undefined,
    atr5m: number
  ): string {
    if (
      typeof entryPrice !== 'number' ||
      typeof takeProfit !== 'number' ||
      atr5m <= 0
    ) {
      return '15 – 45 mins (M5/M15 swing)';
    }
    const dist = Math.abs(takeProfit - entryPrice);
    const atrBars = dist / atr5m;
    const minMins = Math.max(5, Math.round(atrBars * 4));
    const maxMins = Math.max(minMins + 15, Math.round(atrBars * 9));
    if (maxMins <= 25) return `${minMins} – ${maxMins} mins (M5 scalp)`;
    if (maxMins <= 60) return `${minMins} – ${maxMins} mins (M15 intraday)`;
    return `${minMins} – ${Math.min(180, maxMins)} mins (H1 structure swing)`;
  }

  /**
   * Runs independent evaluations for all 14 Price-Action, Trendline, Breakout,
   * Support/Resistance, Supply/Demand, and Chart Pattern strategies sharing a unified
   * top-down H4 -> H1 -> M15 -> M5 -> M1 analysis snapshot.
   */
  public static evaluateAllStrategies(
    input: MultiStrategyEvalInput,
    regime: DetailedMarketRegime
  ): StrategySetupCandidate[] {
    const dir = input.candidateDir;
    const riseFall =
      dir === 'BULLISH' ? 'BUY / RISE' : dir === 'BEARISH' ? 'SELL / FALL' : 'WAIT';
    const timeframesUsed: ('4H' | '1H' | '15M' | '5M' | '1M')[] = [
      ...(input.h4Available ? (['4H'] as const) : []),
      '1H',
      '15M',
      '5M',
      '1M'
    ];

    const holdEstimate = this.estimateHoldingTime(
      input.entryPrice ?? input.currentPrice,
      input.takeProfit,
      input.atr
    );

    const isSetupEligible =
      dir !== 'NEUTRAL' &&
      input.overallCondition !== 'UNCLEAR' &&
      input.tradingRange.isValid &&
      input.htfAligned &&
      !input.blockedByOpposingZone &&
      !input.extendedMove;

    const baseGlobalMissing: string[] = [];
    if (input.overallCondition === 'UNCLEAR') baseGlobalMissing.push('Clear market structure');
    if (!input.tradingRange.isValid) baseGlobalMissing.push('Valid M15 trading range');
    if (!input.htfAligned) baseGlobalMissing.push('H4/H1 multi-timeframe alignment');
    if (!input.m1EntryConfirmed) baseGlobalMissing.push('Closed M1 entry confirmation candle');
    if (input.blockedByOpposingZone) baseGlobalMissing.push('Path clear of opposing S/R zone');
    if (input.extendedMove) baseGlobalMissing.push('Pullback (avoid chasing extended move)');

    const invPriceStr =
      typeof input.stopLoss === 'number'
        ? input.stopLoss.toFixed(2)
        : input.protectedLow && dir === 'BULLISH'
        ? input.protectedLow.price.toFixed(2)
        : input.protectedHigh && dir === 'BEARISH'
        ? input.protectedHigh.price.toFixed(2)
        : 'Protected swing boundary';

    const buildCandidate = (cfg: {
      strategyId: StrategySetupCandidate['strategyId'];
      category: StrategySetupCandidate['category'];
      label: string;
      prioritizedRegimes: DetailedMarketRegime[];
      strategySignalPresent: boolean;
      specificEntryMet: boolean;
      scoreOffset?: number;
      entryCondition: string;
      invalidationCondition: string;
      specificConfirmations: string[];
      specificMissing: string[];
    }): StrategySetupCandidate => {
      const regimePrioritized = cfg.prioritizedRegimes.includes(regime);
      const adjScore = Math.max(
        0,
        Math.min(100, input.baseConfluenceScore + (cfg.scoreOffset ?? 0))
      );

      let status: StrategySetupCandidate['status'] = 'INACTIVE';
      if (cfg.strategySignalPresent) {
        const ready =
          isSetupEligible &&
          cfg.specificEntryMet &&
          input.m1EntryConfirmed &&
          adjScore >= 75 &&
          typeof input.entryPrice === 'number' &&
          typeof input.takeProfit === 'number';
        status = ready ? 'CONFIRMED' : 'PENDING';
      }

      const missing = [
        ...(cfg.specificEntryMet ? [] : cfg.specificMissing),
        ...baseGlobalMissing
      ];
      if (adjScore < 75) {
        missing.push(`Confluence ${adjScore}% / 75% min`);
      }

      return {
        strategyId: cfg.strategyId,
        category: cfg.category,
        label: cfg.label,
        status,
        regimePrioritized,
        direction: dir,
        riseFallLabel: status === 'CONFIRMED' ? riseFall : 'WAIT',
        confluenceScore: adjScore,
        entryPrice: status === 'CONFIRMED' ? input.entryPrice : undefined,
        stopLoss: status === 'CONFIRMED' ? input.stopLoss : undefined,
        takeProfit: status === 'CONFIRMED' ? input.takeProfit : undefined,
        riskRewardRatio: status === 'CONFIRMED' ? input.riskRewardRatio : undefined,
        entryCondition: cfg.entryCondition,
        invalidationCondition: `${cfg.invalidationCondition} (SL ${invPriceStr})`,
        confirmationReasons: cfg.specificConfirmations,
        missingConditions: Array.from(new Set(missing)),
        expectedHoldingTime: holdEstimate,
        timeframesUsed
      };
    };

    const bullOrBear = dir === 'BULLISH' ? 'ascending' : 'descending';
    const intactTl = input.trendlines.find(
      (t) =>
        !t.broken &&
        (t.direction === dir || t.direction === 'HORIZONTAL') &&
        (t.event === 'BOUNCE' || t.event === 'RETEST' || t.touches >= 2)
    );
    const brokenTl = input.trendlines.find(
      (t) => t.event === 'BREAKOUT' || (t.broken && t.retested)
    );
    const channelPattern = input.confirmedPatterns.find(
      (p) => p.type === 'ASCENDING_CHANNEL' || p.type === 'DESCENDING_CHANNEL'
    );
    const hasParallelTls =
      input.trendlines.some((t) => t.direction === 'BULLISH') &&
      input.trendlines.some((t) => t.direction === 'BEARISH');

    const trianglePattern = input.confirmedPatterns.find((p) =>
      ['ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE', 'SYMMETRICAL_TRIANGLE'].includes(p.type)
    );
    const rectanglePattern = input.confirmedPatterns.find((p) => p.type === 'RECTANGLE');
    const chartPatternOther = input.confirmedPatterns.find((p) =>
      [
        'HEAD_AND_SHOULDERS',
        'INVERSE_HEAD_AND_SHOULDERS',
        'DOUBLE_TOP',
        'DOUBLE_BOTTOM',
        'BULL_FLAG',
        'BEAR_FLAG',
        'BULL_PENNANT',
        'BEAR_PENNANT',
        'RISING_WEDGE',
        'FALLING_WEDGE'
      ].includes(p.type)
    );

    const nearSdZone = input.zones.find(
      (z) =>
        !z.broken &&
        Math.abs(input.currentPrice - (z.upperPrice + z.lowerPrice) / 2) / input.currentPrice <= 0.009 &&
        (dir === 'BULLISH'
          ? z.type === 'DEMAND' || z.type === 'SUPPORT'
          : z.type === 'SUPPLY' || z.type === 'RESISTANCE')
    );

    const hasBreakoutCandle =
      input.reversal1m.name === (dir === 'BULLISH' ? 'BREAKOUT_BULLISH' : 'BREAKOUT_BEARISH') ||
      input.reversal5m.name === (dir === 'BULLISH' ? 'BREAKOUT_BULLISH' : 'BREAKOUT_BEARISH');

    const isBreakoutRetestState =
      (dir === 'BULLISH' && input.tradingRange.breakoutState === 'BULLISH_BREAKOUT_RETEST') ||
      (dir === 'BEARISH' && input.tradingRange.breakoutState === 'BEARISH_BREAKOUT_RETEST');

    const isRejectionCandle =
      (input.reversal1m.direction === dir &&
        ['BULLISH_ENGULFING', 'BEARISH_ENGULFING', 'BULLISH_PIN_BAR', 'BEARISH_PIN_BAR', 'HAMMER', 'SHOOTING_STAR', 'TWEEZER_BOTTOM', 'TWEEZER_TOP', 'MORNING_STAR', 'EVENING_STAR', 'STRONG_BULLISH_REJECTION', 'STRONG_BEARISH_REJECTION'].includes(
          input.reversal1m.name
        )) ||
      (input.reversal5m.direction === dir && input.reversal5m.name !== 'NONE');

    const strategies: StrategySetupCandidate[] = [
      // 1. Trendline Continuation
      buildCandidate({
        strategyId: 'TRENDLINE_CONTINUATION',
        category: 'Trendline',
        label: 'Trendline Continuation',
        prioritizedRegimes: ['STRONG_UPTREND', 'STRONG_DOWNTREND'],
        strategySignalPresent: Boolean(intactTl),
        specificEntryMet: Boolean(intactTl && (intactTl.event === 'BOUNCE' || intactTl.retested)),
        scoreOffset: intactTl?.event === 'BOUNCE' ? 2 : 0,
        entryCondition: `Retest & rejection off intact ${bullOrBear} trendline (${intactTl?.touches || 2}+ touches) confirmed by M1 close.`,
        invalidationCondition: `Candle body close beyond trendline boundary`,
        specificConfirmations: intactTl
          ? [`${intactTl.direction} trendline (${intactTl.touches} touches · ${intactTl.event})`]
          : [],
        specificMissing: ['Price touch & rejection at active trendline']
      }),

      // 2. Support & Resistance Breakout
      buildCandidate({
        strategyId: 'SR_BREAKOUT_RETEST',
        category: 'Breakout',
        label: 'Support & Resistance Breakout',
        prioritizedRegimes: ['BREAKOUT_DEVELOPING', 'STRONG_UPTREND', 'STRONG_DOWNTREND'],
        strategySignalPresent: isBreakoutRetestState || hasBreakoutCandle || input.srFlipDetected,
        specificEntryMet: isBreakoutRetestState || (hasBreakoutCandle && input.srFlipDetected),
        scoreOffset: 2,
        entryCondition: `Decisive close through S/R level followed by controlled retest holding above/below level.`,
        invalidationCondition: `Re-entry close back inside broken S/R range`,
        specificConfirmations: [
          ...(isBreakoutRetestState ? [`M15 ${input.tradingRange.breakoutState.replace(/_/g, ' ')}`] : []),
          ...(hasBreakoutCandle ? ['Decisive breakout candle close'] : [])
        ],
        specificMissing: ['Confirmed S/R breakout close & retest hold']
      }),

      // 3. Consolidation Breakout
      buildCandidate({
        strategyId: 'CONSOLIDATION_BREAKOUT',
        category: 'Breakout',
        label: 'Consolidation Breakout',
        prioritizedRegimes: ['CONSOLIDATION', 'BREAKOUT_DEVELOPING'],
        strategySignalPresent:
          input.tradingRange.isValid &&
          (input.tradingRange.breakoutState !== 'INSIDE_RANGE' || regime === 'CONSOLIDATION'),
        specificEntryMet: isBreakoutRetestState || (hasBreakoutCandle && input.momentum.passed),
        entryCondition: `Valid M15 range compression breaking out decisively on closed candle with directional follow-through.`,
        invalidationCondition: `Failure back inside consolidation midpoint`,
        specificConfirmations: input.tradingRange.isValid
          ? [`M15 range [${input.tradingRange.rangeLow.toFixed(2)} - ${input.tradingRange.rangeHigh.toFixed(2)}] ${input.tradingRange.breakoutState.replace(/_/g, ' ')}`]
          : [],
        specificMissing: ['Decisive range boundary breakout candle close']
      }),

      // 4. Support & Resistance Reversal / Flip
      (() => {
        const flipZone =
          dir === 'BULLISH'
            ? input.flipAssessment?.activeBullishFlip ||
              input.zones.find((z) => z.isFlip && !z.broken && z.type === 'SUPPORT')
            : dir === 'BEARISH'
            ? input.flipAssessment?.activeBearishFlip ||
              input.zones.find((z) => z.isFlip && !z.broken && z.type === 'RESISTANCE')
            : undefined;

        const hasValidFlipZone = Boolean(
          flipZone && !flipZone.broken && flipZone.flipState !== 'FALSE_BREAKOUT' && flipZone.flipState !== 'FAILED_RETEST'
        );
        const noTrapOrFailure =
          !input.flipAssessment?.falseBreakoutDetected && !input.flipAssessment?.failedRetestDetected;
        const structureOk = Boolean(
          (input.activeShift5m?.confirmedByClose && input.activeShift5m.direction === dir) ||
            (input.activeShift1m?.confirmedByClose && input.activeShift1m.direction === dir)
        );
        const momentumOk = input.momentum.classification !== 'WEAK' && input.momentum.score >= 30;
        const retestRejected = Boolean(flipZone?.retestRejection !== false && isRejectionCandle);

        const missing: string[] = [];
        if (!hasValidFlipZone) missing.push('Candle-close breakout beyond S/R + retest');
        if (input.flipAssessment?.falseBreakoutDetected) missing.push('False breakout trap detected (rejected)');
        if (input.flipAssessment?.failedRetestDetected) missing.push('Failed retest (closed back inside level)');
        if (!retestRejected) missing.push('Rejection & candlestick pattern confirmation at flipped level');
        if (!structureOk) missing.push('Market structure confirmation (BOS/CHoCH)');
        if (!momentumOk) missing.push('Directional momentum follow-through');

        const roleLabel =
          dir === 'BULLISH' ? 'Resistance → Support (R→S)' : dir === 'BEARISH' ? 'Support → Resistance (S→R)' : 'Role Reversal';

        return buildCandidate({
          strategyId: 'FLIP_SUPPORT_RESISTANCE',
          category: 'Support & Resistance',
          label: 'Support & Resistance Reversal / Flip',
          prioritizedRegimes: ['STRONG_UPTREND', 'STRONG_DOWNTREND', 'BREAKOUT_DEVELOPING', 'POTENTIAL_REVERSAL'],
          strategySignalPresent: hasValidFlipZone || Boolean(input.srFlipDetected),
          specificEntryMet: Boolean(
            hasValidFlipZone && noTrapOrFailure && retestRejected && structureOk && momentumOk
          ),
          scoreOffset: hasValidFlipZone && retestRejected && structureOk ? 3 : 0,
          entryCondition: `Confirmed candle close beyond S/R level followed by ${roleLabel} retest, rejection pattern, structure alignment & momentum.`,
          invalidationCondition: `Close back beyond flipped ${roleLabel} zone (failed retest)`,
          specificConfirmations: [
            ...(hasValidFlipZone ? [`${roleLabel} flip confirmed by breakout close & retest`] : []),
            ...(retestRejected ? ['Rejection & candlestick pattern at flipped level'] : []),
            ...(structureOk ? ['Market structure aligned'] : []),
            ...(momentumOk ? [`${input.momentum.classification} momentum confirmed`] : [])
          ],
          specificMissing: missing
        });
      })(),

      // 5. Supply & Demand
      buildCandidate({
        strategyId: 'SUPPLY_DEMAND_REACTION',
        category: 'Supply & Demand',
        label: 'Supply & Demand',
        prioritizedRegimes: ['STRONG_UPTREND', 'STRONG_DOWNTREND', 'RANGE_BOUND', 'POTENTIAL_REVERSAL'],
        strategySignalPresent: Boolean(nearSdZone && (nearSdZone.fresh || nearSdZone.hasBaseFormation || nearSdZone.causedDisplacement)),
        specificEntryMet: Boolean(nearSdZone && input.m1EntryConfirmed),
        scoreOffset: nearSdZone?.hasBaseFormation ? 2 : 0,
        entryCondition: `Price retracing into fresh Supply/Demand origin (base + impulsive departure) confirmed by M1 rejection.`,
        invalidationCondition: `Close completely beyond S&D distal edge`,
        specificConfirmations: nearSdZone
          ? [
              `Fresh ${nearSdZone.timeframe.toUpperCase()} ${nearSdZone.type}${nearSdZone.hasBaseFormation ? ' (base + displacement)' : ''}`
            ]
          : [],
        specificMissing: ['Price reaction inside fresh Supply/Demand zone']
      }),

      // 6. Chart Pattern Recognition
      buildCandidate({
        strategyId: 'CHART_PATTERN',
        category: 'Chart Pattern',
        label: chartPatternOther ? chartPatternOther.label : (trianglePattern ? trianglePattern.label : (channelPattern ? channelPattern.label : (rectanglePattern ? rectanglePattern.label : 'Chart Pattern Recognition'))),
        prioritizedRegimes: ['POTENTIAL_REVERSAL', 'BREAKOUT_DEVELOPING', 'STRONG_UPTREND', 'STRONG_DOWNTREND'],
        strategySignalPresent: Boolean(chartPatternOther || trianglePattern || channelPattern || rectanglePattern),
        specificEntryMet: Boolean(chartPatternOther?.confirmedByClose || trianglePattern?.confirmedByClose || channelPattern?.confirmedByClose || rectanglePattern?.confirmedByClose),
        scoreOffset: 3,
        entryCondition: `Completed chart pattern structure with confirmed neckline or boundary close.`,
        invalidationCondition: `Break beyond pattern invalidation swing`,
        specificConfirmations: [
          ...(chartPatternOther ? [chartPatternOther.description] : []),
          ...(trianglePattern ? [trianglePattern.description] : []),
          ...(channelPattern ? [channelPattern.description] : []),
          ...(rectanglePattern ? [rectanglePattern.description] : [])
        ],
        specificMissing: ['Completed pattern & neckline close confirmation']
      })
    ];

    // Sort: CONFIRMED first, then PENDING prioritized by regime, then Confluence Score
    return strategies.sort((a, b) => {
      const statusWeight = (s: StrategySetupCandidate['status']) =>
        s === 'CONFIRMED' ? 3 : s === 'PENDING' ? 2 : 1;
      const sw = statusWeight(b.status) - statusWeight(a.status);
      if (sw !== 0) return sw;
      if (b.regimePrioritized !== a.regimePrioritized) return b.regimePrioritized ? 1 : -1;
      return b.confluenceScore - a.confluenceScore;
    });
  }
}
