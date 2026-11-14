/**
 * Activity and scanner telemetry records.
 *
 * The scanner engines run in the browser, so the server cannot observe them
 * directly. These records are what the client reports back (and what the server
 * records itself, e.g. sign-ins). They exist so Scanner Operations, Platform
 * Analytics and System Health can show measured figures instead of "unavailable".
 *
 * Two shapes, for two different questions:
 *  - `ActivityEventRecord` — discrete, append-only events. "What happened, and
 *    when?" Used for DAU/MAU, feature usage and an audit-style trail.
 *  - `ScannerSessionRecord` — one mutable row per running scanner, keyed by a
 *    client-supplied session id. "How many scanners are running right now?"
 *    Stored keyed rather than appended so heartbeats update in place and the
 *    collection stays bounded by the number of live sessions, not by time.
 *
 * Nothing here carries trading data, account balances or credentials. Events
 * are deliberately narrow: an event kind, an optional user, a timestamp and a
 * small bag of counters. The client is untrusted, so every field is validated
 * and size-capped on ingest.
 */

/** Discrete event kinds the platform records. Kept narrow on purpose. */
export const ACTIVITY_EVENT_KINDS = [
  /** Server-observed: a trader signed in. */
  'auth.login',
  /** Server-observed: a trader signed out. */
  'auth.logout',
  /** Client-reported: a scanner run started. */
  'scan.started',
  /** Client-reported: a scanner run stopped. */
  'scan.stopped',
  /** Client-reported: one signal was produced by the engines. */
  'signal.generated',
  /** Client-reported: an engine or scanner error. */
  'engine.error',
  /** Client-reported: a settings change the user made in the scanner UI. */
  'settings.changed',
  /** Client-reported: the user opened the workspace. */
  'app.opened'
] as const;

export type ActivityEventKind = (typeof ACTIVITY_EVENT_KINDS)[number];

/** One recorded activity event. Append-only; never edited. */
export interface ActivityEventRecord {
  id: string;
  /** UTC epoch milliseconds, as recorded by the server on ingest. */
  timestamp: number;
  kind: ActivityEventKind;
  /** Trader user id (`u_...`) when the event is attributable to a signed-in user. */
  userId: string | null;
  /** Scanner session this event belongs to, when applicable. */
  sessionId: string | null;
  /** Symbol/timeframe the event concerns, when applicable. */
  symbol: string | null;
  timeframe: string | null;
  /** Small, validated numeric payload (counts only — never free text). */
  metrics: Record<string, number>;
  /** Client build/version, for correlating a regression to a release. */
  clientVersion: string | null;
}

/**
 * One running scanner. Keyed by `id` (a client-generated id), so heartbeats
 * update the same row. `lastSeenAt` is what makes "active now" meaningful;
 * stale rows are pruned.
 */
export interface ScannerSessionRecord {
  id: string;
  userId: string;
  /** Symbol list the scanner is watching, capped on ingest. */
  symbols: string[];
  timeframes: string[];
  startedAt: number;
  lastSeenAt: number;
  /** Signals this session has produced, incremented on reported signals. */
  signalCount: number;
  /** Errors this session has reported. */
  errorCount: number;
  clientVersion: string | null;
}

/** Aggregate metrics surfaced to the admin console. */
export interface ActivitySummary {
  /** Distinct users with at least one event in the last 24h. */
  dau: number;
  /** Distinct users with at least one event in the last 30 days. */
  mau: number;
  /** Scanner sessions seen in the last `SCANNER_ACTIVE_WINDOW_MS`. */
  activeScannerSessions: number;
  /** Signals reported over the last 24h. */
  signalsLast24h: number;
  /** Engine errors reported over the last 24h. */
  engineErrorsLast24h: number;
  /** When the last activity event was recorded, or null if none. */
  lastEventAt: number | null;
}

/** How recently a scanner must have been seen to count as "active now". */
export const SCANNER_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
