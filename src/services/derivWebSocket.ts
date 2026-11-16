import {
  DERIV_WS_URL,
  DERIVED_GRANULARITY_SOURCE,
  DERIVED_SOURCE_MAX_COUNT,
  WS_CANDLE_CACHE_TTL_MS,
  WS_HEALTH_TIMEOUT_MS,
  WS_HISTORY_MAX_PER_WINDOW,
  WS_HISTORY_QUEUE_TIMEOUT_MS,
  WS_HISTORY_WINDOW_MS,
  WS_MAX_IN_FLIGHT,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_MIN_REQUEST_INTERVAL_MS,
  WS_PING_INTERVAL_MS,
  WS_REQUEST_TIMEOUT_MS,
  WS_STALE_TICK_MS,
} from '../config/deriv';
import type {
  Candle,
  ConnectionStatus,
  DerivErrorInfo,
  SyntheticMarket,
} from '../types/market';
import {
  candleEquals,
  parseActiveSymbols,
  parseHistoricalCandles,
  parseOhlcUpdate,
  parseTick,
} from '../utils/derivParser';
import {
  confirmedDerivedCandles,
  aggregateCandles,
  foldDerivedCandle,
} from '../utils/timeframeCandles';
import {
  isRateLimitError,
  nextReconnectDelay,
  nextSendDelayMs,
  rateLimitBackoffMs,
  SlidingWindowLimiter,
} from '../utils/connectionPacing';

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A request waiting for a send slot in the pacing queue. */
interface PendingQueueItem {
  payload: Record<string, unknown>;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  /** Epoch ms after which the queued request is abandoned (history only). */
  deadlineAt?: number;
  /** Foreground requests (health diagnostics) jump ahead of background sweeps. */
  priority?: boolean;
}

/** A cached candle series for one symbol+granularity. */
interface CandleCacheEntry {
  candles: Candle[];
  /** Epoch ms the series was fetched (used for the TTL). */
  at: number;
}

export interface OhlcStreamEvent {
  symbol: string;
  granularity: number;
  candle: Candle;
}

export interface TickStreamEvent {
  symbol: string;
  epochSec: number;
  quote: number;
}

export interface CandleSnapshotEvent {
  symbol: string;
  granularity: number;
  candles: Candle[];
}

export interface ConnectionDiagnostics {
  status: ConnectionStatus;
  url: string;
  /** Consecutive failed connection attempts since the last successful open. */
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  /** Why the last attempt failed, if it did. */
  lastError: DerivErrorInfo | null;
  /** Epoch ms of the last inbound message of any kind. */
  lastMessageAt: number | null;
  /** Epoch ms of the last live tick received. */
  lastTickAt: number | null;
  /** Number of live subscriptions currently registered. */
  activeSubscriptions: number;
  /** Requests waiting for a paced send slot (0 when idle). */
  queuedRequests: number;
  /** Epoch ms until which outbound requests are paused after a rate limit (0 when clear). */
  rateLimitedUntil: number;
  /** True only once real market data has been received on this connection. */
  hasReceivedData: boolean;
  /** True while a manual reconnect/disconnect cycle is in progress. */
  isManual: boolean;
}

type StatusListener = (status: ConnectionStatus, error?: DerivErrorInfo | null) => void;
type OhlcListener = (event: OhlcStreamEvent) => void;
type TickListener = (event: TickStreamEvent) => void;
type CandleSnapshotListener = (event: CandleSnapshotEvent) => void;

interface CandleSubscription {
  symbol: string;
  granularity: number;
  count: number;
  subscriptionId: string | null;
}

interface TickSubscription {
  symbol: string;
  subscriptionId: string | null;
}

export class DerivApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DerivApiError';
    this.code = code;
  }
}

/**
 * Builds a full derived-timeframe history (e.g. M7 from M1) using the shared aggregation
 * rules. The forming (trailing) bucket is dropped so an incomplete candle is never handed
 * back as a confirmed historical candle. Only the fully-covered tail is returned.
 */
export function buildDerivedHistory(source: readonly Candle[], granularitySec: number): Candle[] {
  if (source.length === 0) return [];
  const ordered = [...source].sort((a, b) => a.time - b.time);
  const aggregated = aggregateCandles(ordered, granularitySec);
  return confirmedDerivedCandles(aggregated, ordered[0].time, granularitySec, false);
}

/**
 * A single Deriv public market-data WebSocket client.
 *
 * Responsibilities:
 *  - one socket, many concurrent candle + tick subscriptions (keyed by symbol:granularity);
 *  - automatic reconnection with exponential backoff and a retry cap;
 *  - heartbeat/ping monitoring with a health timeout;
 *  - full subscription restoration after a reconnect;
 *  - honest status reporting: `connected` is only emitted after real market data
 *    (symbols, candles or ticks) has actually been received, never merely on `onopen`.
 *
 * The public endpoint needs no authentication and rejects `product_type`, so requests
 * carry only the fields the market-data API accepts.
 */
