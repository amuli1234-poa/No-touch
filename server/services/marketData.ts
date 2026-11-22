import type { ServerConfig } from '../config.js';
import type { MinimalWebSocket } from '../lib/balance.js';
import { CacheKeys, type Cache } from './cache.js';
import { DIGIT_PREDICTION_TYPES, type DerivContractType } from '../execution/types.js';

/**
 * Server-side Deriv market data.
 *
 * The browser already streams ticks, but the backend could not: the legacy
 * `ws.derivws.com/websockets/v3` endpoint is Cloudflare-blocked from the server
 * (HTTP 520). This service uses the documented public options gateway instead,
 * which needs no authentication:
 *
 *   wss://api.derivws.com/trading/v1/options/ws/public
 *
 * It provides a shared, deduplicated upstream connection: many callers may
 * subscribe to the same symbol and Deriv sees one subscription. Every snapshot
 * carries the epoch Deriv stamped and a local `receivedAt`, so consumers can
 * reason about freshness rather than assuming a price is current.
 *
 * Nothing here trades. It is read-only market data.
 */

export interface MarketTick {
  symbol: string;
  quote: number;
  bid: number | null;
  ask: number | null;
  /** Deriv's own epoch (seconds) for the tick. */
  epoch: number;
  pipSize: number | null;
}

export interface MarketSnapshot extends MarketTick {
  /** Local monotonic-ish time the tick was received, for freshness checks. */
  receivedAt: number;
}

export interface ActiveSymbol {
  symbol: string;
  displayName: string;
  market: string;
  submarket: string;
  pipSize: number;
  exchangeOpen: boolean;
  tradingSuspended: boolean;
}

/**
 * One contract type Deriv currently offers for a symbol, as returned by
 * `contracts_for`. Only the fields the Bots compatibility engine needs are
 * kept; the raw payload is not stored.
 */
export interface AvailableContract {
  /** Deriv contract type, e.g. `CALL`, `DIGITEVEN`, `NOTOUCH`. */
  contractType: string;
  /** Deriv contract category, e.g. `callput`, `digits`, `touchnotouch`. */
  category: string;
  /** Number of barriers the contract needs. `0` means barrier-free. */
  barriers: number;
  /** `daily` | `tick` | `intraday` | `no_expiry`, as Deriv reports it. */
  expiryType: string;
  /** Duration bounds Deriv reports, when present. */
  minDuration: number | null;
  maxDuration: number | null;
  /** Per-contract duration unit, e.g. `t` for tick-based digit contracts. */
  durationUnit: string | null;
  /** True when Deriv requires the contract to specify a digit prediction. */
  requiresDigit: boolean;
}

export type MarketDataErrorCode =
  | 'not_connected'
  | 'unknown_symbol'
  | 'timeout'
  | 'socket_failed'
  | 'deriv_error';

export class MarketDataError extends Error {
  readonly code: MarketDataErrorCode;
  constructor(code: MarketDataErrorCode, message: string) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
  }
}

/**
 * How long a symbol's `contracts_for` result is reused. Deriv's catalogue
 * changes on the order of hours, so a few minutes is safe and keeps a ticking
 * bot from re-requesting it on every evaluation.
 */
const CONTRACT_CATALOG_TTL_MS = 5 * 60 * 1000;

/** Parses Deriv's compound duration strings, e.g. `5t`, `1d`, `60s`. */
function parseDuration(raw: unknown): { value: number; unit: string } | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: match[2].toLowerCase() };
}

export interface MarketDataOptions {
  /** WebSocket factory; defaults to the Node global. Injected in tests. */
  wsFactory?: (url: string) => MinimalWebSocket;
  /** Overrides the public gateway URL (tests). */
  url?: string;
  /** Ring-buffer cap of ticks retained per symbol. */
  maxTicksPerSymbol?: number;
  /** Request/response timeout. */
  requestTimeoutMs?: number;
  /** Ping cadence. 0 disables pings (tests). */
  pingIntervalMs?: number;
  /** Reconnect backoff bounds. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Clock; injected in tests. */
  now?: () => number;
  /**
   * If no message of any kind arrives for this long, the socket is treated as
   * half-open and forced to reconnect. Must exceed `pingIntervalMs` so a healthy
   * idle connection (pong-only traffic) is never mistaken for a dead one.
   */
  staleTimeoutMs?: number;
  /** Optional shared cache for recomputable reads (symbol catalogue). */
  cache?: Cache;
}

