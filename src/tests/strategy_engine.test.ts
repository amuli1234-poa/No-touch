import { Candle, PivotPoint } from '../types/scanner';
import { MarketStructureEngine } from '../engines/MarketStructureEngine';
import { SupportResistanceEngine } from '../engines/SupportResistanceEngine';
import { CandlestickEngine } from '../engines/CandlestickEngine';
import { FvgEngine } from '../engines/FvgEngine';
import { TechnicalIndicatorsEngine } from '../engines/TechnicalIndicatorsEngine';
import { TrendlineAndRangeEngine } from '../engines/TrendlineAndRangeEngine';
import { OpportunityScoringEngine } from '../engines/OpportunityScoringEngine';
import { ChartPatternEngine } from '../engines/ChartPatternEngine';
import { MultiStrategyEngine } from '../engines/MultiStrategyEngine';
import { DerivWebSocketManager } from '../services/DerivWebSocketManager';

console.log('🧪 Starting WickSentinel Analytical Engines Test Suite...\n');

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failCount++;
  }
}

// 1. Symbol Filtering Test (Plain + 1s Volatility ONLY)
console.log('[1] Testing Volatility-Only Market Filtering');
assert(DerivWebSocketManager.isSupportedVolatilitySymbol('R_100', 'synthetic_index'), 'Plain R_100 accepted');
assert(DerivWebSocketManager.isSupportedVolatilitySymbol('1HZ75V', 'synthetic_index'), '1s 1HZ75V accepted');
assert(!DerivWebSocketManager.isSupportedVolatilitySymbol('JD50', 'synthetic_index'), 'Jump Index JD50 excluded');
assert(!DerivWebSocketManager.isSupportedVolatilitySymbol('stpRNG', 'synthetic_index'), 'Step Index excluded');
assert(!DerivWebSocketManager.isSupportedVolatilitySymbol('BOOM1000', 'synthetic_index'), 'Boom 1000 excluded');
assert(!DerivWebSocketManager.isSupportedVolatilitySymbol('CRASH500', 'synthetic_index'), 'Crash 500 excluded');

// 2. Liquidity Sweep & Structural Shift
console.log('\n[2] Testing MarketStructureEngine — Liquidity Sweep & CHoCH');
const pivots: PivotPoint[] = [
  { index: 1, epoch: 1000, price: 100.0, type: 'LOW', isSwept: false }
];
const sweepCandles: Candle[] = [
  { epoch: 1000, open: 102, high: 103, low: 100, close: 101 },
  { epoch: 1120, open: 100.5, high: 101, low: 99.2, close: 100.4 }
];
const { sweeps, updatedPivots } = MarketStructureEngine.evaluateLiquiditySweeps(sweepCandles, pivots);
assert(sweeps.length === 1 && sweeps[0].type === 'SELLSIDE', 'Detected Sell-Side Liquidity Sweep (SSL)');
assert(updatedPivots[0].isSwept === true, 'Updated pivot marked as isSwept');

const structurePivots: PivotPoint[] = [
  { index: 1, epoch: 1000, price: 105.0, type: 'HIGH', isSwept: false },
  { index: 3, epoch: 1240, price: 98.0, type: 'LOW', isSwept: false }
];
const breakoutCandles: Candle[] = [
  { epoch: 1000, open: 103, high: 105, low: 102, close: 104 },
  { epoch: 1120, open: 104, high: 104.5, low: 99, close: 99.5 },
  { epoch: 1240, open: 100, high: 108, low: 99.5, close: 107.5 }
];
const shifts = MarketStructureEngine.detectStructuralShifts(breakoutCandles, structurePivots);
assert(shifts.length > 0 && shifts[0].direction === 'BULLISH' && shifts[0].confirmedByClose, 'Bullish structural shift confirmed by candle close');

const protCandles: Candle[] = [
  { epoch: 1000, open: 100, high: 102, low: 98, close: 99 },
  { epoch: 1120, open: 99, high: 105, low: 97, close: 104 },
  { epoch: 1240, open: 104, high: 104.5, low: 101, close: 102 },
  { epoch: 1360, open: 102, high: 103, low: 99, close: 100 },
  { epoch: 1480, open: 100, high: 106.5, low: 99.5, close: 106.2 } // breaks 105 high!
];
const protPivots: PivotPoint[] = [
  { index: 1, epoch: 1120, price: 105.0, type: 'HIGH', isSwept: false },
  { index: 3, epoch: 1360, price: 99.0, type: 'LOW', isSwept: false }
];
const protSwings = MarketStructureEngine.identifyProtectedSwings(protCandles, protPivots);
assert(
  protSwings.protectedHigh === null && protSwings.protectedLow?.price === 99.0,
  'Broken swing high invalidated while unbroken Protected Low (99.0) retained'
);