export class DerivWebSocketService {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private lastError: DerivErrorInfo | null = null;
  private reqIdCounter = 1;
  private pending = new Map<number, PendingRequest>();
  private statusListeners = new Set<StatusListener>();
  private ohlcListeners = new Set<OhlcListener>();
  private tickListeners = new Set<TickListener>();
  private candleSnapshotListeners = new Set<CandleSnapshotListener>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private connectPromise: Promise<void> | null = null;
  private lastMessageAt = 0;
  private lastTickAt = 0;
  private hasReceivedData = false;
  private openedOnce = false;
  private networkListenersBound = false;

  /** Outbound request pacing: a FIFO queue drained at WS_MIN_REQUEST_INTERVAL_MS. */
  private requestQueue: PendingQueueItem[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private lastSendAt = 0;
  /** Epoch ms until which no request may be sent (set after a server rate-limit error). */
  private rateLimitedUntil = 0;
  /** Sliding-window budget for `ticks_history` (the only throttled request class). */
  private historyLimiter = new SlidingWindowLimiter(
    WS_HISTORY_MAX_PER_WINDOW,
    WS_HISTORY_WINDOW_MS
  );

  /**
   * Shared candle cache keyed by `symbol:granularity`. Every AI module, the scanner, the
   * analyser, the chart and the health centre read the same series, so a warm cache turns a
   * full multi-market sweep into zero history requests — the single biggest defence against
   * Deriv's per-connection `ticks_history` rate limit.
   */
  private candleCache = new Map<string, CandleCacheEntry>();
  /** In-flight history requests, so concurrent callers share ONE server round-trip. */
  private candleInFlight = new Map<string, Promise<Candle[]>>();

  /** Live subscriptions, restored verbatim after any reconnect. */
  private candleSubs = new Map<string, CandleSubscription>();
  private tickSubs = new Map<string, TickSubscription>();

  /**
   * Derived-granularity live series (e.g. M7 built from M1). Keyed `symbol:granularity`.
   * The native source stream is folded in and a genuine candle event is emitted on change.
   */
  private derivedSeries = new Map<string, Candle[]>();

  /**
   * In-flight dedupe for the shared market registry. The app is ONE shared live-data
   * infrastructure, so concurrent callers await the same `active_symbols` request instead
   * of each issuing their own — no duplicate subscriptions and no Deriv rate-limit trips.
   * The result is never cached permanently, so newly listed eligible markets are still
   * discovered on the next refresh.
   */
  private marketsPromise: Promise<SyntheticMarket[]> | null = null;

  constructor(url: string = DERIV_WS_URL) {
    this.url = url;
  }

  private handleBrowserOffline = () => {
    if (this.manualDisconnect) return;
    this.clearReconnectTimer();
    this.teardownSocket(false);
    this.setStatus('reconnecting', {
      code: 'NETWORK_OFFLINE',
      message: 'Browser network connection lost. Waiting to reconnect...',
    });
  };

  private handleBrowserOnline = () => {
    if (this.manualDisconnect) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
      void this.connect().catch(() => {
        // Handled via status listeners & backoff
      });
    }
  };

  private bindNetworkListeners() {
    if (this.networkListenersBound || typeof window === 'undefined') return;
    window.addEventListener('offline', this.handleBrowserOffline);
    window.addEventListener('online', this.handleBrowserOnline);
    this.networkListenersBound = true;
  }

  private unbindNetworkListeners() {
    if (!this.networkListenersBound || typeof window === 'undefined') return;
    window.removeEventListener('offline', this.handleBrowserOffline);
    window.removeEventListener('online', this.handleBrowserOnline);
    this.networkListenersBound = false;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getLastError(): DerivErrorInfo | null {
    return this.lastError;
  }

  getDiagnostics(): ConnectionDiagnostics {
    return {
      status: this.status,
      url: this.url,
      reconnectAttempt: this.reconnectAttempt,
      maxReconnectAttempts: WS_MAX_RECONNECT_ATTEMPTS,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt || null,
      lastTickAt: this.lastTickAt || null,
      activeSubscriptions: this.candleSubs.size + this.tickSubs.size,
      queuedRequests: this.requestQueue.length,
      rateLimitedUntil: this.rateLimitedUntil,
      hasReceivedData: this.hasReceivedData,
      isManual: this.manualDisconnect,
    };
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.lastError);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onOhlc(listener: OhlcListener): () => void {
    this.ohlcListeners.add(listener);
    return () => {
      this.ohlcListeners.delete(listener);
    };
  }

  onTick(listener: TickListener): () => void {
    this.tickListeners.add(listener);
    return () => {
      this.tickListeners.delete(listener);
    };
  }

  onCandleSnapshot(listener: CandleSnapshotListener): () => void {
    this.candleSnapshotListeners.add(listener);
    return () => {
      this.candleSnapshotListeners.delete(listener);
    };
  }

  private setStatus(status: ConnectionStatus, error: DerivErrorInfo | null = null) {
    this.status = status;
    this.lastError = error;
    for (const listener of this.statusListeners) {
      listener(status, error);
    }
  }

  /**
   * Promotes the socket to `connected` only once genuine market data has arrived.
   * Before that, the socket may be open but the feed is not usable, so we keep
   * reporting `connecting`/`reconnecting` rather than a misleading `connected`.
   */
  private markDataReceived() {
    this.hasReceivedData = true;
    // Real data proves the throttle has cleared; the queue may resume immediately.
    this.rateLimitedUntil = 0;
    if (this.status !== 'connected') {
      this.reconnectAttempt = 0;
      this.setStatus('connected', null);
    }
  }

  /**
   * Watches the live tick age. While connected, a feed that stops ticking within the
   * staleness window is reported as `stale` (never silently as `connected`), so the UI and
   * every signal gate can withhold output instead of acting on frozen prices.
   */
  private startStaleWatch() {
    if (this.staleTimer) return;
    this.staleTimer = setInterval(() => {
      if (this.status === 'connected') {
        if (this.lastTickAt > 0 && Date.now() - this.lastTickAt > WS_STALE_TICK_MS) {
          this.setStatus('stale', {
            code: 'STALE_FEED',
            message: `No live tick for over ${Math.round(WS_STALE_TICK_MS / 1000)}s.`,
          });
        }
      } else if (this.status === 'stale') {
        // A fresh tick (or a still-fresh feed) clears the stale flag.
        if (this.lastTickAt > 0 && Date.now() - this.lastTickAt <= WS_STALE_TICK_MS) {
          this.setStatus('connected', null);
        }
      }
    }, 3000);
  }

  private stopStaleWatch() {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      return this.connectPromise ?? Promise.resolve();
    }

    this.manualDisconnect = false;
    this.bindNetworkListeners();
    this.clearReconnectTimer();
    this.rateLimitedUntil = 0;
    this.setStatus(this.openedOnce ? 'reconnecting' : 'connecting', null);

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;

      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        const message =
          err instanceof Error
            ? `Failed to initialize WebSocket (${err.message}).`
            : 'Unable to open WebSocket connection.';
        this.setStatus('error', { message });
        this.connectPromise = null;
        reject(new Error(message));
        return;
      }

