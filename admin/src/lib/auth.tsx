import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler, type AdminIdentity } from './api';

/**
 * Admin session context.
 *
 * The identity is fetched once on boot from `/auth/session`. `has()` is the
 * single source of truth for whether a control is shown; the server re-checks
 * every permission independently, so hiding a control is presentation only.
 */

interface AuthState {
  admin: AdminIdentity | null;
  loading: boolean;
  has: (permission: string) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  setAdmin: (admin: AdminIdentity) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdminState] = useState<AdminIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ admin: AdminIdentity; csrfToken: string }>('/auth/session');
      setCsrfToken(res.csrfToken);
      setAdminState(res.admin);
    } catch {
      setCsrfToken(null);
      setAdminState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setAdminState(null);
    });
    void refresh();
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* logging out locally is what matters */
    }
    setCsrfToken(null);
    setAdminState(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      admin,
      loading,
      has: (permission: string) => Boolean(admin?.permissions?.includes(permission)),
      refresh,
      signOut,
      setAdmin: setAdminState
    }),
    [admin, loading, refresh, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
