import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TIMEFRAME_MAP } from '../config/deriv';
import { advanceSetupLifecycles } from '../analysis/setupLifecycle';
import { applySignalQualityFilter } from '../analysis/signalFilter';
import {
  runCentralRanking,
  toCentralCandidate,
  validatedPerformanceFromProfile,
  CENTRAL_TOP_N,
} from '../analysis/centralRanking';
import type { CentralCandidateIntelligence } from '../analysis/centralRanking';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { AiSignal } from '../types/aiModule';
import type { CentralRankingResult, CentralRankingWeights, IndexValidatedPerformance } from '../types/centralRanking';
import { DEFAULT_CENTRAL_WEIGHTS } from '../types/centralRanking';
import type { DsSignal } from '../types/demandSupply';
import type { EntryModelDecision } from '../types/entryModelAI';
import type { IndexModelProfile } from '../types/entryModelProfiles';
import type { IndexLearningPlan } from '../types/learning';
import type { EngineSignal } from '../types/engine';
import type { Candle, ConnectionStatus } from '../types/market';
import type { ManagedRankedSetup, RankedSetup } from '../types/ranking';
import type { FilteredSignal, SignalFilterConfig } from '../types/signalFilter';
import { DEFAULT_SIGNAL_FILTER_CONFIG } from '../types/signalFilter';
import type { TrendlineSignal } from '../types/trendline';
import { buildRankedSetups, rankSetups } from '../utils/signalRanking';

const STORAGE_KEY = 'lucky_central_setup_ledger_v1';
/** Default number of opportunities the floating scanner displays. */
export const DEFAULT_RANK_LIMIT = 3;
/** Continuous lifecycle re-validation interval. */
const LIFECYCLE_INTERVAL_MS = 30_000;

export interface SetupLedgerEntry {
  key: string;
  symbol: string;
  displayName: string;
  sourceLabel: string;
  direction: 'RISE' | 'FALL';
  score: number;
  outcome: 'TARGET_HIT' | 'STOP_HIT' | 'INVALIDATED';
  settledAt: number;
}

export interface SetupLedgerStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
}

function loadLedger(): SetupLedgerEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SetupLedgerEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLedger(entries: readonly SetupLedgerEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 200)));
  } catch {
    // Ignore storage errors
  }
}

export interface UseSignalRankingProps {
  derivService: DerivWebSocketService;
  /** Confirmed setups from the price-action breadth/depth engine. */
  engineSignals: readonly EngineSignal[];
  trendlineSignals: readonly TrendlineSignal[];
  dsSignals: readonly DsSignal[];
  aiSignals: readonly { moduleLabel: string; signal: AiSignal }[];
  /**
   * Entry-model label per setup key, from the universal Entry Model AI. Only setups whose
   * entry model is evaluated (and not rejected) qualify for the final ranking.
   */
  entryModelByKey?: ReadonlyMap<string, string>;
  /**
   * Full Entry Model AI decisions per setup key — used by the central engine to apply the
   * index-specific entry-model validation before ranking.
   */
  entryDecisionByKey?: ReadonlyMap<string, EntryModelDecision>;
  /** The learned per-index entry-model profiles (validated performance for ranking). */
  indexProfiles?: ReadonlyMap<string, IndexModelProfile>;
  /**
   * The Learning AI's learned timeframe plans per index (from the ONE Learning Intelligence
   * AI). Advisory evidence the central scanner attaches to each candidate for ranking.
   */
  learningPlans?: ReadonlyMap<string, IndexLearningPlan>;
  /**
   * Per-index advisory intelligence from the Timeframe Alignment AI and the Consolidation &
   * Momentum AI (alignment score, momentum strength, consolidation probability). Attached to
   * each candidate so the central ranking can weight multi-timeframe alignment and momentum.
   */
  intelligenceBySymbol?: ReadonlyMap<string, CentralCandidateIntelligence>;
  /** Central ranking weights (validated performance + quality + RR + HTF + confirmation). */
  centralWeights?: CentralRankingWeights;
  /** How many top opportunities to expose to the floating scanner. */
  limit?: number;
  /** Minimum score for a setup to be ranked. */
  minScore?: number;
  /** Live connection status — the centralized filter withholds signals when not live. */
  connectionStatus?: ConnectionStatus;
}

