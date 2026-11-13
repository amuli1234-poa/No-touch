import {
  Candle,
  ChartPattern,
  ChartPatternLine,
  ChartPatternPoint,
  PivotPoint,
  Timeframe
} from '../types/scanner';

/**
 * Validated Chart Pattern Recognition Engine
 * Detects and validates patterns strictly when structure AND breakout/boundary confirmation
 * are complete on genuine candle closes. Never emits incomplete or speculative patterns.
 */
export class ChartPatternEngine {
  public static detectConfirmedPatterns(
    candles: Candle[],
    pivots: PivotPoint[],
    timeframe: Timeframe,
    atr: number = 0
  ): ChartPattern[] {
    if (candles.length < 18 || pivots.length < 3) return [];

    const candidates: ChartPattern[] = [];
    const highs = pivots.filter((p) => p.type === 'HIGH');
    const lows = pivots.filter((p) => p.type === 'LOW');
    const latest = candles[candles.length - 1];
    const effAtr = atr > 0 ? atr : Math.max(1e-6, latest.high - latest.low);

    // 1. Double Top & Double Bottom (Neckline Close Confirmed)
    if (highs.length >= 2) {
      const h2 = highs[highs.length - 1];
      const h1 = highs[highs.length - 2];
      const symDiff = Math.abs(h2.price - h1.price) / Math.max(1e-9, h1.price);
      if (h2.index - h1.index >= 4 && symDiff <= 0.0032) {
        const trough = lows.find((l) => l.index > h1.index && l.index < h2.index);
        if (trough && (h1.price - trough.price) >= effAtr * 1.1) {
          const neckline = trough.price;
          const postH2 = candles.slice(h2.index + 1);
          const breakCandle = postH2.find((c) => c.close < neckline && c.close < c.open);
          if (breakCandle && candles.indexOf(breakCandle) >= candles.length - 6) {
            const height = Math.max(h1.price, h2.price) - neckline;
            candidates.push({
              id: `DT_${timeframe}_${h2.epoch}`,
              type: 'DOUBLE_TOP',
              label: 'Double Top',
              timeframe,
              direction: 'BEARISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: neckline,
              targetPrice: neckline - height,
              invalidationPrice: Math.max(h1.price, h2.price),
              lines: [
                {
                  startEpoch: h1.epoch,
                  startPrice: h1.price,
                  endEpoch: h2.epoch,
                  endPrice: h2.price,
                  kind: 'BOUNDARY'
                },
                {
                  startEpoch: h1.epoch,
                  startPrice: neckline,
                  endEpoch: latest.epoch,
                  endPrice: neckline,
                  kind: 'NECKLINE'
                }
              ],
              points: [
                { epoch: h1.epoch, price: h1.price },
                { epoch: trough.epoch, price: trough.price },
                { epoch: h2.epoch, price: h2.price }
              ],
              detectedEpoch: breakCandle.epoch,
              description: `Confirmed Double Top closing below neckline ${neckline.toFixed(2)}.`
            });
          }
        }
      }
    }

    if (lows.length >= 2) {
      const l2 = lows[lows.length - 1];
      const l1 = lows[lows.length - 2];
      const symDiff = Math.abs(l2.price - l1.price) / Math.max(1e-9, l1.price);
      if (l2.index - l1.index >= 4 && symDiff <= 0.0032) {
        const peak = highs.find((h) => h.index > l1.index && h.index < l2.index);
        if (peak && (peak.price - l1.price) >= effAtr * 1.1) {
          const neckline = peak.price;
          const postL2 = candles.slice(l2.index + 1);
          const breakCandle = postL2.find((c) => c.close > neckline && c.close > c.open);
          if (breakCandle && candles.indexOf(breakCandle) >= candles.length - 6) {
            const height = neckline - Math.min(l1.price, l2.price);
            candidates.push({
              id: `DB_${timeframe}_${l2.epoch}`,
              type: 'DOUBLE_BOTTOM',
              label: 'Double Bottom',
              timeframe,
              direction: 'BULLISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: neckline,
              targetPrice: neckline + height,
              invalidationPrice: Math.min(l1.price, l2.price),
              lines: [
                {
                  startEpoch: l1.epoch,
                  startPrice: l1.price,
                  endEpoch: l2.epoch,
                  endPrice: l2.price,
                  kind: 'BOUNDARY'
                },
                {
                  startEpoch: l1.epoch,
                  startPrice: neckline,
                  endEpoch: latest.epoch,
                  endPrice: neckline,
                  kind: 'NECKLINE'
                }
              ],
              points: [
                { epoch: l1.epoch, price: l1.price },
                { epoch: peak.epoch, price: peak.price },
                { epoch: l2.epoch, price: l2.price }
              ],
              detectedEpoch: breakCandle.epoch,
              description: `Confirmed Double Bottom closing above neckline ${neckline.toFixed(2)}.`
            });
          }
        }
      }
    }

    // 2. Head and Shoulders & Inverse Head and Shoulders (Neckline Close Confirmed)
    if (highs.length >= 3) {
      const h3 = highs[highs.length - 1];
      const h2 = highs[highs.length - 2];
      const h1 = highs[highs.length - 3];
      const shoulderSym = Math.abs(h1.price - h3.price) / Math.max(1e-9, h2.price);
      if (h2.price > h1.price * 1.0008 && h2.price > h3.price * 1.0008 && shoulderSym <= 0.0045) {
        const l1 = lows.find((l) => l.index > h1.index && l.index < h2.index);
        const l2 = lows.find((l) => l.index > h2.index && l.index < h3.index);
        if (l1 && l2 && l2.epoch > l1.epoch) {
          const slope = (l2.price - l1.price) / (l2.epoch - l1.epoch);
          const neckAtLatest = l1.price + slope * (latest.epoch - l1.epoch);
          const breakCandle = candles
            .slice(h3.index + 1)
            .find((c) => c.close < l1.price + slope * (c.epoch - l1.epoch));
          if (breakCandle && candles.indexOf(breakCandle) >= candles.length - 6) {
            const headHeight = h2.price - ((l1.price + l2.price) / 2);
            candidates.push({
              id: `HS_${timeframe}_${h3.epoch}`,
              type: 'HEAD_AND_SHOULDERS',
              label: 'Head & Shoulders',
              timeframe,
              direction: 'BEARISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: neckAtLatest,
              targetPrice: neckAtLatest - headHeight,
              invalidationPrice: h3.price,
              lines: [
                {
                  startEpoch: l1.epoch,
                  startPrice: l1.price,
                  endEpoch: latest.epoch,
                  endPrice: neckAtLatest,
                  kind: 'NECKLINE'
                }
              ],
              points: [h1, h2, h3].map((p) => ({ epoch: p.epoch, price: p.price })),
              detectedEpoch: breakCandle.epoch,
              description: `Head & Shoulders neckline breakdown confirmed.`
            });
          }
        }
      }
    }

    if (lows.length >= 3) {
      const l3 = lows[lows.length - 1];
      const l2 = lows[lows.length - 2];
      const l1 = lows[lows.length - 3];
      const shoulderSym = Math.abs(l1.price - l3.price) / Math.max(1e-9, l2.price);
      if (l2.price < l1.price * 0.9992 && l2.price < l3.price * 0.9992 && shoulderSym <= 0.0045) {
        const h1 = highs.find((h) => h.index > l1.index && h.index < l2.index);
        const h2 = highs.find((h) => h.index > l2.index && h.index < l3.index);
        if (h1 && h2 && h2.epoch > h1.epoch) {
          const slope = (h2.price - h1.price) / (h2.epoch - h1.epoch);
          const neckAtLatest = h1.price + slope * (latest.epoch - h1.epoch);
          const breakCandle = candles
            .slice(l3.index + 1)
            .find((c) => c.close > h1.price + slope * (c.epoch - h1.epoch));
          if (breakCandle && candles.indexOf(breakCandle) >= candles.length - 6) {
            const headHeight = ((h1.price + h2.price) / 2) - l2.price;
            candidates.push({
              id: `IHS_${timeframe}_${l3.epoch}`,
              type: 'INVERSE_HEAD_AND_SHOULDERS',
              label: 'Inverse H&S',
              timeframe,
              direction: 'BULLISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: neckAtLatest,
              targetPrice: neckAtLatest + headHeight,
              invalidationPrice: l3.price,
              lines: [
                {
                  startEpoch: h1.epoch,
                  startPrice: h1.price,
                  endEpoch: latest.epoch,
                  endPrice: neckAtLatest,
                  kind: 'NECKLINE'
                }
              ],
              points: [l1, l2, l3].map((p) => ({ epoch: p.epoch, price: p.price })),
              detectedEpoch: breakCandle.epoch,
              description: `Inverse Head & Shoulders neckline breakout confirmed.`
            });
          }
        }
      }
    }

    // 3. Triangles, Wedges, Channels, Rectangles & Broadening Formations (2+ highs & 2+ lows)
    if (highs.length >= 2 && lows.length >= 2) {
      const hA = highs[highs.length - 2];
      const hB = highs[highs.length - 1];
      const lA = lows[lows.length - 2];
      const lB = lows[lows.length - 1];

      if (hB.index > hA.index && lB.index > lA.index) {
        const upperSlope = (hB.price - hA.price) / Math.max(1, hB.epoch - hA.epoch);
        const lowerSlope = (lB.price - lA.price) / Math.max(1, lB.epoch - lA.epoch);

        const startEpoch = Math.min(hA.epoch, lA.epoch);
        const upperAtStart = hA.price + upperSlope * (startEpoch - hA.epoch);
        const lowerAtStart = lA.price + lowerSlope * (startEpoch - lA.epoch);
        const upperAtLatest = hA.price + upperSlope * (latest.epoch - hA.epoch);
        const lowerAtLatest = lA.price + lowerSlope * (latest.epoch - lA.epoch);

        const startWidth = upperAtStart - lowerAtStart;
        const endWidth = upperAtLatest - lowerAtLatest;
        const spanSec = Math.max(60, latest.epoch - startEpoch);
        const upperMovePct = Math.abs(upperAtLatest - upperAtStart) / Math.max(1e-9, hA.price);
        const lowerMovePct = Math.abs(lowerAtLatest - lowerAtStart) / Math.max(1e-9, lA.price);

        const flatThresh = 0.0014;
        const isUpperFlat = upperMovePct <= flatThresh;
        const isLowerFlat = lowerMovePct <= flatThresh;
        const isConverging = startWidth > 0 && endWidth > 0 && endWidth < startWidth * 0.78;
        const isDiverging = startWidth > 0 && endWidth > startWidth * 1.25;

        const brokeAbove = latest.close > upperAtLatest && latest.close > latest.open;
        const brokeBelow = latest.close < lowerAtLatest && latest.close < latest.open;
        const avgBody = Math.abs(latest.close - latest.open);
        const latestRange = Math.max(1e-9, latest.high - latest.low);
        const cleanClose = avgBody / latestRange >= 0.45;

        const boundaryLines: ChartPatternLine[] = [
          {
            startEpoch,
            startPrice: upperAtStart,
            endEpoch: latest.epoch,
            endPrice: upperAtLatest,
            kind: 'BOUNDARY'
          },
          {
            startEpoch,
            startPrice: lowerAtStart,
            endEpoch: latest.epoch,
            endPrice: lowerAtLatest,
            kind: 'BOUNDARY'
          }
        ];
        const pts: ChartPatternPoint[] = [hA, lA, hB, lB].map((p) => ({
          epoch: p.epoch,
          price: p.price
        }));

        if (spanSec > 0 && startWidth > effAtr * 0.8) {
          // A. Triangles (Confirmed Breakout)
          if (isUpperFlat && lowerSlope > 0 && isConverging && brokeAbove && cleanClose) {
            candidates.push({
              id: `ASCTRI_${timeframe}_${latest.epoch}`,
              type: 'ASCENDING_TRIANGLE',
              label: 'Ascending Triangle',
              timeframe,
              direction: 'BULLISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: upperAtLatest,
              targetPrice: upperAtLatest + startWidth,
              invalidationPrice: lB.price,
              lines: boundaryLines,
              points: pts,
              detectedEpoch: latest.epoch,
              description: 'Ascending Triangle confirmed with bullish breakout close.'
            });
          } else if (isLowerFlat && upperSlope < 0 && isConverging && brokeBelow && cleanClose) {
            candidates.push({
              id: `DESCTRI_${timeframe}_${latest.epoch}`,
              type: 'DESCENDING_TRIANGLE',
              label: 'Descending Triangle',
              timeframe,
              direction: 'BEARISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: lowerAtLatest,
              targetPrice: lowerAtLatest - startWidth,
              invalidationPrice: hB.price,
              lines: boundaryLines,
              points: pts,
              detectedEpoch: latest.epoch,
              description: 'Descending Triangle confirmed with bearish breakdown close.'
            });
          } else if (!isUpperFlat && !isLowerFlat && upperSlope < 0 && lowerSlope > 0 && isConverging && (brokeAbove || brokeBelow) && cleanClose) {
            candidates.push({
              id: `SYMTRI_${timeframe}_${latest.epoch}`,
              type: 'SYMMETRICAL_TRIANGLE',
              label: 'Symmetrical Triangle',
              timeframe,
              direction: brokeAbove ? 'BULLISH' : 'BEARISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: brokeAbove ? upperAtLatest : lowerAtLatest,
              targetPrice: brokeAbove ? upperAtLatest + startWidth : lowerAtLatest - startWidth,
              invalidationPrice: brokeAbove ? lB.price : hB.price,
              lines: boundaryLines,
              points: pts,
              detectedEpoch: latest.epoch,
              description: `Symmetrical Triangle confirmed with ${brokeAbove ? 'bullish' : 'bearish'} breakout close.`
            });
          }
          // B. Wedges (Confirmed Reversal/Breakout)
          else if (!isUpperFlat && !isLowerFlat && upperSlope > 0 && lowerSlope > 0 && lowerSlope > upperSlope * 1.15 && isConverging && brokeBelow && cleanClose) {
            candidates.push({
              id: `RWEDGE_${timeframe}_${latest.epoch}`,
              type: 'RISING_WEDGE',
              label: 'Rising Wedge',
              timeframe,
              direction: 'BEARISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: lowerAtLatest,
              targetPrice: lowerAtLatest - startWidth,
              invalidationPrice: hB.price,
              lines: boundaryLines,
              points: pts,
              detectedEpoch: latest.epoch,
              description: 'Rising Wedge broken to the downside by candle close.'
            });
          } else if (!isUpperFlat && !isLowerFlat && upperSlope < 0 && lowerSlope < 0 && Math.abs(upperSlope) > Math.abs(lowerSlope) * 1.15 && isConverging && brokeAbove && cleanClose) {
            candidates.push({
              id: `FWEDGE_${timeframe}_${latest.epoch}`,
              type: 'FALLING_WEDGE',
              label: 'Falling Wedge',
              timeframe,
              direction: 'BULLISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: upperAtLatest,
              targetPrice: upperAtLatest + startWidth,
              invalidationPrice: lB.price,
              lines: boundaryLines,
              points: pts,
              detectedEpoch: latest.epoch,
              description: 'Falling Wedge broken to the upside by candle close.'
            });
          }
          // C. Rectangle (Confirmed Breakout or Clean Range)
          else if (isUpperFlat && isLowerFlat && (brokeAbove || brokeBelow) && cleanClose) {
            const boxHigh = Math.max(hA.price, hB.price);
            const boxLow = Math.min(lA.price, lB.price);
            const boxH = boxHigh - boxLow;
            candidates.push({
              id: `RECT_${timeframe}_${latest.epoch}`,
              type: 'RECTANGLE',
              label: 'Rectangle Breakout',
              timeframe,
              direction: brokeAbove ? 'BULLISH' : 'BEARISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: brokeAbove ? boxHigh : boxLow,
              targetPrice: brokeAbove ? boxHigh + boxH : boxLow - boxH,
              invalidationPrice: brokeAbove ? boxLow : boxHigh,
              lines: [
                {
                  startEpoch,
                  startPrice: boxHigh,
                  endEpoch: latest.epoch,
                  endPrice: boxHigh,
                  kind: 'BOUNDARY'
                },
                {
                  startEpoch,
                  startPrice: boxLow,
                  endEpoch: latest.epoch,
                  endPrice: boxLow,
                  kind: 'BOUNDARY'
                }
              ],
              points: pts,
              detectedEpoch: latest.epoch,
              description: `Horizontal Rectangle ${brokeAbove ? 'upside' : 'downside'} breakout confirmed.`
            });
          }
          // D. Broadening Formation (Diverging boundaries + close confirmation)
          else if (upperSlope > 0 && lowerSlope < 0 && isDiverging && (brokeAbove || brokeBelow) && cleanClose) {
            candidates.push({
              id: `BROAD_${timeframe}_${latest.epoch}`,
              type: 'BROADENING_FORMATION',
              label: 'Broadening Formation',
              timeframe,
              direction: brokeAbove ? 'BULLISH' : 'BEARISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: brokeAbove ? upperAtLatest : lowerAtLatest,
              targetPrice: brokeAbove ? upperAtLatest + endWidth * 0.65 : lowerAtLatest - endWidth * 0.65,
              invalidationPrice: brokeAbove ? lB.price : hB.price,
              lines: boundaryLines,
              points: pts,
              detectedEpoch: latest.epoch,
              description: `Expanding Broadening Formation breakout confirmed.`
            });
          }
          // E. Ascending & Descending Channels (Parallel slope, boundary bounce/continuation)
          else if (!isUpperFlat && !isLowerFlat) {
            const sameSign = (upperSlope > 0 && lowerSlope > 0) || (upperSlope < 0 && lowerSlope < 0);
            const ratio = Math.min(Math.abs(upperSlope), Math.abs(lowerSlope)) / Math.max(1e-12, Math.abs(upperSlope), Math.abs(lowerSlope));
            if (sameSign && ratio >= 0.55 && !isConverging && !isDiverging) {
              const nearLowerBounce =
                upperSlope > 0 &&
                latest.low <= lowerAtLatest + effAtr * 0.45 &&
                latest.close > latest.open &&
                latest.close > lowerAtLatest;
              const nearUpperRejection =
                upperSlope < 0 &&
                latest.high >= upperAtLatest - effAtr * 0.45 &&
                latest.close < latest.open &&
                latest.close < upperAtLatest;

              if (nearLowerBounce || nearUpperRejection || brokeAbove || brokeBelow) {
                const isUpChannel = upperSlope > 0;
                const dir = nearLowerBounce || brokeAbove ? 'BULLISH' : 'BEARISH';
                candidates.push({
                  id: `CHAN_${timeframe}_${latest.epoch}`,
                  type: isUpChannel ? 'ASCENDING_CHANNEL' : 'DESCENDING_CHANNEL',
                  label: isUpChannel ? 'Ascending Channel' : 'Descending Channel',
                  timeframe,
                  direction: dir,
                  status: brokeAbove || brokeBelow ? 'CONFIRMED_BREAKOUT' : 'FORMED_AT_BOUNDARY',
                  confirmedByClose: true,
                  necklineOrBreakLevel: dir === 'BULLISH' ? lowerAtLatest : upperAtLatest,
                  targetPrice: dir === 'BULLISH' ? upperAtLatest : lowerAtLatest,
                  invalidationPrice: dir === 'BULLISH' ? lowerAtLatest - effAtr : upperAtLatest + effAtr,
                  lines: boundaryLines,
                  points: pts,
                  detectedEpoch: latest.epoch,
                  description: `${isUpChannel ? 'Ascending' : 'Descending'} Channel ${brokeAbove || brokeBelow ? 'breakout' : 'boundary reaction'} confirmed.`
                });
              }
            }
          }
        }
      }
    }

    // 4. Flags & Pennants (Sharp Pole + Controlled Retrace + Breakout Close)
    if (candles.length >= 16) {
      const consolStart = candles.length - 8;
      const poleStart = Math.max(0, consolStart - 6);
      const poleBars = candles.slice(poleStart, consolStart + 1);
      const consolBars = candles.slice(consolStart, candles.length - 1);

      if (poleBars.length >= 4 && consolBars.length >= 4) {
        const poleMove = poleBars[poleBars.length - 1].close - poleBars[0].open;
        const absPole = Math.abs(poleMove);
        if (absPole >= effAtr * 2.1) {
          const consolHigh = Math.max(...consolBars.map((c) => c.high));
          const consolLow = Math.min(...consolBars.map((c) => c.low));
          const consolSpan = consolHigh - consolLow;

          if (poleMove > 0 && consolSpan <= absPole * 0.52 && latest.close > consolHigh && latest.close > latest.open) {
            const firstHalfRange =
              Math.max(...consolBars.slice(0, Math.floor(consolBars.length / 2)).map((c) => c.high)) -
              Math.min(...consolBars.slice(0, Math.floor(consolBars.length / 2)).map((c) => c.low));
            const secondHalfRange =
              Math.max(...consolBars.slice(Math.floor(consolBars.length / 2)).map((c) => c.high)) -
              Math.min(...consolBars.slice(Math.floor(consolBars.length / 2)).map((c) => c.low));
            const isPennant = secondHalfRange < firstHalfRange * 0.72;

            candidates.push({
              id: `BFLAG_${timeframe}_${latest.epoch}`,
              type: isPennant ? 'BULL_PENNANT' : 'BULL_FLAG',
              label: isPennant ? 'Bull Pennant' : 'Bull Flag',
              timeframe,
              direction: 'BULLISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: consolHigh,
              targetPrice: latest.close + absPole * 0.85,
              invalidationPrice: consolLow,
              lines: [
                {
                  startEpoch: poleBars[0].epoch,
                  startPrice: poleBars[0].low,
                  endEpoch: poleBars[poleBars.length - 1].epoch,
                  endPrice: poleBars[poleBars.length - 1].high,
                  kind: 'POLE'
                },
                {
                  startEpoch: consolBars[0].epoch,
                  startPrice: consolHigh,
                  endEpoch: latest.epoch,
                  endPrice: consolHigh,
                  kind: 'BOUNDARY'
                },
                {
                  startEpoch: consolBars[0].epoch,
                  startPrice: consolLow,
                  endEpoch: latest.epoch,
                  endPrice: consolLow,
                  kind: 'BOUNDARY'
                }
              ],
              points: [],
              detectedEpoch: latest.epoch,
              description: `Confirmed ${isPennant ? 'Bullish Pennant' : 'Bullish Flag'} continuation breakout.`
            });
          } else if (poleMove < 0 && consolSpan <= absPole * 0.52 && latest.close < consolLow && latest.close < latest.open) {
            const firstHalfRange =
              Math.max(...consolBars.slice(0, Math.floor(consolBars.length / 2)).map((c) => c.high)) -
              Math.min(...consolBars.slice(0, Math.floor(consolBars.length / 2)).map((c) => c.low));
            const secondHalfRange =
              Math.max(...consolBars.slice(Math.floor(consolBars.length / 2)).map((c) => c.high)) -
              Math.min(...consolBars.slice(Math.floor(consolBars.length / 2)).map((c) => c.low));
            const isPennant = secondHalfRange < firstHalfRange * 0.72;

            candidates.push({
              id: `SFLAG_${timeframe}_${latest.epoch}`,
              type: isPennant ? 'BEAR_PENNANT' : 'BEAR_FLAG',
              label: isPennant ? 'Bear Pennant' : 'Bear Flag',
              timeframe,
              direction: 'BEARISH',
              status: 'CONFIRMED_BREAKOUT',
              confirmedByClose: true,
              necklineOrBreakLevel: consolLow,
              targetPrice: latest.close - absPole * 0.85,
              invalidationPrice: consolHigh,
              lines: [
                {
                  startEpoch: poleBars[0].epoch,
                  startPrice: poleBars[0].high,
                  endEpoch: poleBars[poleBars.length - 1].epoch,
                  endPrice: poleBars[poleBars.length - 1].low,
                  kind: 'POLE'
                },
                {
                  startEpoch: consolBars[0].epoch,
                  startPrice: consolHigh,
                  endEpoch: latest.epoch,
                  endPrice: consolHigh,
                  kind: 'BOUNDARY'
                },
                {
                  startEpoch: consolBars[0].epoch,
                  startPrice: consolLow,
                  endEpoch: latest.epoch,
                  endPrice: consolLow,
                  kind: 'BOUNDARY'
                }
              ],
              points: [],
              detectedEpoch: latest.epoch,
              description: `Confirmed ${isPennant ? 'Bearish Pennant' : 'Bearish Flag'} continuation breakdown.`
            });
          }
        }
      }
    }

    // Prioritize most recent confirmed pattern (avoid clutter)
    return candidates.sort((a, b) => b.detectedEpoch - a.detectedEpoch).slice(0, 2);
  }
}
