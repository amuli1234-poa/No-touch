import type { Store, UserRecord } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import { open } from '../lib/crypto.js';
import type { MarketDataService, MarketSnapshot, ActiveSymbol } from './marketData.js';
import { createSignal, SignalError } from './signals.js';
import type { AutoExecutionRunner, AutoRunResult } from '../execution/autoRunner.js';
import type { SignalDirection, ContractFamily } from '../execution/types.js';
import type { Cache } from './cache.js';
import { CacheKeys } from './cache.js';

/**
 * AUTOMATIC MARKET SCANNER.
 *
 * The loop behind "automatic" mode: it watches every eligible Volatility Index,
 * scores each one, and — when a market looks directional enough to act on —
 * creates a validated signal and hands it to the automatic runner. The runner
 * then does exactly what a manual trade does: kill switches, ownership, the risk
 * engine, single-use signal, one purchase path.
 *
 * This module has no authority of its own. It cannot buy, skip a check or widen
 * an account's access; it can only *propose* a signal. Everything downstream
 * treats that proposal as it would a customer's.
 *
 * Two properties are deliberate:
 *
 *  - It is DEMO-only. The runner refuses a real account outright, and the
 *    scanner only ever proposes on an account the user owns and that is demo.
 *  - It is transparent. The score is a fractal-efficiency ratio — |net move| over
 *    total path travelled — not a black box. A choppy market scores low and is
 *    ignored; a clean trend scores high. There is no claim of an edge here, and
 *    no martingale: the stake is the customer's fixed preference, never raised
 *    after a loss.
 */

/** The market universe, mirroring the client's eligibility rule exactly. */
const EXCLUDED_NAME_TOKENS = ['BOOM', 'CRASH', 'JUMP', 'STEP', 'RANGE BREAK', 'DAILY RESET', 'DRIFT', 'TREK', 'SKEW'];

/**
 * True for a genuine Volatility Index (standard or 1-second) the scanner may
 * watch. Mirrors `src/utils/eligibleMarkets.ts`: family first, then a defensive
 * name check so a mislabelled synthetic can never slip in.
 */
export function isEligibleVolatilitySymbol(s: ActiveSymbol): boolean {
  const name = s.displayName.toUpperCase();
  if (EXCLUDED_NAME_TOKENS.some((t) => name.includes(t))) return false;
  const sub = (s.submarket ?? '').toLowerCase();
  const sym = s.symbol.toUpperCase();
  return sub === 'random_index' || sym.startsWith('R_') || sym.startsWith('1HZ') || name.includes('VOLATILITY');
}

export interface ScannerMarket {
  symbol: string;
  displayName: string;
}

export interface ScannerOptions {
  /** Ticks used for one reading. */
  windowTicks: number;
  /** Only ticks no older than this are considered. */
  windowMs: number;
  /** Minimum fractal efficiency (0..1) to call a direction. */
  minEfficiency: number;
  /** Minimum ticks required before a market can be scored at all. */
  minTicks: number;
  /** Minimum seconds between two signals for the same market and user. */
  perSymbolCooldownSeconds: number;
  /** How often a full pass runs. */
  intervalMs: number;
  /**
   * How long a market's directional reading stays tradeable after it was last
   * seen. A manual trade may only be placed against a live reading, so this is
   * the window in which the Trade panel can act on a scanner signal.
   */
  candidateTtlMs: number;
}

export const DEFAULT_SCANNER_OPTIONS: ScannerOptions = {
  windowTicks: 60,
  windowMs: 60_000,
  // Calibrated against live Volatility indices: the median efficiency of a
  // 60-tick window is ~0.12 and the 90th percentile is ~0.36. 0.35 sits near
  // that 90th percentile, so a market is called only when its recent travel is
  // unusually directional — not on ordinary noise.
  minEfficiency: 0.35,
  minTicks: 30,
  perSymbolCooldownSeconds: 120,
  intervalMs: 30_000,
  // Two passes' worth: a reading stays actionable until the next pass would
  // have replaced it, with a margin so a slow pass does not blink it out.
  candidateTtlMs: 60_000
};

