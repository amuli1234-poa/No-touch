import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildAlert,
  defaultAlertSettings,
  mergeAlert,
  observationFromJournal,
  segmentAlertAccuracy,
  shouldDeliver,
  summarizeAlerts,
  type AlertObservation,
} from '../analysis/alertEngine';
import type { AiJournalRecord } from '../analysis/aiJournal';
import { playSignalChime, setSoundEnabled } from '../utils/sound';
import { isNotificationSupported, notificationPermission } from '../utils/notify';
import {
  DEFAULT_ALERT_FILTERS,
  type AiAlert,
  type AlertFilters,
  type AlertPriority,
  type AlertSettings,
} from '../types/alerts';

const ALERT_STORAGE_KEY = 'lucky_ai_alerts_v1';
const SETTINGS_STORAGE_KEY = 'lucky_ai_alert_settings_v1';
const MAX_ALERTS = 400;

function loadAlerts(): AiAlert[] {
  try {
    const raw = localStorage.getItem(ALERT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AiAlert[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadSettings(): AlertSettings {
  const base = defaultAlertSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<AlertSettings>;
    return {
      ...base,
      ...parsed,
      enabledPriorities: { ...base.enabledPriorities, ...(parsed.enabledPriorities ?? {}) },
      channels: { ...base.channels, ...(parsed.channels ?? {}) },
      quietHours: { ...base.quietHours, ...(parsed.quietHours ?? {}) },
      enabledModules: { ...base.enabledModules, ...(parsed.enabledModules ?? {}) },
      enabledSymbols: parsed.enabledSymbols ?? base.enabledSymbols,
      enabledTimeframes: parsed.enabledTimeframes ?? base.enabledTimeframes,
    };
  } catch {
    return base;
  }
}

export interface AlertManagerValue {
  alerts: AiAlert[];
  filtered: AiAlert[];
  summary: ReturnType<typeof summarizeAlerts>;
  byModule: ReturnType<typeof segmentAlertAccuracy>;
  bySymbol: ReturnType<typeof segmentAlertAccuracy>;
  byModel: ReturnType<typeof segmentAlertAccuracy>;
  settings: AlertSettings;
  filters: AlertFilters;
  /** Alerts the user has not seen yet. */
  unreadCount: number;
  /** Notifications delivered in the last rolling hour (drives the rate limit). */
  deliveredLastHour: number;
  updateSettings: (next: Partial<AlertSettings>) => void;
  toggleModule: (moduleId: string) => void;
  togglePriority: (priority: AlertPriority) => void;
  toggleChannel: (channel: keyof AlertSettings['channels']) => void;
  toggleSymbol: (symbol: string) => void;
  setFilters: (next: Partial<AlertFilters>) => void;
  resetFilters: () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clear: () => void;
  /** Feeds any module observation into the alert engine (de-duplicated in place). */
  ingestObservations: (observations: readonly AlertObservation[]) => void;
  /** Feeds independently-settled journal outcomes (TP / SL / invalidated / expired). */
  ingestJournal: (records: readonly AiJournalRecord[]) => void;
}

/**
 * AI ALERTS & NOTIFICATION MANAGER — orchestration hook.
 *
 * It collects observations from the modules and the independent journal, records every event
 * (so history is complete even during quiet hours) and delivers only material, de-duplicated
 * notifications through the channels that are actually implemented and enabled.
 */
export function useAlertManager(): AlertManagerValue {
  const [alerts, setAlerts] = useState<AiAlert[]>(() => loadAlerts());
  const [settings, setSettings] = useState<AlertSettings>(() => loadSettings());
  const [filters, setFiltersState] = useState<AlertFilters>(DEFAULT_ALERT_FILTERS);

  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const deliveryTimesRef = useRef<number[]>([]);
  const lastDeliveryCountRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(alerts.slice(0, MAX_ALERTS)));
    } catch {
      // Ignore storage write errors.
    }
  }, [alerts]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage write errors.
    }
    setSoundEnabled(settings.channels.SOUND);
  }, [settings]);

  /** Delivers one alert through every enabled, implemented channel. */
  const deliver = useCallback((alert: AiAlert) => {
    const s = settingsRef.current;
    if (s.channels.SOUND) playSignalChime(alert.priority === 'CRITICAL' ? 'invalidated' : 'validated');
    if (
      s.channels.BROWSER &&
      isNotificationSupported() &&
      notificationPermission() === 'granted'
    ) {
      try {
        new Notification(`${alert.priority} · ${alert.displayName}`, {
          body: `${alert.modelLabel} · ${alert.status} · ${alert.quality}/100`,
          tag: alert.id,
        });
      } catch {
        // Notification construction can throw on some platforms; ignore.
      }
    }
  }, []);

  const recordObservations = useCallback(
    (observations: readonly AlertObservation[]) => {
      if (observations.length === 0) return;
      const now = Date.now();
      // Compute the merge OUTSIDE the state updater so delivery side effects never run twice.
      let working = alertsRef.current;
      const material: AiAlert[] = [];
      for (const obs of observations) {
        const result = mergeAlert(working, obs, now);
        working = result.alerts;
        if (result.changed) material.push(result.changed);
      }

      const delivered: AiAlert[] = [];
      for (const alert of material) {
        const decision = shouldDeliver({
          alert,
          settings: settingsRef.current,
          now,
          priorDeliveryCount: deliveryTimesRef.current.filter((t) => now - t < 3_600_000).length,
        });
        if (decision.deliver) delivered.push(alert);
      }

      if (delivered.length > 0) {
        const ids = new Set(delivered.map((a) => a.id));
        working = working.map((a) => (ids.has(a.id) ? { ...a, notified: true } : a));
        const times = deliveryTimesRef.current.filter((t) => now - t < 3_600_000);
        for (const _ of delivered) times.push(now);
        deliveryTimesRef.current = times;
        for (const alert of delivered) deliver(alert);
      }

      alertsRef.current = working;
      setAlerts(working);
    },
    [deliver]
  );

  const ingestObservations = useCallback(
    (observations: readonly AlertObservation[]) => {
      recordObservations(observations);
    },
    [recordObservations]
  );

  const ingestJournal = useCallback(
    (records: readonly AiJournalRecord[]) => {
      const observations = records
        .filter((r) => r.outcome !== 'PENDING')
        .map((r) => observationFromJournal(r));
      recordObservations(observations);
    },
    [recordObservations]
  );

  const updateSettings = useCallback((next: Partial<AlertSettings>) => {
    setSettings((prev) => ({ ...prev, ...next }));
  }, []);

  const toggleModule = useCallback((moduleId: string) => {
    setSettings((prev) => ({
      ...prev,
      enabledModules: { ...prev.enabledModules, [moduleId]: !(prev.enabledModules[moduleId] ?? true) },
    }));
  }, []);

  const togglePriority = useCallback((priority: AlertPriority) => {
    setSettings((prev) => ({
      ...prev,
      enabledPriorities: { ...prev.enabledPriorities, [priority]: !prev.enabledPriorities[priority] },
    }));
  }, []);

  const toggleChannel = useCallback((channel: keyof AlertSettings['channels']) => {
    setSettings((prev) => ({
      ...prev,
      channels: { ...prev.channels, [channel]: !prev.channels[channel] },
    }));
  }, []);

  const toggleSymbol = useCallback((symbol: string) => {
    setSettings((prev) => ({
      ...prev,
      enabledSymbols: prev.enabledSymbols.includes(symbol)
        ? prev.enabledSymbols.filter((s) => s !== symbol)
        : [...prev.enabledSymbols, symbol],
    }));
  }, []);

  const setFilters = useCallback((next: Partial<AlertFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...next }));
  }, []);
  const resetFilters = useCallback(() => setFiltersState(DEFAULT_ALERT_FILTERS), []);

  const markRead = useCallback((id: string) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, read: true } : a)));
  }, []);
  const markAllRead = useCallback(() => {
    setAlerts((prev) => prev.map((a) => (a.read ? a : { ...a, read: true })));
  }, []);
  const dismiss = useCallback((id: string) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, dismissed: true, read: true } : a)));
  }, []);
  const clear = useCallback(() => setAlerts([]), []);

  const filtered = useMemo(() => {
    return alerts.filter((a) => {
      if (!filters.includeDismissed && a.dismissed) return false;
      if (filters.unreadOnly && a.read) return false;
      if (filters.symbol !== 'ALL' && a.symbol !== filters.symbol) return false;
      if (filters.direction !== 'ALL' && a.direction !== filters.direction) return false;
      if (filters.module !== 'ALL' && a.module !== filters.module) return false;
      if (filters.priority !== 'ALL' && a.priority !== filters.priority) return false;
      if (filters.timeframe !== 'ALL' && a.timeframe !== filters.timeframe) return false;
      if (filters.status !== 'ALL' && a.status !== filters.status) return false;
      if (filters.since !== null && a.createdAt < filters.since) return false;
      return true;
    });
  }, [alerts, filters]);

  const summary = useMemo(() => summarizeAlerts(filtered), [filtered]);
  const byModule = useMemo(() => segmentAlertAccuracy(filtered, 'module'), [filtered]);
  const bySymbol = useMemo(() => segmentAlertAccuracy(filtered, 'symbol'), [filtered]);
  const byModel = useMemo(() => segmentAlertAccuracy(filtered, 'modelId'), [filtered]);
  const unreadCount = useMemo(() => alerts.filter((a) => !a.read && !a.dismissed).length, [alerts]);
  const deliveredLastHour = useMemo(() => {
    const cutoff = Date.now() - 3_600_000;
    return deliveryTimesRef.current.filter((t) => t >= cutoff).length;
  }, [alerts]);

  // Keep the "delivered per hour" readout in sync without a per-render timer.
  useEffect(() => {
    lastDeliveryCountRef.current = deliveredLastHour;
  }, [deliveredLastHour]);

  return {
    alerts,
    filtered,
    summary,
    byModule,
    bySymbol,
    byModel,
    settings,
    filters,
    unreadCount,
    deliveredLastHour,
    updateSettings,
    toggleModule,
    togglePriority,
    toggleChannel,
    toggleSymbol,
    setFilters,
    resetFilters,
    markRead,
    markAllRead,
    dismiss,
    clear,
    ingestObservations,
    ingestJournal,
  };
}

export type AlertManagerHookValue = ReturnType<typeof useAlertManager>;

/** Builds an alert id for external callers (tests, deep links). */
export { buildAlert };
