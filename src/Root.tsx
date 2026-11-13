import React, { useEffect } from 'react';
import App from './App';
import { LandingPage } from './components/landing/LandingPage';
import { AccessPage } from './components/landing/AccessPage';
import { LegalPage } from './components/landing/LegalPage';
import { NotFoundPage } from './components/landing/NotFoundPage';
import { useRoute } from './lib/router';

const TITLES: Record<string, string> = {
  '/': 'WickSentinel — See Beyond the Candles. Understand the Market.',
  '/app': 'WickSentinel Scanner — Market Intelligence',
  '/login': 'Log in — WickSentinel',
  '/get-started': 'Get Started — WickSentinel',
  '/privacy': 'Privacy Policy — WickSentinel',
  '/terms': 'Terms of Service — WickSentinel',
  '/risk-disclaimer': 'Risk Disclaimer — WickSentinel'
};

/**
 * Resolves which surface to mount from the pathname.
 *
 * The public site lives at `/`; the existing scanner workspace is unchanged and
 * mounts at `/app` (and any deeper path beneath it). No router dependency is
 * added — the scanner keeps its own internal state-based routing.
 */
export default function Root() {
  const path = useRoute();
  const isApp = path === '/app' || path.startsWith('/app/');

  useEffect(() => {
    document.title = isApp
      ? TITLES['/app']
      : TITLES[path] ?? 'Page not found — WickSentinel';
  }, [path, isApp]);

  if (isApp) return <App />;

  switch (path) {
    case '/':
      return <LandingPage />;
    case '/login':
      return <AccessPage mode="login" />;
    case '/get-started':
      return <AccessPage mode="get-started" />;
    case '/privacy':
      return <LegalPage kind="privacy" />;
    case '/terms':
      return <LegalPage kind="terms" />;
    case '/risk-disclaimer':
      return <LegalPage kind="risk-disclaimer" />;
    default:
      return <NotFoundPage />;
  }
}
