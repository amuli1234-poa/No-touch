import type {
  Candle,
  CrosshairReadout,
  MarketFamily,
  SyntheticMarket,
} from '../types/market';

interface RawActiveSymbol {
  symbol?: unknown;
  underlying_symbol?: unknown;
  display_name?: unknown;
  underlying_symbol_name?: unknown;
  market?: unknown;
  subgroup?: unknown;
  submarket?: unknown;
  submarket_display_name?: unknown;
  symbol_type?: unknown;
  underlying_symbol_type?: unknown;
  pip?: unknown;
  pip_size?: unknown;
  exchange_is_open?: unknown;
  is_trading_suspended?: unknown;
}

interface RawCandle {
  epoch?: unknown;
  open_time?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
}

interface RawOhlc {
  symbol?: unknown;
  granularity?: unknown;
  epoch?: unknown;
  open_time?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
}

const SUBMARKET_SORT_ORDER: Record<string, number> = {
  random_index: 1,
  jump_index: 2,
  step_index: 3,
  random_daily: 4,
  crash_index: 5,
  range_index: 6,
  range_break: 6,
  forex_basket: 7,
  commodity_basket: 8,
};

const SUBMARKET_LABELS: Record<string, string> = {
  random_index: 'Volatility Indices',
  random_daily: 'Daily Reset Indices',
  crash_index: 'Crash/Boom Indices',
  jump_index: 'Jump Indices',
  step_index: 'Step Indices',
  range_index: 'Range Break Indices',
  range_break: 'Range Break Indices',
  forex_basket: 'Forex Basket Indices',
  commodity_basket: 'Commodity Basket Indices',
};

export function classifyMarketFamily(
  symbol: string,
  submarket: string,
  displayName: string
): MarketFamily {
  const sym = symbol.toUpperCase();
  const sub = submarket.toLowerCase();
  const name = displayName.toUpperCase();

  if (sub === 'jump_index' || sym.startsWith('JD') || name.includes('JUMP')) {
    return 'JUMP';
  }
  if (
    sub === 'step_index' ||
    sym.includes('STP') ||
    name.includes('STEP')
  ) {
    return 'STEP';
  }
  if (
    sub === 'range_index' ||
    sub === 'range_break' ||
    sym.startsWith('RB') ||
    name.includes('RANGE BREAK')
  ) {
    return 'RANGE_BREAK';
  }
  if (
    sub === 'random_index' ||
    sym.startsWith('R_') ||
    sym.startsWith('1HZ') ||
    name.includes('VOLATILITY')
  ) {
    return 'VOLATILITY';
  }
  return 'OTHER';
}


function countDecimalsFromStep(numericStep: number): number {
  if (!Number.isFinite(numericStep) || numericStep <= 0) {
    return 2;
  }
  if (numericStep >= 1) {
    return 0;
  }

  const str = numericStep.toString();
  if (str.includes('e-')) {
    const exp = Number(str.split('e-')[1]);
    if (Number.isInteger(exp) && exp >= 0 && exp <= 8) {
      return exp;
    }
  }

  const dotIndex = str.indexOf('.');
  if (dotIndex === -1) {
    return 2;
  }
  return Math.min(8, Math.max(0, str.length - dotIndex - 1));
}

export function computePrecisionFromPip(pip?: unknown, pipSize?: unknown): number {
  // In the current Deriv public API, active_symbols provides pip_size as a float step (e.g. 0.01, 0.0001, 0.00001, 0.1).
  // In candles/ohlc payloads, pip_size may be an integer decimal count (e.g. 2, 3, 4).
  const numericPipSize =
    typeof pipSize === 'number'
      ? pipSize
      : typeof pipSize === 'string' && pipSize.trim() !== ''
        ? Number(pipSize)
        : NaN;

  if (Number.isFinite(numericPipSize) && numericPipSize > 0) {
    if (numericPipSize < 1) {
      return countDecimalsFromStep(numericPipSize);
    }
    if (Number.isInteger(numericPipSize) && numericPipSize <= 8) {
      return numericPipSize;
    }
  }

  const numericPip =
    typeof pip === 'number'
      ? pip
      : typeof pip === 'string' && pip.trim() !== ''
        ? Number(pip)
        : NaN;

  if (Number.isFinite(numericPip) && numericPip > 0) {
    return countDecimalsFromStep(numericPip);
  }

  return 2;
}

