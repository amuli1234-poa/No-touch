import { createOpaqueId } from '../lib/pkce.js';
import type { Store } from '../store/store.js';
import {
  ACTIVITY_EVENT_KINDS,
  SCANNER_ACTIVE_WINDOW_MS,
  type ActivityEventKind,
  type ActivityEventRecord,
  type ActivitySummary,
  type ScannerSessionRecord
} from './types.js';

/**
 * Validation and aggregation for activity/scanner telemetry.
 *
 * The client is untrusted: it is the browser bundle the user controls. Every
 * field arriving from it is therefore treated as hostile input and normalised
 * here, before anything reaches the store. Only two things survive validation —
 * a known event kind and a small set of bounded primitives. Free text is never
 * stored, so the collection cannot be used to smuggle arbitrary content into
 * the admin console.
 */

/** Caps that bound one request and the resulting record. */
export const MAX_EVENTS_PER_REQUEST = 50;
export const MAX_SYMBOLS = 25;
export const MAX_TIMEFRAMES = 10;
export const MAX_METRIC_KEYS = 12;
/** Longest accepted client-supplied identifier (session id, symbol, version). */
export const MAX_ID_LEN = 64;

/** Event kinds a client may submit. Server-observed kinds are not client-writable. */
const CLIENT_KINDS = new Set<ActivityEventKind>([
  'scan.started',
  'scan.stopped',
  'signal.generated',
  'engine.error',
  'settings.changed',
  'app.opened'
]);

const KIND_SET = new Set<string>(ACTIVITY_EVENT_KINDS);

export interface RawEventInput {
  kind?: unknown;
  sessionId?: unknown;
  symbol?: unknown;
  timeframe?: unknown;
  metrics?: unknown;
  clientVersion?: unknown;
}

export interface IngestResult {
  accepted: number;
  rejected: number;
}

/** Trims a string to a bounded length, returning null when unusable. */
function boundedString(value: unknown, maxLen = MAX_ID_LEN): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return trimmed;
}

/** Keeps only finite, sane numbers, capped in count. */
function boundedMetrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_METRIC_KEYS) break;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    if (key.length === 0 || key.length > MAX_ID_LEN) continue;
    out[key] = raw;
  }
  return out;
}

