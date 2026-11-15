import type {
  ChartPatternStructure,
  SwingPoint,
  TrendlineStructure,
} from '../types/analysis';
import type { Candle } from '../types/market';
import { formatPrice } from '../utils/derivParser';
import { getCandleStats, getRecentAverageBody } from './swings';

function linePriceAtTime(
  startTime: number,
  startPrice: number,
  slopePerSec: number,
  time: number
): number {
  return startPrice + slopePerSec * (time - startTime);
}

export function detectTrendlines(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  atr: number,
  precision: number
): TrendlineStructure[] {
  if (candles.length < 25 || swings.length < 4 || atr <= 0) return [];

  const results: TrendlineStructure[] = [];
  const latestBar = candles[candles.length - 1];
  const lows = swings.filter((s) => s.type === 'low');
  const highs = swings.filter((s) => s.type === 'high');

  // Bullish Trendline: ascending swing lows with minimal body violation in between
  if (lows.length >= 2) {
    let bestBull: TrendlineStructure | null = null;
    for (let a = Math.max(0, lows.length - 5); a < lows.length - 1; a++) {
      for (let b = a + 1; b < lows.length; b++) {
        const p1 = lows[a];
        const p2 = lows[b];
        if (p2.price <= p1.price || p2.index - p1.index < 5 || p2.time === p1.time) {
          continue;
        }
        const slope = (p2.price - p1.price) / (p2.time - p1.time);
        let violatedBetween = false;
        let touches = 2;

        for (let k = p1.index + 1; k < candles.length - 1; k++) {
          const bar = candles[k];
          const lineY = linePriceAtTime(p1.time, p1.price, slope, bar.time);
          if (bar.close < lineY - atr * 0.35) {
            violatedBetween = true;
            break;
          }
          if (
            k !== p2.index &&
            Math.abs(bar.low - lineY) <= atr * 0.28 &&
            bar.close >= lineY
          ) {
            touches++;
          }
        }
        if (violatedBetween) continue;

        const currentLineY = linePriceAtTime(p1.time, p1.price, slope, latestBar.time);
        const avgBody = getRecentAverageBody(candles, candles.length - 1, 14);
        const latestStats = getCandleStats(latestBar);
        const broken =
          latestBar.close < currentLineY - atr * 0.15 &&
          latestStats.isBearish &&
          latestStats.body >= avgBody * 0.9;

        bestBull = {
          id: `tl-bull-${p1.time}-${p2.time}`,
          direction: 'bullish',
          startTime: p1.time,
          startPrice: p1.price,
          endTime: latestBar.time,
          endPrice: currentLineY,
          slopePerSec: slope,
          touches,
          broken,
          breakDirection: broken ? 'bearish' : undefined,
          breakTime: broken ? latestBar.time : undefined,
          breakPrice: broken ? latestBar.close : undefined,
          reason: broken
            ? `BEARISH TRENDLINE BREAK — Price closed below ascending support trendline near ${formatPrice(
                currentLineY,
                precision
              )}.`
            : `BULLISH TRENDLINE — Ascending support connecting ${touches} higher swing lows.`,
        };
      }
    }
    if (bestBull) results.push(bestBull);
  }

  // Bearish Trendline: descending swing highs
  if (highs.length >= 2) {
    let bestBear: TrendlineStructure | null = null;
    for (let a = Math.max(0, highs.length - 5); a < highs.length - 1; a++) {
      for (let b = a + 1; b < highs.length; b++) {
        const p1 = highs[a];
        const p2 = highs[b];
        if (p2.price >= p1.price || p2.index - p1.index < 5 || p2.time === p1.time) {
          continue;
        }
        const slope = (p2.price - p1.price) / (p2.time - p1.time);
        let violatedBetween = false;
        let touches = 2;

        for (let k = p1.index + 1; k < candles.length - 1; k++) {
          const bar = candles[k];
          const lineY = linePriceAtTime(p1.time, p1.price, slope, bar.time);
          if (bar.close > lineY + atr * 0.35) {
            violatedBetween = true;
            break;
          }
          if (
            k !== p2.index &&
            Math.abs(bar.high - lineY) <= atr * 0.28 &&
            bar.close <= lineY
          ) {
            touches++;
          }
        }
        if (violatedBetween) continue;

        const currentLineY = linePriceAtTime(p1.time, p1.price, slope, latestBar.time);
        const avgBody = getRecentAverageBody(candles, candles.length - 1, 14);
        const latestStats = getCandleStats(latestBar);
        const broken =
          latestBar.close > currentLineY + atr * 0.15 &&
          latestStats.isBullish &&
          latestStats.body >= avgBody * 0.9;

        bestBear = {
          id: `tl-bear-${p1.time}-${p2.time}`,
          direction: 'bearish',
          startTime: p1.time,
          startPrice: p1.price,
          endTime: latestBar.time,
          endPrice: currentLineY,
          slopePerSec: slope,
          touches,
          broken,
          breakDirection: broken ? 'bullish' : undefined,
          breakTime: broken ? latestBar.time : undefined,
          breakPrice: broken ? latestBar.close : undefined,
          reason: broken
            ? `BULLISH TRENDLINE BREAK — Price closed above descending resistance trendline near ${formatPrice(
                currentLineY,
                precision
              )}.`
            : `BEARISH TRENDLINE — Descending resistance connecting ${touches} lower swing highs.`,
        };
      }
    }
    if (bestBear) results.push(bestBear);
  }

  return results;
}