const DEFAULT_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const DEFAULT_MAX_TICKS = 2_000;
const DEFAULT_REQUEST_TIMEOUT = 10_000;
const DEFAULT_PING = 30_000;
const DEFAULT_RECONNECT_BASE = 500;
const DEFAULT_RECONNECT_MAX = 30_000;
/** Two ping intervals without any inbound traffic means the socket is dead. */
const DEFAULT_STALE_TIMEOUT = 90_000;
/** How often the liveness watchdog checks the socket. */
const WATCHDOG_INTERVAL = 15_000;

type TickHandler = (tick: MarketSnapshot) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Only ever dial Deriv's own public gateway — never an arbitrary host. */
function assertDerivPublicUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MarketDataError('socket_failed', 'The market data URL is unparseable.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'wss:' || !(host === 'derivws.com' || host.endsWith('.derivws.com'))) {
    throw new MarketDataError('socket_failed', 'The market data URL is not a Deriv origin.');
  }
}

export class MarketDataService {
  private readonly cfg: ServerConfig;
  private readonly opts: Required<Omit<MarketDataOptions, 'wsFactory' | 'url' | 'now' | 'cache'>> & {
    wsFactory: (url: string) => MinimalWebSocket;
    url: string;
    now: () => number;
  };

  private socket: MinimalWebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Epoch ms of the last inbound message of any kind; drives the watchdog. */
  private lastMessageAt = 0;
  /** Set while a reconnect is being attempted, to avoid overlapping attempts. */
  private reconnecting = false;

  private nextReqId = 1;
  private readonly pending = new Map<number, Pending>();

  private activeSymbols: ActiveSymbol[] | null = null;
  /** Per-symbol `contracts_for` results, keyed by symbol, with a fetch time. */
  private readonly contractCatalog = new Map<string, { at: number; contracts: AvailableContract[] }>();
  private activeSymbolsWaiters: Array<(s: ActiveSymbol[]) => void> = [];
  private readonly cache: Cache | null;

  private readonly snapshots = new Map<string, MarketSnapshot>();
  private readonly tickBuffers = new Map<string, MarketSnapshot[]>();
  private readonly subscribers = new Map<string, Set<TickHandler>>();

