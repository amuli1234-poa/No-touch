import {
  Candle,
  ChartPattern,
  MarketCondition,
  ProtectedSwing,
  SupportResistanceZone,
  Timeframe,
  Trendline
} from '../types/scanner';
import { MarketStructureEngine } from './MarketStructureEngine';
import { SupportResistanceEngine } from './SupportResistanceEngine';
import { TrendlineAndRangeEngine } from './TrendlineAndRangeEngine';
import { ChartPatternEngine } from './ChartPatternEngine';
import { TechnicalIndicatorsEngine } from './TechnicalIndicatorsEngine';

/**
 * Derives the chart-structure overlays (zones, trendlines, protected swings,
 * confirmed patterns) from raw candles for a single timeframe.
 *
 * This used to live inside the old canvas chart component. It is engine logic
 * — pure derivation from candles, no rendering — so per the project convention
 * it belongs in `src/engines` and stays reusable by any chart renderer.
 */

export type ChartTrendLabel = 'Uptrend' | 'Downtrend' | 'Consolidation';

export interface ChartStructure {
  trendLabel: ChartTrendLabel;
  marketCondition: MarketCondition;
  protectedHigh: ProtectedSwing | null;
  protectedLow: ProtectedSwing | null;
  supportZones: SupportResistanceZone[];
  resistanceZones: SupportResistanceZone[];
  trendlines: Trendline[];
  confirmedPattern: ChartPattern | null;
}

const EMPTY: ChartStructure = {
  trendLabel: 'Consolidation',
  marketCondition: 'UNCLEAR',
  protectedHigh: null,
  protectedLow: null,
  supportZones: [],
  resistanceZones: [],
  trendlines: [],
  confirmedPattern: null
};

export const ChartStructureEngine = {
  /**
   * Only the zones nearest price are drawn, so the chart stays readable. Flip
   * zones are always kept (they are rare and high-signal); regular support and
   * demand are ranked by distance and capped.
   */
  derive(candles: Candle[], timeframe: Timeframe): ChartStructure {
    if (candles.length < 8) return EMPTY;

    const pivots = MarketStructureEngine.findPivots(candles, 2, 2);
    const shifts = MarketStructureEngine.detectAllStructuralShifts(candles, pivots);
    const rawCond = MarketStructureEngine.classifyMarketCondition(candles, pivots, shifts);
    const latestClose = candles[candles.length - 1].close;
    const bias = MarketStructureEngine.getDirectionalBias(pivots, latestClose);

    let trendLabel: ChartTrendLabel = 'Consolidation';
    if (rawCond === 'UPTRENDING') {
      trendLabel = 'Uptrend';
    } else if (rawCond === 'DOWNTRENDING') {
      trendLabel = 'Downtrend';
    } else if (rawCond === 'REVERSING') {
      const lastShift = shifts[shifts.length - 1];
      if (lastShift?.direction === 'BULLISH' || bias === 'BULLISH') trendLabel = 'Uptrend';
      else if (lastShift?.direction === 'BEARISH' || bias === 'BEARISH') trendLabel = 'Downtrend';
    } else if (rawCond === 'UNCLEAR') {
      if (bias === 'BULLISH') trendLabel = 'Uptrend';
      else if (bias === 'BEARISH') trendLabel = 'Downtrend';
    }

    const { protectedHigh, protectedLow } = MarketStructureEngine.identifyProtectedSwings(
      candles,
      pivots,
      shifts
    );

    const allZones = SupportResistanceEngine.mapZones(candles, pivots, timeframe);
    const rankZone = (z: SupportResistanceZone) => {
      const mid = (z.upperPrice + z.lowerPrice) / 2;
      const dist = Math.abs(latestClose - mid);
      const flipBonus = z.isFlip ? 0.55 : 1.0;
      const strengthMultiplier = z.strength.startsWith('STRONG') ? 0.65 : 1.0;
      return dist * strengthMultiplier * flipBonus;
    };

    const flipZones = allZones.filter((z) => !z.broken && z.isFlip);
    const supportZones = [
      ...flipZones.filter((z) => z.type === 'SUPPORT'),
      ...allZones
        .filter(
          (z) =>
            !z.broken &&
            !z.isFlip &&
            (z.type === 'DEMAND' || z.type === 'SUPPORT') &&
            z.lowerPrice <= latestClose * 1.008
        )
        .sort((a, b) => rankZone(a) - rankZone(b))
        .slice(0, 2)
    ].slice(0, 3);

    const resistanceZones = [
      ...flipZones.filter((z) => z.type === 'RESISTANCE'),
      ...allZones
        .filter(
          (z) =>
            !z.broken &&
            !z.isFlip &&
            (z.type === 'SUPPLY' || z.type === 'RESISTANCE') &&
            z.upperPrice >= latestClose * 0.992
        )
        .sort((a, b) => rankZone(a) - rankZone(b))
        .slice(0, 2)
    ].slice(0, 3);

    const trendlines = TrendlineAndRangeEngine.detectTrendlines(candles, pivots, timeframe).filter(
      (t) => !t.broken || t.retested
    );

    // Patterns are confirmed on completed candles only: an unclosed final bar
    // can still change shape, so it must not be allowed to confirm a pattern.
    const tfSec = TIMEFRAME_SECONDS[timeframe];
    const currBucket = Math.floor(Date.now() / 1000 / tfSec) * tfSec;
    const last = candles[candles.length - 1];
    const closedCandles = candles.length > 20 && last.epoch >= currBucket ? candles.slice(0, -1) : candles;
    const closedPivots =
      closedCandles.length === candles.length ? pivots : MarketStructureEngine.findPivots(closedCandles, 2, 2);
    const atrSeries = TechnicalIndicatorsEngine.computeAtrSeries(closedCandles, 14);
    const atr = atrSeries[atrSeries.length - 1] ?? 0;
    const confirmedPatterns = ChartPatternEngine.detectConfirmedPatterns(
      closedCandles,
      closedPivots,
      timeframe,
      atr
    );

    return {
      trendLabel,
      marketCondition: rawCond,
      protectedHigh,
      protectedLow,
      supportZones,
      resistanceZones,
      trendlines,
      confirmedPattern: confirmedPatterns[0] || null
    };
  }
};

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400
};
