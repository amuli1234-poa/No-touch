/**
 * In-process operational telemetry for the monitoring centre.
 *
 * This measures the *real* running process: request counts, latency, error rate
 * and recent errors, plus a few domain counters incremented by the app. It is
 * intentionally honest — anything it cannot measure is reported as UNKNOWN by
 * the monitoring route rather than being estimated.
 *
 * NOTE: state is per-process. A multi-instance deployment needs a shared sink
 * (Prometheus/OTel); this is recorded in the security/limitations notes.
 */

export interface LatencySummary {
  count: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface RecentError {
  at: number;
  method: string;
  path: string;
  status: number;
  message: string | null;
}

export class Telemetry {
  readonly startedAt = Date.now();
  private totalRequests = 0;
  private totalErrors = 0;
  private readonly latencies: number[] = [];
  private readonly maxLatencySamples = 2000;
  private readonly recentErrors: RecentError[] = [];
  private readonly maxRecentErrors = 50;
  /** Domain counters other services increment (signals generated, etc.). */
  private readonly counters = new Map<string, number>();
  private readonly lastCounterAt = new Map<string, number>();

  recordRequest(method: string, path: string, status: number, durationMs: number, message?: string | null): void {
    this.totalRequests += 1;
    if (this.latencies.length >= this.maxLatencySamples) this.latencies.shift();
    this.latencies.push(durationMs);
    if (status >= 500) {
      this.totalErrors += 1;
      this.recentErrors.unshift({ at: Date.now(), method, path, status, message: message ?? null });
      if (this.recentErrors.length > this.maxRecentErrors) this.recentErrors.pop();
    }
  }

  increment(counter: string, by = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
    this.lastCounterAt.set(counter, Date.now());
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  counterLastAt(name: string): number | null {
    return this.lastCounterAt.get(name) ?? null;
  }

  get requestCount(): number {
    return this.totalRequests;
  }

  get errorCount(): number {
    return this.totalErrors;
  }

  get errorRate(): number {
    return this.totalRequests === 0 ? 0 : this.totalErrors / this.totalRequests;
  }

  latencySummary(): LatencySummary {
    if (this.latencies.length === 0) return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return {
      count: sorted.length,
      avgMs: Math.round((sum / sorted.length) * 100) / 100,
      p95Ms: Math.round(sorted[p95Index] * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100
    };
  }

  errors(limit = 20): RecentError[] {
    return this.recentErrors.slice(0, limit);
  }

  uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }
}

/** Express middleware that times every request and records it. */
export function telemetryMiddleware(telemetry: Telemetry) {
  return (req: any, res: any, next: any): void => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      // Health probes are excluded so they do not skew latency/error stats.
      if (req.path === '/healthz') return;
      telemetry.recordRequest(req.method, req.path, res.statusCode, durationMs);
    });
    next();
  };
}
