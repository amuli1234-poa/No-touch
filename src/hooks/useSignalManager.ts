import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  advanceManagedSignalsLive,
  isTerminal,
  managedSignalFromFeed,
} from '../analysis/signalManagement';
import type { Candle } from '../types/market';
import type { SignalFeedItem } from '../types/signals';
import type { ManagedSignal } from '../types/training';

const STORAGE_KEY = 'lucky_deriv_managed_signals_v1';
const MAX_SIGNALS = 60;

function loadManaged(): ManagedSignal[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ManagedSignal[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveManaged(signals: readonly ManagedSignal[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(signals.slice(0, MAX_SIGNALS)));
  } catch {
    // Ignore storage write errors
  }
}

interface UseSignalManagerProps {
  feed: readonly SignalFeedItem[];
  /** Live candles for the currently selected instrument. */
  candles: readonly Candle[];
  currentSymbol: string;
  precision: number;
}

/**
 * Live trade management. Every confirmed feed signal becomes a ManagedSignal with a
 * LOCKED entry/stop-loss and a DYNAMIC take-profit. Signals for the currently viewed
 * instrument are advanced against live candles (entry fill, MISSED, target/stop and
 * TP adjustments); other instruments are advanced when they are opened.
 */
export function useSignalManager({
  feed,
  candles,
  currentSymbol,
  precision,
}: UseSignalManagerProps) {
  const [managedSignals, setManagedSignals] = useState<ManagedSignal[]>(() => loadManaged());
  const knownIdsRef = useRef<Set<string>>(new Set(loadManaged().map((s) => s.id)));

  // Adopt newly published feed signals as managed signals (entry/SL locked at creation).
  useEffect(() => {
    if (feed.length === 0) return;
    setManagedSignals((prev) => {
      const next = [...prev];
      let changed = false;
      for (const item of feed) {
        if (knownIdsRef.current.has(item.id)) continue;
        if (item.entryPrice === null || item.stopLoss === null) continue;
        knownIdsRef.current.add(item.id);
        next.unshift(
          managedSignalFromFeed({
            id: item.id,
            symbol: item.symbol,
            displayName: item.displayName,
            marketFamily: item.marketFamily,
            timeframe: item.timeframe,
            direction: item.direction,
            model: item.model,
            modelLabel: item.modelLabel,
            condition: item.condition,
            quality: item.quality,
            entryPrice: item.entryPrice,
            stopLoss: item.stopLoss,
            takeProfit1: item.takeProfit1,
            takeProfit2: item.takeProfit2,
            confidence: item.confidence,
            createdAt: item.createdAt,
            explanation: item.snapshot?.confirmationExplanation,
            invalidationPrice: item.snapshot?.invalidationPrice,
          })
        );
        changed = true;
      }
      return changed ? next.slice(0, MAX_SIGNALS) : prev;
    });
  }, [feed]);

  // Advance managed signals for the viewed instrument as new confirmed candles arrive.
  useEffect(() => {
    if (candles.length < 25) return;
    setManagedSignals((prev) => {
      const mine = prev.filter((s) => s.symbol === currentSymbol);
      if (mine.length === 0) return prev;
      const advanced = advanceManagedSignalsLive(mine, candles, precision, Date.now());
      let changed = false;
      const byId = new Map(advanced.map((s) => [s.id, s]));
      const next = prev.map((s) => {
        const a = byId.get(s.id);
        if (a && a !== s) {
          changed = true;
          return a;
        }
        return s;
      });
      return changed ? next : prev;
    });
  }, [candles, currentSymbol, precision]);

  useEffect(() => {
    saveManaged(managedSignals);
  }, [managedSignals]);

  const byId = useMemo(() => {
    const map = new Map<string, ManagedSignal>();
    for (const s of managedSignals) map.set(s.id, s);
    return map;
  }, [managedSignals]);

  const getManaged = useCallback((id: string) => byId.get(id) ?? null, [byId]);

  const openSignals = useMemo(
    () => managedSignals.filter((s) => !isTerminal(s.status)),
    [managedSignals]
  );

  const clearManagedSignals = useCallback(() => {
    knownIdsRef.current = new Set();
    setManagedSignals([]);
    saveManaged([]);
  }, []);

  return { managedSignals, openSignals, getManaged, clearManagedSignals };
}
