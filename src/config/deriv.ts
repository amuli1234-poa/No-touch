import type { TimeframeConfig, TimeframeKey } from '../types/market';

export const DERIV_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

export const DEFAULT_SYMBOL = 'R_100';
export const DEFAULT_TIMEFRAME: TimeframeKey = 'M5';

export const INITIAL_CANDLE_COUNT = 500;
export const HISTORY_PAGE_COUNT = 300;
export const WS_REQUEST_TIMEOUT_MS = 15000;
export const WS_PING_INTERVAL_MS = 25000;
export const WS_HEALTH_TIMEOUT_MS = 10000;
export const WS_MAX_RECONNECT_DELAY_MS = 16000;
/** Hard cap on consecutive automatic reconnection attempts before surfacing an error. */
export const WS_MAX_RECONNECT_ATTEMPTS = 8;
/** A live tick older than this (ms) means the feed is stale and signals must be withheld. */
export const WS_STALE_TICK_MS = 20000;

export const TIMEFRAMES: readonly TimeframeConfig[] = [
  { key: 'H4', label: 'H4', granularitySec: 14400 },
  { key: 'H1', label: 'H1', granularitySec: 3600 },
  { key: 'M15', label: 'M15', granularitySec: 900 },
  { key: 'M5', label: 'M5', granularitySec: 300 },
  { key: 'M1', label: 'M1', granularitySec: 60 },
] as const;

export const TIMEFRAME_MAP: Record<TimeframeKey, TimeframeConfig> = {
  H4: TIMEFRAMES[0],
  H1: TIMEFRAMES[1],
  M15: TIMEFRAMES[2],
  M5: TIMEFRAMES[3],
  M1: TIMEFRAMES[4],
};
