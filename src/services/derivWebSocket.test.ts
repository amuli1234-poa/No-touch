import test from 'node:test';
import assert from 'node:assert/strict';
import { DerivWebSocketService } from './derivWebSocket';
import { TIMEFRAME_MAP } from '../config/deriv';

/**
 * Regression guard for the subscription lifecycle when the operator switches
 * Volatility Index (or timeframe).
 *
 * The bug this locks down: cancelling a subscribe while its request was still in
 * flight left the upstream stream running forever. A user clicking quickly down
 * the instrument list accumulated one candle + one tick subscription per symbol
 * (10–16 live streams instead of 2), and the chart could keep receiving a stream
 * for an instrument it was no longer showing.
 */

interface SentMessage {
  [key: string]: unknown;
}

/**
 * A deterministic stand-in socket. Requests are answered on a microtask so tests
 * read like real async flow; `pause()`/`resume()` open a controllable window in
 * which a request is in flight and can be cancelled.
 */
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;

  readonly sent: SentMessage[] = [];
  private held: SentMessage[] = [];
  private paused = false;
  private opened = false;
  private nextSubId = 0;

  constructor() {
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.opened = true;
      this.onopen?.();
    });
  }

  send(raw: string) {
    const payload = JSON.parse(raw) as SentMessage;
    this.sent.push(payload);
    if (this.paused) this.held.push(payload);
    else queueMicrotask(() => this.respond(payload));
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  /** Withhold responses so a request can be observed (and cancelled) in flight. */
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    const held = this.held;
    this.held = [];
    for (const payload of held) this.respond(payload);
  }

  get isOpen() {
    return this.opened;
  }

  /** Upstream subscription ids the service asked the gateway to forget. */
  get forgotten(): string[] {
    return this.sent
      .filter((m) => typeof m.forget === 'string')
      .map((m) => m.forget as string);
  }

  private emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  private respond(req: SentMessage) {
    const reqId = req.req_id as number;
    if (typeof req.active_symbols === 'string') {
      this.emit({ req_id: reqId, msg_type: 'active_symbols', active_symbols: [] });
      return;
    }
    if (typeof req.ticks_history === 'string') {
      const symbol = req.ticks_history;
      const granularity = req.granularity as number;
      const response: Record<string, unknown> = {
        req_id: reqId,
        msg_type: 'candles',
        candles: [
          { epoch: 1, open: 1, high: 1, low: 1, close: 1 },
          { epoch: 1 + granularity, open: 1, high: 1, low: 1, close: 1 },
        ],
      };
      if (req.subscribe === 1) {
        response.subscription = { id: `cand:${symbol}:${granularity}:${++this.nextSubId}` };
      }
      this.emit(response);
      return;
    }
    if (typeof req.ticks === 'string') {
      const symbol = req.ticks;
      this.emit({
        req_id: reqId,
        msg_type: 'tick',
        subscription: { id: `tick:${symbol}:${++this.nextSubId}` },
        tick: { symbol, epoch: 1, quote: 1 },
      });
      return;
    }
    if (typeof req.forget === 'string') {
      this.emit({ req_id: reqId, msg_type: 'forget', forget: req.forget });
    }
  }
}

const OriginalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

function installFakeWebSocket(): { sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  (globalThis as { WebSocket: unknown }).WebSocket = class extends FakeSocket {
    constructor(_url: string) {
      super();
      sockets.push(this);
    }
  } as unknown as typeof WebSocket;
  return { sockets };
}

function restoreWebSocket() {
  (globalThis as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function connectedService(): Promise<{ svc: DerivWebSocketService; socket: FakeSocket }> {
  const { sockets } = installFakeWebSocket();
  const svc = new DerivWebSocketService();
  await svc.fetchSyntheticMarkets();
  return { svc, socket: sockets[sockets.length - 1] };
}

test('switching instrument mid-flight forgets the orphaned candle subscription', async () => {
  const { svc, socket } = await connectedService();
  try {
    socket.pause();
    const inFlight = svc.subscribeCandles('R_10', 300, 5);
    await tick();
    // The user switches away before the R_10 request has resolved.
    await svc.unsubscribeCandleSubscription('R_10', 300);
    socket.resume();
    await inFlight;

    assert.equal(
      svc.getDiagnostics().activeSubscriptions,
      0,
      'a cancelled candle subscription must not remain registered'
    );
    assert.deepEqual(
      socket.forgotten,
      ['cand:R_10:300:1'],
      'the id the server issued for the abandoned request must be forgotten'
    );
  } finally {
    svc.disconnect();
    restoreWebSocket();
  }
});

test('switching instrument mid-flight forgets the orphaned tick subscription', async () => {
  const { svc, socket } = await connectedService();
  try {
    socket.pause();
    const inFlight = svc.subscribeTicks('R_25');
    await tick();
    await svc.unsubscribeTicks('R_25');
    socket.resume();
    await inFlight;

    assert.equal(svc.getDiagnostics().activeSubscriptions, 0);
    assert.deepEqual(socket.forgotten, ['tick:R_25:1']);
  } finally {
    svc.disconnect();
    restoreWebSocket();
  }
});

test('a replaced candle subscription forgets the id it supersedes', async () => {
  const { svc, socket } = await connectedService();
  try {
    await svc.subscribeCandles('R_50', 300, 5);
    const forgottenAfterFirst = socket.forgotten;
    assert.deepEqual(forgottenAfterFirst, [], 'the first subscribe had nothing to forget');

    // Re-subscribing the same key returns a fresh id; the old one must be released.
    socket.pause();
    const second = svc.subscribeCandles('R_50', 300, 5);
    await tick();
    socket.resume();
    await second;

    assert.ok(
      socket.forgotten.includes('cand:R_50:300:1'),
      'the superseded id must be forgotten'
    );
    assert.equal(svc.getDiagnostics().activeSubscriptions, 1);
  } finally {
    svc.disconnect();
    restoreWebSocket();
  }
});

test('rapidly switching across every volatility keeps exactly one candle + one tick stream', async () => {
  const { svc, socket } = await connectedService();
  try {
    const symbols = [
      'R_10',
      'R_25',
      'R_50',
      'R_75',
      'R_100',
      '1HZ10V',
      '1HZ25V',
      '1HZ50V',
      '1HZ100V',
    ];
    let active: { symbol: string; granularity: number } | null = null;
    let latestRequest = 0;

    // Mirror the hook: cancel the previous stream, subscribe the next, and only open
    // the tick stream once the request is confirmed current.
    const switchTo = async (symbol: string) => {
      const reqSeq = ++latestRequest;
      const granularity = TIMEFRAME_MAP.M5.granularitySec;
      if (active) {
        void svc.unsubscribeCandleSubscription(active.symbol, active.granularity);
        void svc.unsubscribeTicks(active.symbol);
      }
      active = { symbol, granularity };
      await svc.subscribeCandles(symbol, granularity, 5);
      if (latestRequest !== reqSeq) return;
      void svc.subscribeTicks(symbol);
    };

    // Click quickly: start each switch and let the next one supersede it mid-flight.
    socket.pause();
    for (const symbol of symbols) {
      void switchTo(symbol);
      await tick();
    }
    socket.resume();
    await tick();
    await tick();

    assert.equal(
      svc.getDiagnostics().activeSubscriptions,
      2,
      'only the final instrument may keep a candle + tick stream open'
    );
    const orphaned = socket.forgotten;
    assert.ok(
      orphaned.length >= symbols.length - 1,
      `expected each abandoned stream to be forgotten, got ${JSON.stringify(orphaned)}`
    );
  } finally {
    svc.disconnect();
    restoreWebSocket();
  }
});