export interface ScanCandidate {
  symbol: string;
  displayName: string;
  direction: SignalDirection;
  /** Fractal efficiency in 0..1, used as the signal's confidence. */
  confidence: number;
  reason: string;
}

/**
 * Scores a window of ticks. Pure and deterministic.
 *
 * `efficiency = |last - first| / Σ|p_i - p_{i-1}|` — how much of the total price
 * travel was net movement rather than back-and-forth. A market that ends where
 * it started scores 0; a straight line scores 1. Below `minEfficiency` there is
 * no directional call at all.
 */
export function analyseTicks(
  ticks: readonly MarketSnapshot[],
  opts: Pick<ScannerOptions, 'windowTicks' | 'windowMs' | 'minEfficiency' | 'minTicks'>,
  now = Date.now()
): { direction: SignalDirection; confidence: number; reason: string } | null {
  const recent = ticks
    .filter((t) => now - t.receivedAt <= opts.windowMs && Number.isFinite(t.quote))
    .slice(-opts.windowTicks);
  if (recent.length < opts.minTicks) return null;

  const first = recent[0].quote;
  const last = recent[recent.length - 1].quote;
  let path = 0;
  for (let i = 1; i < recent.length; i++) path += Math.abs(recent[i].quote - recent[i - 1].quote);
  if (!Number.isFinite(path) || path <= 0) return null;

  const net = last - first;
  const efficiency = Math.min(1, Math.abs(net) / path);
  if (efficiency < opts.minEfficiency) return null;

  const direction: SignalDirection = net > 0 ? 'RISE' : 'FALL';
  return {
    direction,
    confidence: efficiency,
    reason: `Fractal efficiency ${efficiency.toFixed(2)} over ${recent.length} ticks; ${direction} bias.`
  };
}

export type ScanOutcomeKind = 'proposed' | 'skipped_cooldown' | 'no_signal' | 'skipped_manual_mode';

export interface ScanOutcome {
  symbol: string;
  outcome: ScanOutcomeKind;
  candidate: ScanCandidate | null;
  auto: AutoRunResult | null;
}

export interface MarketScannerDeps {
  store: Store;
  cfg: ServerConfig;
  market: MarketDataService;
  runner: AutoExecutionRunner;
  options?: Partial<ScannerOptions>;
  now?: () => number;
  /** Optional shared cache for the scanner's live readings. */
  cache?: Cache;
}

export class MarketScanner {
  private readonly store: Store;
  private readonly cfg: ServerConfig;
  private readonly market: MarketDataService;
  private readonly runner: AutoExecutionRunner;
  private readonly opts: ScannerOptions;
  private readonly now: () => number;
  private readonly cache: Cache | null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickSubscriptions = new Map<string, () => void>();
  private activeMarketList: ScannerMarket[] = [];
  private running = false;
  private lastPassAt: number | null = null;
  private readonly recentOutcomes: ScanOutcome[] = [];
  /** `${userId}:${symbol}` -> epoch ms of the last signal proposed. */
  private readonly lastProposedAt = new Map<string, number>();
  /**
   * The most recent directional reading per market, whether or not a signal was
   * proposed for it. A manual trade is only allowed when it agrees with a live
   * entry here, so the customer can never place a trade the scanner would not
   * have generated itself.
   */
  private readonly liveCandidates = new Map<string, { candidate: ScanCandidate; seenAt: number }>();