      this.ws = socket;

      const openTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          try {
            socket.close();
          } catch {
            // ignore close failure
          }
          const errInfo: DerivErrorInfo = {
            code: 'CONNECTION_TIMEOUT',
            message: `Timed out after ${WS_REQUEST_TIMEOUT_MS / 1000}s connecting to ${this.url}.`,
          };
          this.setStatus('error', errInfo);
          this.scheduleReconnect();
          reject(new Error(errInfo.message));
        }
      }, WS_REQUEST_TIMEOUT_MS);

      socket.onopen = () => {
        clearTimeout(openTimeout);
        this.lastMessageAt = Date.now();
        this.openedOnce = true;
        this.connectPromise = null;
        this.startHealthChecks();
        this.startStaleWatch();
        // Socket is open but no data yet: keep reporting a pending state until the
        // first real market-data frame arrives (see markDataReceived).
        this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', null);
        if (!settled) {
          settled = true;
          resolve();
        }
        // Restore every live subscription on this fresh socket so streams resume
        // automatically after a reconnect (no caller action required).
        void this.restoreSubscriptions();
      };

      socket.onmessage = (event: MessageEvent) => {
        this.lastMessageAt = Date.now();
        this.clearHealthTimeout();
        this.handleMessage(event.data);
      };

      socket.onerror = () => {
        const errInfo: DerivErrorInfo = {
          code: 'WS_ERROR',
          message: `WebSocket handshake or transport error connecting to ${this.url}.`,
        };
        this.lastError = errInfo;
        if (!settled) {
          clearTimeout(openTimeout);
          settled = true;
          this.connectPromise = null;
          this.setStatus('error', errInfo);
          reject(new Error(errInfo.message));
        }
      };

      socket.onclose = (event: CloseEvent) => {
        clearTimeout(openTimeout);
        this.stopHealthChecks();
        this.connectPromise = null;
        this.hasReceivedData = false;
        const closeDetail = event.reason
          ? `${event.reason} (code ${event.code})`
          : `WebSocket closed (code ${event.code || 1006})`;
        this.rejectAllPending(new Error(closeDetail));
        if (this.ws === socket) {
          this.ws = null;
        }
        this.invalidateSubscriptionIds();

        if (!settled) {
          settled = true;
          const errInfo: DerivErrorInfo = {
            code: event.code ? String(event.code) : 'WS_CLOSED',
            message: this.lastError?.message || `${closeDetail} while connecting to Deriv API.`,
          };
          this.setStatus('error', errInfo);
          this.scheduleReconnect();
          reject(new Error(errInfo.message));
          return;
        }

        if (this.manualDisconnect) {
          this.setStatus('disconnected', null);
        } else {
          this.setStatus('reconnecting', {
            code: event.code ? String(event.code) : undefined,
            message: `${closeDetail}. Attempting automatic reconnection...`,
          });
          this.scheduleReconnect();
        }
      };
    });

    return this.connectPromise;
  }

  async reconnect(): Promise<void> {
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.teardownSocket(false);
    return this.connect();
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.unbindNetworkListeners();
    this.clearReconnectTimer();
    this.teardownSocket(true);
    this.setStatus('disconnected', null);
  }

  private teardownSocket(isManual: boolean) {
    this.manualDisconnect = isManual;
    this.stopHealthChecks();
    this.hasReceivedData = false;
    this.invalidateSubscriptionIds();
    this.rejectAllPending(new Error('WebSocket connection reset.'));
    if (this.ws) {
      const s = this.ws;
      this.ws = null;
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try {
        s.close();
      } catch {
        // ignore close failure
      }
    }
    this.connectPromise = null;
  }

  private invalidateSubscriptionIds() {
    for (const sub of this.candleSubs.values()) sub.subscriptionId = null;
    for (const sub of this.tickSubs.values()) sub.subscriptionId = null;
  }

  private scheduleReconnect() {
    if (this.manualDisconnect || this.reconnectTimer) {
      return;
    }
    if (this.reconnectAttempt >= WS_MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('error', {
        code: 'MAX_RETRIES',
        message: `Gave up after ${WS_MAX_RECONNECT_ATTEMPTS} reconnection attempts to ${this.url}. Use Reconnect to retry.`,
      });
      return;
    }
    // Full jitter: spread reconnects so many clients (or tabs) never stampede the endpoint
    // at the same instant after an outage.
    const delay = nextReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualDisconnect) {
        void this.connect().catch(() => {
          // Handled via status listeners & subsequent backoff
        });
      }
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHealthChecks() {
    this.stopHealthChecks();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const pingSentAt = Date.now();
      this.clearHealthTimeout();
      this.healthTimeoutTimer = setTimeout(() => {
        if (
          this.ws &&
          this.ws.readyState === WebSocket.OPEN &&
          this.lastMessageAt < pingSentAt
        ) {
          this.lastError = {
            code: 'HEARTBEAT_TIMEOUT',
            message: 'Deriv WebSocket heartbeat timed out. Reconnecting...',
          };
          try {
            this.ws.close(4000, 'Heartbeat timeout');
          } catch {
            // ignore close errors
          }
        }
      }, WS_HEALTH_TIMEOUT_MS);

      try {
        this.ws.send(JSON.stringify({ ping: 1 }));
      } catch {
        // ignore send errors on closing socket
      }
    }, WS_PING_INTERVAL_MS);
  }

  private clearHealthTimeout() {
    if (this.healthTimeoutTimer) {
      clearTimeout(this.healthTimeoutTimer);
      this.healthTimeoutTimer = null;
    }
  }

  private stopHealthChecks() {
    this.clearHealthTimeout();
    this.stopStaleWatch();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private rejectAllPending(err: Error) {
    this.inFlight = 0;
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
      this.pending.delete(id);
    }
    this.rejectQueue(err);
  }

  /**
   * Paces outbound requests. Deriv throttles per connection, so requests are queued and
   * sent one slot at a time (WS_MIN_REQUEST_INTERVAL_MS apart, up to WS_MAX_IN_FLIGHT in
   * flight). A server rate-limit error pauses the queue for WS_RATE_LIMIT_BACKOFF_MS so a
   * burst can never escalate into a hard block. The returned promise resolves with the
   * correlated response exactly as before.
   */
  private sendRequest(
    payload: Record<string, unknown>,
    options: { deadlineMs?: number; priority?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to Deriv WebSocket API.'));
    }
    return new Promise((resolve, reject) => {
      const item: PendingQueueItem = {
        payload,
        resolve,
        reject,
        deadlineAt:
          options.deadlineMs !== undefined ? Date.now() + options.deadlineMs : undefined,
        priority: options.priority,
      };
      // A priority request is inserted ahead of every queued background request (but behind
      // other priority requests) so a foreground health probe is never starved by a sweep.
      if (options.priority) {
        const idx = this.requestQueue.findIndex((q) => !q.priority);
        if (idx === -1) this.requestQueue.push(item);
        else this.requestQueue.splice(idx, 0, item);
      } else {
        this.requestQueue.push(item);
      }
      this.scheduleDrain();
    });
  }

  private scheduleDrain() {
    if (this.drainTimer) return;
    const wait = this.nextSlotDelayMs();
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainQueue();
    }, wait);
  }

  /**
   * Milliseconds until the next request may be released. Combines the fixed inter-request
   * spacing, any active rate-limit gate, AND the sliding-window history budget when the
   * request at the head of the queue is a `ticks_history` call.
   */
  private nextSlotDelayMs(): number {
    const now = Date.now();
    let wait = nextSendDelayMs({
      now,
      lastSendAt: this.lastSendAt,
      minIntervalMs: WS_MIN_REQUEST_INTERVAL_MS,
      rateLimitedUntil: this.rateLimitedUntil,
    });
    const head = this.requestQueue[0];
    if (head && 'ticks_history' in head.payload) {
      wait = Math.max(wait, this.historyLimiter.delayMs(now));
    }
    return wait;
  }

  private drainQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.rejectQueue(new Error('Not connected to Deriv WebSocket API.'));
      return;
    }
    while (this.requestQueue.length > 0 && this.inFlight < WS_MAX_IN_FLIGHT) {
      const head = this.requestQueue[0];
      // Abandon a history request that has been waiting past its deadline rather than
      // letting the queue grow without bound during a long rate-limit window.
      if (head.deadlineAt !== undefined && Date.now() > head.deadlineAt) {
        this.requestQueue.shift();
        head.reject(new Error('Deriv history request expired while waiting for a send slot.'));
        continue;
      }
      const wait = this.nextSlotDelayMs();
      if (wait > 0) break;
      this.requestQueue.shift();
      if ('ticks_history' in head.payload) this.historyLimiter.record(Date.now());
      this.dispatchRequest(head);
    }
    if (this.requestQueue.length > 0) this.scheduleDrain();
  }

  private dispatchRequest(item: PendingQueueItem) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      item.reject(new Error('Not connected to Deriv WebSocket API.'));
      return;
    }
    const reqId = this.reqIdCounter++;
    const body = { ...item.payload, req_id: reqId };
    this.lastSendAt = Date.now();
    this.inFlight += 1;

    const timer = setTimeout(() => {
      if (this.pending.delete(reqId)) {
        this.inFlight = Math.max(0, this.inFlight - 1);
      }
      item.reject(new Error('Deriv API request timed out.'));
    }, WS_REQUEST_TIMEOUT_MS);

    this.pending.set(reqId, { resolve: item.resolve, reject: item.reject, timer });

    try {
      this.ws.send(JSON.stringify(body));
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(reqId);
      this.inFlight = Math.max(0, this.inFlight - 1);
      item.reject(err instanceof Error ? err : new Error('Failed to send Deriv request.'));
    }
  }

  private rejectQueue(err: Error) {
    const queued = this.requestQueue;
    this.requestQueue = [];
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    for (const item of queued) item.reject(err);
  }

  private handleMessage(rawData: unknown) {
    if (typeof rawData !== 'string') return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return;
    }

    const reqId = typeof data.req_id === 'number' ? data.req_id : null;
    const msgType = typeof data.msg_type === 'string' ? data.msg_type : '';

    // Any well-formed market-data frame proves the feed is live.
    if (msgType && msgType !== 'ping' && msgType !== 'pong') {
      this.markDataReceived();
    }

    if (reqId !== null && this.pending.has(reqId)) {
      const pending = this.pending.get(reqId)!;
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      this.inFlight = Math.max(0, this.inFlight - 1);

      const errorObj = data.error as
        | { message?: unknown; code?: unknown; details?: unknown; rate_limit?: unknown }
        | undefined;
      if (errorObj && typeof errorObj === 'object') {
        const rawMsg =
          typeof errorObj.message === 'string'
            ? errorObj.message
            : 'Deriv API returned an error.';
        const code = typeof errorObj.code === 'string' ? errorObj.code : undefined;
        const message = code ? `${rawMsg} (${code})` : rawMsg;
        if (isRateLimitError(code, rawMsg)) {
          const backoff = rateLimitBackoffMs(errorObj as Record<string, unknown>);
          this.rateLimitedUntil = Date.now() + backoff;
          // The server's budget is authoritative: refill our window so no further history
          // request is released until it clears, even if we thought we had budget left.
          this.historyLimiter.exhaust(Date.now());
          this.setStatus('rate_limited', {
            code: code ?? 'RateLimit',
            message: `Deriv is rate limiting requests. Pausing ${Math.round(backoff / 1000)}s...`,
          });
        }
        pending.reject(new DerivApiError(message, code));
        return;
      }

      pending.resolve(data);
    }

    if (msgType === 'ohlc' && data.ohlc) {
      const parsed = parseOhlcUpdate(data.ohlc, 0);
      if (!parsed) return;

      const key = `${parsed.symbol}:${parsed.granularity}`;
      const sub = this.candleSubs.get(key);
      if (!sub) return;

      const incomingSubId = (data.subscription as { id?: unknown } | undefined)?.id;
      if (
        sub.subscriptionId &&
        typeof incomingSubId === 'string' &&
        incomingSubId !== sub.subscriptionId
      ) {
        return;
      }
      if (!sub.subscriptionId && typeof incomingSubId === 'string') {
        sub.subscriptionId = incomingSubId;
      }

      // Feed any derived series (e.g. M7) built from THIS native granularity. The native
      // source candle is folded in and the derived candle is re-emitted only on a real change.
      this.foldIntoDerivedSeries(parsed.symbol, parsed.granularity, parsed.candle);

      for (const listener of this.ohlcListeners) {
        listener(parsed);
      }
      return;
    }

    if (msgType === 'tick' && data.tick) {
      const parsed = parseTick(data.tick);
      if (!parsed) return;

      const sub = this.tickSubs.get(parsed.symbol);
      if (!sub) return;

      const incomingSubId = (data.subscription as { id?: unknown } | undefined)?.id;
      if (
        sub.subscriptionId &&
        typeof incomingSubId === 'string' &&
        incomingSubId !== sub.subscriptionId
      ) {
        return;
      }
      if (!sub.subscriptionId && typeof incomingSubId === 'string') {
        sub.subscriptionId = incomingSubId;
      }

      this.lastTickAt = Date.now();
      for (const listener of this.tickListeners) {
        listener(parsed);
      }
    }
  }

  async fetchSyntheticMarkets(): Promise<SyntheticMarket[]> {
    if (this.marketsPromise) return this.marketsPromise;
    this.marketsPromise = (async () => {
      await this.connect();
      const res = await this.sendRequest({ active_symbols: 'brief' });
      const markets = parseActiveSymbols(res.active_symbols);
      if (markets.length > 0) this.markDataReceived();
      return markets;
    })();
    try {
      return await this.marketsPromise;
    } finally {
      this.marketsPromise = null;
    }
  }

  /** Registers (or refreshes) the desired candle subscription, restored after reconnect. */
  registerCandleSubscription(
    symbol: string,
    granularitySec: number,
    count: number
  ): CandleSubscription {
    const key = `${symbol}:${granularitySec}`;
    const existing = this.candleSubs.get(key);
    if (existing) {
      existing.count = count;
      return existing;
    }
    const created: CandleSubscription = {
      symbol,
      granularity: granularitySec,
      count,
      subscriptionId: null,
    };
    this.candleSubs.set(key, created);
    return created;
  }

  /**
   * Forgets an upstream subscription id that was issued for a request the caller has
   * already abandoned (the user switched instrument or timeframe before it resolved).
   * Without this the server keeps streaming data nobody consumes.
   */
  private async forgetOrphanedSubscription(subscriptionId: unknown): Promise<void> {
    if (typeof subscriptionId !== 'string') return;
    try {
      await this.sendRequest({ forget: subscriptionId });
    } catch {
      // Ignore forget failures if the stream already closed.
    }
  }

  /**
   * Folds a native candle into every derived series that is built from that granularity
   * (currently M1 → M7). A genuine derived candle is emitted via the candle-snapshot
   * listeners only when its OHLC actually changes, so no duplicate events are produced.
   */
  private foldIntoDerivedSeries(symbol: string, sourceGranularity: number, candle: Candle) {
    for (const [derivedGranularity, source] of Object.entries(DERIVED_GRANULARITY_SOURCE)) {
      if (source !== sourceGranularity) continue;
      const derived = Number(derivedGranularity);
      const key = `${symbol}:${derived}`;
      const series = this.derivedSeries.get(key);
      if (!series) continue;
      const next = foldDerivedCandle(series, derived, candle);
      if (next === series) continue;
      const prevLast = series[series.length - 1];
      const nextLast = next[next.length - 1];
      if (prevLast && nextLast && candleEquals(prevLast, nextLast)) continue;
      this.derivedSeries.set(key, next);
      for (const listener of this.candleSnapshotListeners) {
        listener({ symbol, granularity: derived, candles: next });
      }
    }
  }

  /**
   * Re-issues every registered subscription on the current socket. Called automatically
   * after each open so live streams resume after a reconnect without caller action.
   */
  private async restoreSubscriptions() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const candles = [...this.candleSubs.values()];
    const ticks = [...this.tickSubs.values()];
    for (const sub of candles) {
      try {
        const res = await this.sendRequest({
          ticks_history: sub.symbol,
          adjust_start_time: 1,
          count: sub.count,
          end: 'latest',
          granularity: sub.granularity,
          style: 'candles',
          subscribe: 1,
        });
        const current = this.candleSubs.get(`${sub.symbol}:${sub.granularity}`);
        const subId = (res.subscription as { id?: unknown } | undefined)?.id;
        if (current && typeof subId === 'string') current.subscriptionId = subId;

        const refreshed = parseHistoricalCandles(res.candles);
        if (refreshed.length > 0) {
          this.markDataReceived();
          for (const listener of this.candleSnapshotListeners) {
            listener({ symbol: sub.symbol, granularity: sub.granularity, candles: refreshed });
          }
        }
      } catch {
        // Leave subscriptionId null; the next open will retry.
      }
    }
    for (const sub of ticks) {
      try {
        const res = await this.sendRequest({ ticks: sub.symbol, subscribe: 1 });
        const current = this.tickSubs.get(sub.symbol);
        const subId = (res.subscription as { id?: unknown } | undefined)?.id;
        if (current && typeof subId === 'string') current.subscriptionId = subId;
      } catch {
        // Leave subscriptionId null; the next open will retry.
      }
    }
  }

  async unsubscribeCandles(): Promise<void> {
    const prev = [...this.candleSubs.values()].filter((s) => s.subscriptionId);
    this.candleSubs.clear();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      for (const sub of prev) {
        if (sub.subscriptionId) {
          await this.sendRequest({ forget: sub.subscriptionId });
        }
      }
      await this.sendRequest({ forget_all: 'candles' });
    } catch {
      // Ignore unsubscribe failures if stream already closed
    }
  }

  /** Forgets a single candle subscription without disturbing any other active stream. */
  async unsubscribeCandleSubscription(symbol: string, granularitySec: number): Promise<void> {
    const key = `${symbol}:${granularitySec}`;
    // A derived granularity holds no native subscription of its own — drop its built series
    // and release the native source stream it was folded from.
    const sourceGranularity = DERIVED_GRANULARITY_SOURCE[granularitySec];
    if (sourceGranularity !== undefined) {
      this.derivedSeries.delete(key);
      this.candleCache.delete(key);
      await this.unsubscribeCandleSubscription(symbol, sourceGranularity);
      return;
    }
    const sub = this.candleSubs.get(key);
    this.candleSubs.delete(key);
    if (!sub?.subscriptionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      await this.sendRequest({ forget: sub.subscriptionId });
    } catch {
      // Ignore forget failures if stream already closed
    }
  }

  async subscribeCandles(
    symbol: string,
    granularitySec: number,
    count: number
  ): Promise<Candle[]> {
    await this.connect();

    // A derived granularity (e.g. M7) subscribes to its NATIVE source (M1), seeds the
    // derived series from aggregated history, and folds every subsequent native candle in.
    const sourceGranularity = DERIVED_GRANULARITY_SOURCE[granularitySec];
    if (sourceGranularity !== undefined) {
      const sourceCount = Math.min(DERIVED_SOURCE_MAX_COUNT, Math.ceil(count * (granularitySec / sourceGranularity)) + 1);
      const historical = await this.subscribeCandles(symbol, sourceGranularity, sourceCount);
      const derived = buildDerivedHistory(historical, granularitySec).slice(-count);
      const key = `${symbol}:${granularitySec}`;
      if (derived.length > 0) {
        this.derivedSeries.set(key, derived);
        this.candleCache.set(key, { candles: derived, at: Date.now() });
      }
      return derived;
    }

    const registered = this.registerCandleSubscription(symbol, granularitySec, count);

    const res = await this.sendRequest(
      {
        ticks_history: symbol,
        adjust_start_time: 1,
        count,
        end: 'latest',
        granularity: granularitySec,
        style: 'candles',
        subscribe: 1,
      },
      { deadlineMs: WS_HISTORY_QUEUE_TIMEOUT_MS }
    );

    const key = `${symbol}:${granularitySec}`;
    const subId = (res.subscription as { id?: unknown } | undefined)?.id;
    if (this.candleSubs.get(key) !== registered) {
      // The user switched instrument or timeframe while this request was in flight.
      // The stream is no longer wanted, so forget the id the server just issued —
      // otherwise it keeps pushing candles nobody consumes.
      await this.forgetOrphanedSubscription(subId);
    } else if (typeof subId === 'string') {
      const superseded = registered.subscriptionId;
      registered.subscriptionId = subId;
      if (superseded && superseded !== subId) {
        await this.forgetOrphanedSubscription(superseded);
      }
    }

    const candles = parseHistoricalCandles(res.candles);
    if (candles.length > 0) {
      // Seed the shared cache so every AI module / scanner read for this symbol+timeframe
      // is served from here instead of issuing its own throttled history request.
      this.setCandleCache(symbol, granularitySec, candles);
      this.markDataReceived();
    }
    return candles;
  }

  async fetchOlderCandles(
    symbol: string,
    granularitySec: number,
    endEpochSec: number,
    count: number
  ): Promise<Candle[]> {
    await this.connect();
    const sourceGranularity = DERIVED_GRANULARITY_SOURCE[granularitySec];
    if (sourceGranularity !== undefined) {
      const sourceCount = Math.min(DERIVED_SOURCE_MAX_COUNT, Math.ceil(count * (granularitySec / sourceGranularity)) + 1);
      const res = await this.sendRequest(
        {
          ticks_history: symbol,
          adjust_start_time: 1,
          count: sourceCount,
          end: String(Math.max(0, Math.floor(endEpochSec))),
          granularity: sourceGranularity,
          style: 'candles',
        },
        { deadlineMs: WS_HISTORY_QUEUE_TIMEOUT_MS }
      );
      const source = parseHistoricalCandles(res.candles);
      const older = buildDerivedHistory(source, granularitySec).filter((c) => c.time < endEpochSec + 1);
      if (older.length > 0) this.markDataReceived();
      return older;
    }
    const res = await this.sendRequest(
      {
        ticks_history: symbol,
        adjust_start_time: 1,
        count,
        end: String(Math.max(0, Math.floor(endEpochSec))),
        granularity: granularitySec,
        style: 'candles',
      },
      { deadlineMs: WS_HISTORY_QUEUE_TIMEOUT_MS }
    );
    const candles = parseHistoricalCandles(res.candles);
    if (candles.length > 0) this.markDataReceived();
    return candles;
  }

  /**
   * Shared, deduped history fetch. This is the single entry point every caller (AI modules,
   * scanner, analyser, chart, health) uses, so:
   *  - a cached series younger than WS_CANDLE_CACHE_TTL_MS is served without any request;
   *  - concurrent callers for the same symbol+granularity share ONE server round-trip;
   *  - a failed request falls back to the last good cache entry rather than returning nothing.
   * The cached array is treated as read-only by callers (engines receive `readonly Candle[]`
   * and the chart only ever derives new arrays from it).
   */
  private async loadHistory(
    symbol: string,
    granularitySec: number,
    count: number,
    priority = false
  ): Promise<Candle[]> {
    const key = `${symbol}:${granularitySec}`;
    const cached = this.candleCache.get(key);
    // Only serve the cache when it is both fresh AND long enough for this caller, so the
    // chart (which wants a deep series) is never short-changed by a shallower AI request.
    if (cached && Date.now() - cached.at < WS_CANDLE_CACHE_TTL_MS && cached.candles.length >= count) {
      return cached.candles;
    }
    const existing = this.candleInFlight.get(key);
    if (existing) return existing;

    const request = (async () => {
      await this.connect();
      // A derived granularity (e.g. M7 = 420s) is NOT native to Deriv: fetch enough native
      // source candles (M1) and aggregate them internally into genuine candles.
      const sourceGranularity = DERIVED_GRANULARITY_SOURCE[granularitySec];
      if (sourceGranularity !== undefined) {
        const sourceCount = Math.min(DERIVED_SOURCE_MAX_COUNT, Math.ceil(count * (granularitySec / sourceGranularity)) + 1);
        const res = await this.sendRequest(
          {
            ticks_history: symbol,
            adjust_start_time: 1,
            count: sourceCount,
            end: 'latest',
            granularity: sourceGranularity,
            style: 'candles',
          },
          { deadlineMs: WS_HISTORY_QUEUE_TIMEOUT_MS, priority }
        );
        const source = parseHistoricalCandles(res.candles);
        const candles = buildDerivedHistory(source, granularitySec).slice(-count);
        if (candles.length > 0) {
          this.candleCache.set(key, { candles, at: Date.now() });
          this.markDataReceived();
          return candles;
        }
        return this.candleCache.get(key)?.candles ?? [];
      }

      const res = await this.sendRequest(
        {
          ticks_history: symbol,
          adjust_start_time: 1,
          count,
          end: 'latest',
          granularity: granularitySec,
          style: 'candles',
        },
        { deadlineMs: WS_HISTORY_QUEUE_TIMEOUT_MS, priority }
      );
      const candles = parseHistoricalCandles(res.candles);
      if (candles.length > 0) {
        this.candleCache.set(key, { candles, at: Date.now() });
        this.markDataReceived();
        return candles;
      }
      return this.candleCache.get(key)?.candles ?? [];
    })();

    this.candleInFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.candleInFlight.delete(key);
    }
  }

  /** Drops cached series for one key (used when a stream is replaced with a fresh snapshot). */
  private setCandleCache(symbol: string, granularitySec: number, candles: Candle[]) {
    if (candles.length === 0) return;
    this.candleCache.set(`${symbol}:${granularitySec}`, { candles, at: Date.now() });
  }

  async fetchHistoricalCandles(
    symbol: string,
    granularitySec: number,
    count: number,
    options: { priority?: boolean } = {}
  ): Promise<Candle[]> {
    return this.loadHistory(symbol, granularitySec, count, options.priority === true);
  }

  /** Opens a continuous live tick stream for one symbol. */
  async subscribeTicks(symbol: string): Promise<void> {
    await this.connect();
    const existing = this.tickSubs.get(symbol);
    if (existing && existing.subscriptionId) return;

    // Register the intent before the request so a switch that happens while it is in
    // flight can cancel it (see `unsubscribeTicks`).
    const registered: TickSubscription = existing ?? { symbol, subscriptionId: null };
    this.tickSubs.set(symbol, registered);

    const res = await this.sendRequest({ ticks: symbol, subscribe: 1 });
    const subId = (res.subscription as { id?: unknown } | undefined)?.id;

    if (this.tickSubs.get(symbol) !== registered) {
      // The stream was cancelled (instrument switched) while this request was in flight;
      // forget the id so the server stops pushing ticks for a symbol we no longer show.
      await this.forgetOrphanedSubscription(subId);
      return;
    }
    if (typeof subId === 'string') registered.subscriptionId = subId;

    const tick = parseTick(res.tick);
    if (tick) {
      this.lastTickAt = Date.now();
      this.markDataReceived();
      for (const listener of this.tickListeners) {
        listener(tick);
      }
    }
  }

  async unsubscribeTicks(symbol: string): Promise<void> {
    const sub = this.tickSubs.get(symbol);
    this.tickSubs.delete(symbol);
    if (!sub?.subscriptionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      await this.sendRequest({ forget: sub.subscriptionId });
    } catch {
      // Ignore forget failures if stream already closed
    }
  }

  async fetchRecentTicks(
    symbol: string,
    count = 20
  ): Promise<Array<{ time: number; quote: number }>> {
    await this.connect();
    try {
      const res = await this.sendRequest({
        ticks_history: symbol,
        adjust_start_time: 1,
        count,
        end: 'latest',
        style: 'ticks',
      });
      const history = res.history as
        | { times?: unknown[]; prices?: unknown[] }
        | undefined;
      const times = Array.isArray(history?.times) ? history.times : [];
      const prices = Array.isArray(history?.prices) ? history.prices : [];
      const ticks: Array<{ time: number; quote: number }> = [];
      for (let i = 0; i < Math.min(times.length, prices.length); i++) {
        const t = Number(times[i]);
        const p = Number(prices[i]);
        if (Number.isFinite(t) && Number.isFinite(p)) {
          ticks.push({ time: t, quote: p });
        }
      }
      if (ticks.length > 0) this.markDataReceived();
      return ticks;
    } catch {
      return [];
    }
  }
}
