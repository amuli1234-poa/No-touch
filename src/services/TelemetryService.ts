/**
 * Client telemetry sender.
 *
 * The scanner runs entirely in the browser, so the server can only learn what
 * the engines do if the client tells it. This service batches that information
 * and posts it to `/api/telemetry/*`.
 *
 * Design rules, in priority order:
 *  1. Never interfere with trading. Every call is fire-and-forget, errors are
 *     swallowed, and nothing here is awaited on a user path. If telemetry is
 *     down the scanner behaves exactly as before.
 *  2. Send little. Events are queued in memory and flushed on a timer (or when
 *     the tab is hidden), in batches, so a burst of signals is one request.
 *  3. Send nothing sensitive. Only an event kind, a symbol/timeframe and small
 *     counters. No balances, no account ids, no token.
 *
 * The session id identifies one running scanner, so the server can count
 * "active scanners now" and attribute signals to a run.
 */

type EventKind =
  | 'scan.started'
  | 'scan.stopped'
  | 'signal.generated'
  | 'engine.error'
  | 'settings.changed'
  | 'app.opened';

interface QueuedEvent {
  kind: EventKind;
  /** Always the page-load session, so the server can attribute events to a run. */
  sessionId: string;
  symbol?: string;
  timeframe?: string;
  metrics?: Record<string, number>;
}

const FLUSH_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 45_000;
const MAX_QUEUE = 200;

/** One id per page load = one scanner session. */
const SESSION_ID = `ss_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

class TelemetryService {
  private queue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private scanning = false;
  private currentSymbols: string[] = [];
  private currentTimeframes: string[] = [];

  /** Idempotent. Safe to call from a mount effect. */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);

    // Flush what we have when the tab is hidden or closed; a lost batch is
    // acceptable, but this keeps recent activity accurate.
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);

    this.track('app.opened');
    void this.heartbeat();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.heartbeatTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    void this.flush();
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') void this.flush();
  };

  private onPageHide = (): void => {
    void this.flush();
  };

  /** Records that a scan run started or stopped, with its scope. */
  setScanning(scanning: boolean, symbols: string[], timeframes: string[]): void {
    this.currentSymbols = symbols.slice(0, 25);
    this.currentTimeframes = timeframes.slice(0, 10);
    if (scanning === this.scanning) return;
    this.scanning = scanning;
    this.track(scanning ? 'scan.started' : 'scan.stopped', {
      metrics: { symbols: this.currentSymbols.length }
    });
    void this.heartbeat();
  }

  /** Records a generated signal. */
  signal(symbol: string, timeframe: string, score: number): void {
    this.track('signal.generated', { symbol, timeframe, metrics: { score } });
  }

  /**
   * Records an engine/scanner error. Deliberately carries no message text — the
   * server only needs to count errors, and storing client-authored strings would
   * widen the attack surface for no analytical gain.
   */
  error(): void {
    this.track('engine.error');
  }

  /** Records a user settings change (no values — just that it happened). */
  settingsChanged(): void {
    this.track('settings.changed');
  }

  private track(kind: EventKind, extra: Partial<Omit<QueuedEvent, 'kind' | 'sessionId'>> = {}): void {
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({ kind, sessionId: SESSION_ID, ...extra });
  }

  /** Posts the queued events and clears them. Never throws. */
  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    try {
      await fetch('/api/telemetry/events', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch })
      });
    } catch {
      // Telemetry is best-effort; dropping the batch is the correct failure.
    }
  }

  /** Reports that this scanner is still running. Never throws. */
  private async heartbeat(): Promise<void> {
    try {
      await fetch('/api/telemetry/heartbeat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          symbols: this.currentSymbols,
          timeframes: this.currentTimeframes
        })
      });
    } catch {
      // ignore
    }
  }
}

/** App-wide singleton. */
export const telemetry = new TelemetryService();