  constructor(deps: MarketScannerDeps) {
    this.store = deps.store;
    this.cfg = deps.cfg;
    this.market = deps.market;
    this.runner = deps.runner;
    this.opts = { ...DEFAULT_SCANNER_OPTIONS, ...deps.options };
    this.now = deps.now ?? (() => Date.now());
    this.cache = deps.cache ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get lastPassTime(): number | null {
    return this.lastPassAt;
  }

  /** Recent decisions, newest last, capped so status stays cheap to serve. */
  get recent(): readonly ScanOutcome[] {
    return this.recentOutcomes;
  }

  /** Markets with live tick subscriptions owned by this scanner. */
  get activeMarkets(): readonly ScannerMarket[] {
    return this.activeMarketList;
  }

  /**
   * The live directional reading for a symbol, or null when the scanner has no
   * fresh one. `stale` is true when the last reading has aged past the TTL, so a
   * caller can tell "no setup right now" from "had one, it has passed".
   */
  liveReading(symbol: string): { candidate: ScanCandidate; stale: boolean } | null {
    const entry = this.liveCandidates.get(symbol);
    if (!entry) return null;
    const age = this.now() - entry.seenAt;
    return { candidate: entry.candidate, stale: age > this.opts.candidateTtlMs };
  }

  /**
   * True when the scanner currently sees a fresh directional setup for the
   * symbol in the given direction. This is the authority the manual Trade panel
   * defers to: a trade is only allowed against a live, agreeing reading.
   */
  hasLiveSignal(symbol: string, direction: SignalDirection): boolean {
    const reading = this.liveReading(symbol);
    if (!reading || reading.stale) return false;
    return reading.candidate.direction === direction;
  }

  /** The markets the scanner watches, from the live catalogue. */
  async watchedMarkets(): Promise<ScannerMarket[]> {
    const symbols = await this.market.getActiveSymbols();
    return symbols
      .filter(isEligibleVolatilitySymbol)
      .map((s) => ({ symbol: s.symbol, displayName: s.displayName }));
  }

  /**
   * Begins periodic scanning. Subscribes to every eligible market so tick
   * buffers fill, then runs a pass on the interval. Idempotent.
   */
  async start(): Promise<void> {
    if (this.running) return;
    const markets = await this.watchedMarkets();
    this.syncSubscriptions(markets);
    this.running = true;
    this.timer = setInterval(() => {
      void this.scanOnce().catch(() => {
        /* a failed pass must not stop the loop */
      });
    }, this.opts.intervalMs);
    // Do not hold the event loop open for the timer alone.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.tickSubscriptions.values()) unsubscribe();
    this.tickSubscriptions.clear();
    this.activeMarketList = [];
  }

  /**
   * One full pass: score every watched market, then offer each candidate to
   * every customer in automatic mode. Returns the decisions, for tests and for
   * the status endpoint.
   */
  async scanOnce(): Promise<ScanOutcome[]> {
    const markets = await this.watchedMarkets();
    if (this.running) this.syncSubscriptions(markets);
    const candidates: ScanCandidate[] = [];
    for (const m of markets) {
      const ticks = this.market.getTicks(m.symbol);
      const reading = analyseTicks(ticks, this.opts, this.now());
      if (reading) {
        candidates.push({ symbol: m.symbol, displayName: m.displayName, ...reading });
      }
    }

    // Remember every directional reading, and forget the ones that have gone
    // quiet, so a manual trade can be checked against what the scanner sees now.
    const now = this.now();
    const seenSymbols = new Set(candidates.map((c) => c.symbol));
    for (const candidate of candidates) {
      this.liveCandidates.set(candidate.symbol, { candidate, seenAt: now });
      // Publish the reading so a second process can answer a manual-trade gate
      // without running its own sweep. Short TTL: a reading is only useful live.
      void this.cache?.set(
        CacheKeys.scannerReading(candidate.symbol),
        { candidate, seenAt: now },
        Math.max(1, Math.round(this.opts.candidateTtlMs / 1000))
      );
    }
    for (const symbol of [...this.liveCandidates.keys()]) {
      if (!seenSymbols.has(symbol)) this.liveCandidates.delete(symbol);
    }

    const automaticUsers = this.store
      .listUsers()
      .filter((u) => this.store.getExecutionPreferences(u.id)?.mode === 'automatic');

    const outcomes: ScanOutcome[] = [];
    for (const user of automaticUsers) {
      const account = this.demoAccountFor(user);
      if (!account) continue;
      const token = this.tokenFor(user);
      if (!token) continue;
      for (const candidate of candidates) {
        outcomes.push(await this.offer(user, candidate, account.accountId, account.currency ?? null, token));
      }
    }

    this.lastPassAt = this.now();
    this.recentOutcomes.push(...outcomes);
    // Keep the in-memory log bounded.
    if (this.recentOutcomes.length > 200) this.recentOutcomes.splice(0, this.recentOutcomes.length - 200);
    return outcomes;
  }

  private syncSubscriptions(markets: readonly ScannerMarket[]): void {
    const uniqueMarkets = [...new Map(markets.map((market) => [market.symbol, market])).values()];
    const symbols = new Set(uniqueMarkets.map((market) => market.symbol));
    for (const [symbol, unsubscribe] of this.tickSubscriptions) {
      if (symbols.has(symbol)) continue;
      unsubscribe();
      this.tickSubscriptions.delete(symbol);
    }
    for (const market of uniqueMarkets) {
      if (!this.tickSubscriptions.has(market.symbol)) {
        this.tickSubscriptions.set(market.symbol, this.market.subscribeTicks(market.symbol, () => {}));
      }
    }
    this.activeMarketList = uniqueMarkets;
  }

  /** Proposes one candidate to one user, through the normal signal path. */
  private async offer(
    user: UserRecord,
    candidate: ScanCandidate,
    accountId: string,
    currency: string | null,
    token: string
  ): Promise<ScanOutcome> {
    const prefs = this.store.getExecutionPreferences(user.id);
    const family: ContractFamily = prefs?.contractFamily ?? 'rise_fall';

    const key = `${user.id}:${candidate.symbol}`;
    const last = this.lastProposedAt.get(key) ?? 0;
    if (this.now() - last < this.opts.perSymbolCooldownSeconds * 1000) {
      return { symbol: candidate.symbol, outcome: 'skipped_cooldown', candidate, auto: null };
    }

    // A signal must be built on a fresh price, exactly as a manual one is.
    const snapshot = await this.market.freshSnapshot(candidate.symbol);
    if (!snapshot) return { symbol: candidate.symbol, outcome: 'no_signal', candidate, auto: null };

    let signal;
    try {
      signal = await createSignal(
        this.store,
        this.market,
        {
          userId: user.id,
          accountId,
          accountMode: 'demo',
          symbol: candidate.symbol,
          timeframe: 'scanner',
          direction: candidate.direction,
          contractFamily: family,
          analysisId: 'market_scanner',
          confidence: candidate.confidence,
          reason: candidate.reason
        },
        { ttlSeconds: 30 }
      );
    } catch (err) {
      if (err instanceof SignalError) {
        return { symbol: candidate.symbol, outcome: 'no_signal', candidate, auto: null };
      }
      throw err;
    }

    this.lastProposedAt.set(key, this.now());
    const auto = await this.runner.runForUser(user, signal, token);
    return { symbol: candidate.symbol, outcome: 'proposed', candidate, auto };
  }

  /** The user's demo account, preferring the one they selected. */
  private demoAccountFor(user: UserRecord): UserRecord['accounts'][number] | null {
    const preferred = this.store.getExecutionPreferences(user.id)?.preferredAccountId?.demo;
    const demos = user.accounts.filter((a) => a.type === 'demo');
    return demos.find((a) => a.accountId === preferred) ?? demos[0] ?? null;
  }

  /**
   * Unseals the Deriv token from the user's most recent live session. The token
   * is used only for the purchase the runner makes; it is never logged or
   * returned. No live session means no automatic trading for that user.
   */
  private tokenFor(user: UserRecord): string | null {
    const now = this.now();
    const sessions = this.store
      .listSessionsForUser(user.id)
      .filter((s) => !s.revoked && s.expiresAt > now && s.derivTokenExpiresAt > now && s.derivTokenSealed)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const session of sessions) {
      try {
        return open(session.derivTokenSealed, this.cfg.session.secret);
      } catch {
        /* an unreadable token is treated as absent */
      }
    }
    return null;
  }
}