// 3. Strong vs Weak Supply & Demand Zone Classification
console.log('\n[3] Testing SupportResistanceEngine — Strong vs Weak Zones');
const zoneCandles: Candle[] = [
  { epoch: 100, open: 102, high: 103, low: 100, close: 100.2 },
  { epoch: 200, open: 100.2, high: 101, low: 98.0, close: 99.8 }, // swing low pivot
  { epoch: 300, open: 100, high: 108, low: 99.8, close: 107.8 }, // massive displacement away
  { epoch: 400, open: 107.8, high: 110, low: 107, close: 109.5 }
];
const zonePivots: PivotPoint[] = [{ index: 1, epoch: 200, price: 98.0, type: 'LOW', isSwept: false }];
const zones = SupportResistanceEngine.mapZones(zoneCandles, zonePivots, '15m');
assert(zones.length === 1 && zones[0].strength === 'STRONG_DEMAND', 'Fresh displacement origin classified as STRONG_DEMAND');

// 4. Candlestick & Mandatory Momentum Assessment
console.log('\n[4] Testing CandlestickEngine — Reversal & Mandatory Momentum');
const hammerCandle: Candle = { epoch: 2000, open: 100.5, high: 101, low: 96, close: 100.8 };
const hammerSignal = CandlestickEngine.evaluate(hammerCandle);
assert(hammerSignal.name === 'BULLISH_PIN_BAR' || hammerSignal.name === 'HAMMER', 'Hammer / Pin Bar detected');

const strongMomCandles: Candle[] = [
  { epoch: 100, open: 100, high: 101, low: 99.5, close: 100.8 },
  { epoch: 220, open: 100.8, high: 104, low: 100.5, close: 103.8 },
  { epoch: 340, open: 103.8, high: 107, low: 103.5, close: 106.7 },
  { epoch: 460, open: 106.7, high: 110, low: 106.5, close: 109.6 }
];
const momOk = CandlestickEngine.evaluateMomentum(strongMomCandles, 'BULLISH', 2.0);
assert(
  momOk.passed === true && momOk.classification === 'STRONG' && momOk.followThroughCandles === 3,
  `Strong follow-through momentum classified as STRONG (${momOk.score}/100)`
);

const moderateMomCandles: Candle[] = [
  { epoch: 100, open: 100, high: 101, low: 99.5, close: 100.3 },
  { epoch: 220, open: 100.3, high: 102.2, low: 99.9, close: 101.6 },
  { epoch: 340, open: 101.6, high: 103.5, low: 101.2, close: 102.8 },
  { epoch: 460, open: 102.8, high: 104.2, low: 102.3, close: 103.6 }
];
const momModerate = CandlestickEngine.evaluateMomentum(moderateMomCandles, 'BULLISH', 2.0);
assert(
  momModerate.classification === 'MODERATE' || momModerate.classification === 'DEVELOPING',
  `Balanced directional push classified as ${momModerate.classification} (${momModerate.score}/100)`
);

const weakMomCandles: Candle[] = [
  { epoch: 100, open: 100, high: 102, low: 99, close: 100.2 },
  { epoch: 220, open: 100.2, high: 104, low: 100, close: 100.6 }, // huge upper wick
  { epoch: 340, open: 100.6, high: 101, low: 99, close: 99.8 } // bearish reversal
];
const momFail = CandlestickEngine.evaluateMomentum(weakMomCandles, 'BULLISH', 2.0);
assert(
  momFail.passed === false && momFail.classification === 'WEAK',
  `Weak/indecisive candles classified as WEAK (${momFail.score}/100)`
);

// 5. Fair Value Gap & Technical Indicators
console.log('\n[5] Testing FvgEngine & TechnicalIndicatorsEngine');
const fvgCandles: Candle[] = [
  { epoch: 100, open: 100, high: 102, low: 99, close: 101 },
  { epoch: 220, open: 101.5, high: 112, low: 101, close: 111 },
  { epoch: 340, open: 111, high: 114, low: 105, close: 113 }
];
const fvgs = FvgEngine.scan(fvgCandles, '5m', 0.0001);
assert(fvgs.length === 1 && fvgs[0].direction === 'BULLISH', 'Bullish FVG detected on 5m');

const trendSeries: Candle[] = Array.from({ length: 40 }, (_, i) => {
  const base = 100 + i * 0.8;
  return {
    epoch: 1000 + i * 300,
    open: base,
    high: base + 1.1,
    low: base - 0.3,
    close: base + 0.9
  };
});
const indSnap = TechnicalIndicatorsEngine.evaluateSnapshot(trendSeries, 'BULLISH');
assert(indSnap.rsi14 > 55 && indSnap.emaBias === 'BULLISH' && indSnap.adx14 > 20, 'RSI, EMA20/50, and ADX confirm steady uptrend');

