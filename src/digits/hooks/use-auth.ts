'use client';

/**
 * Session-reuse auth for the vendored Digits app.
 *
 * The Digits app originally ran its own Deriv OAuth/PKCE flow. Inside
 * WickSentinel it reuses the host's signed session instead: the browser never
 * holds the Deriv access token. On mount (and on account switch) it calls
 * `POST /api/bot/session`, which verifies the WickSentinel session, enforces
 * same-origin, and returns the selected account, the accounts the session owns,
 * and a short-lived account-bound Deriv WebSocket URL. That URL is the only
 * credential the browser ever sees.
 *
 * The public surface (`UseAuthReturn`) is unchanged so the rest of the Digits
 * UI (provider, trading hooks, views) works without modification.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AuthInfo, DerivAccount, AuthState, AuthConfig } from '@deriv/core';
import { useAppTranslations } from '@/components/custom/i18n-provider';

export interface UseAuthReturn {
  authState: AuthState;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  activeAccountId: string | null;
  wsUrl: string | undefined;
  login: () => Promise<void>;
  signUp: () => Promise<void>;
  logout: () => void;
  switchAccount: (accountId: string) => Promise<void>;
  updateAccountBalance: (accountId: string, balance: string, currency?: string) => void;
  error: string | null;
}

/** No-op kept for import compatibility with the login prompt. */
export function prefetchAuthReferral(): void {}

interface BotSessionResponse {
  account: { account_id: string; account_type: 'demo' | 'real'; currency?: string; status: string };
  accounts: { account_id: string; account_type: 'demo' | 'real'; currency?: string; status: string }[];
  websocket_url: string;
}

function toDerivAccount(a: BotSessionResponse['account']): DerivAccount {
  return {
    account_id: a.account_id,
    account_type: a.account_type,
    currency: a.currency,
    status: a.status,
    balance: undefined,
  } as unknown as DerivAccount;
}

async function requestSession(accountId?: string): Promise<BotSessionResponse> {
  const res = await fetch('/api/bot/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(accountId ? { accountId } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `session_${res.status}`);
  }
  return (await res.json()) as BotSessionResponse;
}

export function useAuth(): UseAuthReturn {
  const { currentLang } = useAppTranslations();
  const [authState, setAuthState] = useState<AuthState>('unauthenticated');
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const initRef = useRef(false);

  const applySession = useCallback((data: BotSessionResponse) => {
    const list = (data.accounts ?? []).map(toDerivAccount);
    setAccounts(list);
    setActiveAccountId(data.account.account_id);
    setWsUrl(data.websocket_url);
    setAuthState('authenticated');
    setError(null);
  }, []);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void requestSession()
      .then(applySession)
      .catch((err: unknown) => {
        const code = err instanceof Error ? err.message : 'session_failed';
        // A 401/403 means there is no WickSentinel session yet — send the user to
        // the host login rather than showing a trading error.
        if (code === 'deriv_authorization_expired' || code === 'session_401' || code === 'session_403') {
          setAuthState('unauthenticated');
        } else {
          setError(code);
          setAuthState('error');
        }
      });
  }, [applySession]);

  // The host owns login/sign-up (Deriv OAuth). Sending the user there keeps a
  // single session; the Digits page picks it up on the next mount.
  const login = useCallback(async () => {
    window.location.href = '/login';
  }, []);

  const signUp = useCallback(async () => {
    window.location.href = '/get-started';
  }, []);

  const logout = useCallback(() => {
    void fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).finally(() => {
      setAccounts([]);
      setActiveAccountId(null);
      setWsUrl(undefined);
      setAuthState('unauthenticated');
      setError(null);
      window.location.href = '/login';
    });
  }, []);

  const switchAccount = useCallback(async (accountId: string) => {
    try {
      const data = await requestSession(accountId);
      applySession(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'account_switch_failed');
    }
  }, [applySession]);

  const updateAccountBalance = useCallback((accountId: string, balance: string, currency?: string) => {
    setAccounts((current) => {
      let changed = false;
      const updated = current.map((account) => {
        if (account.account_id !== accountId) return account;
        const nextCurrency = currency ?? account.currency;
        if (account.balance === balance && account.currency === nextCurrency) return account;
        changed = true;
        return { ...account, balance, currency: nextCurrency };
      });
      return changed ? updated : current;
    });
  }, []);

  const activeAccount = accounts.find((a) => a.account_id === activeAccountId) ?? accounts[0] ?? null;

  // `currentLang` is read so a future localized login hand-off stays consistent;
  // the host login already forwards the stored language.
  void currentLang;

  return {
    authState,
    accounts,
    activeAccount,
    activeAccountId,
    wsUrl,
    login,
    signUp,
    logout,
    switchAccount,
    updateAccountBalance,
    error,
  };
}

// Type-only re-export so `@deriv/core` consumers keep compiling.
export type { AuthInfo, AuthConfig };