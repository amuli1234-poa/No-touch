import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildIndexProfiles, indexHistoricalBonusMap } from '../analysis/entryModelProfiles';
import {
  buildLearningReport,
  toIndexModelRecords,
} from '../analysis/learningIntelligence';
import {
  loadLearningLedger,
  mergeLearningRecords,
  saveLearningLedger,
} from '../analysis/learningLedger';
import type { EntryModelOutcomeRecord, EntryModelPerformance } from '../types/entryModelAI';
import { aggregateEntryModelPerformance } from '../analysis/entryModelAI';
import type { IndexModelProfile } from '../types/entryModelProfiles';
import type {
  IndexLearningPlan,
  IndexLearningProfile,
  LearningIntelligenceReport,
  LearningOutcomeRecord,
} from '../types/learning';

/**
 * ONE LEARNING INTELLIGENCE AI — the single persistent learning hook.
 *
 * This is the ONLY module that owns historical outcomes. Every other surface (entry-model
 * performance, per-index profiles, the learning dashboard, the central scanner's validated
 * performance input) READS from it — none keeps a competing ledger. Outcomes are permanent,
 * deduped by id, attributed to the originating AI / strategy / entry model / index and never
 * overwritten once recorded.
 */
export interface LearningIntelligenceValue {
  /** The permanent outcome ledger (immutable history). */
  ledger: LearningOutcomeRecord[];
  /** The full per-index learning report. */
  report: LearningIntelligenceReport;
  /** Per-index validated entry-model profiles (retention + rollback state). */
  modelProfiles: IndexModelProfile[];
  /** Fast lookup of a validated model profile by symbol. */
  profileBySymbol: Map<string, IndexModelProfile>;
  /** Fast lookup of the learned timeframe plan by symbol (for the central scanner). */
  planBySymbol: Map<string, IndexLearningPlan>;
  /** Per-index historical bonus the entry-model selection reads. */
  bonusBySymbol: ReturnType<typeof indexHistoricalBonusMap>;
  /** Sample-aware entry-model performance derived from the SAME ledger (for the view). */
  entryModelPerformance: EntryModelPerformance[];
  /** Learning profile for one index (null when it has no recorded outcomes yet). */
  profileFor: (symbol: string) => IndexLearningProfile | null;
  /** Records settled outcomes permanently (deduped by id; never overwrites history). */
  recordOutcomes: (records: readonly LearningOutcomeRecord[]) => void;
  /** Clears the ledger (explicit user action only). */
  clear: () => void;
}

export function useLearningIntelligence(): LearningIntelligenceValue {
  const [ledger, setLedger] = useState<LearningOutcomeRecord[]>(() => loadLearningLedger());
  const profilesRef = useRef<Map<string, IndexModelProfile>>(new Map());

  useEffect(() => {
    saveLearningLedger(ledger);
  }, [ledger]);

  const indexRecords = useMemo(() => toIndexModelRecords(ledger), [ledger]);

  // Validated per-index entry-model profiles, RETAINING the previous selection when no
  // challenger genuinely beats it (rollback-safe: a rejected challenger never replaces it).
  const modelProfiles = useMemo(() => {
    const built = buildIndexProfiles(indexRecords, profilesRef.current);
    profilesRef.current = built;
    return built;
  }, [indexRecords]);

  const profileBySymbol = modelProfiles;
  const bonusBySymbol = useMemo(() => indexHistoricalBonusMap(modelProfiles), [modelProfiles]);

  const report = useMemo(() => buildLearningReport(ledger, modelProfiles), [ledger, modelProfiles]);

  const planBySymbol = useMemo(() => {
    const map = new Map<string, IndexLearningPlan>();
    for (const p of report.profiles) map.set(p.symbol, p.plan);
    return map;
  }, [report]);

  // Entry-model performance for the view is derived from the SAME ledger — the entry-model
  // view and the learning dashboard can never disagree about how a model has performed.
  const entryModelPerformance = useMemo<EntryModelPerformance[]>(() => {
    const records: EntryModelOutcomeRecord[] = ledger
      .filter((r) => r.outcome === 'TARGET_HIT' || r.outcome === 'STOP_HIT' || r.outcome === 'INVALIDATED' || r.outcome === 'MISSED')
      .map((r) => ({
        model: r.entryModel,
        modelLabel: r.entryModelLabel,
        symbol: r.symbol,
        displayName: r.displayName,
        marketFamily: r.marketFamily,
        timeframe: r.timeframe,
        direction: r.direction,
        riskRewardRatio: r.realisedRr ?? r.plannedRr,
        outcome:
          r.outcome === 'TARGET_HIT'
            ? 'TARGET_HIT'
            : r.outcome === 'STOP_HIT'
              ? 'STOP_HIT'
              : r.outcome === 'INVALIDATED'
                ? 'INVALIDATED'
                : 'MISSED',
        settledAt: r.settledAt,
      }));
    return aggregateEntryModelPerformance(records);
  }, [ledger]);

  const profileFor = useCallback(
    (symbol: string) => report.profiles.find((p) => p.symbol === symbol) ?? null,
    [report]
  );

  const recordOutcomes = useCallback((records: readonly LearningOutcomeRecord[]) => {
    if (records.length === 0) return;
    setLedger((prev) => {
      const next = mergeLearningRecords(prev, records);
      return next.length === prev.length ? prev : next;
    });
  }, []);

  const clear = useCallback(() => setLedger([]), []);

  return {
    ledger,
    report,
    modelProfiles: [...modelProfiles.values()],
    profileBySymbol,
    planBySymbol,
    bonusBySymbol,
    entryModelPerformance,
    profileFor,
    recordOutcomes,
    clear,
  };
}