export function isSyntheticSymbolRecord(raw: RawActiveSymbol): boolean {
  const market = typeof raw.market === 'string' ? raw.market : '';
  const subgroup = typeof raw.subgroup === 'string' ? raw.subgroup : '';
  const symbolType = typeof raw.symbol_type === 'string' ? raw.symbol_type : '';
  const submarket = typeof raw.submarket === 'string' ? raw.submarket : '';

  if (market === 'synthetic_index' || market === 'synthetic') {
    return true;
  }
  if (subgroup === 'synthetics') {
    return true;
  }
  if (symbolType === 'synthetic_index') {
    return true;
  }
  return submarket in SUBMARKET_SORT_ORDER;
}

export function parseActiveSymbols(rawSymbols: unknown): SyntheticMarket[] {
  if (!Array.isArray(rawSymbols)) {
    return [];
  }

  const seen = new Set<string>();
  const markets: SyntheticMarket[] = [];

  for (const entry of rawSymbols) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as RawActiveSymbol;
    if (!isSyntheticSymbolRecord(raw)) continue;

    const symbol =
      typeof raw.symbol === 'string'
        ? raw.symbol
        : typeof raw.underlying_symbol === 'string'
          ? raw.underlying_symbol
          : '';
    if (!symbol || seen.has(symbol)) continue;

    const displayName =
      typeof raw.display_name === 'string'
        ? raw.display_name
        : typeof raw.underlying_symbol_name === 'string'
          ? raw.underlying_symbol_name
          : symbol;

    const submarket = typeof raw.submarket === 'string' ? raw.submarket : 'synthetic';
    const submarketDisplayName =
      typeof raw.submarket_display_name === 'string' && raw.submarket_display_name.trim()
        ? raw.submarket_display_name
        : SUBMARKET_LABELS[submarket] ?? 'Synthetic Indices';
    const family = classifyMarketFamily(symbol, submarket, displayName);

    const precision = computePrecisionFromPip(raw.pip, raw.pip_size);
    const rawNumericPip =
      typeof raw.pip === 'number' && Number.isFinite(raw.pip) && raw.pip > 0
        ? raw.pip
        : typeof raw.pip_size === 'number' && Number.isFinite(raw.pip_size) && raw.pip_size > 0 && raw.pip_size < 1
          ? raw.pip_size
          : Math.pow(10, -precision);

    const isOpen = raw.exchange_is_open === undefined ? true : Boolean(Number(raw.exchange_is_open));
    const isSuspended = Boolean(Number(raw.is_trading_suspended ?? 0));

    if (isSuspended) continue;

    seen.add(symbol);
    markets.push({
      symbol,
      displayName,
      submarket,
      submarketDisplayName,
      family,
      pip: rawNumericPip,
      precision,
      isOpen,
      isSuspended,
    });
  }

  return markets.sort((a, b) => {
    const orderA = SUBMARKET_SORT_ORDER[a.submarket] ?? 99;
    const orderB = SUBMARKET_SORT_ORDER[b.submarket] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return a.displayName.localeCompare(b.displayName, undefined, { numeric: true });
  });
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function parseHistoricalCandles(rawCandles: unknown): Candle[] {
  if (!Array.isArray(rawCandles)) {
    return [];
  }

  const byTime = new Map<number, Candle>();

  for (const item of rawCandles) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as RawCandle;
    const time = toFiniteNumber(raw.open_time ?? raw.epoch);
    const open = toFiniteNumber(raw.open);
    const high = toFiniteNumber(raw.high);
    const low = toFiniteNumber(raw.low);
    const close = toFiniteNumber(raw.close);

    if (time === null || open === null || high === null || low === null || close === null) {
      continue;
    }

    byTime.set(Math.floor(time), {
      time: Math.floor(time),
      open,
      high,
      low,
      close,
    });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function parseOhlcUpdate(
  rawOhlc: unknown,
  fallbackGranularitySec: number
): { symbol: string; granularity: number; candle: Candle } | null {
  if (!rawOhlc || typeof rawOhlc !== 'object') {
    return null;
  }

  const raw = rawOhlc as RawOhlc;
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : '';
  const granularityNum = toFiniteNumber(raw.granularity) ?? fallbackGranularitySec;
  const open = toFiniteNumber(raw.open);
  const high = toFiniteNumber(raw.high);
  const low = toFiniteNumber(raw.low);
  const close = toFiniteNumber(raw.close);
  const openTime = toFiniteNumber(raw.open_time);
  const epoch = toFiniteNumber(raw.epoch);

  if (!symbol || open === null || high === null || low === null || close === null) {
    return null;
  }

  let candleTime: number | null = null;
  if (openTime !== null) {
    candleTime = Math.floor(openTime);
  } else if (epoch !== null && granularityNum > 0) {
    candleTime = Math.floor(epoch / granularityNum) * granularityNum;
  }

  if (candleTime === null) {
    return null;
  }

  return {
    symbol,
    granularity: granularityNum,
    candle: {
      time: candleTime,
      open,
      high,
      low,
      close,
    },
  };
}

interface RawTick {
  symbol?: unknown;
  epoch?: unknown;
  quote?: unknown;
}

export function parseTick(
  rawTick: unknown
): { symbol: string; epochSec: number; quote: number } | null {
  if (!rawTick || typeof rawTick !== 'object') return null;
  const raw = rawTick as RawTick;
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : '';
  const epoch = toFiniteNumber(raw.epoch);
  const quote = toFiniteNumber(raw.quote);
  if (!symbol || epoch === null || quote === null) return null;
  return { symbol, epochSec: Math.floor(epoch), quote };
}

export function mergeCandleUpdate(candles: readonly Candle[], incoming: Candle): Candle[] {
  if (candles.length === 0) {
    return [incoming];
  }

  const last = candles[candles.length - 1];
  if (incoming.time === last.time) {
    const next = candles.slice();
    next[next.length - 1] = incoming;
    return next;
  }

  if (incoming.time > last.time) {
    return [...candles, incoming];
  }

  return candles as Candle[];
}

/** True when two candles are visually identical (same bucket and OHLC values). */
export function candleEquals(a: Candle, b: Candle): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close
  );
}

