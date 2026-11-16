import { useCallback, useEffect, useState } from 'react';

export type DirectionPreference = 'RISE' | 'FALL' | 'BOTH';
export type ThemeMode = 'dark' | 'light';
/** How the global accent colour is chosen. 'auto' follows live system status. */
export type AccentMode = 'auto' | 'blue' | 'green' | 'red' | 'purple' | 'orange';

export interface ChartOverlayPreferences {
  supportResistance: boolean;
  supplyDemand: boolean;
  trendlines: boolean;
  patterns: boolean;
  structureBreaks: boolean;
  liquiditySweeps: boolean;
  swingLabels: boolean;
  entryLevels: boolean;
  entryZone: boolean;
  /** Sideways range: support/resistance/equilibrium lines + 25%/50% band shading. */
  rangeZones: boolean;
  targets: boolean;
  legends: boolean;
  /** Forward-looking structure layer: BOS/CHOCH, bands, fresh watch zones. */
  structureZones: boolean;
  /** Fresh fair value gaps (unfilled imbalances) on the structure layer. */
  fvgZones: boolean;
  /** Show zones that are already partially tested (hidden by default). */
  showTestedZones: boolean;
}

export interface AppSettings {
  directionPreference: DirectionPreference;
  minQuality: 'ANY' | 'MODERATE' | 'HIGH';
  overlays: ChartOverlayPreferences;
  compactChart: boolean;
  /** Light or dark theme. */
  theme: ThemeMode;
  /** Accent colour strategy; 'auto' tracks live system status. */
  accentMode: AccentMode;
  /** Play a short chime when a signal is confirmed or validated. */
  soundEnabled: boolean;
  /** Chime volume, 0–100. */
  soundVolume: number;
  /** Show an in-app toast + browser notification for a confirmed high-quality signal. */
  notificationsEnabled: boolean;
  /** Speak the signal aloud (Web Speech API) when a high-quality signal fires. */
  voiceEnabled: boolean;
}

const STORAGE_KEY = 'deriv_ai_scanner_settings_v1';

export const DEFAULT_SETTINGS: AppSettings = {
  directionPreference: 'BOTH',
  minQuality: 'ANY',
  overlays: {
    supportResistance: true,
    supplyDemand: true,
    trendlines: true,
    patterns: true,
    structureBreaks: true,
    liquiditySweeps: true,
    swingLabels: true,
    entryLevels: true,
    entryZone: true,
    rangeZones: true,
    targets: true,
    legends: true,
    structureZones: true,
    fvgZones: true,
    showTestedZones: false,
  },
  compactChart: false,
  theme: 'dark',
  accentMode: 'auto',
  soundEnabled: true,
  soundVolume: 70,
  notificationsEnabled: true,
  voiceEnabled: false,
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      overlays: {
        ...DEFAULT_SETTINGS.overlays,
        ...(parsed.overlays ?? {}),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage write errors
    }
  }, [settings]);

  const setDirectionPreference = useCallback((pref: DirectionPreference) => {
    setSettings((prev) => ({ ...prev, directionPreference: pref }));
  }, []);

  const setMinQuality = useCallback((quality: AppSettings['minQuality']) => {
    setSettings((prev) => ({ ...prev, minQuality: quality }));
  }, []);

  const toggleOverlay = useCallback((key: keyof ChartOverlayPreferences) => {
    setSettings((prev) => ({
      ...prev,
      overlays: { ...prev.overlays, [key]: !prev.overlays[key] },
    }));
  }, []);

  const setCompactChart = useCallback((compact: boolean) => {
    setSettings((prev) => ({ ...prev, compactChart: compact }));
  }, []);

  const setTheme = useCallback((theme: ThemeMode) => {
    setSettings((prev) => ({ ...prev, theme }));
  }, []);

  const toggleTheme = useCallback(() => {
    setSettings((prev) => ({ ...prev, theme: prev.theme === 'dark' ? 'light' : 'dark' }));
  }, []);

  const setAccentMode = useCallback((accentMode: AccentMode) => {
    setSettings((prev) => ({ ...prev, accentMode }));
  }, []);

  const setSoundVolume = useCallback((soundVolume: number) => {
    setSettings((prev) => ({
      ...prev,
      soundVolume: Math.max(0, Math.min(100, Math.round(soundVolume))),
    }));
  }, []);

  const setSoundEnabled = useCallback((enabled: boolean) => {
    setSettings((prev) => ({ ...prev, soundEnabled: enabled }));
  }, []);

  const setNotificationsEnabled = useCallback((enabled: boolean) => {
    setSettings((prev) => ({ ...prev, notificationsEnabled: enabled }));
  }, []);

  const setVoiceEnabled = useCallback((enabled: boolean) => {
    setSettings((prev) => ({ ...prev, voiceEnabled: enabled }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return {
    settings,
    setDirectionPreference,
    setMinQuality,
    toggleOverlay,
    setCompactChart,
    setTheme,
    toggleTheme,
    setAccentMode,
    setSoundEnabled,
    setSoundVolume,
    setNotificationsEnabled,
    setVoiceEnabled,
    resetSettings,
  };
}
