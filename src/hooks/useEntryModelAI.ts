import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TIMEFRAME_MAP } from '../config/deriv';
import { DerivWebSocketService } from '../services/derivWebSocket';
import type { AiSignal } from '../types/aiModule';
import type { DsSignal } from '../types/demandSupply';
import type { EngineSignal } from '../types/engine';
import type {
  EntryModelDecision,
  EntryModelPerformance,
  EntryModelSetupInput,
} from '../types/entryModelAI';
import type {
  IndexHistoricalBonus,
  IndexModelProfile,
} from '../types/entryModelProfiles';
import type { TrendlineSignal } from '../types/trendline';
import { evaluateEntryModels } from '../analysis/entryModelAI';
import {
  aiSignalToEntryInput,
  dsSignalToEntryInput,
  engineSignalToEntryInput,
  trendlineSignalToEntryInput,
} from '../analysis/entryModelAdapters';
import { buildMarketContext, deriveHtfDirection } from '../analysis/entryModelContext';

/** Re-evaluate the best entry model for every qualified setup on an interval. */
const REFRESH_MS = 45_000;

export interface UseEntryModelAIProps {
  derivService: DerivWebSocketService;
  engineSignals: readonly EngineSignal[];
  trendlineSignals: readonly TrendlineSignal[];
  dsSignals: readonly DsSignal[];
  aiSignals: readonly { moduleLabel: string; signal: AiSignal }[];
  /**
   * Per-index validated entry-model profiles from the ONE Learning Intelligence AI. The
   * entry-model AI reads them — it never keeps its own competing history.
   */
  indexProfiles: ReadonlyMap<string, IndexModelProfile>;
  /** Per-index historical bonus the selection reads (derived from the same learning store). */
  bonusBySymbol: IndexHistoricalBonus;
  /** Sample-aware per-model performance derived from the same learning store (for the view). */
  performance: EntryModelPerformance[];
}

export interface EntryModelAIValue {
  /** The best entry-model decision per setup key. */
  decisions: EntryModelDecision[];
  /** Fast lookup by setup key. */
  decisionByKey: Map<string, EntryModelDecision>;
  /** Sample-aware per-model performance (from the single learning store). */
  performance: EntryModelPerformance[];
  /** The learned, validated entry-model profile per index (never blended across indices). */
  profiles: IndexModelProfile[];
  /** Fast lookup of a profile by symbol. */
  profileBySymbol: ReadonlyMap<string, IndexModelProfile>;
  lastEvaluatedAt: number | null;
}

/**
 * UNIVERSAL ENTRY MODEL AI hook.
 *
 * Aggregates the qualified setups from EVERY specialised strategy AI, evaluates the most
 * suitable entry model for each independently against live market context, and exposes the
 * decisions. Learning state (validated profiles, historical bonus, model performance) is
 * OWNED BY the single Learning Intelligence AI and injected here — this hook never records
 * its own outcomes, so there is exactly one learning history in the app.
 */
export function useEntryModelAI({
  derivService,
  engineSignals,
  trendlineSignals,
  dsSignals,
  aiSignals,
  indexProfiles,
  bonusBySymbol,
  performance,
}: UseEntryModelAIProps): EntryModelAIValue {
  const [decisions, setDecisions] = useState<EntryModelDecision[]>([]);
  const [lastEvaluatedAt, setLastEvaluatedAt] = useState<number | null>(null);

  const inputs = useMemo<EntryModelSetupInput[]>(() => {
    return [
      ...engineSignals.map(engineSignalToEntryInput),
      ...trendlineSignals.map(trendlineSignalToEntryInput),
      ...dsSignals.map(dsSignalToEntryInput),
      ...aiSignals.map(({ moduleLabel, signal }) => aiSignalToEntryInput(moduleLabel, signal)),
    ];
  }, [engineSignals, trendlineSignals, dsSignals, aiSignals]);

  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const bonusRef = useRef(bonusBySymbol);
  bonusRef.current = bonusBySymbol;
  const profilesRefLatest = useRef(indexProfiles);
  profilesRefLatest.current = indexProfiles;

  const evaluate = useCallback(async () => {
    const current = inputsRef.current;
    if (current.length === 0) {
      setDecisions([]);
      return;
    }
    const symbols = [...new Set(current.map((s) => s.symbol))];
    const m5Gran = TIMEFRAME_MAP.M5.granularitySec;
    const m15Gran = TIMEFRAME_MAP.M15.granularitySec;

    const contexts = new Map<string, ReturnType<typeof buildMarketContext>>();
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const [entryCandles, htfCandles] = await Promise.all([
            derivService.fetchHistoricalCandles(symbol, m5Gran, 120),
            derivService.fetchHistoricalCandles(symbol, m15Gran, 60),
          ]);
          const profile = profilesRefLatest.current.get(symbol);
          contexts.set(symbol, buildMarketContext({
            candles: entryCandles,
            htfDirection: deriveHtfDirection(htfCandles),
            historicalBonus: bonusRef.current.get(symbol) ?? {},
            indexProfile: profile
              ? { model: profile.selected, label: profile.selectedLabel, retained: profile.retained }
              : null,
            dataTimestamp:
              entryCandles.length > 0 ? entryCandles[entryCandles.length - 1].time : undefined,
          }));
        } catch {
          contexts.set(symbol, null);
        }
      })
    );

    const contextByKey = new Map<string, NonNullable<ReturnType<typeof buildMarketContext>>>();
    for (const setup of current) {
      const ctx = contexts.get(setup.symbol);
      if (ctx) {
        contextByKey.set(setup.key, ctx);
        continue;
      }
      // Candle fetch unavailable — evaluate against a neutral context derived from the
      // setup's OWN levels so a published setup is never silently dropped by the gate.
      // The model still must be selected from the setup's own evidence.
      if (setup.entryPrice !== null) {
        const atr =
          setup.stopLoss !== null ? Math.abs(setup.entryPrice - setup.stopLoss) : 0;
        const profile = profilesRefLatest.current.get(setup.symbol);
        contextByKey.set(setup.key, {
          price: setup.entryPrice,
          atr,
          htfDirection: null,
          historicalBonus: bonusRef.current.get(setup.symbol) ?? {},
          indexProfile: profile
            ? { model: profile.selected, label: profile.selectedLabel, retained: profile.retained }
            : null,
          dataTimestamp: setup.confirmedBarTime,
        });
      }
    }
    setDecisions(evaluateEntryModels(current, contextByKey));
    setLastEvaluatedAt(Date.now());
  }, [derivService]);

  useEffect(() => {
    void evaluate();
    const id = setInterval(() => void evaluate(), REFRESH_MS);
    return () => clearInterval(id);
  }, [evaluate]);

  // Re-evaluate immediately whenever the qualified setups change, so a newly-published
  // strategy setup gets its entry model (and can qualify for the ranking) without waiting
  // for the next refresh interval.
  const inputSignature = useMemo(
    () => inputs.map((s) => s.key).sort().join('|'),
    [inputs]
  );
  const lastSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastSignatureRef.current === inputSignature) return;
    lastSignatureRef.current = inputSignature;
    void evaluate();
  }, [inputSignature, evaluate]);

  const decisionByKey = useMemo(() => {
    const map = new Map<string, EntryModelDecision>();
    for (const d of decisions) map.set(d.key, d);
    return map;
  }, [decisions]);

  return {
    decisions,
    decisionByKey,
    performance,
    profiles: [...indexProfiles.values()],
    profileBySymbol: indexProfiles,
    lastEvaluatedAt,
  };
}