// 6. Trendline, 5 Market Conditions & Mandatory M15 Valid Trading Range
console.log('\n[6] Testing TrendlineAndRangeEngine & 5 Market Conditions');
const tlPivots: PivotPoint[] = [
  { index: 2, epoch: trendSeries[2].epoch, price: trendSeries[2].low, type: 'LOW', isSwept: false },
  { index: 12, epoch: trendSeries[12].epoch, price: trendSeries[12].low, type: 'LOW', isSwept: false },
  { index: 22, epoch: trendSeries[22].epoch, price: trendSeries[22].high, type: 'HIGH', isSwept: false },
  { index: 32, epoch: trendSeries[32].epoch, price: trendSeries[32].low, type: 'LOW', isSwept: false }
];
const tls = TrendlineAndRangeEngine.detectTrendlines(trendSeries, tlPivots, '15m');
assert(tls.some((t) => t.direction === 'BULLISH'), 'Bullish ascending trendline detected');

const cond = MarketStructureEngine.classifyMarketCondition(trendSeries, tlPivots);
assert(
  ['UPTRENDING', 'DOWNTRENDING', 'CONSOLIDATING', 'REVERSING', 'UNCLEAR'].includes(cond),
  `MarketCondition classified cleanly (${cond})`
);

const unclearCond = MarketStructureEngine.classifyMarketCondition(trendSeries.slice(0, 5), []);
assert(unclearCond === 'UNCLEAR', 'Insufficient structure classifies cleanly as UNCLEAR');

const m15SampleCandles: Candle[] = Array.from({ length: 24 }, (_, i) => {
  const base = 100 + Math.sin(i / 2) * 3;
  return {
    epoch: 1000 + i * 900,
    open: base,
    high: base + 1.4,
    low: base - 1.4,
    close: base + 0.3
  };
});
const m15SamplePivots: PivotPoint[] = [
  { index: 4, epoch: m15SampleCandles[4].epoch, price: 96.5, type: 'LOW', isSwept: false },
  { index: 10, epoch: m15SampleCandles[10].epoch, price: 105.0, type: 'HIGH', isSwept: false },
  { index: 16, epoch: m15SampleCandles[16].epoch, price: 97.2, type: 'LOW', isSwept: false },
  { index: 20, epoch: m15SampleCandles[20].epoch, price: 104.8, type: 'HIGH', isSwept: false }
];

// Invalid when 0 POIs inside range
const invalidRange = TrendlineAndRangeEngine.validateTradingRange({
  c15m: m15SampleCandles,
  pivots15m: m15SamplePivots,
  currentPrice: 100.0,
  atr15m: 2.0,
  m15Zones: [],
  m15OrderBlocks: [],
  m15Fvgs: []
});
assert(invalidRange.isValid === false, 'M15 trading range rejected when no valid POIs exist inside range');

// Valid when M15 POI sits inside range
const validRange = TrendlineAndRangeEngine.validateTradingRange({
  c15m: m15SampleCandles,
  pivots15m: m15SamplePivots,
  currentPrice: 99.5,
  atr15m: 2.0,
  m15Zones: [
    {
      id: 'z1',
      timeframe: '15m',
      type: 'DEMAND',
      strength: 'STRONG_DEMAND',
      upperPrice: 100.2,
      lowerPrice: 98.8,
      originEpoch: m15SampleCandles[16].epoch,
      testCount: 0,
      fresh: true,
      broken: false,
      causedDisplacement: true
    }
  ],
  m15OrderBlocks: [],
  m15Fvgs: []
});
assert(
  validRange.isValid === true && validRange.currentPosition === 'DISCOUNT' && validRange.poisInsideRangeCount === 1,
  'Valid M15 range with POI inside range accepted & Discount zone identified'
);

// 7. Automatic Strategy Selection & Strict 20/20/20/15/15/10 Signal Validation
console.log('\n[7] Testing 6-Strategy Selection & Exact 20/20/20/15/15/10 Confluence Gating');

const strategyTrend = OpportunityScoringEngine.selectBestStrategy({
  condition: 'UPTRENDING',
  candidateDir: 'BULLISH',
  tradingRange: validRange,
  nearFvg: false,
  activeFvg: fvgs[0],
  nearZone: true,
  hasFreshZone: true,
  nearOb: false,
  relevantSweep: false,
  activeShift5m: shifts[0],
  m1EntryConfirmed: true,
  momentumPassed: true
});
assert(strategyTrend.matched && strategyTrend.strategy === 'TRENDLINE_CONTINUATION', 'Selects Trendline Continuation in UPTRENDING market at POI');

const strategyUnclear = OpportunityScoringEngine.selectBestStrategy({
  condition: 'UNCLEAR',
  candidateDir: 'BULLISH',
  tradingRange: validRange,
  nearFvg: true,
  activeFvg: fvgs[0],
  nearZone: true,
  hasFreshZone: true,
  nearOb: true,
  relevantSweep: true,
  activeShift5m: shifts[0],
  m1EntryConfirmed: true,
  momentumPassed: true
});
assert(!strategyUnclear.matched && strategyUnclear.strategy === 'NONE', 'Refuses to force strategy when condition is UNCLEAR');

