import { Candle, ActiveSymbol, Timeframe } from '../types/scanner';

export type TickListener = (symbol: string, tick: { epoch: number; quote: number }) => void;
export type CandleListener = (
  symbol: string,
  timeframe: Timeframe,
  candle: Candle,
  isClosed: boolean
) => void;
export type ConnectionStateListener = (state: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => void;

export interface ConnectionHealthMetrics {
  state: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  endpoint: string;
  latencyMs: number | null;
  totalMissedTicks: number;
  lastMessageEpoch: number | null;
  staleCount: number;
}

export class DerivWebSocketManager {
  private ws: WebSocket | null = null;
  private appId: number;
  private endpointIndex = 0;
  private retryCount = 0;
  private pingIntervalMs = 20000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isDestroyed = false;

  public activeSymbols: Map<string, ActiveSymbol> = new Map();
  private ticksSubscribed: Set<string> = new Set();
  private lastTickEpoch: Map<string, number> = new Map();
  private missedTicksCount: Map<string, number> = new Map();
  private h4Fetched: Set<string> = new Set();
  private h1Fetched: Set<string> = new Set();

  // Multi-timeframe historical buffers: symbol -> timeframe ('1m'|'5m'|'15m'|'1h'|'4h') -> Candle[]
  public candles: Map<string, Map<Timeframe, Candle[]>> = new Map();

  private tickListeners: Set<TickListener> = new Set();
  private candleListeners: Set<CandleListener> = new Set();
  private connectionListeners: Set<ConnectionStateListener> = new Set();

  public connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' = 'DISCONNECTED';
  public currentEndpoint: string = '';
  public lastLatencyMs: number | null = null;
  public lastMessageEpoch: number | null = null;
  private lastPingSentAt: number | null = null;

  constructor(appId: number = 1089) {
    this.appId = appId;
    this.initSocket();
    this.startStaleWatchdog();
  }

  private getEndpoints(): string[] {
    return [
      'wss://api.derivws.com/trading/v1/options/ws/public',
      `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}&l=en&brand=deriv`,
      `wss://ws.binaryws.com/websockets/v3?app_id=${this.appId}&l=en&brand=deriv`
    ];
  }

  public updateAppId(newAppId: number) {
    if (newAppId !== this.appId) {
      this.appId = newAppId;
      this.reconnect();
    }
  }

  public reconnect() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
    this.ticksSubscribed.clear();
    this.h4Fetched.clear();
    this.h1Fetched.clear();
    this.retryCount = 0;
    this.initSocket();
  }

  private initSocket() {
    if (this.isDestroyed) return;

    this.setConnectionState('RECONNECTING');

    const endpoints = this.getEndpoints();
    this.currentEndpoint = endpoints[this.endpointIndex % endpoints.length];

    try {
      this.ws = new WebSocket(this.currentEndpoint);

      this.ws.onopen = () => {
        this.setConnectionState('CONNECTED');
        this.retryCount = 0;
        this.sendPing();
        this.startHeartbeat();
        this.fetchActiveSymbols();

        this.activeSymbols.forEach((s) => {
          if (s.isOpen) {
            this.subscribeMarket(s.symbol);
          }
        });
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.lastMessageEpoch = Math.floor(Date.now() / 1000);
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch {
          // ignore malformed payload
        }
      };

      this.ws.onclose = () => {
        this.setConnectionState('DISCONNECTED');
        this.stopHeartbeat();

        if (!this.isDestroyed) {
          this.retryCount++;
          if (this.retryCount >= 2) {
            this.endpointIndex = (this.endpointIndex + 1) % endpoints.length;
          }
          const delay = Math.min(20000, 1500 * Math.pow(1.5, Math.min(this.retryCount, 6)));
          this.reconnectTimer = setTimeout(() => this.initSocket(), delay);
        }
      };

      this.ws.onerror = () => {
        // Handled in onclose
      };
    } catch {
      this.setConnectionState('DISCONNECTED');
      if (!this.isDestroyed) {
        this.endpointIndex = (this.endpointIndex + 1) % endpoints.length;
        this.reconnectTimer = setTimeout(() => this.initSocket(), 3000);
      }
    }
  }

  private setConnectionState(state: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') {
    this.connectionState = state;
    this.connectionListeners.forEach((l) => l(state));
  }

  private sendPing() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.lastPingSentAt = performance.now();
      this.ws.send(JSON.stringify({ ping: 1 }));
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, this.pingIntervalMs);
  }

  private stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startStaleWatchdog() {
    this.staleCheckTimer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      let openCount = 0;
      let staleOpenCount = 0;

      this.activeSymbols.forEach((sym) => {
        if (sym.isOpen) openCount++;
        const last = this.lastTickEpoch.get(sym.symbol);
        const thresholdSec = sym.is1s ? 10 : 20;
        if (last && now - last > thresholdSec) {
          sym.isStale = true;
          if (sym.isOpen) staleOpenCount++;
        } else if (last) {
          sym.isStale = false;
        }
      });

      // Detect silent feed drop / missing ticks across all open markets and reconnect cleanly
      if (
        !this.isDestroyed &&
        this.connectionState === 'CONNECTED' &&
        this.lastMessageEpoch &&
        now - this.lastMessageEpoch > 18 &&
        openCount > 0 &&
        staleOpenCount === openCount
      ) {
        this.reconnect();
      }
    }, 4000);
  }

  private fetchActiveSymbols() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ active_symbols: 'brief' }));
    }
  }

  private handleMessage(data: any) {
    const msgType = data.msg_type;

    if (msgType === 'ping' || data.ping === 'pong') {
      if (this.lastPingSentAt !== null) {
        this.lastLatencyMs = Math.max(1, Math.round(performance.now() - this.lastPingSentAt));
        this.lastPingSentAt = null;
      }
      return;
    }

    if (msgType === 'active_symbols') {
      this.processActiveSymbols(data.active_symbols || []);
    } else if (msgType === 'tick') {
      this.processIncomingTick(data.tick);
    } else if (msgType === 'candles') {
      this.processHistoricalCandles(data);
    }
  }

  /**
   * Filters strictly to Plain Volatility Indices and Volatility 1-second Indices.
   */
  public static isSupportedVolatilitySymbol(symName: string, market?: string): boolean {
    if (market && market !== 'synthetic_index') return false;
    const upper = symName.toUpperCase();

    if (
      upper.includes('JD') ||
      upper.includes('STP') ||
      upper.includes('BOOM') ||
      upper.includes('CRASH') ||
      upper.includes('RDB') ||
      upper.includes('WL') ||
      upper.includes('DEX')
    ) {
      return false;
    }

    const isPlainVol = /^R_(10|15|25|30|50|75|90|100)$/.test(upper);
    const isOneSecVol = /^1HZ(10|15|25|30|50|75|90|100)V$/.test(upper);
    return isPlainVol || isOneSecVol;
  }

  private processActiveSymbols(rawSymbols: any[]) {
    for (const sym of rawSymbols) {
      const symName: string = sym.symbol || sym.underlying_symbol || '';
      if (!symName) continue;
      if (!DerivWebSocketManager.isSupportedVolatilitySymbol(symName, sym.market)) continue;

      const is1s = symName.toUpperCase().startsWith('1HZ');
      const displayName = sym.display_name || sym.underlying_symbol_name || symName;
      const pipSize =
        typeof sym.pip === 'number'
          ? Math.pow(10, -sym.pip)
          : typeof sym.pip_size === 'number'
          ? sym.pip_size
          : 0.01;
      const isOpen = !sym.is_trading_suspended && sym.exchange_is_open === 1;

      const existing = this.activeSymbols.get(symName);
      const item: ActiveSymbol = {
        symbol: symName,
        displayName,
        market: sym.market || 'synthetic_index',
        is1s,
        isOpen,
        pipSize,
        isStale: existing?.isStale ?? false,
        lastQuote: existing?.lastQuote,
        lastTickEpoch: existing?.lastTickEpoch,
        missedTicks: existing?.missedTicks ?? 0,
        lastLatencyMs: this.lastLatencyMs ?? existing?.lastLatencyMs
      };

      this.activeSymbols.set(symName, item);
      if (!this.candles.has(symName)) {
        this.candles.set(symName, new Map());
      }
    }

    this.activeSymbols.forEach((s) => {
      if (s.isOpen) {
        this.subscribeMarket(s.symbol);
      }
    });
  }

  public subscribeMarket(symbol: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // 1. Fetch 4-hour historical candles (180 bars = 30 days for macro 4H structure)
    if (!this.h4Fetched.has(symbol)) {
      this.ws.send(
        JSON.stringify({
          ticks_history: symbol,
          adjust_start_time: 1,
          count: 180,
          end: 'latest',
          style: 'candles',
          granularity: 14400
        })
      );
      this.h4Fetched.add(symbol);
    }

    // 2. Fetch 1-hour historical candles (240 bars = 10 days for 1H structure & valid trading ranges)
    if (!this.h1Fetched.has(symbol)) {
      this.ws.send(
        JSON.stringify({
          ticks_history: symbol,
          adjust_start_time: 1,
          count: 240,
          end: 'latest',
          style: 'candles',
          granularity: 3600
        })
      );
      this.h1Fetched.add(symbol);
    }

    if (this.ticksSubscribed.has(symbol)) return;

    // 3. Fetch 1-minute historical candles (1500 bars = 25 hours -> 300 5m bars, 100 15m bars, 1500 1m bars)
    this.ws.send(
      JSON.stringify({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 1500,
        end: 'latest',
        style: 'candles',
        granularity: 60
      })
    );

    // 4. Subscribe to live ticks
    this.ws.send(
      JSON.stringify({
        ticks: symbol,
        subscribe: 1
      })
    );

    this.ticksSubscribed.add(symbol);
  }

  private processHistoricalCandles(data: any) {
    const symbol = data.echo_req?.ticks_history || data.echo_req?.underlying_symbol;
    const granularity = Number(data.echo_req?.granularity || 60);
    const rawCandles = data.candles;
    if (!symbol || !Array.isArray(rawCandles)) return;

    const parsed: Candle[] = rawCandles
      .map((c: any) => ({
        epoch: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
      .filter((c) => Number.isFinite(c.epoch) && Number.isFinite(c.close) && c.epoch > 0)
      .sort((a, b) => a.epoch - b.epoch);

    const symStore = this.candles.get(symbol) || new Map<Timeframe, Candle[]>();

    if (granularity === 14400) {
      symStore.set('4h', parsed);
      this.candles.set(symbol, symStore);
      if (parsed.length > 0) {
        this.emitCandle(symbol, '4h', parsed[parsed.length - 1], true);
      }
      return;
    }

    if (granularity === 3600) {
      symStore.set('1h', parsed);
      if (!symStore.has('4h') || (symStore.get('4h')?.length || 0) === 0) {
        symStore.set('4h', this.aggregateCandles(parsed, 14400));
      }
      this.candles.set(symbol, symStore);
      if (parsed.length > 0) {
        this.emitCandle(symbol, '1h', parsed[parsed.length - 1], true);
      }
      return;
    }

    // Standard 1m batch -> aggregate strictly to 5m and 15m (plus fallback 1h/4h only if native not loaded yet)
    symStore.set('1m', parsed);
    const c5m = this.aggregateCandles(parsed, 300);
    const c15m = this.aggregateCandles(parsed, 900);

    symStore.set('5m', c5m);
    symStore.set('15m', c15m);

    if (!symStore.has('1h') || (symStore.get('1h')?.length || 0) === 0) {
      symStore.set('1h', this.aggregateCandles(parsed, 3600));
    }
    if (!symStore.has('4h') || (symStore.get('4h')?.length || 0) === 0) {
      symStore.set('4h', this.aggregateCandles(parsed, 14400));
    }

    this.candles.set(symbol, symStore);

    const symInfo = this.activeSymbols.get(symbol);
    if (symInfo && parsed.length > 0) {
      const latest = parsed[parsed.length - 1];
      if (!symInfo.lastQuote) {
        symInfo.lastQuote = latest.close;
      }
      if (!symInfo.lastTickEpoch) {
        symInfo.lastTickEpoch = latest.epoch;
      }
    }

    if (c5m.length > 0) {
      this.emitCandle(symbol, '5m', c5m[c5m.length - 1], true);
    }
  }

  private processIncomingTick(tick: any) {
    if (!tick) return;
    const symbol: string = tick.symbol || tick.underlying_symbol;
    if (!symbol) return;

    const epoch = Number(tick.epoch);
    const quote = Number(tick.quote);
    if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return;

    const lastTime = this.lastTickEpoch.get(symbol) || 0;
    if (epoch <= lastTime) return;

    const symInfo = this.activeSymbols.get(symbol);
    if (lastTime > 0 && symInfo) {
      const gap = epoch - lastTime;
      const expectedMaxGap = symInfo.is1s ? 3 : 6;
      if (gap > expectedMaxGap) {
        const missed = (this.missedTicksCount.get(symbol) || 0) + Math.floor(gap / (symInfo.is1s ? 1 : 2));
        this.missedTicksCount.set(symbol, missed);
        symInfo.missedTicks = missed;
      }
    }

    this.lastTickEpoch.set(symbol, epoch);

    if (symInfo) {
      symInfo.lastQuote = quote;
      symInfo.lastTickEpoch = epoch;
      symInfo.isStale = false;
      symInfo.lastLatencyMs = this.lastLatencyMs ?? symInfo.lastLatencyMs;
    }

    this.tickListeners.forEach((l) => l(symbol, { epoch, quote }));
    this.updateMultiCandles(symbol, epoch, quote);
  }

  private updateMultiCandles(symbol: string, epoch: number, quote: number) {
    const symCandles = this.candles.get(symbol);
    if (!symCandles) return;

    const timeframes: { tf: Timeframe; period: number }[] = [
      { tf: '1m', period: 60 },
      { tf: '5m', period: 300 },
      { tf: '15m', period: 900 },
      { tf: '1h', period: 3600 },
      { tf: '4h', period: 14400 }
    ];

    for (const { tf, period } of timeframes) {
      const list = symCandles.get(tf) || [];
      const bucketEpoch = Math.floor(epoch / period) * period;

      if (list.length === 0) {
        const newCandle: Candle = {
          epoch: bucketEpoch,
          open: quote,
          high: quote,
          low: quote,
          close: quote
        };
        list.push(newCandle);
        symCandles.set(tf, list);
        this.emitCandle(symbol, tf, newCandle, false);
        continue;
      }

      const activeCandle = list[list.length - 1];

      if (activeCandle.epoch === bucketEpoch) {
        activeCandle.high = Math.max(activeCandle.high, quote);
        activeCandle.low = Math.min(activeCandle.low, quote);
        activeCandle.close = quote;
        this.emitCandle(symbol, tf, activeCandle, false);
      } else if (bucketEpoch > activeCandle.epoch) {
        this.emitCandle(symbol, tf, activeCandle, true);

        const freshCandle: Candle = {
          epoch: bucketEpoch,
          open: quote,
          high: quote,
          low: quote,
          close: quote
        };
        list.push(freshCandle);
        if (list.length > 1500) list.shift();
        symCandles.set(tf, list);
        this.emitCandle(symbol, tf, freshCandle, false);
      }
    }
  }

  private aggregateCandles(source: Candle[], targetSeconds: number): Candle[] {
    const result: Candle[] = [];
    let currentBucket: Candle | null = null;

    for (const c of source) {
      const bucketEpoch = Math.floor(c.epoch / targetSeconds) * targetSeconds;
      if (!currentBucket || currentBucket.epoch !== bucketEpoch) {
        if (currentBucket) result.push(currentBucket);
        currentBucket = {
          epoch: bucketEpoch,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        };
      } else {
        currentBucket.high = Math.max(currentBucket.high, c.high);
        currentBucket.low = Math.min(currentBucket.low, c.low);
        currentBucket.close = c.close;
      }
    }
    if (currentBucket) result.push(currentBucket);
    return result;
  }

  private emitCandle(symbol: string, tf: Timeframe, c: Candle, isClosed: boolean) {
    this.candleListeners.forEach((l) => l(symbol, tf, { ...c }, isClosed));
  }

  public onTick(cb: TickListener) {
    this.tickListeners.add(cb);
  }
  public offTick(cb: TickListener) {
    this.tickListeners.delete(cb);
  }
  public onCandle(cb: CandleListener) {
    this.candleListeners.add(cb);
  }
  public offCandle(cb: CandleListener) {
    this.candleListeners.delete(cb);
  }
  public onConnectionChange(cb: ConnectionStateListener) {
    this.connectionListeners.add(cb);
  }
  public offConnectionChange(cb: ConnectionStateListener) {
    this.connectionListeners.delete(cb);
  }

  public getDiscoveredSymbols(): ActiveSymbol[] {
    return Array.from(this.activeSymbols.values()).sort((a, b) => {
      if (a.is1s !== b.is1s) return a.is1s ? 1 : -1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  public getHealthMetrics(): ConnectionHealthMetrics {
    let totalMissedTicks = 0;
    this.missedTicksCount.forEach((v) => {
      totalMissedTicks += v;
    });

    let staleCount = 0;
    this.activeSymbols.forEach((s) => {
      if (s.isStale) staleCount++;
    });

    return {
      state: this.connectionState,
      endpoint: this.currentEndpoint,
      latencyMs: this.lastLatencyMs,
      totalMissedTicks,
      lastMessageEpoch: this.lastMessageEpoch,
      staleCount
    };
  }

  public destroy() {
    this.isDestroyed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
