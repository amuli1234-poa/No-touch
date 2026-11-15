import { useEffect, useMemo } from 'react';
import type { AppSettings } from '../hooks/useAppSettings';
import type { FullAnalysisReport } from '../types/analysis';
import type { SignalLifecycle } from '../utils/signalStatus';
import { accentCssVars, MANUAL_ACCENT_TO_STATUS, type SystemStatus } from '../theme/accents';

/** Applies the light/dark theme to <html> so CSS variables switch everywhere. */
export function useTheme(theme: AppSettings['theme']): void {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0a0f1a' : '#eef2f8');
  }, [theme]);
}

export interface UseSystemStatusOptions {
  lifecycle: SignalLifecycle | null;
  report: FullAnalysisReport | null;
  isAnalyzing: boolean;
  isScanning: boolean;
  trainingRunning: boolean;
  accentMode: AppSettings['accentMode'];
  theme: AppSettings['theme'];
}

/**
 * Derives the live "system status" (and therefore the interface accent hue) from
 * real engine state only. A confirmed bullish setup turns the UI green, a bearish
 * one red, analysis is blue, training purple and a developing setup amber. In
 * Settings the user may pin a colour instead.
 */
export function useSystemStatus({
  lifecycle,
  report,
  isAnalyzing,
  isScanning,
  trainingRunning,
  accentMode,
  theme,
}: UseSystemStatusOptions): SystemStatus {
  const status = useMemo<SystemStatus>(() => {
    if (accentMode !== 'auto') return MANUAL_ACCENT_TO_STATUS[accentMode];

    const direction = report?.overlays.signal?.direction ?? null;
    if (lifecycle?.status === 'CONFIRMED') {
      if (direction === 'FALL') return 'bearish';
      return 'bullish';
    }
    if (lifecycle?.status === 'INVALIDATED') return 'bearish';
    if (lifecycle?.status === 'DEVELOPING') return 'warning';

    if (trainingRunning) return 'training';
    if (isAnalyzing || isScanning) return 'analysis';

    // Fall back to the market's own direction when nothing else is running.
    if (report?.overallDirection === 'BULLISH') return 'bullish';
    if (report?.overallDirection === 'BEARISH') return 'bearish';

    return 'analysis';
  }, [
    lifecycle,
    report,
    isAnalyzing,
    isScanning,
    trainingRunning,
    accentMode,
  ]);

  useEffect(() => {
    const vars = accentCssVars(status, theme);
    const root = document.documentElement;
    root.setAttribute('data-status', status);
    root.style.setProperty('--color-accent', vars.accent);
    root.style.setProperty('--color-accent-soft', vars.accentSoft);
    root.style.setProperty('--accent-rgb', vars.accentRgb);
    root.style.setProperty('--accent-soft-rgb', vars.accentSoftRgb);
    root.style.setProperty('--accent-glow', vars.glow);
  }, [status, theme]);

  return status;
}
