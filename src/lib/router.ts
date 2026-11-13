import { useEffect, useState } from 'react';

/** Vite injects the deploy base ('/' in dev, '/repo/' on a project Pages site). */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

function currentPath(): string {
  let path = window.location.pathname;
  if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length);
  path = path.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

/**
 * Minimal pathname router. The scanner is a single-page workspace that owns its
 * own state-based routing, so the public site only needs to decide *which app*
 * to mount. This avoids pulling in a router dependency and keeps the existing
 * scanner untouched.
 */
export function useRoute(): string {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onPopState = () => setPath(currentPath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return path;
}

export function navigate(to: string): void {
  const target = `${BASE}${to}`;
  if (currentPath() === to) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  window.history.pushState({}, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Scrolls to an in-page anchor on the landing page, navigating home first if needed. */
export function navigateToSection(id: string): void {
  if (currentPath() !== '/') {
    navigate('/');
    window.setTimeout(() => scrollToSection(id), 60);
    return;
  }
  scrollToSection(id);
}

function scrollToSection(id: string): void {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