export interface SignalRankingValue {
  /** The best N currently valid setups — what the floating scanner shows. */
  topSetups: ManagedRankedSetup[];
  /** Every currently valid setup, strongest first. */
  activeSetups: ManagedRankedSetup[];
  /** Recently settled setups (completed / invalidated) kept for the statistics ledger. */
  settledSetups: ManagedRankedSetup[];
  /** Performance statistics from settled setups. */
  stats: SetupLedgerStats;
  /** True while a RUN SCAN validation pass is in flight. */
  isValidating: boolean;
  /** Epoch ms of the last successful ranking pass. */
  lastRankedAt: number | null;
  /**
   * RUN SCAN — retrieve the latest qualified setups from every specialised AI,
   * re-validate their live market conditions, re-rank and refresh the top list.
   * This NEVER restarts the background scanner; it only requests the latest ranking.
   */
  runScan: () => void;
  /** The centralized filter's accepted setups (published) for this pass. */
  filterAccepted: FilteredSignal[];
  /** The centralized filter's rejected setups with short reasons (internal only). */
  filterRejected: FilteredSignal[];
  /** The active filter configuration. */
  filterConfig: SignalFilterConfig;
  /** Update the filter configuration (e.g. the minimum quality gate). */
  setFilterConfig: (config: Partial<SignalFilterConfig>) => void;
  /** True once the filter has produced a verdict for at least one candidate. */
  filterRan: boolean;
  /** The full central multi-market ranking result (ranked opportunities + rejections). */
  central: CentralRankingResult | null;
}

/**
 * CENTRAL SETUP VALIDATION AND RANKING ENGINE.
 *
 * Every specialised AI publishes its own confirmed setups. This engine aggregates them,
 * re-validates each against fresh live candles, drops duplicates / missed / expired /
 * invalidated setups, ranks the remainder with one consistent quality score, and exposes
 * only the strongest currently valid opportunities. It is the single source the floating
 * scanner reads from, and it is deliberately separate from the background market scanner.
 */
