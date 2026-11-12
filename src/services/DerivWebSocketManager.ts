import { Candle, ActiveSymbol, Timeframe } from '../types/scanner';

export type TickListener = (symbol: string, tick: { epoch: number; quote: number }) => void;
export type CandleListener = (
  symbol: string,
  timeframe: Timeframe,
  candle: Candle,
  isClosed: boolean
) => void;
export type ConnectionStateListener = (state: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => void;

export class DerivWebSocketManager {
  private ws: WebSocket | null = null;
  private appId: number;
  private endpointIndex = 0;
  private retryCount = 0;
  private pingIntervalMs = 25000;
  private pingTimer: any = null;
  private staleCheckTimer: any = null;
  private reconnectTimer: any = null;
  private isDestroyed = false;

  public activeSymbols: Map<string, ActiveSymbol> = new Map();
  private ticksSubscribed: Set<string> = new Set();
  private lastTickEpoch: Map<string, number> = new Map();

  // Multi-timeframe historical buffers: symbol -> timeframe -> Candle[]
  public candles: Map<string, Map<Timeframe, Candle[]>> = new Map();

  private tickListeners: Set<TickListener> = new Set();
  private candleListeners: Set<CandleListener> = new Set();
  private connectionListeners: Set<ConnectionStateListener> = new Set();
  private proposalResolvers: Map<string, (val: any) => void> = new Map();

  public connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' = 'DISCONNECTED';
  public currentEndpoint: string = '';

  constructor(appId: number = 1089) {
    this.appId = appId;
    this.seedDefaultSymbols();
    this.initSocket();
    this.startStaleWatchdog();
  }

  private seedDefaultSymbols() {
    const defaults: { symbol: string; displayName: string; is1s: boolean }[] = [
      { symbol: 'R_10', displayName: 'Volatility 10 Index', is1s: false },
      { symbol: 'R_25', displayName: 'Volatility 25 Index', is1s: false },
      { symbol: 'R_50', displayName: 'Volatility 50 Index', is1s: false },
      { symbol: 'R_75', displayName: 'Volatility 75 Index', is1s: false },
      { symbol: 'R_100', displayName: 'Volatility 100 Index', is1s: false },
      { symbol: '1HZ10V', displayName: 'Volatility 10 (1s) Index', is1s: true },
      { symbol: '1HZ15V', displayName: 'Volatility 15 (1s) Index', is1s: true },
      { symbol: '1HZ25V', displayName: 'Volatility 25 (1s) Index', is1s: true },
      { symbol: '1HZ30V', displayName: 'Volatility 30 (1s) Index', is1s: true },
      { symbol: '1HZ50V', displayName: 'Volatility 50 (1s) Index', is1s: true },
      { symbol: '1HZ75V', displayName: 'Volatility 75 (1s) Index', is1s: true },
      { symbol: '1HZ90V', displayName: 'Volatility 90 (1s) Index', is1s: true },
      { symbol: '1HZ100V', displayName: 'Volatility 100 (1s) Index', is1s: true }
    ];

    defaults.forEach((d) => {
      this.activeSymbols.set(d.symbol, {
        symbol: d.symbol,
        displayName: d.displayName,
        market: 'synthetic_index',
        is1s: d.is1s,
        isOpen: true,
        pipSize: 0.01,
        isStale: false
      });
      if (!this.candles.has(d.symbol)) {
        this.candles.set(d.symbol, new Map());
      }
    });
  }

  private getEndpoints(): string[] {
    return [
      // Primary high-reliability public options endpoint (unblocked by Cloudflare)
      'wss://api.derivws.com/trading/v1/options/ws/public',
      // Secondary standard Deriv endpoint
      `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}&l=en&brand=deriv`,
      // Tertiary fallback endpoint
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
        // ignore
      }
      this.ws = null;
    }
    this.ticksSubscribed.clear();
    this.retryCount = 0;
    this.initSocket();
  }

  private initSocket() {
    if (this.isDestroyed) return;

    this.setConnectionState(
      this.connectionState === 'DISCONNECTED' ? 'RECONNECTING' : 'RECONNECTING'
    );

    const endpoints = this.getEndpoints();
    this.currentEndpoint = endpoints[this.endpointIndex % endpoints.length];

    try {
      this.ws = new WebSocket(this.currentEndpoint);

      this.ws.onopen = () => {
        this.setConnectionState('CONNECTED');
        this.retryCount = 0;
        this.startHeartbeat();
        this.fetchActiveSymbols();

        // Resubscribe to existing symbols
        this.activeSymbols.forEach((s) => {
          if (s.isOpen) {
            this.subscribeMarket(s.symbol);
          }
        });
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch {
          // parse error ignored
        }
      };

      this.ws.onclose = () => {
        this.setConnectionState('DISCONNECTED');
        this.stopHeartbeat();

        if (!this.isDestroyed) {
          this.retryCount++;
          // If persistent failure on current endpoint, switch to fallback
          if (this.retryCount >= 2) {
            this.endpointIndex = (this.endpointIndex + 1) % endpoints.length;
          }

          // Exponential backoff with ceiling (2s -> 3s -> 4.5s ... max 20s)
          const delay = Math.min(20000, 2000 * Math.pow(1.5, Math.min(this.retryCount, 6)));
          this.reconnectTimer = setTimeout(() => this.initSocket(), delay);
        }
      };

      this.ws.onerror = () => {
        // Standard browser Event; onclose automatically fires immediately after onerror
        // Do not call console.error(err) which outputs {"isTrusted":true}
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

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
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
      this.activeSymbols.forEach((sym) => {
        const last = this.lastTickEpoch.get(sym.symbol);
        if (last && now - last > 20) {
          sym.isStale = true;
        } else if (last) {
          sym.isStale = false;
        }
      });
    }, 5000);
  }

  private fetchActiveSymbols() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Sent without product_type for maximum compatibility across all Deriv endpoints
      this.ws.send(
        JSON.stringify({
          active_symbols: 'brief'
        })
      );
    }
  }

  private handleMessage(data: any) {
    const msgType = data.msg_type;

    if (msgType === 'active_symbols') {
      this.processActiveSymbols(data.active_symbols || []);
    } else if (msgType === 'tick') {
      this.processIncomingTick(data.tick);
    } else if (msgType === 'candles') {
      this.processHistoricalCandles(data);
    } else if (msgType === 'proposal') {
      const reqId = data.echo_req?.req_id;
      if (reqId) {
        const resolver = this.proposalResolvers.get(reqId);
        if (resolver) {
          resolver(data);
          this.proposalResolvers.delete(reqId);
        }
      }
    }
  }

  private processActiveSymbols(rawSymbols: any[]) {
    const targetPatterns = [
      'R_10', 'R_15', 'R_25', 'R_30', 'R_50', 'R_75', 'R_90', 'R_100',
      '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V'
    ];

    for (const sym of rawSymbols) {
      if (sym.market !== 'synthetic_index') continue;

      // Handle both standard symbol and options api underlying_symbol fields
      const symName: string = sym.symbol || sym.underlying_symbol || '';
      if (!symName) continue;

      const isTarget = targetPatterns.some(
        (pattern) => symName === pattern || symName.startsWith(pattern)
      );
      const isVolatilityIndex =
        sym.submarket === 'random_index' ||
        sym.subgroup === 'synthetics' ||
        symName.startsWith('R_') ||
        symName.startsWith('1HZ');

      if (!isTarget && !isVolatilityIndex) continue;

      const is1s = symName.startsWith('1HZ') || symName.includes('1S');
      const displayName = sym.display_name || sym.underlying_symbol_name || symName;
      const pipSize = sym.pip ? Math.pow(10, -sym.pip) : (sym.pip_size || 0.01);
      const isOpen = !sym.is_trading_suspended && sym.exchange_is_open === 1;

      const existing = this.activeSymbols.get(symName);
      const item: ActiveSymbol = {
        symbol: symName,
        displayName,
        market: sym.market,
        is1s,
        isOpen,
        pipSize,
        isStale: false,
        lastQuote: existing?.lastQuote,
        lastTickEpoch: existing?.lastTickEpoch
      };

      this.activeSymbols.set(symName, item);
      if (!this.candles.has(symName)) {
        this.candles.set(symName, new Map());
      }
    }

    // Subscribe to open markets
    this.activeSymbols.forEach((s) => {
      if (s.isOpen) {
        this.subscribeMarket(s.symbol);
      }
    });
  }

  public subscribeMarket(symbol: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ticksSubscribed.has(symbol)) return;

    // 1. Fetch initial 1-minute historical candles (500 candles = 8.3 hours)
    this.ws.send(
      JSON.stringify({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 500,
        end: 'latest',
        style: 'candles',
        granularity: 60
      })
    );

    // 2. Subscribe to continuous live tick stream
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
    const rawCandles = data.candles;
    if (!symbol || !Array.isArray(rawCandles)) return;

    const c1m: Candle[] = rawCandles.map((c: any) => ({
      epoch: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }));

    const symStore = this.candles.get(symbol) || new Map();
    symStore.set('1m', c1m);

    // Aggregate to 2m, 5m, 15m, 1h
    const c2m = this.aggregateCandles(c1m, 120);
    symStore.set('2m', c2m);
    symStore.set('5m', this.aggregateCandles(c1m, 300));
    symStore.set('15m', this.aggregateCandles(c1m, 900));
    symStore.set('1h', this.aggregateCandles(c1m, 3600));

    this.candles.set(symbol, symStore);

    // Update spot quote from latest candle close if not yet set by ticks
    const symInfo = this.activeSymbols.get(symbol);
    if (symInfo && c1m.length > 0) {
      const latestClose = c1m[c1m.length - 1].close;
      if (!symInfo.lastQuote) {
        symInfo.lastQuote = latestClose;
      }
    }

    // Immediately trigger candle listener so analysis can execute right away
    if (c2m.length > 0) {
      this.emitCandle(symbol, '2m', c2m[c2m.length - 1], true);
    }
  }

  private processIncomingTick(tick: any) {
    if (!tick) return;
    const symbol: string = tick.symbol || tick.underlying_symbol;
    if (!symbol) return;

    const epoch = Number(tick.epoch);
    const quote = Number(tick.quote);

    // Duplicate tick and non-monotonic protection
    const lastTime = this.lastTickEpoch.get(symbol) || 0;
    if (epoch < lastTime) return;
    this.lastTickEpoch.set(symbol, epoch);

    // Update active symbol quote
    const symInfo = this.activeSymbols.get(symbol);
    if (symInfo) {
      symInfo.lastQuote = quote;
      symInfo.lastTickEpoch = epoch;
      symInfo.isStale = false;
    }

    // Notify tick listeners
    this.tickListeners.forEach((l) => l(symbol, { epoch, quote }));

    // Feed and incrementally construct multi-timeframe candles
    this.updateMultiCandles(symbol, epoch, quote);
  }

  private updateMultiCandles(symbol: string, epoch: number, quote: number) {
    const symCandles = this.candles.get(symbol);
    if (!symCandles) return;

    const timeframes: { tf: Timeframe; period: number }[] = [
      { tf: '1m', period: 60 },
      { tf: '2m', period: 120 },
      { tf: '5m', period: 300 },
      { tf: '15m', period: 900 },
      { tf: '1h', period: 3600 }
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
        // Form current open candle
        activeCandle.high = Math.max(activeCandle.high, quote);
        activeCandle.low = Math.min(activeCandle.low, quote);
        activeCandle.close = quote;
        this.emitCandle(symbol, tf, activeCandle, false);
      } else if (bucketEpoch > activeCandle.epoch) {
        // Complete the previous candle
        this.emitCandle(symbol, tf, activeCandle, true);

        // Open a new forming candle
        const freshCandle: Candle = {
          epoch: bucketEpoch,
          open: quote,
          high: quote,
          low: quote,
          close: quote
        };
        list.push(freshCandle);
        if (list.length > 500) list.shift();
        symCandles.set(tf, list);
        this.emitCandle(symbol, tf, freshCandle, false);
      }
    }
  }

  private aggregateCandles(source1m: Candle[], targetSeconds: number): Candle[] {
    const result: Candle[] = [];
    let currentBucket: Candle | null = null;

    for (const c of source1m) {
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

  /**
   * Queries real No Touch contract proposal directly from Deriv official API
   */
  public async getNoTouchProposal(
    symbol: string,
    barrierOffsetStr: string,
    durationMinutes: number,
    amount: number = 10
  ): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection is not open.');
    }

    const isOptionsApi = this.currentEndpoint.includes('api.derivws.com');
    const reqId = `prop_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;

    // Send underlying_symbol for options api, or symbol for standard v3
    const req: Record<string, any> = {
      proposal: 1,
      amount,
      basis: 'stake',
      currency: 'USD',
      contract_type: 'NOTOUCH',
      barrier: barrierOffsetStr,
      duration: durationMinutes,
      duration_unit: 'm',
      req_id: reqId
    };

    if (isOptionsApi) {
      req.underlying_symbol = symbol;
    } else {
      req.symbol = symbol;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.proposalResolvers.delete(reqId);
        reject(new Error(`Deriv proposal request timed out for barrier ${barrierOffsetStr}`));
      }, 6000);

      this.proposalResolvers.set(reqId, (response) => {
        clearTimeout(timeout);
        if (response.error) {
          reject(new Error(response.error.message || 'Deriv proposal rejected.'));
        } else {
          resolve(response.proposal);
        }
      });

      this.ws!.send(JSON.stringify(req));
    });
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
    return Array.from(this.activeSymbols.values());
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
