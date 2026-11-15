import { useEffect, useState, useSyncExternalStore } from 'react';
import { resetBalances } from './balances';

/**
 * Frontend authentication client.
 *
 * The browser only ever talks to same-origin /auth and /api endpoints. The
 * Deriv access token, client secret and session signing secret live exclusively
 * on the server; the session itself is an HttpOnly cookie the JS cannot read.
 */

export interface AuthUser {
  id: string;
  loginId: string | null;
  createdAt: number;
  accounts: { accountId: string; type: 'demo' | 'real'; currency?: string }[];
  demoAccounts: number;
  realAccounts: number;
}

export interface AuthSessionInfo {
  expiresAt: number;
  derivTokenExpiresAt: number;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: AuthUser; session: AuthSessionInfo };

/* ------------------------------ store --------------------------------- */

let state: AuthState = { status: 'loading' };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(next: AuthState): void {
  state = next;
  emit();
}

/** Clears stale authenticated UI state after a protected request rejects the session. */
export function expireAuth(): void {
  setState({ status: 'anonymous' });
  resetBalances();
}

async function requestSession(): Promise<void> {
  try {
    const res = await fetch('/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) return expireAuth();
    const data = await res.json();
    if (data?.authenticated && data.user) {
      setState({ status: 'authenticated', user: data.user, session: data.session });
    } else {
      expireAuth();
    }
  } catch {
    expireAuth();
  }
}

/** Fetches the current session once and notifies subscribers. */
export function refreshAuth(): Promise<void> {
  if (!inflight) {
    inflight = requestSession().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): AuthState {
  return state;
}

export function useAuth(): AuthState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void refreshAuth();
  }, []);
  return snapshot;
}

/* ----------------------------- actions -------------------------------- */

/** Redirects the browser into Deriv's OAuth flow (server builds the URL). */
export function startDerivAuth(mode: 'login' | 'signup'): void {
  window.location.assign(`/auth/start?mode=${mode}`);
}

export async function logout(): Promise<void> {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    expireAuth();
  }
}

export async function fetchPreferences<T = Record<string, unknown>>(): Promise<T | null> {
  const res = await fetch('/api/preferences', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (res.status === 401) expireAuth();
  if (!res.ok) return null;
  const data = await res.json();
  return (data?.preferences ?? null) as T | null;
}

export async function savePreferences(preferences: Record<string, unknown>): Promise<boolean> {
  const res = await fetch('/api/preferences', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferences })
  });
  if (res.status === 401) expireAuth();
  return res.ok;
}

/* --------------------------- routing hint ----------------------------- */

/** When auth is not available (static preview), the app degrades gracefully. */
export function useAuthAvailable(): boolean {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/healthz', { headers: { Accept: 'application/json' } })
      .then((r) => setAvailable(r.ok))
      .catch(() => setAvailable(false));
  }, []);
  return available === true;
}
