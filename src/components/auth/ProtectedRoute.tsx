import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { navigate } from '../../lib/router';
import { refreshAuth, useAuth } from '../../lib/auth';

/**
 * Guards the scanner workspace.
 *
 * When the authentication backend is present (served by server/index.ts), an
 * unauthenticated visitor is sent to /login. When the app is hosted statically
 * (no backend available — e.g. the GitHub Pages preview), the guard steps
 * aside so the existing scanner keeps working; it never fabricates a session.
 */

let backendProbe: Promise<boolean> | null = null;

function probeBackend(): Promise<boolean> {
  if (!backendProbe) {
    backendProbe = fetch('/healthz', { headers: { Accept: 'application/json' } })
      .then((r) => r.ok)
      .catch(() => false);
  }
  return backendProbe;
}

export const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const auth = useAuth();
  const [backend, setBackend] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    probeBackend().then((ok) => active && setBackend(ok));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (backend === false) return; // static deployment: no auth backend
    if (backend === true && auth.status === 'anonymous') navigate('/login');
  }, [backend, auth.status]);

  // Static host: nothing to enforce, render the scanner as before.
  if (backend === false) return <>{children}</>;

  if (backend === null || auth.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app">
        <div className="flex items-center gap-2.5 text-[13px] text-fg-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Verifying your session…
        </div>
      </div>
    );
  }

  if (auth.status === 'anonymous') {
    // The redirect effect above runs; render nothing in the meantime.
    return <div className="min-h-screen bg-app" />;
  }

  return <>{children}</>;
};

/** Re-checks the session and re-renders on auth changes. */
export function useSessionRefresh(): void {
  useEffect(() => {
    void refreshAuth();
  }, []);
}
