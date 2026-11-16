import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'ws-theme';

/* --------------------------------------------------------------------------
   The initial theme is resolved by an inline script in index.html *before*
   React mounts, so the first paint already has the right colours (no flash).
   It writes the resolved value onto <html data-theme>. This module reads that
   attribute back as the source of truth and keeps it in sync on change.
   -------------------------------------------------------------------------- */

function readAppliedTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* Storage may be unavailable (private mode); the attribute still applies. */
  }
  emit();
}

/**
 * Reads and writes the active theme. The value lives on <html data-theme>,
 * which the pre-mount script and setTheme both control, so this hook simply
 * subscribes to changes rather than owning separate state.
 */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, readAppliedTheme, () => 'light' as Theme);

  useEffect(() => {
    /* Keep the attribute and colour-scheme correct if a value was stored after
       the inline script ran (e.g. a returning visitor whose storage was read
       late). Harmless when they already match. */
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme(readAppliedTheme() === 'dark' ? 'light' : 'dark');
  }, []);

  return { theme, setTheme, toggle };
}