const nonBlockingMomentumSetup = OpportunityScoringEngine.evaluateConfluence({
  candidateDir: 'BULLISH',
  marketCondition: 'UPTRENDING',
  selectedStrategy: strategyTrend,
  h4Bias: 'BULLISH',
  h1Bias: 'BULLISH',
  m15Bias: 'BULLISH',
  m5Bias: 'BULLISH',
  h4Available: true,
  tradingRange: validRange,
  activePoiInsideRange: true,
  hasStrongPoi: true,
  sweepIdentified: true,
  activeShift5m: shifts[0],
  activeShift1m: shifts[0],
  reversal5m: hammerSignal,
  reversal1m: hammerSignal,
  m1EntryConfirmed: true,
  momentum: momFail,
  indicators: indSnap,
  minThreshold: 75
});
assert(
  nonBlockingMomentumSetup.confirmed === true && nonBlockingMomentumSetup.breakdown.total >= 75,
  `Momentum does not independently block an otherwise valid setup (${nonBlockingMomentumSetup.breakdown.total}%)`
);

const gatedInvalidRange = OpportunityScoringEngine.evaluateConfluence({
  candidateDir: 'BULLISH',
  marketCondition: 'UPTRENDING',
  selectedStrategy: strategyTrend,
  h4Bias: 'BULLISH',
  h1Bias: 'BULLISH',
  m15Bias: 'BULLISH',
  m5Bias: 'BULLISH',
  h4Available: true,
  tradingRange: invalidRange,
  activePoiInsideRange: true,
  hasStrongPoi: true,
  sweepIdentified: true,
  activeShift5m: shifts[0],
  activeShift1m: shifts[0],
  reversal5m: hammerSignal,
  reversal1m: hammerSignal,
  m1EntryConfirmed: true,
  momentum: momOk,
  indicators: indSnap,
  minThreshold: 75
});
assert(gatedInvalidRange.confirmed === false, 'Setup rejected / WAIT when mandatory M15 trading range is invalid');

const gatedNoM1Trigger = OpportunityScoringEngine.evaluateConfluence({
  candidateDir: 'BULLISH',
  marketCondition: 'UPTRENDING',
  selectedStrategy: strategyTrend,
  h4Bias: 'BULLISH',
  h1Bias: 'BULLISH',
  m15Bias: 'BULLISH',
  m5Bias: 'BULLISH',
  h4Available: true,
  tradingRange: validRange,
  activePoiInsideRange: true,
  hasStrongPoi: true,
  sweepIdentified: true,
  activeShift5m: shifts[0],
  activeShift1m: null,
  reversal5m: hammerSignal,
  reversal1m: { ...hammerSignal, name: 'NONE', direction: 'NEUTRAL' },
  m1EntryConfirmed: false,
  momentum: momOk,
  indicators: indSnap,
  minThreshold: 75
});
assert(gatedNoM1Trigger.confirmed === false, 'Setup rejected / WAIT when M1 entry trigger is unconfirmed');

const confirmedEval = OpportunityScoringEngine.evaluateConfluence({
  candidateDir: 'BULLISH',
  marketCondition: 'UPTRENDING',
  selectedStrategy: strategyTrend,
  h4Bias: 'BULLISH',
  h1Bias: 'BULLISH',
  m15Bias: 'BULLISH',
  m5Bias: 'BULLISH',
  h4Available: true,
  tradingRange: validRange,
  activePoiInsideRange: true,
  hasStrongPoi: true,
  sweepIdentified: true,
  activeShift5m: shifts[0],
  activeShift1m: shifts[0],
  reversal5m: hammerSignal,
  reversal1m: hammerSignal,
  m1EntryConfirmed: true,
  momentum: momOk,
  indicators: indSnap,
  minThreshold: 75
});
assert(
  confirmedEval.confirmed === true &&
    confirmedEval.breakdown.marketStructure <= 20 &&
    confirmedEval.breakdown.rangeAndPoi <= 20 &&
    confirmedEval.breakdown.priceActionConfirmation <= 20 &&
    confirmedEval.breakdown.momentumAndDisplacement <= 15 &&
    confirmedEval.breakdown.multiTimeframeAlignment <= 15 &&
    confirmedEval.breakdown.technicalConfirmation <= 10 &&
    confirmedEval.breakdown.total >= 75,
  `Confirmed setup passes all 8 checks with weighted 20/20/20/15/15/10 breakdown (${confirmedEval.breakdown.total}%)`
);

// 8. Additional Rise & Fall Strategies: S/R Flips, Horizontal Trendlines, Chart Patterns, Extended Candlesticks & MACD
console.log('\n[8] Testing S/R Flips, Horizontal Trendlines, Chart Patterns, Candlestick Context & MACD');

