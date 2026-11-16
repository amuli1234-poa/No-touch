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
/**
 * Client-side request pacing. Deriv throttles `ticks_history` per connection; a burst of
 * history requests (one per market) trips the limit, so history requests are released
 * through a sliding window rather than a fixed interval.
 */
export const WS_MIN_REQUEST_INTERVAL_MS = 120;
/** How long to back off after the server reports a rate-limit error (ms). */
export const WS_RATE_LIMIT_BACKOFF_MS = 5000;
/** Max requests allowed in flight at once (correlated by req_id). */
export const WS_MAX_IN_FLIGHT = 4;
/**
 * Sliding-window budget for `ticks_history` requests. Measured against the live public
 * endpoint: a burst of 80 requests returns exactly 50 successful responses before the
 * server answers `RateLimit`, and the budget recovers ~25s later. The window is therefore
 * sized below the measured ceiling (40 per 25s) so a full multi-market sweep never trips it.
 */
export const WS_HISTORY_WINDOW_MS = 25_000;
export const WS_HISTORY_MAX_PER_WINDOW = 40;
/**
 * How long a fetched candle series stays servable without a new request. Every AI module,
 * the scanner, the analyser and the health centre read the SAME series per
 * symbol+granularity, so a warm cache collapses a full sweep to near-zero history requests.
 * 60s keeps the data well inside the scanner's own staleness gate (>=300s for M1) while
 * letting ten staggered module passes share one round of fetches.
 */
export const WS_CANDLE_CACHE_TTL_MS = 60_000;
/** Hard cap on how long a single history request may occupy the queue before it is dropped. */
export const WS_HISTORY_QUEUE_TIMEOUT_MS = 90_000;

export const TIMEFRAMES: readonly TimeframeConfig[] = [
  { key: 'H4', label: 'H4', granularitySec: 14400, sourceGranularitySec: 14400, derived: false },
  { key: 'H1', label: 'H1', granularitySec: 3600, sourceGranularitySec: 3600, derived: false },
  { key: 'M30', label: 'M30', granularitySec: 1800, sourceGranularitySec: 900, derived: true },
  { key: 'M15', label: 'M15', granularitySec: 900, sourceGranularitySec: 900, derived: false },
  { key: 'M10', label: 'M10', granularitySec: 600, sourceGranularitySec: 300, derived: true },
  // M7 is NOT a Deriv native granularity — it is built internally from M1 (60s) candles.
  { key: 'M7', label: 'M7', granularitySec: 420, sourceGranularitySec: 60, derived: true },
  { key: 'M6', label: 'M6', granularitySec: 360, sourceGranularitySec: 180, derived: true },
  { key: 'M5', label: 'M5', granularitySec: 300, sourceGranularitySec: 300, derived: false },
  { key: 'M4', label: 'M4', granularitySec: 240, sourceGranularitySec: 60, derived: true },
  // M3 is a genuine Deriv granularity (180s), requested natively.
  { key: 'M3', label: 'M3', granularitySec: 180, sourceGranularitySec: 180, derived: false },
  { key: 'M2', label: 'M2', granularitySec: 120, sourceGranularitySec: 60, derived: true },
  { key: 'M1', label: 'M1', granularitySec: 60, sourceGranularitySec: 60, derived: false },
] as const;

export const TIMEFRAME_MAP: Record<TimeframeKey, TimeframeConfig> = {
  H4: TIMEFRAMES[0],
  H1: TIMEFRAMES[1],
  M30: TIMEFRAMES[2],
  M15: TIMEFRAMES[3],
  M10: TIMEFRAMES[4],
  M7: TIMEFRAMES[5],
  M6: TIMEFRAMES[6],
  M5: TIMEFRAMES[7],
  M4: TIMEFRAMES[8],
  M3: TIMEFRAMES[9],
  M2: TIMEFRAMES[10],
  M1: TIMEFRAMES[11],
};

/**
 * Timeframes that Deriv does not serve natively, mapped to the native granularity they are
 * built from. The service aggregates these internally so every caller can request a logical
 * granularity and receive genuine candles.
 */
export const DERIVED_GRANULARITY_SOURCE: Record<number, number> = {
  1800: 900,
  600: 300,
  420: 60,
  360: 180,
  240: 60,
  120: 60,
};

/** Max native candles requested when building a derived series (Deriv caps at 5000). */
export const DERIVED_SOURCE_MAX_COUNT = 5000;

/**
 * THE TEN ANALYSIS TIMEFRAMES every strategy AI reads, in top-down hierarchy order. Each AI
 * keeps its own strategy rules but may read all ten:
 *  - M30/M15  major trend, external structure, directional bias
 *  - M10/M7/M6 intermediate structure and setup development
 *  - M5       primary execution and confirmation (the mandatory final entry timeframe)
 *  - M4/M3/M2/M1 supporting structure, rejection and entry refinement
 */
export const AI_TIMEFRAME_KEYS: readonly TimeframeKey[] = [
  'M30',
  'M15',
  'M10',
  'M7',
  'M6',
  'M5',
  'M4',
  'M3',
  'M2',
  'M1',
];

/** The single mandatory execution / entry-confirmation timeframe. */
export const EXECUTION_TIMEFRAME: TimeframeKey = 'M5';

/** The five top-down roles of the ten-timeframe ladder (single source of truth for the UI). */
export type TimeframeRole = 'MAJOR' | 'INTERMEDIATE' | 'EXECUTION' | 'REFINEMENT';

/** Human description of each timeframe's role in the top-down ladder. */
export const TIMEFRAME_ROLES: Partial<Record<TimeframeKey, string>> = {
  M30: 'Major trend & external structure',
  M15: 'Major trend & directional bias',
  M10: 'Intermediate structure',
  M7: 'Intermediate setup development',
  M6: 'Intermediate setup development',
  M5: 'Primary execution & confirmation',
  M4: 'Supporting structure',
  M3: 'Rejection & refinement',
  M2: 'Entry refinement',
  M1: 'Precise entry execution',
};

/** The role each timeframe plays in the top-down ladder. */
export const TIMEFRAME_ROLE_BY_KEY: Partial<Record<TimeframeKey, TimeframeRole>> = {
  M30: 'MAJOR',
  M15: 'MAJOR',
  M10: 'INTERMEDIATE',
  M7: 'INTERMEDIATE',
  M6: 'INTERMEDIATE',
  M5: 'EXECUTION',
  M4: 'REFINEMENT',
  M3: 'REFINEMENT',
  M2: 'REFINEMENT',
  M1: 'REFINEMENT',
};
