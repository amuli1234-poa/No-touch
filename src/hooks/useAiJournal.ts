import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  evaluateAiJournalRecord,
  loadAiJournal,
  mergeJournalSignals,
  saveAiJournal,
  type AiJournalRecord,
} from '../analysis/aiJournal';
import {
  performanceAlerts,
  segmentPerformance,
  summarizePerformance,
  type PerformanceAlert,
  type PerformanceSummary,
  type SegmentedPerformance,
} from '../analysis/aiPerformance';
import type { AiSignal } from '../types/aiModule';

export interface AiJournalEntry {
  module: string;
  signal: AiSignal;
}

export interface AiJournalFilters {
  symbol: string | 'ALL';
  module: string | 'ALL';
  model: string | 'ALL';
  direction: 'RISE' | 'FALL' | 'ALL';
  condition: string | 'ALL';
}

const DEFAULT_FILTERS: AiJournalFilters = {
  symbol: 'ALL',
  module: 'ALL',
  model: 'ALL',
  direction: 'ALL',
  condition: 'ALL',
};

export interface AiJournalValue {
  records: AiJournalRecord[];
  filtered: AiJournalRecord[];
  summary: PerformanceSummary;
  byModule: SegmentedPerformance[];
  bySymbol: SegmentedPerformance[];
  byModel: SegmentedPerformance[];
  byCondition: SegmentedPerformance[];
  byDirection: SegmentedPerformance[];
  alerts: PerformanceAlert[];
  filters: AiJournalFilters;
  setFilters: (next: Partial<AiJournalFilters>) => void;
  resetFilters: () => void;
  /** Records every module's currently-published signals (id-keyed, never duplicated). */
  ingest: (entries: readonly AiJournalEntry[]) => void;
  /** Re-verifies outcomes against fresh candles per index. */
  settle: (candlesBySymbol: Map<string, AiJournalRecordCandles>) => void;
  clear: () => void;
  exportCsv: () => string;
}

type AiJournalRecordCandles = Parameters<typeof evaluateAiJournalRecord>[1];

/**
 * TRADE PERFORMANCE & LEARNING AI — journal hook. It observes signals from every module,
 * records them (never erasing history), settles outcomes against real candles and exposes
 * segmented performance. It never modifies another module's analysis.
 */
export function useAiJournal(): AiJournalValue {
  const [records, setRecords] = useState<AiJournalRecord[]>(() => loadAiJournal());
  const [filters, setFiltersState] = useState<AiJournalFilters>(DEFAULT_FILTERS);
  const recordsRef = useRef(records);
  recordsRef.current = records;

  useEffect(() => {
    saveAiJournal(records);
  }, [records]);

  const ingest = useCallback((entries: readonly AiJournalEntry[]) => {
    if (entries.length === 0) return;
    setRecords((prev) => {
      const next = mergeJournalSignals(prev, entries);
      // Skip state churn when nothing new was added.
      return next.length === prev.length ? prev : next;
    });
  }, []);

  const settle = useCallback((candlesBySymbol: Map<string, AiJournalRecordCandles>) => {
    setRecords((prev) => {
      let changed = false;
      const next = prev.map((r) => {
        const candles = candlesBySymbol.get(r.symbol);
        if (!candles || candles.length === 0) return r;
        const updated = evaluateAiJournalRecord(r, candles);
        if (updated !== r) changed = true;
        return updated;
      });
      return changed ? next : prev;
    });
  }, []);

  const setFilters = useCallback((next: Partial<AiJournalFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...next }));
  }, []);
  const resetFilters = useCallback(() => setFiltersState(DEFAULT_FILTERS), []);

  const clear = useCallback(() => setRecords([]), []);

  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (filters.symbol !== 'ALL' && r.symbol !== filters.symbol) return false;
      if (filters.module !== 'ALL' && r.module !== filters.module) return false;
      if (filters.model !== 'ALL' && r.modelId !== filters.model) return false;
      if (filters.direction !== 'ALL' && r.direction !== filters.direction) return false;
      if (filters.condition !== 'ALL' && r.condition !== filters.condition) return false;
      return true;
    });
  }, [records, filters]);

  const summary = useMemo(() => summarizePerformance(filtered), [filtered]);
  const byModule = useMemo(() => segmentPerformance(filtered, 'module'), [filtered]);
  const bySymbol = useMemo(() => segmentPerformance(filtered, 'symbol'), [filtered]);
  const byModel = useMemo(() => segmentPerformance(filtered, 'model'), [filtered]);
  const byCondition = useMemo(() => segmentPerformance(filtered, 'condition'), [filtered]);
  const byDirection = useMemo(() => segmentPerformance(filtered, 'direction'), [filtered]);
  const alerts = useMemo(() => performanceAlerts(filtered), [filtered]);

  const exportCsv = useCallback(() => {
    const header = [
      'id',
      'symbol',
      'displayName',
      'module',
      'modelId',
      'direction',
      'entryPrice',
      'stopLoss',
      'tp1',
      'tp2',
      'tp3',
      'riskReward',
      'quality',
      'condition',
      'outcome',
      'highestTarget',
      'createdAt',
    ].join(',');
    const rows = filtered.map((r) =>
      [
        r.id,
        r.symbol,
        `"${r.displayName}"`,
        r.module,
        r.modelId,
        r.direction,
        r.entryPrice,
        r.stopLoss,
        r.takeProfit1,
        r.takeProfit2,
        r.takeProfit3 ?? '',
        r.riskRewardRatio,
        r.qualityScore,
        r.condition,
        r.outcome,
        r.highestTargetReached,
        new Date(r.createdAt).toISOString(),
      ].join(',')
    );
    return [header, ...rows].join('\n');
  }, [filtered]);

  return {
    records,
    filtered,
    summary,
    byModule,
    bySymbol,
    byModel,
    byCondition,
    byDirection,
    alerts,
    filters,
    setFilters,
    resetFilters,
    ingest,
    settle,
    clear,
    exportCsv,
  };
}

export type AiJournalHookValue = ReturnType<typeof useAiJournal>;