/** Parses a symbol/timeframe list from either an array or a single value. */
function boundedStringList(value: unknown, max: number): string[] {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  const out: string[] = [];
  for (const item of arr) {
    const s = boundedString(item, MAX_ID_LEN);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Validates and stores a batch of client-reported events.
 *
 * Rejected events are counted, not stored — a malformed batch must not poison
 * the collection. `userId` comes from the caller's verified session, never from
 * the payload, so a client cannot attribute events to another user.
 */
export async function ingestEvents(
  store: Store,
  userId: string | null,
  rawEvents: RawEventInput[]
): Promise<IngestResult> {
  const now = Date.now();
  let accepted = 0;
  let rejected = 0;

  for (const raw of rawEvents.slice(0, MAX_EVENTS_PER_REQUEST)) {
    const kind = typeof raw.kind === 'string' ? raw.kind : '';
    if (!KIND_SET.has(kind) || !CLIENT_KINDS.has(kind as ActivityEventKind)) {
      rejected += 1;
      continue;
    }
    const sessionId = boundedString(raw.sessionId);
    const event: ActivityEventRecord = {
      id: `ae_${createOpaqueId(12)}`,
      timestamp: now,
      kind: kind as ActivityEventKind,
      userId,
      sessionId,
      symbol: boundedString(raw.symbol),
      timeframe: boundedString(raw.timeframe),
      metrics: boundedMetrics(raw.metrics),
      clientVersion: boundedString(raw.clientVersion)
    };
    await store.appendActivityEvent(event);

    // A reported signal/error also advances the scanner session it belongs to,
    // so the "active now" view reflects real work, not only explicit heartbeats.
    if (sessionId && userId && (event.kind === 'signal.generated' || event.kind === 'engine.error')) {
      await bumpScannerSessionCounters(store, sessionId, userId, event.kind, now);
    }
    accepted += 1;
  }

  return { accepted, rejected };
}

async function bumpScannerSessionCounters(
  store: Store,
  sessionId: string,
  userId: string,
  kind: ActivityEventKind,
  now: number
): Promise<void> {
  const existing = store.getScannerSession(sessionKey(userId, sessionId));
  // A counter bump for a session we have never seen is ignored: the heartbeat
  // route is what creates a session, so this cannot fabricate one.
  if (!existing) return;
  existing.lastSeenAt = now;
  if (kind === 'signal.generated') existing.signalCount += 1;
  if (kind === 'engine.error') existing.errorCount += 1;
  await store.upsertScannerSession(existing);
}

/**
 * Scanner sessions are keyed by user *and* client session id. The id is
 * client-supplied and therefore untrusted: without the user prefix, one user
 * could guess another's id and overwrite their session row.
 */
function sessionKey(userId: string, clientSessionId: string): string {
  return `${userId}:${clientSessionId}`;
}

/**
 * Records or refreshes a scanner session from a heartbeat. The session id is
 * client-supplied but namespaced to the caller's user id, so two users can
 * never collide on the same row.
 */
export async function recordHeartbeat(
  store: Store,
  userId: string,
  input: {
    sessionId?: unknown;
    symbols?: unknown;
    timeframes?: unknown;
    clientVersion?: unknown;
  }
): Promise<ScannerSessionRecord | null> {
  const sessionId = boundedString(input.sessionId);
  if (!sessionId) return null;

  const now = Date.now();
  const key = sessionKey(userId, sessionId);
  const existing = store.getScannerSession(key);
  const symbols = boundedStringList(input.symbols, MAX_SYMBOLS);
  const timeframes = boundedStringList(input.timeframes, MAX_TIMEFRAMES);

  const session: ScannerSessionRecord = existing
    ? {
        ...existing,
        symbols: symbols.length > 0 ? symbols : existing.symbols,
        timeframes: timeframes.length > 0 ? timeframes : existing.timeframes,
        lastSeenAt: now,
        clientVersion: boundedString(input.clientVersion) ?? existing.clientVersion
      }
    : {
        id: key,
        userId,
        symbols,
        timeframes,
        startedAt: now,
        lastSeenAt: now,
        signalCount: 0,
        errorCount: 0,
        clientVersion: boundedString(input.clientVersion)
      };

  await store.upsertScannerSession(session);
  return session;
}

/**
 * Records a server-observed event (sign-in, sign-out). Unlike client-reported
 * events these carry no untrusted input, so there is nothing to validate — the
 * caller has already resolved the user from a verified session.
 */
export async function recordServerEvent(
  store: Store,
  kind: Extract<ActivityEventKind, 'auth.login' | 'auth.logout'>,
  userId: string | null
): Promise<void> {
  await store.appendActivityEvent({
    id: `ae_${createOpaqueId(12)}`,
    timestamp: Date.now(),
    kind,
    userId,
    sessionId: null,
    symbol: null,
    timeframe: null,
    metrics: {},
    clientVersion: null
  });
}

/** Distinct user ids with at least one event since `sinceMs`. */
function distinctUsersSince(events: ActivityEventRecord[], sinceMs: number): number {
  const users = new Set<string>();
  for (const e of events) {
    if (e.userId && e.timestamp >= sinceMs) users.add(e.userId);
  }
  return users.size;
}

const DAY = 24 * 60 * 60 * 1000;

/** Computes the aggregate figures the admin console shows. */
export function summarise(store: Store, now = Date.now()): ActivitySummary {
  const events = store.listActivityEvents();
  const since24h = now - DAY;
  const since30d = now - 30 * DAY;

  let signalsLast24h = 0;
  let engineErrorsLast24h = 0;
  for (const e of events) {
    if (e.timestamp < since24h) continue;
    if (e.kind === 'signal.generated') signalsLast24h += 1;
    if (e.kind === 'engine.error') engineErrorsLast24h += 1;
  }

  return {
    dau: distinctUsersSince(events, since24h),
    mau: distinctUsersSince(events, since30d),
    activeScannerSessions: store.countActiveScannerSessions(SCANNER_ACTIVE_WINDOW_MS, now),
    signalsLast24h,
    engineErrorsLast24h,
    lastEventAt: events.length > 0 ? events[events.length - 1].timestamp : null
  };
}