// 8A. Support/Resistance Flip detection
const flipCandles: Candle[] = [
  { epoch: 100, open: 98, high: 100.0, low: 97.5, close: 98.5 },
  { epoch: 200, open: 98.5, high: 99.0, low: 96.0, close: 96.2 },
  { epoch: 300, open: 96.2, high: 101.2, low: 96.1, close: 101.0 }, // closes decisively above 100.0 resistance
  { epoch: 400, open: 101.0, high: 101.5, low: 99.8, close: 100.9 }, // retests broken level from above and holds
  { epoch: 500, open: 100.9, high: 103.5, low: 100.8, close: 103.2 } // pushes higher
];
const flipPivots: PivotPoint[] = [{ index: 0, epoch: 100, price: 100.0, type: 'HIGH', isSwept: false }];
const flipZones = SupportResistanceEngine.mapZones(flipCandles, flipPivots, '15m');
assert(
  flipZones.some((z) => z.isFlip && z.type === 'SUPPORT'),
  'Broken resistance retested from above classified as flipped SUPPORT zone'
);

// 8B. Horizontal Trendlines
const horizCandles: Candle[] = Array.from({ length: 22 }, (_, i) => ({
  epoch: 1000 + i * 300,
  open: 100.2,
  high: i === 2 || i === 14 ? 105.0 : 103.5,
  low: 99.8,
  close: 100.4
}));
const horizPivots: PivotPoint[] = [
  { index: 2, epoch: horizCandles[2].epoch, price: 105.0, type: 'HIGH', isSwept: false },
  { index: 6, epoch: horizCandles[6].epoch, price: 99.5, type: 'LOW', isSwept: false },
  { index: 14, epoch: horizCandles[14].epoch, price: 105.0, type: 'HIGH', isSwept: false },
  { index: 18, epoch: horizCandles[18].epoch, price: 99.6, type: 'LOW', isSwept: false }
];
const horizTls = TrendlineAndRangeEngine.detectTrendlines(horizCandles, horizPivots, '15m');
assert(
  horizTls.some((t) => t.direction === 'HORIZONTAL'),
  'Equal swing levels produce HORIZONTAL trendline'
);

// 8C. ChartPatternEngine: Double Top confirmed only on neckline close (rejects incomplete patterns)
const dtCandles: Candle[] = Array.from({ length: 22 }, (_, i) => {
  let close = 102;
  let high = 103;
  let low = 101;
  if (i === 4) { high = 110.0; close = 109.5; low = 107; }
  else if (i === 9) { low = 100.0; close = 100.5; high = 102; }
  else if (i === 14) { high = 110.1; close = 109.4; low = 107; }
  else if (i >= 15 && i <= 18) { high = 106; low = 101.5; close = 102; }
  else if (i >= 19) { high = 101.2; low = 97.5; close = 98.0; } // closes decisively below neckline 100.0
  return { epoch: 1000 + i * 900, open: close + 0.8, high, low, close };
});
const dtPivots: PivotPoint[] = [
  { index: 4, epoch: dtCandles[4].epoch, price: 110.0, type: 'HIGH', isSwept: false },
  { index: 9, epoch: dtCandles[9].epoch, price: 100.0, type: 'LOW', isSwept: false },
  { index: 14, epoch: dtCandles[14].epoch, price: 110.1, type: 'HIGH', isSwept: false }
];
const dtConfirmed = ChartPatternEngine.detectConfirmedPatterns(dtCandles, dtPivots, '15m', 1.5);
assert(
  dtConfirmed.length > 0 && dtConfirmed[0].type === 'DOUBLE_TOP' && dtConfirmed[0].confirmedByClose,
  'ChartPatternEngine confirms Double Top only after neckline close'
);
const dtIncomplete = ChartPatternEngine.detectConfirmedPatterns(dtCandles.slice(0, 18), dtPivots, '15m', 1.5);
assert(
  !dtIncomplete.some((p) => p.type === 'DOUBLE_TOP'),
  'ChartPatternEngine refuses to emit incomplete Double Top before neckline break'
);

// 8D. CandlestickEngine extended context (Breakout, Failed Breakout, Inside Bar, Tweezer Bottom, Strong Momentum)
const priorFlat: Candle = { epoch: 1000, open: 99.0, high: 100.0, low: 98.5, close: 99.8 };
const breakoutRes = CandlestickEngine.evaluate(
  { epoch: 1060, open: 99.8, high: 102.2, low: 99.7, close: 102.0 },
  priorFlat,
  undefined,
  { resistanceLevel: 100.5 }
);
assert(breakoutRes.name === 'BREAKOUT_BULLISH', 'Contextual bullish breakout candle closing above resistance detected');

