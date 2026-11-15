import {
  DERIV_WS_URL,
  WS_HEALTH_TIMEOUT_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_MAX_RECONNECT_DELAY_MS,
  WS_PING_INTERVAL_MS,
  WS_REQUEST_TIMEOUT_MS,
} from '../config/deriv';
import type {
  Candle,
  ConnectionStatus,
  DerivErrorInfo,
  SyntheticMarket,
} from '../types/market';
import {
  parseActiveSymbols,
  parseHistoricalCandles,
  parseOhlcUpdate,
  parseTick,
} from '../utils/derivParser';

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private connectPromise: Promise<void> | null = null;
  private lastMessageAt = 0;
  private lastTickAt = 0;
  private hasReceivedData = false;
  private openedOnce = false;
  private networkListenersBound = false;

  /** Live subscriptions, restored verbatim after any reconnect. */
  private candleSubs = new Map<string, CandleSubscription>();
  private tickSubs = new Map<string, TickSubscription>();

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
    const firstData = !this.hasReceivedData;
    this.hasReceivedData = true;
    if (firstData && this.status !== 'connected') {
      this.reconnectAttempt = 0;
      this.setStatus('connected', null);
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
    const delay = Math.min(
      WS_MAX_RECONNECT_DELAY_MS,
      1000 * Math.pow(2, this.reconnectAttempt)
    );
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
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private rejectAllPending(err: Error) {
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
      this.pending.delete(id);
    }
  }

  private sendRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to Deriv WebSocket API.'));
    }

    const reqId = this.reqIdCounter++;
    const body = { ...payload, req_id: reqId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('Deriv API request timed out.'));
      }, WS_REQUEST_TIMEOUT_MS);

      this.pending.set(reqId, { resolve, reject, timer });

      try {
        this.ws!.send(JSON.stringify(body));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err instanceof Error ? err : new Error('Failed to send Deriv request.'));
      }
    });
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

      const errorObj = data.error as
        | { message?: unknown; code?: unknown; details?: unknown }
        | undefined;
      if (errorObj && typeof errorObj === 'object') {
        const rawMsg =
          typeof errorObj.message === 'string'
            ? errorObj.message
            : 'Deriv API returned an error.';
        const code = typeof errorObj.code === 'string' ? errorObj.code : undefined;
        const message = code ? `${rawMsg} (${code})` : rawMsg;
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
    await this.connect();
    const res = await this.sendRequest({ active_symbols: 'brief' });
    const markets = parseActiveSymbols(res.active_symbols);
    if (markets.length > 0) this.markDataReceived();
    return markets;
  }

  /** Registers (or refreshes) the desired candle subscription, restored after reconnect. */
  registerCandleSubscription(symbol: string, granularitySec: number, count: number) {
    const key = `${symbol}:${granularitySec}`;
    const existing = this.candleSubs.get(key);
    if (existing) {
      existing.count = count;
      existing.subscriptionId = null;
      return;
    }
    this.candleSubs.set(key, { symbol, granularity: granularitySec, count, subscriptionId: null });
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
    this.registerCandleSubscription(symbol, granularitySec, count);

    const res = await this.sendRequest({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: 'latest',
      granularity: granularitySec,
      style: 'candles',
      subscribe: 1,
    });

    const key = `${symbol}:${granularitySec}`;
    const sub = this.candleSubs.get(key);
    const subId = (res.subscription as { id?: unknown } | undefined)?.id;
    if (sub && typeof subId === 'string') {
      sub.subscriptionId = subId;
    }

    const candles = parseHistoricalCandles(res.candles);
    if (candles.length > 0) this.markDataReceived();
    return candles;
  }

  async fetchOlderCandles(
    symbol: string,
    granularitySec: number,
    endEpochSec: number,
    count: number
  ): Promise<Candle[]> {
    await this.connect();
    const res = await this.sendRequest({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: String(Math.max(0, Math.floor(endEpochSec))),
      granularity: granularitySec,
      style: 'candles',
    });
    const candles = parseHistoricalCandles(res.candles);
    if (candles.length > 0) this.markDataReceived();
    return candles;
  }

  async fetchHistoricalCandles(
    symbol: string,
    granularitySec: number,
    count: number
  ): Promise<Candle[]> {
    await this.connect();
    const res = await this.sendRequest({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: 'latest',
      granularity: granularitySec,
      style: 'candles',
    });
    const candles = parseHistoricalCandles(res.candles);
    if (candles.length > 0) this.markDataReceived();
    return candles;
  }

  /** Opens a continuous live tick stream for one symbol. */
  async subscribeTicks(symbol: string): Promise<void> {
    await this.connect();
    const existing = this.tickSubs.get(symbol);
    if (existing && existing.subscriptionId) return;

    const res = await this.sendRequest({ ticks: symbol, subscribe: 1 });
    const subId = (res.subscription as { id?: unknown } | undefined)?.id;
    const sub = this.tickSubs.get(symbol) ?? { symbol, subscriptionId: null };
    if (typeof subId === 'string') sub.subscriptionId = subId;
    this.tickSubs.set(symbol, sub);

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