export function useSignalRanking({
  derivService,
  engineSignals,
  trendlineSignals,
  dsSignals,
  aiSignals,
  entryModelByKey,
  entryDecisionByKey,
  indexProfiles,
  learningPlans,
  intelligenceBySymbol,
  centralWeights = DEFAULT_CENTRAL_WEIGHTS,
  limit = DEFAULT_RANK_LIMIT,
  minScore = 0,
  connectionStatus = 'connected',
}: UseSignalRankingProps): SignalRankingValue {
  const [isValidating, setIsValidating] = useState(false);
  const [lastRankedAt, setLastRankedAt] = useState<number | null>(null);
  const [active, setActive] = useState<ManagedRankedSetup[]>([]);
  const [settled, setSettled] = useState<ManagedRankedSetup[]>([]);
  const [ledger, setLedger] = useState<SetupLedgerEntry[]>(() => loadLedger());
  const [filterConfig, setFilterConfigState] = useState<SignalFilterConfig>(
    DEFAULT_SIGNAL_FILTER_CONFIG
  );
  const [filterAccepted, setFilterAccepted] = useState<FilteredSignal[]>([]);
  const [filterRejected, setFilterRejected] = useState<FilteredSignal[]>([]);
  const [filterRan, setFilterRan] = useState(false);
  const [central, setCentral] = useState<CentralRankingResult | null>(null);

  // The previous lifecycle verdict per setup key — terminal states are never re-opened.
  const managedRef = useRef<Map<string, ManagedRankedSetup>>(new Map());

  // Ref to the live connection status so the central pass reads the current value without
  // being re-created on every status change.
  const connectionRef = useRef<ConnectionStatus>(connectionStatus);
  connectionRef.current = connectionStatus;

  const setFilterConfig = useCallback((config: Partial<SignalFilterConfig>) => {
    setFilterConfigState((prev) => ({ ...prev, ...config }));
  }, []);

  const candidates = useMemo<RankedSetup[]>(() => {
    const base = rankSetups(buildRankedSetups({ engineSignals, trendlineSignals, dsSignals, aiSignals }));
    if (!entryModelByKey) return base;
    // Only fully evaluated opportunities qualify: the Entry Model AI must have selected a
    // model for the setup (an unconfirmed/unevaluated setup is not ranked). The selected
    // model label is attached so downstream surfaces can show it.
    return base
      .filter((setup) => entryModelByKey.has(setup.key))
      .map((setup) => ({ ...setup, entryModelLabel: entryModelByKey.get(setup.key) ?? null }));
  }, [engineSignals, trendlineSignals, dsSignals, aiSignals, entryModelByKey]);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  // Live refs read inside the central pass without re-creating `reconcile`.
  const entryDecisionRef = useRef(entryDecisionByKey);
  entryDecisionRef.current = entryDecisionByKey;
  const indexProfilesRef = useRef(indexProfiles);
  indexProfilesRef.current = indexProfiles;
  const learningPlansRef = useRef(learningPlans);
  learningPlansRef.current = learningPlans;
  const intelligenceRef = useRef(intelligenceBySymbol);
  intelligenceRef.current = intelligenceBySymbol;
  const weightsRef = useRef(centralWeights);
  weightsRef.current = centralWeights;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  /** Fetch the freshest entry-timeframe candles for a set of symbols. */
  const fetchCandles = useCallback(
    async (symbols: readonly string[]): Promise<Map<string, Candle[]>> => {
      const out = new Map<string, Candle[]>();
      const granularity = TIMEFRAME_MAP.M5.granularitySec;
      await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const candles = await derivService.fetchHistoricalCandles(symbol, granularity, 120);
            out.set(symbol, candles);
          } catch {
            out.set(symbol, []);
          }
        })
      );
      return out;
    },
    [derivService]
  );

  /**
   * Re-validates every candidate against fresh candles and applies the automatic
   * lifecycle. Settled setups move to the ledger and leave the active ranking.
   */
  const reconcile = useCallback(
    async (symbolsToFetch: readonly string[]) => {
      const candlesBySymbol = await fetchCandles(symbolsToFetch);

      // CENTRALIZED SIGNAL QUALITY FILTER — the single gate between every AI strategy and
      // the display. Only accepted setups are ranked/managed; rejected setups are kept
      // internally with their short reasons and never reach the chart.
      const filtered = applySignalQualityFilter(
        candidatesRef.current,
        { connectionStatus, candlesBySymbol, dataTimeframe: 'M5' },
        filterConfig
      );
      setFilterAccepted(filtered.accepted);
      setFilterRejected(filtered.rejected);
      setFilterRan(true);

      const acceptedSetups = filtered.accepted.map((f) => f.setup);
      const { active: nextActive, settled: justSettled } = advanceSetupLifecycles(
        acceptedSetups,
        candlesBySymbol,
        managedRef.current
      );

      // CENTRAL MULTI-MARKET RANKING — collect every accepted setup, normalise it into a
      // central candidate (with the Entry Model AI's validation attached), verify freshness,
      // drop duplicates/conflicts, apply the index-specific entry-model validation and
      // produce the single unified ranking. This is the ONLY ranking the scanner reads.
      const perfBySymbol = new Map<string, IndexValidatedPerformance>();
      if (indexProfilesRef.current) {
        for (const [symbol, profile] of indexProfilesRef.current) {
          const perf = validatedPerformanceFromProfile(profile);
          if (perf) perfBySymbol.set(symbol, perf);
        }
      }
      const centralCandidates = acceptedSetups.map((setup) =>
        toCentralCandidate(
          setup,
          entryDecisionRef.current?.get(setup.key) ?? null,
          Date.now(),
          learningPlansRef.current?.get(setup.symbol) ?? null,
          intelligenceRef.current?.get(setup.symbol) ?? {}
        )
      );
      const centralResult = runCentralRanking({
        candidates: centralCandidates,
        connectionStatus: connectionRef.current,
        performanceBySymbol: perfBySymbol,
        weights: weightsRef.current,
        topN: limitRef.current,
      });
      setCentral(centralResult);

      const nextMap = new Map<string, ManagedRankedSetup>();
      for (const s of nextActive) nextMap.set(s.key, s);
      for (const s of justSettled) nextMap.set(s.key, s);
      managedRef.current = nextMap;
      setActive(nextActive);

      if (justSettled.length > 0) {
        setSettled((prev) => {
          const seen = new Set(prev.map((s) => s.key));
          const fresh = justSettled.filter((s) => !seen.has(s.key));
          return fresh.length > 0 ? [...fresh, ...prev].slice(0, 100) : prev;
        });
        setLedger((prev) => {
          const seen = new Set(prev.map((e) => e.key));
          const additions: SetupLedgerEntry[] = justSettled
            .filter((s) => s.outcome && !seen.has(s.key))
            .map((s) => ({
              key: s.key,
              symbol: s.symbol,
              displayName: s.displayName,
              sourceLabel: s.sourceLabel,
              direction: s.direction,
              score: s.score,
              outcome: s.outcome!,
              settledAt: s.settledAt ?? Date.now(),
            }));
          if (additions.length === 0) return prev;
          const next = [...additions, ...prev].slice(0, 200);
          saveLedger(next);
          return next;
        });
      }
    },
    [fetchCandles, connectionStatus, filterConfig]
  );

  // CONTINUOUS LIVE SETUP MANAGEMENT — re-validate active setups on an interval so a
  // setup leaves the ranking the moment its TP or SL is triggered.
  useEffect(() => {
    if (candidates.length === 0) return;
    const symbols = [...new Set(candidates.map((c) => c.symbol))];
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await reconcile(symbols);
      if (!cancelled) setLastRankedAt(Date.now());
    };
    void tick();
    const id = setInterval(() => void tick(), LIFECYCLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [candidates, reconcile]);

  // RUN SCAN — on-demand: revalidate the latest setups and re-rank. Never restarts the
  // background market scanner; it only requests the freshest ranking.
  const runScan = useCallback(() => {
    setIsValidating(true);
    const symbols = [...new Set(candidatesRef.current.map((c) => c.symbol))];
    void reconcile(symbols)
      .then(() => setLastRankedAt(Date.now()))
      .finally(() => setIsValidating(false));
  }, [reconcile]);

  const activeSetups = useMemo(
    () => rankSetups(active.filter((s) => s.status === 'ACTIVE')),
    [active]
  );

  // The top list is the CENTRAL ranking's final opportunities (validated, deduped,
  // conflict-resolved, entry-model confirmed). It is never a raw per-engine sort.
  const topSetups = useMemo<ManagedRankedSetup[]>(() => {
    if (!central || central.ranked.length === 0) return [];
    const byKey = new Map(activeSetups.map((s) => [s.key, s]));
    const out: ManagedRankedSetup[] = [];
    for (const opp of central.ranked) {
      const managed = byKey.get(opp.candidate.key);
      if (managed) out.push(managed);
    }
    return out.filter((s) => s.score >= minScore).slice(0, Math.max(0, limit));
  }, [central, activeSetups, minScore, limit]);

  const stats = useMemo<SetupLedgerStats>(() => {
    const wins = ledger.filter((e) => e.outcome === 'TARGET_HIT').length;
    const total = ledger.length;
    return {
      total,
      wins,
      losses: total - wins,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
    };
  }, [ledger]);

  return {
    topSetups,
    activeSetups,
    settledSetups: settled,
    stats,
    isValidating,
    lastRankedAt,
    runScan,
    filterAccepted,
    filterRejected,
    filterConfig,
    setFilterConfig,
    filterRan,
    central,
  };
}