export function detectChartPatterns(
  candles: readonly Candle[],
  swings: readonly SwingPoint[],
  atr: number,
  precision: number
): ChartPatternStructure[] {
  if (candles.length < 30 || swings.length < 4 || atr <= 0) {
    return [];
  }

  const patterns: ChartPatternStructure[] = [];
  const latestBar = candles[candles.length - 1];
  const avgBody = getRecentAverageBody(candles, candles.length - 1, 14);
  const latestStats = getCandleStats(latestBar);

  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  // 1. Double Top (bearish) — strictly require two aligned highs separated by >= 6 bars and clear neckline
  if (highs.length >= 2 && lows.length >= 1) {
    const h1 = highs[highs.length - 2];
    const h2 = highs[highs.length - 1];
    const midLow = lows.find((l) => l.index > h1.index && l.index < h2.index);
    if (
      midLow &&
      h2.index - h1.index >= 6 &&
      candles.length - 1 - h2.index <= 25 &&
      Math.abs(h1.price - h2.price) <= atr * 0.45 &&
      Math.max(h1.price, h2.price) - midLow.price >= atr * 1.4
    ) {
      const neckline = midLow.price;
      const confirmed =
        latestBar.close < neckline - atr * 0.05 &&
        latestStats.isBearish &&
        latestStats.body >= avgBody * 0.85;

      // Only emit if confirmed breakout OR actively testing/forming near neckline (within 1.5 ATR)
      if (confirmed || Math.abs(latestBar.close - neckline) <= atr * 1.5) {
        patterns.push({
          id: `pat-dt-${h1.time}-${h2.time}`,
          name: 'Double Top',
          bias: 'bearish',
          confirmed,
          breakTime: confirmed ? latestBar.time : undefined,
          breakPrice: confirmed ? latestBar.close : undefined,
          necklinePrice: neckline,
          lines: [
            {
              startTime: h1.time,
              startPrice: h1.price,
              endTime: h2.time,
              endPrice: h2.price,
            },
            {
              startTime: midLow.time,
              startPrice: neckline,
              endTime: latestBar.time,
              endPrice: neckline,
            },
          ],
          reason: confirmed
            ? `DOUBLE TOP CONFIRMED — Price closed below neckline ${formatPrice(
                neckline,
                precision
              )} after twin resistance peaks.`
            : `DOUBLE TOP FORMING — Twin peaks near ${formatPrice(
                (h1.price + h2.price) / 2,
                precision
              )} approaching neckline ${formatPrice(neckline, precision)}.`,
        });
      }
    }
  }

  // 2. Double Bottom (bullish)
  if (lows.length >= 2 && highs.length >= 1) {
    const l1 = lows[lows.length - 2];
    const l2 = lows[lows.length - 1];
    const midHigh = highs.find((h) => h.index > l1.index && h.index < l2.index);
    if (
      midHigh &&
      l2.index - l1.index >= 6 &&
      candles.length - 1 - l2.index <= 25 &&
      Math.abs(l1.price - l2.price) <= atr * 0.45 &&
      midHigh.price - Math.min(l1.price, l2.price) >= atr * 1.4
    ) {
      const neckline = midHigh.price;
      const confirmed =
        latestBar.close > neckline + atr * 0.05 &&
        latestStats.isBullish &&
        latestStats.body >= avgBody * 0.85;

      if (confirmed || Math.abs(latestBar.close - neckline) <= atr * 1.5) {
        patterns.push({
          id: `pat-db-${l1.time}-${l2.time}`,
          name: 'Double Bottom',
          bias: 'bullish',
          confirmed,
          breakTime: confirmed ? latestBar.time : undefined,
          breakPrice: confirmed ? latestBar.close : undefined,
          necklinePrice: neckline,
          lines: [
            {
              startTime: l1.time,
              startPrice: l1.price,
              endTime: l2.time,
              endPrice: l2.price,
            },
            {
              startTime: midHigh.time,
              startPrice: neckline,
              endTime: latestBar.time,
              endPrice: neckline,
            },
          ],
          reason: confirmed
            ? `DOUBLE BOTTOM CONFIRMED — Price closed above neckline ${formatPrice(
                neckline,
                precision
              )} after twin support lows.`
            : `DOUBLE BOTTOM FORMING — Twin lows near ${formatPrice(
                (l1.price + l2.price) / 2,
                precision
              )} approaching neckline ${formatPrice(neckline, precision)}.`,
        });
      }
    }
  }

  // 3. Triangles (Ascending, Descending, Symmetrical) from last 2 highs and last 2 lows
  if (highs.length >= 2 && lows.length >= 2) {
    const h1 = highs[highs.length - 2];
    const h2 = highs[highs.length - 1];
    const l1 = lows[lows.length - 2];
    const l2 = lows[lows.length - 1];
    const startIdx = Math.min(h1.index, l1.index);
    const endIdx = Math.max(h2.index, l2.index);

    if (
      endIdx - startIdx >= 10 &&
      candles.length - 1 - endIdx <= 18 &&
      h1.time !== h2.time &&
      l1.time !== l2.time
    ) {
      const upperSlope = (h2.price - h1.price) / (h2.time - h1.time);
      const lowerSlope = (l2.price - l1.price) / (l2.time - l1.time);
      const upperNow = linePriceAtTime(h1.time, h1.price, upperSlope, latestBar.time);
      const lowerNow = linePriceAtTime(l1.time, l1.price, lowerSlope, latestBar.time);

      const initialWidth = Math.abs(h1.price - l1.price);
      const currentWidth = upperNow - lowerNow;

      const isFlatUpper = Math.abs(h2.price - h1.price) <= atr * 0.35;
      const isRisingLower = l2.price - l1.price >= atr * 0.45;
      const isFlatLower = Math.abs(l2.price - l1.price) <= atr * 0.35;
      const isFallingUpper = h1.price - h2.price >= atr * 0.45;
      const isConverging = currentWidth > 0 && currentWidth < initialWidth * 0.85;

      if (isConverging) {
        if (isFlatUpper && isRisingLower) {
          const confirmed =
            latestBar.close > upperNow + atr * 0.05 &&
            latestStats.isBullish &&
            latestStats.body >= avgBody * 0.9;
          patterns.push({
            id: `pat-asc-tri-${h1.time}`,
            name: 'Ascending Triangle',
            bias: 'bullish',
            confirmed,
            breakTime: confirmed ? latestBar.time : undefined,
            breakPrice: confirmed ? latestBar.close : undefined,
            lines: [
              {
                startTime: h1.time,
                startPrice: h1.price,
                endTime: latestBar.time,
                endPrice: upperNow,
              },
              {
                startTime: l1.time,
                startPrice: l1.price,
                endTime: latestBar.time,
                endPrice: lowerNow,
              },
            ],
            reason: confirmed
              ? `ASCENDING TRIANGLE BREAKOUT — Bullish close above flat resistance ${formatPrice(
                  upperNow,
                  precision
                )}.`
              : `ASCENDING TRIANGLE — Rising higher lows pressing against flat resistance ${formatPrice(
                  upperNow,
                  precision
                )}.`,
          });
        } else if (isFlatLower && isFallingUpper) {
          const confirmed =
            latestBar.close < lowerNow - atr * 0.05 &&
            latestStats.isBearish &&
            latestStats.body >= avgBody * 0.9;
          patterns.push({
            id: `pat-desc-tri-${l1.time}`,
            name: 'Descending Triangle',
            bias: 'bearish',
            confirmed,
            breakTime: confirmed ? latestBar.time : undefined,
            breakPrice: confirmed ? latestBar.close : undefined,
            lines: [
              {
                startTime: h1.time,
                startPrice: h1.price,
                endTime: latestBar.time,
                endPrice: upperNow,
              },
              {
                startTime: l1.time,
                startPrice: l1.price,
                endTime: latestBar.time,
                endPrice: lowerNow,
              },
            ],
            reason: confirmed
              ? `DESCENDING TRIANGLE BREAKOUT — Bearish close below flat support ${formatPrice(
                  lowerNow,
                  precision
                )}.`
              : `DESCENDING TRIANGLE — Falling lower highs pressing against flat support ${formatPrice(
                  lowerNow,
                  precision
                )}.`,
          });
        } else if (isFallingUpper && isRisingLower) {
          const bullBreak =
            latestBar.close > upperNow + atr * 0.05 &&
            latestStats.isBullish &&
            latestStats.body >= avgBody * 0.9;
          const bearBreak =
            latestBar.close < lowerNow - atr * 0.05 &&
            latestStats.isBearish &&
            latestStats.body >= avgBody * 0.9;

          if (bullBreak || bearBreak) {
            patterns.push({
              id: `pat-sym-tri-${startIdx}`,
              name: 'Symmetrical Triangle',
              bias: bullBreak ? 'bullish' : 'bearish',
              confirmed: true,
              breakTime: latestBar.time,
              breakPrice: latestBar.close,
              lines: [
                {
                  startTime: h1.time,
                  startPrice: h1.price,
                  endTime: latestBar.time,
                  endPrice: upperNow,
                },
                {
                  startTime: l1.time,
                  startPrice: l1.price,
                  endTime: latestBar.time,
                  endPrice: lowerNow,
                },
              ],
              reason: bullBreak
                ? `SYMMETRICAL TRIANGLE BREAKOUT — Bullish break above converging resistance ${formatPrice(
                    upperNow,
                    precision
                  )}.`
                : `SYMMETRICAL TRIANGLE BREAKOUT — Bearish break below converging support ${formatPrice(
                    lowerNow,
                    precision
                  )}.`,
            });
          }
        }
      }
    }
  }

  // Only return confirmed patterns or high-clarity active patterns (max 2)
  return patterns
    .sort((a, b) => Number(b.confirmed) - Number(a.confirmed))
    .slice(0, 2);
}
