import { Candle, TechnicalIndicatorsSnapshot, TrendDirection } from '../types/scanner';

export class TechnicalIndicatorsEngine {
  public static computeEmaSeries(values: number[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    if (values.length < period) return result;

    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    let prevEma = sum / period;
    result[period - 1] = prevEma;

    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      prevEma = values[i] * k + prevEma * (1 - k);
      result[i] = prevEma;
    }
    return result;
  }

  public static computeRsiSeries(candles: Candle[], period: number = 14): (number | null)[] {
    const result: (number | null)[] = new Array(candles.length).fill(null);
    if (candles.length <= period) return result;

    let gainSum = 0;
    let lossSum = 0;
    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) gainSum += diff;
      else lossSum += Math.abs(diff);
    }

    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < candles.length; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    return result;
  }

  public static computeAtrSeries(candles: Candle[], period: number = 14): (number | null)[] {
    const result: (number | null)[] = new Array(candles.length).fill(null);
    if (candles.length <= period) return result;

    const trs: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = candles[i - 1].close;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      );
      trs.push(tr);
    }

    let atr = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
    result[period] = atr;

    for (let i = period + 1; i < candles.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      result[i] = atr;
    }

    return result;
  }

  public static computeAdxSeries(
    candles: Candle[],
    period: number = 14
  ): { adx: (number | null)[]; plusDi: (number | null)[]; minusDi: (number | null)[] } {
    const len = candles.length;
    const adx: (number | null)[] = new Array(len).fill(null);
    const plusDi: (number | null)[] = new Array(len).fill(null);
    const minusDi: (number | null)[] = new Array(len).fill(null);

    if (len < period * 2 + 1) {
      return { adx, plusDi, minusDi };
    }

    const tr: number[] = new Array(len).fill(0);
    const dmPlus: number[] = new Array(len).fill(0);
    const dmMinus: number[] = new Array(len).fill(0);

    for (let i = 1; i < len; i++) {
      const upMove = candles[i].high - candles[i - 1].high;
      const downMove = candles[i - 1].low - candles[i].low;
      dmPlus[i] = upMove > downMove && upMove > 0 ? upMove : 0;
      dmMinus[i] = downMove > upMove && downMove > 0 ? downMove : 0;
      tr[i] = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
    }

    let smoothTr = 0;
    let smoothPlus = 0;
    let smoothMinus = 0;
    for (let i = 1; i <= period; i++) {
      smoothTr += tr[i];
      smoothPlus += dmPlus[i];
      smoothMinus += dmMinus[i];
    }

    const dxList: number[] = new Array(len).fill(0);

    for (let i = period; i < len; i++) {
      if (i > period) {
        smoothTr = smoothTr - smoothTr / period + tr[i];
        smoothPlus = smoothPlus - smoothPlus / period + dmPlus[i];
        smoothMinus = smoothMinus - smoothMinus / period + dmMinus[i];
      }

      const pDi = smoothTr > 0 ? (smoothPlus / smoothTr) * 100 : 0;
      const mDi = smoothTr > 0 ? (smoothMinus / smoothTr) * 100 : 0;
      plusDi[i] = pDi;
      minusDi[i] = mDi;

      const diSum = pDi + mDi;
      dxList[i] = diSum > 0 ? (Math.abs(pDi - mDi) / diSum) * 100 : 0;
    }

    let adxVal = 0;
    const startAdx = period * 2 - 1;
    if (startAdx < len) {
      let dxSum = 0;
      for (let i = period; i <= startAdx; i++) {
        dxSum += dxList[i];
      }
      adxVal = dxSum / period;
      adx[startAdx] = adxVal;

      for (let i = startAdx + 1; i < len; i++) {
        adxVal = (adxVal * (period - 1) + dxList[i]) / period;
        adx[i] = adxVal;
      }
    }

    return { adx, plusDi, minusDi };
  }

  public static computeBollingerSeries(
    candles: Candle[],
    period: number = 20,
    stdMult: number = 2
  ): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
    const len = candles.length;
    const upper: (number | null)[] = new Array(len).fill(null);
    const middle: (number | null)[] = new Array(len).fill(null);
    const lower: (number | null)[] = new Array(len).fill(null);

    if (len < period) return { upper, middle, lower };

    for (let i = period - 1; i < len; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += candles[j].close;
      }
      const mean = sum / period;
      let sqDiff = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = candles[j].close - mean;
        sqDiff += d * d;
      }
      const stdDev = Math.sqrt(sqDiff / period);
      middle[i] = mean;
      upper[i] = mean + stdMult * stdDev;
      lower[i] = mean - stdMult * stdDev;
    }

    return { upper, middle, lower };
  }

  public static computeMacdSeries(
    closes: number[],
    fast: number = 12,
    slow: number = 26,
    signalPeriod: number = 9
  ): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
    const len = closes.length;
    const macd: (number | null)[] = new Array(len).fill(null);
    const signal: (number | null)[] = new Array(len).fill(null);
    const histogram: (number | null)[] = new Array(len).fill(null);

    if (len < slow) return { macd, signal, histogram };

    const emaFast = this.computeEmaSeries(closes, fast);
    const emaSlow = this.computeEmaSeries(closes, slow);

    const validMacd: number[] = [];
    const validIndices: number[] = [];
    for (let i = 0; i < len; i++) {
      const f = emaFast[i];
      const s = emaSlow[i];
      if (f !== null && s !== null) {
        const m = f - s;
        macd[i] = m;
        validMacd.push(m);
        validIndices.push(i);
      }
    }

    const sigSeries = this.computeEmaSeries(validMacd, signalPeriod);
    for (let k = 0; k < validIndices.length; k++) {
      const idx = validIndices[k];
      const sig = sigSeries[k];
      const m = macd[idx];
      if (sig !== null && m !== null) {
        signal[idx] = sig;
        histogram[idx] = m - sig;
      }
    }

    return { macd, signal, histogram };
  }

  public static evaluateSnapshot(
    candles: Candle[],
    candidateDirection: TrendDirection
  ): TechnicalIndicatorsSnapshot {
    if (candles.length < 22) {
      const lastClose = candles[candles.length - 1]?.close || 0;
      return {
        rsi14: 50,
        rsiState: 'NEUTRAL',
        adx14: 18,
        plusDi: 20,
        minusDi: 20,
        adxRegime: 'WEAK_RANGING',
        ema20: lastClose,
        ema50: lastClose,
        emaBias: 'NEUTRAL',
        macdLine: 0,
        macdSignal: 0,
        macdHistogram: 0,
        macdBias: 'NEUTRAL',
        bbUpper: lastClose,
        bbMiddle: lastClose,
        bbLower: lastClose,
        bbPosition: 'MID_ZONE',
        atr14: 0,
        technicalVerdict: 'NEUTRAL',
        confirmationNotes: ['Insufficient candle history for full indicator confirmation.']
      };
    }

    const closes = candles.map((c) => c.close);
    const latestClose = closes[closes.length - 1];

    const rsiSeries = this.computeRsiSeries(candles, 14);
    const rsi14 = rsiSeries[rsiSeries.length - 1] ?? 50;

    const { adx, plusDi, minusDi } = this.computeAdxSeries(candles, 14);
    const adx14 = adx[adx.length - 1] ?? 18;
    const pDi = plusDi[plusDi.length - 1] ?? 20;
    const mDi = minusDi[minusDi.length - 1] ?? 20;

    const ema20Arr = this.computeEmaSeries(closes, 20);
    const ema50Arr = this.computeEmaSeries(closes, Math.min(50, closes.length));
    const ema20 = ema20Arr[ema20Arr.length - 1] ?? latestClose;
    const ema50 = ema50Arr[ema50Arr.length - 1] ?? ema20;

    const macdData = this.computeMacdSeries(closes, 12, 26, 9);
    const macdLine = macdData.macd[macdData.macd.length - 1] ?? 0;
    const macdSignal = macdData.signal[macdData.signal.length - 1] ?? 0;
    const macdHistogram = macdData.histogram[macdData.histogram.length - 1] ?? 0;
    const macdEps = Math.max(1e-6, Math.abs(macdLine) * 0.02);
    const macdBias: TrendDirection =
      (macdLine > 0 && macdHistogram >= -macdEps) || (macdHistogram > 0 && macdLine > macdSignal)
        ? 'BULLISH'
        : (macdLine < 0 && macdHistogram <= macdEps) || (macdHistogram < 0 && macdLine < macdSignal)
        ? 'BEARISH'
        : 'NEUTRAL';

    const bb = this.computeBollingerSeries(candles, 20, 2);
    const bbUpper = bb.upper[bb.upper.length - 1] ?? latestClose;
    const bbMiddle = bb.middle[bb.middle.length - 1] ?? latestClose;
    const bbLower = bb.lower[bb.lower.length - 1] ?? latestClose;

    const atrArr = this.computeAtrSeries(candles, 14);
    const atr14 = atrArr[atrArr.length - 1] ?? 0;

    const rsiState: TechnicalIndicatorsSnapshot['rsiState'] =
      rsi14 >= 70
        ? 'OVERBOUGHT'
        : rsi14 <= 30
        ? 'OVERSOLD'
        : rsi14 >= 53
        ? 'BULLISH'
        : rsi14 <= 47
        ? 'BEARISH'
        : 'NEUTRAL';

    const adxRegime: TechnicalIndicatorsSnapshot['adxRegime'] =
      adx14 >= 28 ? 'STRONG_TREND' : adx14 >= 20 ? 'TRENDING' : 'WEAK_RANGING';

    const emaBias: TrendDirection =
      ema20 > ema50 && latestClose >= ema20
        ? 'BULLISH'
        : ema20 < ema50 && latestClose <= ema20
        ? 'BEARISH'
        : 'NEUTRAL';

    const bbPosition: TechnicalIndicatorsSnapshot['bbPosition'] =
      latestClose >= bbUpper - (bbUpper - bbMiddle) * 0.25
        ? 'UPPER_BAND'
        : latestClose <= bbLower + (bbMiddle - bbLower) * 0.25
        ? 'LOWER_BAND'
        : 'MID_ZONE';

    const notes: string[] = [];
    let bullVotes = 0;
    let bearVotes = 0;

    if (rsi14 >= 52 && rsi14 < 74) {
      bullVotes++;
      notes.push(`RSI(14) at ${rsi14.toFixed(1)} supports bullish momentum without exhaustion.`);
    } else if (rsi14 <= 48 && rsi14 > 26) {
      bearVotes++;
      notes.push(`RSI(14) at ${rsi14.toFixed(1)} supports bearish momentum without exhaustion.`);
    } else if (rsi14 >= 74) {
      notes.push(`RSI(14) overbought (${rsi14.toFixed(1)}) — caution chasing longs.`);
    } else if (rsi14 <= 26) {
      notes.push(`RSI(14) oversold (${rsi14.toFixed(1)}) — caution chasing shorts.`);
    }

    if (adx14 >= 20) {
      if (pDi > mDi) {
        bullVotes++;
        notes.push(`ADX(14) ${adx14.toFixed(1)} confirms trend strength (+DI ${pDi.toFixed(1)} > -DI ${mDi.toFixed(1)}).`);
      } else {
        bearVotes++;
        notes.push(`ADX(14) ${adx14.toFixed(1)} confirms trend strength (-DI ${mDi.toFixed(1)} > +DI ${pDi.toFixed(1)}).`);
      }
    } else {
      notes.push(`ADX(14) low at ${adx14.toFixed(1)} (weak / ranging expansion).`);
    }

    if (emaBias === 'BULLISH') {
      bullVotes++;
      notes.push(`Price & EMA20 (${ema20.toFixed(2)}) aligned above EMA50 (${ema50.toFixed(2)}).`);
    } else if (emaBias === 'BEARISH') {
      bearVotes++;
      notes.push(`Price & EMA20 (${ema20.toFixed(2)}) aligned below EMA50 (${ema50.toFixed(2)}).`);
    }

    if (macdBias === 'BULLISH') {
      bullVotes++;
      notes.push(`MACD histogram bullish (+${macdHistogram.toFixed(3)}).`);
    } else if (macdBias === 'BEARISH') {
      bearVotes++;
      notes.push(`MACD histogram bearish (${macdHistogram.toFixed(3)}).`);
    }

    if (candidateDirection === 'BULLISH' && latestClose > bbMiddle) {
      notes.push('Price holding above Bollinger 20SMA basis.');
    } else if (candidateDirection === 'BEARISH' && latestClose < bbMiddle) {
      notes.push('Price holding below Bollinger 20SMA basis.');
    }

    const technicalVerdict: TrendDirection =
      bullVotes >= 2 && bullVotes > bearVotes
        ? 'BULLISH'
        : bearVotes >= 2 && bearVotes > bullVotes
        ? 'BEARISH'
        : 'NEUTRAL';

    return {
      rsi14,
      rsiState,
      adx14,
      plusDi: pDi,
      minusDi: mDi,
      adxRegime,
      ema20,
      ema50,
      emaBias,
      macdLine,
      macdSignal,
      macdHistogram,
      macdBias,
      bbUpper,
      bbMiddle,
      bbLower,
      bbPosition,
      atr14,
      technicalVerdict,
      confirmationNotes: notes
    };
  }
}
