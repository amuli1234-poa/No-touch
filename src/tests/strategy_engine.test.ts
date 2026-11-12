import { Candle, PivotPoint, FVG, TrendDirection } from '../types/scanner';
import { MarketStructureEngine } from '../engines/MarketStructureEngine';
import { CandlestickEngine } from '../engines/CandlestickEngine';
import { FvgEngine } from '../engines/FvgEngine';
import { AdaptiveFillEngine } from '../engines/AdaptiveFillEngine';
import { TradeableRangeEngine } from '../engines/TradeableRangeEngine';
import { PathTouchProbability } from '../engines/PathTouchProbability';
import { OpportunityScoringEngine } from '../engines/OpportunityScoringEngine';
import { MarketShiftEngine } from '../engines/MarketShiftEngine';

console.log('🧪 Starting Deriv No Touch Strategy Engines Validation Suite...\n');

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

// 1. Test Liquidity Sweep Detection
console.log('[1] Testing MarketStructureEngine — Liquidity Sweep vs Breakout');
const pivots: PivotPoint[] = [
  { index: 1, epoch: 1000, price: 100.0, type: 'LOW', isSwept: false }
];
const sweepCandles: Candle[] = [
  { epoch: 1000, open: 102, high: 103, low: 100, close: 101 },
  // Pierces 100.0 (low: 99.2) but closes at 100.4 (ABOVE level) -> Liquidity Sweep!
  { epoch: 1120, open: 100.5, high: 101, low: 99.2, close: 100.4 }
];
const { sweeps, updatedPivots } = MarketStructureEngine.evaluateLiquiditySweeps(sweepCandles, pivots);
assert(sweeps.length === 1 && sweeps[0].type === 'SELLSIDE', 'Detected Sell-Side Liquidity Sweep (SSL)');
assert(updatedPivots[0].isSwept === true, 'Updated pivot marked as isSwept');

// 2. Test BOS / CHoCH Detection
console.log('\n[2] Testing MarketStructureEngine — CHoCH Confirmation by Close');
const structurePivots: PivotPoint[] = [
  { index: 1, epoch: 1000, price: 105.0, type: 'HIGH', isSwept: false },
  { index: 3, epoch: 1240, price: 98.0, type: 'LOW', isSwept: false }
];
const breakoutCandles: Candle[] = [
  { epoch: 1000, open: 103, high: 105, low: 102, close: 104 },
  { epoch: 1120, open: 104, high: 104.5, low: 99, close: 99.5 },
  // Bullish displacement closing at 107.5 strictly above 105.0 pivot
  { epoch: 1240, open: 100, high: 108, low: 99.5, close: 107.5 }
];
const shifts = MarketStructureEngine.detectStructuralShifts(breakoutCandles, structurePivots);
assert(shifts.length > 0 && shifts[0].type === 'CHOCH' && shifts[0].direction === 'BULLISH', 'Bullish CHoCH confirmed by candle close');

// 3. Test Candlestick Engine
console.log('\n[3] Testing CandlestickEngine — Reversal Rejections');
const hammerCandle: Candle = { epoch: 2000, open: 100.5, high: 101, low: 96, close: 100.8 };
const hammerSignal = CandlestickEngine.evaluate(hammerCandle);
assert(hammerSignal.name === 'BULLISH_PIN_BAR' || hammerSignal.name === 'HAMMER', 'Hammer / Pin Bar detected with long lower wick');
assert(hammerSignal.direction === 'BULLISH', 'Signal direction is Bullish');

// 4. Test FVG Engine
console.log('\n[4] Testing FvgEngine — 3-Candle Imbalance with Displacement');
const fvgCandles: Candle[] = [
  { epoch: 100, open: 100, high: 102, low: 99, close: 101 },   // C1
  { epoch: 220, open: 101.5, high: 112, low: 101, close: 111 }, // C2: massive displacement
  { epoch: 340, open: 111, high: 114, low: 105, close: 113 }    // C3: low is 105 (> C1 high 102)
];
const fvgs = FvgEngine.scan(fvgCandles, '2m', 0.0001);
assert(fvgs.length === 1 && fvgs[0].direction === 'BULLISH', 'Bullish FVG detected between C1 High and C3 Low');
assert(fvgs[0].lowerBoundary === 102 && fvgs[0].upperBoundary === 105, 'FVG boundaries correct (102 to 105)');
assert(fvgs[0].midpoint === 103.5, 'FVG midpoint correct (103.5)');

// 5. Test Adaptive FVG Fill Depth
console.log('\n[5] Testing AdaptiveFillEngine — Dynamic Retracement');
const fillTargetHighVol = AdaptiveFillEngine.computeTarget(fvgs[0], 'BULLISH', 'HIGH', false, 15);
assert(fillTargetHighVol.depthType === 'DEEP_75', 'High Vol + Divergent bias selects Deep 75% fill target');
const fillTargetAligned = AdaptiveFillEngine.computeTarget(fvgs[0], 'BULLISH', 'LOW', true, 15);
assert(fillTargetAligned.depthType === 'NEAR_EDGE', 'Low Vol + MTF aligned selects Near Edge prompt reaction');

// 6. Test Tradeable Range & Protected Swing
console.log('\n[6] Testing TradeableRangeEngine — Protected Swing Isolation');
const sweptLowPivot: PivotPoint = { index: 1, epoch: 100, price: 95.0, type: 'LOW', isSwept: true };
const brokenHighPivot: PivotPoint = { index: 3, epoch: 340, price: 114.0, type: 'HIGH', isSwept: false };
const tr = TradeableRangeEngine.calculate('BULLISH', sweptLowPivot, brokenHighPivot, fvgs[0], 110.0, 'MEDIUM', true);
assert(tr !== null && tr.isRetracementValid, 'Tradeable range is valid');
assert(tr?.newlyProtectedSwing === 95.0, 'Protected Swing is 95.0');
assert(tr?.adaptiveFillTarget === 103.5, 'Adaptive target is 103.5 (well above 95.0 buffer)');

// 7. Test Path Touch Probability
console.log('\n[7] Testing PathTouchProbability — Continuous First-Passage Risk');
const zeroDistanceRisk = PathTouchProbability.calculateTouchRisk(0.01, 0.05, 300);
const wideDistanceRisk = PathTouchProbability.calculateTouchRisk(5.0, 0.05, 300);
assert(zeroDistanceRisk > 0.95, 'Touch risk approaches 100% for near-zero barrier distance');
assert(wideDistanceRisk < 0.15, 'Touch risk drops for wide volatility-adjusted distance');
assert(zeroDistanceRisk > wideDistanceRisk, 'Touch risk monotonically decreases with barrier distance');

// 8. Test Strict Mandatory Condition Gating
console.log('\n[8] Testing OpportunityScoringEngine — Strict Mandatory Gating');
const gatedScore = OpportunityScoringEngine.evaluateScore(
  'BULLISH',
  'BULLISH',
  true,  // Sweep identified
  true,  // Protected swing valid
  hammerSignal,
  null,  // CHoCH MISSING! Mandatory fail
  fvgs[0],
  tr,
  null
);
assert(gatedScore.status === 'REJECTED', 'Missing CHoCH results in REJECTED regardless of score');
assert(gatedScore.rejectionReasons.length > 0, 'Rejection reason explicitly recorded');

console.log(`\n========================================`);
console.log(`RESULTS: ${passCount} Passed, ${failCount} Failed`);
console.log(`========================================\n`);

if (failCount > 0) {
  process.exit(1);
}
