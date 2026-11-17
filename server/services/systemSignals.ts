import type { SignalDirection } from '../execution/types.js';

/**
 * SYSTEM SIGNAL BRIDGE.
 *
 * The automatic trader no longer invents its own signals from raw ticks. The
 * dashboard's own scanner publishes every confirmed signal it produces — the
 * same setups shown in the Best Signal panel, the signal feed and the
 * performance table, each carrying its entry, stop-loss and take-profit markers
 * — and this service is where those publications land.
 *
 * It keeps a per-user ledger keyed by the setup's stable identity, so a setup
 * that keeps being re-published is never traded twice, plus a pointer to the
 * newest publication for the "best signal" surface. It has no authority of its
 * own: it never buys anything. The route that publishes here hands each new
 * signal to the same automatic runner a manual trade goes through.
 */

export interface PublishedSystemSignal {
  id: string;
  userId: string;
  symbol: string;
  displayName: string;
  direction: SignalDirection;
  timeframe: string;
  /** 0–100 quality score from the dashboard's central ranking. */
  confidence: number;
  /** Chart markers only — shown on the chart, never sent to Deriv. */
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Stable identity of the setup, so re-publications of it dedupe. */
  setupKey: string;
  /** Which dashboard surface produced it (scanner, analyser, co-analysis…). */
  source: string;
  publishedAt: number;
  executedAt: number | null;
  executedSignalId: string | null;
  outcome: string | null;
}

export interface PublishSystemSignalInput {
  userId: string;
  symbol: string;
  displayName: string;
  direction: SignalDirection;
  timeframe: string;
  confidence: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  setupKey: string;
  source: string;
}

export interface SystemSignalOptions {
  /** How long a publication stays "current" before it is treated as stale. */
  ttlMs?: number;
  /** How many recent publications to keep for the status surface. */
  historyLimit?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 180_000;
const DEFAULT_HISTORY_LIMIT = 20;

export class SystemSignalService {
  /** Keyed `${userId}|${setupKey}` so a setup is recorded once and deduped. */
  private readonly ledger = new Map<string, PublishedSystemSignal>();
  /** Newest publication per user, for the "best signal" surface. */
  private readonly latest = new Map<string, PublishedSystemSignal>();
  private readonly ttlMs: number;
  private readonly historyLimit: number;
  private readonly now: () => number;
  private counter = 0;

  constructor(options: SystemSignalOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.now = options.now ?? (() => Date.now());
  }

  private static key(userId: string, setupKey: string): string {
    return `${userId}|${setupKey}`;
  }

  /** Drops entries older than the TTL so the ledger cannot grow without bound. */
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, record] of this.ledger) {
      if (record.publishedAt < cutoff) this.ledger.delete(key);
    }
  }

  /**
   * Records a confirmed signal from the dashboard. A re-publication of the same
   * setup (same setupKey) is a no-op that preserves the executed marker, so a
   * setup that keeps surfacing is never traded twice. Returns the stored record.
   */
  publish(input: PublishSystemSignalInput): PublishedSystemSignal {
    this.prune();
    const key = SystemSignalService.key(input.userId, input.setupKey);
    const existing = this.ledger.get(key);
    if (existing) {
      // Refresh the recency without disturbing the executed state.
      existing.publishedAt = this.now();
      this.latest.set(input.userId, existing);
      return existing;
    }
    const record: PublishedSystemSignal = {
      id: `sys_${this.now()}_${this.counter++}`,
      userId: input.userId,
      symbol: input.symbol,
      displayName: input.displayName,
      direction: input.direction,
      timeframe: input.timeframe,
      confidence: input.confidence,
      entryPrice: input.entryPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      setupKey: input.setupKey,
      source: input.source,
      publishedAt: this.now(),
      executedAt: null,
      executedSignalId: null,
      outcome: null
    };
    this.ledger.set(key, record);
    this.latest.set(input.userId, record);
    return record;
  }

  /** The newest non-stale publication for a user, or null. */
  current(userId: string): PublishedSystemSignal | null {
    this.prune();
    const record = this.latest.get(userId);
    if (!record) return null;
    if (this.now() - record.publishedAt > this.ttlMs) return null;
    return record;
  }

  /** True when this exact setup has already been traded. */
  isTraded(userId: string, setupKey: string): boolean {
    this.prune();
    const record = this.ledger.get(SystemSignalService.key(userId, setupKey));
    return record !== undefined && record.executedAt !== null;
  }

  /** Marks a setup as traded, recording the outcome. */
  markExecuted(userId: string, setupKey: string, signalId: string, outcome: string): void {
    const record = this.ledger.get(SystemSignalService.key(userId, setupKey));
    if (!record) return;
    record.executedAt = this.now();
    record.executedSignalId = signalId;
    record.outcome = outcome;
  }

  /** Recent publications for the status surface, oldest first. */
  recent(userId: string): readonly PublishedSystemSignal[] {
    this.prune();
    return [...this.ledger.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.publishedAt - b.publishedAt)
      .slice(-this.historyLimit);
  }

  /** Drops every publication (used by tests and on shutdown). */
  clear(): void {
    this.ledger.clear();
    this.latest.clear();
  }
}