const failedBreak = CandlestickEngine.evaluate(
  { epoch: 1060, open: 99.9, high: 102.5, low: 99.2, close: 99.6 },
  priorFlat,
  undefined,
  { resistanceLevel: 100.5 }
);
assert(failedBreak.name === 'FAILED_BREAKOUT_BEARISH', 'Contextual failed breakout (bull trap) detected');

const insideMother: Candle = { epoch: 2000, open: 100, high: 105, low: 98, close: 103 };
const insideChild: Candle = { epoch: 2060, open: 101, high: 103.5, low: 99.5, close: 102.2 };
const insideSig = CandlestickEngine.evaluate(insideChild, insideMother);
assert(insideSig.name === 'INSIDE_BAR', 'Inside Bar consolidation candle detected');

// 8E. MACD in TechnicalIndicatorsEngine
assert(
  typeof indSnap.macdLine === 'number' &&
    typeof indSnap.macdSignal === 'number' &&
    indSnap.macdBias === 'BULLISH',
  `MACD (12,26,9) computes bullish momentum alignment (${indSnap.macdBias})`
);

// 8F. Opposing S/R Zone & Extended Move Guards
const blockedByZoneEval = OpportunityScoringEngine.evaluateConfluence({
  candidateDir: 'BULLISH',
  marketCondition: 'UPTRENDING',
  selectedStrategy: strategyTrend,
  h4Bias: 'BULLISH',
  h1Bias: 'BULLISH',
  m15Bias: 'BULLISH',
  m5Bias: 'BULLISH',
  h4Available: true,
  tradingRange: validRange,
  activePoiInsideRange: true,
  hasStrongPoi: true,
  sweepIdentified: true,
  activeShift5m: shifts[0],
  activeShift1m: shifts[0],
  reversal5m: hammerSignal,
  reversal1m: hammerSignal,
  m1EntryConfirmed: true,
  momentum: momOk,
  indicators: indSnap,
  blockedByOpposingZone: true,
  minThreshold: 75
});
assert(
  blockedByZoneEval.confirmed === false,
  'Blocks Buy/Rise entry directly into strong opposing resistance zone'
);

const extendedMoveEval = OpportunityScoringEngine.evaluateConfluence({
  candidateDir: 'BULLISH',
  marketCondition: 'UPTRENDING',
  selectedStrategy: strategyTrend,
  h4Bias: 'BULLISH',
  h1Bias: 'BULLISH',
  m15Bias: 'BULLISH',
  m5Bias: 'BULLISH',
  h4Available: true,
  tradingRange: validRange,
  activePoiInsideRange: true,
  hasStrongPoi: true,
  sweepIdentified: true,
  activeShift5m: shifts[0],
  activeShift1m: shifts[0],
  reversal5m: hammerSignal,
  reversal1m: hammerSignal,
  m1EntryConfirmed: true,
  momentum: momOk,
  indicators: indSnap,
  extendedMove: true,
  minThreshold: 75
});
assert(
  extendedMoveEval.confirmed === false,
  'Avoids chasing already extended price move'
);

// 9. MultiStrategyEngine: 6-State Intelligent Market Classification & 14 Independent Strategy Evaluators
console.log('\n[9] Testing MultiStrategyEngine & Supply/Demand Base Formations');

assert(
  zones.some((z) => z.hasBaseFormation === true),
  'Supply & Demand base candle prior to impulsive departure tagged hasBaseFormation'
);

const regimeTrend = MultiStrategyEngine.classifyDetailedRegime({
  overallCondition: 'UPTRENDING',
  h4Bias: 'BULLISH',
  h1Bias: 'BULLISH',
  tradingRange: validRange,
  adx14: 26,
  confirmedPatterns: [],
  activeShift5m: shifts[0],
  trendlines: tls,
  sweepDetected: false
});
assert(
  regimeTrend.regime === 'STRONG_UPTREND' && regimeTrend.label === 'Strong Uptrend',
  'Classifies aligned uptrend with ADX >= 20 cleanly as Strong Uptrend'
);

const regimeReversal = MultiStrategyEngine.classifyDetailedRegime({
  overallCondition: 'REVERSING',
  h4Bias: 'BEARISH',
  h1Bias: 'BEARISH',
  tradingRange: validRange,
  adx14: 22,
  confirmedPatterns: dtConfirmed,
  activeShift5m: { ...shifts[0], type: 'CHOCH' },
  trendlines: [],
  sweepDetected: true
});
assert(
  regimeReversal.regime === 'POTENTIAL_REVERSAL',
  'Classifies sweep + CHoCH / reversal pattern as Potential Reversal'
);