  constructor(cfg: ServerConfig, options: MarketDataOptions = {}) {
    this.cfg = cfg;
    this.opts = {
      wsFactory: options.wsFactory ?? ((url: string) => new (globalThis as any).WebSocket(url) as MinimalWebSocket),
      url: options.url ?? DEFAULT_URL,
      maxTicksPerSymbol: options.maxTicksPerSymbol ?? DEFAULT_MAX_TICKS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULT_PING,
      reconnectBaseMs: options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE,
      reconnectMaxMs: options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX,
      staleTimeoutMs: options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT,
      now: options.now ?? (() => Date.now())
    };
    this.reconnectDelay = this.opts.reconnectBaseMs;
    this.cache = options.cache ?? null;
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /** Opens the shared public connection. Idempotent. */
  async connect(): Promise<void> {
    if (this.socket || this.closed) return;
    assertDerivPublicUrl(this.opts.url);
    const sep = this.opts.url.includes('?') ? '&' : '?';
    const url = `${this.opts.url}${sep}app_id=${encodeURIComponent(this.cfg.deriv.appId)}&l=en`;
    let socket: MinimalWebSocket;
    try {
      socket = this.opts.wsFactory(url);
    } catch {
      throw new MarketDataError('socket_failed', 'Could not open the market data socket.');
    }
    this.socket = socket;
    socket.addEventListener('open', () => this.onOpen());
    socket.addEventListener('message', (event: any) => this.onMessage(event));
    socket.addEventListener('error', () => this.onSocketDown());
    socket.addEventListener('close', () => this.onSocketDown());
  }

  /** Closes the connection and stops reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.stopWatchdog();
    this.reconnectTimer = null;
    this.pingTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new MarketDataError('socket_failed', 'Market data connection closed.'));
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      /* closing an already-closed socket is not an error */
    }
    this.socket = null;
    this.connected = false;
  }

  private onOpen(): void {
    this.connected = true;
    this.reconnecting = false;
    this.reconnectDelay = this.opts.reconnectBaseMs;
    this.lastMessageAt = this.opts.now();
    // Ask for the symbol catalogue once per connection.
    this.request({ active_symbols: 'brief' }).catch(() => {});
    // Restore every active subscription after a reconnect.
    for (const symbol of this.subscribers.keys()) {
      this.send({ ticks: symbol, subscribe: 1, req_id: this.nextReqId++ });
    }
    if (this.opts.pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => this.send({ ping: 1 }), this.opts.pingIntervalMs);
      // Do not keep the process alive solely for the ping timer.
      (this.pingTimer as any)?.unref?.();
    }
    this.startWatchdog();
  }

  /**
   * A TCP socket can go half-open (a NAT rebind, a sleeping laptop, a dropped
   * carrier route) without ever emitting `close`. The socket still looks open
   * and writes still succeed, but nothing comes back — which is exactly the
   * "it silently stops updating" symptom. The watchdog forces a reconnect when
   * no inbound message has arrived within `staleTimeoutMs`, so recovery is
   * automatic rather than requiring a restart.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (this.closed || !this.connected) return;
      const silentFor = this.opts.now() - this.lastMessageAt;
      if (silentFor > this.opts.staleTimeoutMs) {
        // Force the socket down; onSocketDown schedules a jittered reconnect and
        // onOpen re-subscribes every symbol, so no caller has to notice.
        this.forceReconnect(`no data for ${Math.round(silentFor / 1000)}s`);
      }
    }, WATCHDOG_INTERVAL);
    (this.watchdogTimer as any)?.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /** Tears the socket down so the reconnect path runs, without marking closed. */
  private forceReconnect(reason: string): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.socket?.close();
    } catch {
      /* the socket may already be unusable */
    }
    this.onSocketDown(reason);
  }

  private onSocketDown(reason?: string): void {
    if (this.closed) return;
    this.connected = false;
    this.socket = null;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.stopWatchdog();
    // Fail every in-flight request now: on reconnect it would otherwise hang
    // until its own timeout, and the caller can retry against the new socket.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new MarketDataError('socket_failed', `Market data connection lost${reason ? ` (${reason})` : ''}.`));
    }
    this.pending.clear();
    if (this.reconnectTimer) return;
    // Full jitter over the exponential ceiling: many clients dropped by the same
    // event do not stampede the gateway at the same instant.
    const ceiling = this.reconnectDelay;
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.opts.reconnectMaxMs);
    this.reconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect().catch(() => this.onSocketDown('connect failed'));
    }, delay);
    (this.reconnectTimer as any)?.unref?.();
  }

  /* -------------------------------- messaging ----------------------------- */

  private send(msg: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(msg));
    } catch {
      this.onSocketDown();
    }
  }

  private onMessage(event: any): void {
    // Any inbound frame — a tick, a pong, an error — proves the socket is alive.
    this.lastMessageAt = this.opts.now();
    let msg: any;
    try {
      msg = typeof event?.data === 'string' ? JSON.parse(event.data) : null;
    } catch {
      return;
    }
    if (!msg) return;

    const reqId = typeof msg.req_id === 'number' ? msg.req_id : null;
    if (reqId !== null && this.pending.has(reqId)) {
      const p = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new MarketDataError('deriv_error', msg.error.message || 'Deriv rejected the request.'));
      else p.resolve(msg);
      // A tick can also carry req_id; fall through so it is processed below.
    }

    if (msg.msg_type === 'active_symbols' && Array.isArray(msg.active_symbols)) {
      const parsed: ActiveSymbol[] = msg.active_symbols.map((s: any) => ({
        symbol: s.underlying_symbol,
        displayName: s.underlying_symbol_name ?? s.underlying_symbol,
        market: s.market ?? '',
        submarket: s.submarket ?? '',
        pipSize: typeof s.pip_size === 'number' ? s.pip_size : Number(s.pip_size) || 0,
        exchangeOpen: s.exchange_is_open === 1,
        tradingSuspended: s.is_trading_suspended === 1
      }));
      this.activeSymbols = parsed;
      // Publish the catalogue to the shared cache so a second process (or a
      // restart) can serve it without another upstream request.
      void this.cache?.set(CacheKeys.activeSymbols(), parsed, 300);
      const waiters = this.activeSymbolsWaiters;
      this.activeSymbolsWaiters = [];
      for (const w of waiters) w(parsed);
    }

    if (msg.msg_type === 'tick' && msg.tick) {
      this.ingestTick(msg.tick);
    }
  }

  private ingestTick(t: any): void {
    const symbol = t.symbol;
    if (typeof symbol !== 'string') return;
    const snapshot: MarketSnapshot = {
      symbol,
      quote: Number(t.quote),
      bid: t.bid === undefined ? null : Number(t.bid),
      ask: t.ask === undefined ? null : Number(t.ask),
      epoch: Number(t.epoch),
      pipSize: t.pip_size === undefined ? null : Number(t.pip_size),
      receivedAt: this.opts.now()
    };
    this.snapshots.set(symbol, snapshot);
    // Mirror the latest snapshot into the shared cache so a second process (or
    // the HTTP layer) reads a price without its own subscription.
    void this.cache?.set(CacheKeys.snapshot(symbol), snapshot, 15);
    const buf = this.tickBuffers.get(symbol) ?? [];
    buf.push(snapshot);
    if (buf.length > this.opts.maxTicksPerSymbol) buf.splice(0, buf.length - this.opts.maxTicksPerSymbol);
    this.tickBuffers.set(symbol, buf);
    for (const handler of this.subscribers.get(symbol) ?? []) {
      try {
        handler(snapshot);
      } catch {
        /* a subscriber throwing must not break the stream */
      }
    }
  }

  /** Sends a request and resolves with the matching response. */
  private request(msg: Record<string, unknown>): Promise<any> {
    if (!this.socket) return Promise.reject(new MarketDataError('not_connected', 'Market data is not connected.'));
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new MarketDataError('timeout', 'Timed out waiting for Deriv market data.'));
      }, this.opts.requestTimeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send({ ...msg, req_id: reqId });
    });
  }

  /* --------------------------------- public ------------------------------- */

  isConnected(): boolean {
    return this.connected;
  }

  /** The full active-symbol catalogue, fetched once and cached per connection. */
  async getActiveSymbols(): Promise<ActiveSymbol[]> {
    if (this.activeSymbols) return this.activeSymbols;
    // A warm shared cache answers without touching the socket at all.
    if (this.cache) {
      const cached = await this.cache.get<ActiveSymbol[]>(CacheKeys.activeSymbols());
      if (cached && cached.length > 0) {
        this.activeSymbols = cached;
        return cached;
      }
    }
    if (!this.socket) await this.connect();
    if (this.activeSymbols) return this.activeSymbols;
    // The catalogue request was already fired on open; wait for it to land.
    return await new Promise<ActiveSymbol[]>((resolve) => {
      this.activeSymbolsWaiters.push(resolve);
    });
  }

  isKnownSymbol(symbol: string): boolean {
    return this.activeSymbols ? this.activeSymbols.some((s) => s.symbol === symbol) : true;
  }

  /**
   * The contract types Deriv currently offers for `symbol`, from `contracts_for`.
   *
   * This is the authority on symbol-specific availability: Deriv refuses a
   * proposal for a contract the symbol does not list, so guessing here would
   * only move the failure later. Results are cached briefly because the
   * catalogue changes slowly and a bot tick must not pay for it every time.
   */
  async contractsFor(symbol: string, options: { maxAgeMs?: number } = {}): Promise<AvailableContract[]> {
    const maxAge = options.maxAgeMs ?? CONTRACT_CATALOG_TTL_MS;
    const cached = this.contractCatalog.get(symbol);
    if (cached && this.opts.now() - cached.at < maxAge) return cached.contracts;

    const msg = await this.request({ contracts_for: symbol });
    const rows = msg?.contracts_for?.available;
    if (!Array.isArray(rows)) {
      throw new MarketDataError('deriv_error', 'Deriv returned no contract catalogue for this symbol.');
    }

    const contracts: AvailableContract[] = rows.map((row: any) => {
      const min = parseDuration(row?.min_contract_duration);
      const max = parseDuration(row?.max_contract_duration);
      const contractType = String(row?.contract_type ?? '');
      return {
        contractType,
        category: String(row?.contract_category ?? ''),
        barriers: Number(row?.barriers ?? 0) || 0,
        expiryType: String(row?.expiry_type ?? ''),
        minDuration: min?.value ?? null,
        maxDuration: max?.value ?? null,
        durationUnit: min?.unit ?? null,
        // Digit contracts are the `DIGIT*` family; Deriv names the prediction
        // in the proposal rather than the catalogue, so this is derived.
        requiresDigit: DIGIT_PREDICTION_TYPES.has(contractType as DerivContractType)
      };
    });

    // Deriv lists a contract type once per expiry variant (R_100 lists CALL/PUT
    // several times). Collapse to one row per type, keeping the most permissive
    // duration window, so callers see a stable set.
    const byType = new Map<string, AvailableContract>();
    for (const c of contracts) {
      const existing = byType.get(c.contractType);
      if (!existing) {
        byType.set(c.contractType, c);
        continue;
      }
      byType.set(c.contractType, {
        ...existing,
        barriers: Math.max(existing.barriers, c.barriers),
        minDuration:
          existing.minDuration === null
            ? c.minDuration
            : c.minDuration === null
              ? existing.minDuration
              : Math.min(existing.minDuration, c.minDuration),
        maxDuration:
          existing.maxDuration === null
            ? c.maxDuration
            : c.maxDuration === null
              ? existing.maxDuration
              : Math.max(existing.maxDuration, c.maxDuration)
      });
    }

    const collapsed = [...byType.values()].sort((a, b) => a.contractType.localeCompare(b.contractType));
    this.contractCatalog.set(symbol, { at: this.opts.now(), contracts: collapsed });
    return collapsed;
  }

  /**
   * Subscribes to a symbol's ticks. Returns an unsubscribe function. The
   * upstream subscription is shared: Deriv is told once per symbol however many
   * callers subscribe.
   */
  subscribeTicks(symbol: string, handler: TickHandler): () => void {
    let set = this.subscribers.get(symbol);
    const isFirst = !set;
    if (!set) {
      set = new Set();
      this.subscribers.set(symbol, set);
    }
    set.add(handler);
    if (isFirst && this.connected) {
      this.send({ ticks: symbol, subscribe: 1, req_id: this.nextReqId++ });
    }
    return () => {
      const s = this.subscribers.get(symbol);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.subscribers.delete(symbol);
        if (this.connected) this.send({ forget: symbol, req_id: this.nextReqId++ });
      }
    };
  }

  /** Latest snapshot for a symbol, or null if none has arrived yet. */
  getSnapshot(symbol: string): MarketSnapshot | null {
    return this.snapshots.get(symbol) ?? null;
  }

  /** A copy of the retained tick buffer, oldest first. */
  getTicks(symbol: string): MarketSnapshot[] {
    return [...(this.tickBuffers.get(symbol) ?? [])];
  }

  /**
   * Resolves with the next tick for a symbol, or rejects on timeout. Used to
   * obtain a fresh price at decision time rather than trusting a stale snapshot.
   */
  waitForTick(symbol: string, timeoutMs = this.opts.requestTimeoutMs): Promise<MarketSnapshot> {
    return new Promise((resolve, reject) => {
      const unsub = this.subscribeTicks(symbol, (t) => {
        clearTimeout(timer);
        unsub();
        resolve(t);
      });
      const timer = setTimeout(() => {
        unsub();
        reject(new MarketDataError('timeout', `No tick for ${symbol} within ${timeoutMs}ms.`));
      }, timeoutMs);
    });
  }

  /**
   * A snapshot that is fresh enough to act on, or null. Returns the cached
   * snapshot when it is already within `maxAgeMs`; otherwise waits briefly for
   * the next tick. Callers that need a fresh price at decision time use this
   * instead of trusting a possibly stale cache.
   */
  async freshSnapshot(symbol: string, maxAgeMs = 5_000, waitMs = 10_000): Promise<MarketSnapshot | null> {
    const cached = this.snapshots.get(symbol) ?? null;
    if (isSnapshotFresh(cached, maxAgeMs, this.opts.now())) return cached;
    try {
      return await this.waitForTick(symbol, waitMs);
    } catch {
      return null;
    }
  }

  /** Historical ticks for warm-up, oldest first. */
  async getTicksHistory(symbol: string, count = 500): Promise<MarketSnapshot[]> {
    if (!this.socket) await this.connect();
    const res = await this.request({ ticks_history: symbol, count, end: 'latest', style: 'ticks' });
    const prices: number[] = res?.history?.prices ?? [];
    const times: number[] = res?.history?.times ?? [];
    return prices.map((quote, i) => ({
      symbol,
      quote: Number(quote),
      bid: null,
      ask: null,
      epoch: Number(times[i] ?? 0),
      pipSize: res?.pip_size === undefined ? null : Number(res.pip_size),
      receivedAt: this.opts.now()
    }));
  }
}

/** True when a snapshot is no older than `maxAgeMs`, i.e. safe to act on. */
export function isSnapshotFresh(snapshot: MarketSnapshot | null, maxAgeMs: number, now = Date.now()): boolean {
  if (!snapshot) return false;
  return now - snapshot.receivedAt <= maxAgeMs;
}
