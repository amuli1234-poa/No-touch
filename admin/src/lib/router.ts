import { useEffect, useState } from 'react';

/**
 * Tiny history-based router, matching the approach used by the trader app so
 * the admin SPA has no router dependency. Supports plain paths and a `?query`.
 */

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

export function currentPath(): string {
  let path = window.location.pathname;
  if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length);
  path = path.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function navigate(to: string): void {
  const target = `${BASE}${to}`;
  if (window.location.pathname + window.location.search === target) return;
  window.history.pushState({}, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Current `?key` value from the URL. */
export function useQueryParam(key: string): string | null {
  const path = usePath();
  void path; // re-read on navigation
  return new URLSearchParams(window.location.search).get(key);
}