const multiSetups = MultiStrategyEngine.evaluateAllStrategies(
  {
    overallCondition: 'UPTRENDING',
    candidateDir: 'BULLISH',
    currentPrice: 100.0,
    atr: 2.0,
    h4Bias: 'BULLISH',
    h1Bias: 'BULLISH',
    m15Bias: 'BULLISH',
    m5Bias: 'BULLISH',
    h4Available: true,
    tradingRange: validRange,
    momentum: momOk,
    indicators: indSnap,
    baseConfluenceScore: 86,
    htfAligned: true,
    activePoiInsideRange: true,
    m1EntryConfirmed: true,
    blockedByOpposingZone: false,
    extendedMove: false,
    entryPrice: 100.0,
    stopLoss: 97.5,
    takeProfit: 105.0,
    riskRewardRatio: 2.0,
    zones,
    orderBlocks: [],
    fvgs,
    trendlines: tls,
    confirmedPatterns: dtConfirmed,
    activeShift5m: { ...shifts[0], type: 'BOS', direction: 'BULLISH', confirmedByClose: true },
    activeShift1m: shifts[0],
    reversal5m: hammerSignal,
    reversal1m: hammerSignal,
    sweepDetected: true,
    srFlipDetected: true
  },
  'STRONG_UPTREND'
);

assert(
  multiSetups.length === 6 &&
    multiSetups.some((s) => s.status === 'CONFIRMED' && s.strategyId === 'TRENDLINE_CONTINUATION') &&
    multiSetups.every((s) => Boolean(s.entryCondition && s.invalidationCondition && s.expectedHoldingTime)),
  'All 6 core strategies evaluate independently with confirmed Trendline Continuation, entry/invalidation conditions, and holding time'
);

const patternCheck = multiSetups.find((s) => s.strategyId === 'CHART_PATTERN');
const trendCheck = multiSetups.find((s) => s.strategyId === 'TRENDLINE_CONTINUATION');
assert(
  Boolean(trendCheck?.regimePrioritized),
  'Automatically prioritizes strategies matching Strong Uptrend regime'
);

// 10. Flip Support & Resistance (Role Reversal) Independent Strategy Tests
console.log('\n[10] Testing Flip Support & Resistance (Role Reversal) Strategy');

// 10A. False Breakout: wick pierces above resistance (105) without candle close beyond level -> NOT confirmed
const falseBreakCandles: Candle[] = [
  { epoch: 1000, open: 100, high: 102, low: 99, close: 101 },
  { epoch: 1060, open: 101, high: 105.0, low: 100.5, close: 103.5 },
  { epoch: 1120, open: 103.5, high: 104.2, low: 101.0, close: 102.0 },
  { epoch: 1180, open: 102.0, high: 106.2, low: 101.8, close: 104.0 }, // wick trap above 105, closes below!
  { epoch: 1240, open: 104.0, high: 104.5, low: 102.5, close: 103.0 }
];
const falseBreakPivots = [
  { index: 1, epoch: 1060, price: 105.0, type: 'HIGH' as const, isSwept: false }
];
const falseFlipAssess = SupportResistanceEngine.evaluateFlipRoleReversal(
  falseBreakCandles,
  falseBreakPivots,
  '15m',
  103.0,
  0.002
);
assert(
  falseFlipAssess.activeBullishFlip === null && falseFlipAssess.falseBreakoutDetected === true,
  'Flags wick-only pierce above resistance as False Breakout without creating R->S flip'
);

// 10B. Confirmed Resistance-to-Support (R->S) Flip: closed breakout above resistance + controlled retest rejection
const rToSCandles: Candle[] = [
  { epoch: 2000, open: 100, high: 102, low: 99, close: 101 },
  { epoch: 2060, open: 101, high: 105.0, low: 100.5, close: 103.0 }, // Resistance pivot at 105.0
  { epoch: 2120, open: 103.0, high: 104.5, low: 101.5, close: 102.5 },
  { epoch: 2180, open: 102.5, high: 107.0, low: 102.2, close: 106.6 }, // Decisive breakout candle closing > 105.21
  { epoch: 2240, open: 106.6, high: 107.5, low: 106.2, close: 107.1 }, // Follow-through
  { epoch: 2300, open: 107.1, high: 107.2, low: 105.05, close: 106.3 } // Retests top of resistance & rejects bullishly
];
const rToSPivots = [
  { index: 1, epoch: 2060, price: 105.0, type: 'HIGH' as const, isSwept: false }
];
const rToSAssess = SupportResistanceEngine.evaluateFlipRoleReversal(
  rToSCandles,
  rToSPivots,
  '15m',
  106.3,
  0.002
);
assert(
  rToSAssess.activeBullishFlip !== null &&
    rToSAssess.activeBullishFlip.flipType === 'R_TO_S' &&
    rToSAssess.activeBullishFlip.flipState === 'CONFIRMED_FLIP_RETEST' &&
    rToSAssess.activeBullishFlip.retestRejection === true,
  'Detects confirmed Resistance-to-Support (R->S) flip after candle-close breakout & retest rejection'
);