/**
 * Folds a single live tick into the forming OHLC candle for a given granularity.
 *
 * The tick is bucketed to the start of its candle (epoch aligned to `granularitySec`).
 * The resulting candle is monotonic: an update can only widen the high/low and move the
 * close, so out-of-order or duplicate ticks can never corrupt the series. A tick that
 * falls before the newest candle is ignored.
 */
export function foldTickIntoCandle(
  candles: readonly Candle[],
  granularitySec: number,
  tick: { epochSec: number; quote: number }
): Candle[] {
  if (!Number.isFinite(granularitySec) || granularitySec <= 0) return candles as Candle[];
  if (!Number.isFinite(tick.epochSec) || !Number.isFinite(tick.quote)) return candles as Candle[];

  const bucketTime = Math.floor(tick.epochSec / granularitySec) * granularitySec;
  const price = tick.quote;
  const last = candles.length > 0 ? candles[candles.length - 1] : null;

  if (!last || bucketTime > last.time) {
    return [
      ...candles,
      { time: bucketTime, open: price, high: price, low: price, close: price },
    ];
  }

  if (bucketTime === last.time) {
    const next = candles.slice();
    next[next.length - 1] = {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    };
    return next;
  }

  return candles as Candle[];
}

export function prependHistoricalCandles(
  existing: readonly Candle[],
  older: readonly Candle[]
): Candle[] {
  if (older.length === 0) return existing as Candle[];
  const byTime = new Map<number, Candle>();
  for (const c of older) {
    byTime.set(c.time, c);
  }
  for (const c of existing) {
    byTime.set(c.time, c);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function buildCrosshairReadout(
  candle: Candle,
  isLiveBar: boolean
): CrosshairReadout {
  const change = candle.close - candle.open;
  const changePercent = candle.open !== 0 ? (change / candle.open) * 100 : 0;
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    change,
    changePercent,
    isLiveBar,
  };
}

export function formatPrice(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '—';
  const clamped = Math.min(8, Math.max(0, precision));
  return value.toFixed(clamped);
}

export function formatSignedDelta(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatPrice(value, precision)}`;
}

export function formatCandleTime(epochSec: number): string {
  if (!Number.isFinite(epochSec)) return '—';
  const date = new Date(epochSec * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}
