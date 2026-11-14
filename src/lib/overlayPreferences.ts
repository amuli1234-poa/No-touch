import { useCallback, useState } from 'react';
import {
  DEFAULT_OVERLAY_PREFERENCES,
  type OverlayPreferences
} from '../components/chart/chartOverlays';

/**
 * Chart overlay toggles, persisted to localStorage.
 *
 * The storage key is the one the previous chart used, so an operator's existing
 * overlay choices carry over rather than resetting to defaults on upgrade.
 */
const STORAGE_KEY = 'wicksentinel_chart_overlays_v1';

function read(): OverlayPreferences {
  if (typeof localStorage === 'undefined') return DEFAULT_OVERLAY_PREFERENCES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_OVERLAY_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<OverlayPreferences>;
    // Merge so a stored payload missing newer keys still yields a complete set.
    return { ...DEFAULT_OVERLAY_PREFERENCES, ...parsed };
  } catch {
    return DEFAULT_OVERLAY_PREFERENCES;
  }
}

export function useOverlayPreferences(): [
  OverlayPreferences,
  (key: keyof OverlayPreferences) => void
] {
  const [prefs, setPrefs] = useState<OverlayPreferences>(read);

  const toggle = useCallback((key: keyof OverlayPreferences) => {
    setPrefs((cur) => {
      const next = { ...cur, [key]: !cur[key] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable (private mode, quota); the UI still works.
      }
      return next;
    });
  }, []);

  return [prefs, toggle];
}