// 10C. Confirmed Support-to-Resistance (S->R) Flip: closed breakdown below support + retest rejection
const sToRCandles: Candle[] = [
  { epoch: 3000, open: 110, high: 111, low: 108, close: 109 },
  { epoch: 3060, open: 109, high: 109.5, low: 105.0, close: 107.0 }, // Support pivot at 105.0
  { epoch: 3120, open: 107.0, high: 108.0, low: 105.5, close: 106.5 },
  { epoch: 3180, open: 106.5, high: 106.8, low: 103.0, close: 103.4 }, // Decisive breakdown closing < 104.79
  { epoch: 3240, open: 103.4, high: 103.8, low: 102.5, close: 102.9 },
  { epoch: 3300, open: 102.9, high: 104.9, low: 102.8, close: 103.5 } // Retests bottom of broken support & rejects bearishly
];
const sToRPivots = [
  { index: 1, epoch: 3060, price: 105.0, type: 'LOW' as const, isSwept: false }
];
const sToRAssess = SupportResistanceEngine.evaluateFlipRoleReversal(
  sToRCandles,
  sToRPivots,
  '15m',
  103.5,
  0.002
);
assert(
  sToRAssess.activeBearishFlip !== null &&
    sToRAssess.activeBearishFlip.flipType === 'S_TO_R' &&
    sToRAssess.activeBearishFlip.flipState === 'CONFIRMED_FLIP_RETEST',
  'Detects confirmed Support-to-Resistance (S->R) flip after candle-close breakdown & retest rejection'
);

// 10D. Failed Retest: price breaks above resistance then closes back below support boundary -> rejected
const failedRetestCandles: Candle[] = [
  { epoch: 4000, open: 100, high: 102, low: 99, close: 101 },
  { epoch: 4060, open: 101, high: 105.0, low: 100.5, close: 103.0 },
  { epoch: 4120, open: 103.0, high: 104.0, low: 101.5, close: 102.5 },
  { epoch: 4180, open: 102.5, high: 106.5, low: 102.0, close: 106.1 }, // close > upper
  { epoch: 4240, open: 106.1, high: 106.2, low: 103.8, close: 104.2 }  // failed retest: closed back below lower (104.79)
];
const failedRetestPivots = [
  { index: 1, epoch: 4060, price: 105.0, type: 'HIGH' as const, isSwept: false }
];
const failedRetestAssess = SupportResistanceEngine.evaluateFlipRoleReversal(
  failedRetestCandles,
  failedRetestPivots,
  '15m',
  104.2,
  0.002
);
assert(
  failedRetestAssess.activeBullishFlip === null && failedRetestAssess.failedRetestDetected === true,
  'Rejects Failed Retest when price closes back through the flipped level'
);

// 10E. Never generate entry merely because price touches a flipped level (without rejection/structure/momentum)
const touchOnlySetups = MultiStrategyEngine.evaluateAllStrategies(
  {
    overallCondition: 'UPTRENDING',
    candidateDir: 'BULLISH',
    currentPrice: 105.2,
    atr: 2.0,
    h4Bias: 'BULLISH',
    h1Bias: 'BULLISH',
    m15Bias: 'BULLISH',
    m5Bias: 'BULLISH',
    h4Available: true,
    tradingRange: validRange,
    momentum: momFail,
    indicators: indSnap,
    baseConfluenceScore: 80,
    htfAligned: true,
    activePoiInsideRange: true,
    m1EntryConfirmed: false,
    blockedByOpposingZone: false,
    extendedMove: false,
    entryPrice: 105.2,
    stopLoss: 103.0,
    takeProfit: 109.6,
    riskRewardRatio: 2.0,
    zones: rToSAssess.flipZones,
    orderBlocks: [],
    fvgs,
    trendlines: [],
    confirmedPatterns: [],
    activeShift5m: null,
    activeShift1m: null,
    reversal5m: { name: 'NONE', direction: 'NEUTRAL', epoch: 2300, strength: 0, rejectionWickRatio: 0, bodyRatio: 0.2, description: '' },
    reversal1m: { name: 'NONE', direction: 'NEUTRAL', epoch: 2300, strength: 0, rejectionWickRatio: 0, bodyRatio: 0.2, description: '' },
    sweepDetected: false,
    srFlipDetected: true,
    flipAssessment: rToSAssess
  },
  'STRONG_UPTREND'
);
const flipTouchOnly = touchOnlySetups.find((s) => s.strategyId === 'FLIP_SUPPORT_RESISTANCE');
assert(
  flipTouchOnly !== undefined && flipTouchOnly.status === 'PENDING' && flipTouchOnly.missingConditions.length >= 2,
  'Refuses to confirm FLIP_SUPPORT_RESISTANCE entry merely on touching a flipped level without structure, candle & momentum confirmation'
);

console.log(`\n========================================`);
console.log(`RESULTS: ${passCount} Passed, ${failCount} Failed`);
console.log(`========================================\n`);

if (failCount > 0) {
  process.exit(1);
}
