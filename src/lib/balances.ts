import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Frontend balance client.
 *
 * Balances come from same-origin `/api/balances`, which resolves them
 * server-side against the customer's own Deriv accounts. The browser never
 * holds a Deriv token; the session is an HttpOnly cookie the JS cannot read.
 *
 * The server is the only authority on which accounts exist and what mode they
 * are in, so this client stores what it is told and never derives or invents a
 * figure. A null balance is rendered as "unavailable" — never as 0.
 */

export type BalanceState = 'ok' | 'unavailable' | 'stale' | 'disconnected';

export interface AccountBalance {
  accountId: string;
  mode: 'demo' | 'real';
  currency: string | null;
  /** Null unless state is 'ok' or 'stale'. */
  balance: number | null;
  state: BalanceState;
  /** Epoch ms of the last successful read, or null if there has never been one. */
  lastUpdated: number | null;
  reason?: string;
}

export interface BalancesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  accounts: AccountBalance[];
  selectedAccountId: string | null;
  tokenExpiresAt: number | null;
  fetchedAt: number | null;
  error: string | null;
}

/* ------------------------------ store --------------------------------- */

let state: BalancesState = {
  status: 'idle',
  accounts: [],
  selectedAccountId: null,
  tokenExpiresAt: null,
  fetchedAt: null,
  error: null
};

const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function setState(next: Partial<BalancesState>): void {
  state = { ...state, ...next };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): BalancesState {
  return state;
}

/**
 * Keeps the selected account stable across refreshes. If the current selection
 * is gone (account removed, or first load), fall back to the first account —
 * preferring DEMO so a new session never lands on a REAL account by default.
 */
function reconcileSelection(accounts: AccountBalance[]): string | null {
  if (accounts.some((a) => a.accountId === state.selectedAccountId)) return state.selectedAccountId;
  const demo = accounts.find((a) => a.mode === 'demo');
  return (demo ?? accounts[0])?.accountId ?? null;
}

export interface RefreshOptions {
  /** Ask the server to bypass its freshness cache (reconnect / account switch). */
  force?: boolean;
}

/** Fetches every account balance for the signed-in customer. */
export function refreshBalances(opts: RefreshOptions = {}): Promise<void> {
  if (inflight) return inflight;
  const query = opts.force ? '?refresh=1' : '';
  setState({ status: state.accounts.length ? state.status : 'loading' });
  inflight = (async () => {
    try {
      const res = await fetch(`/api/balances${query}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (res.status === 401) {
        // Not signed in (or session ended): show no accounts rather than stale ones.
        setState({ status: 'idle', accounts: [], selectedAccountId: null, error: null });
        return;
      }
      if (!res.ok) {
        setState({ status: 'error', error: 'balance_request_failed' });
        return;
      }
      const data = await res.json();
      const accounts: AccountBalance[] = Array.isArray(data?.accounts) ? data.accounts : [];
      setState({
        status: 'ready',
        accounts,
        selectedAccountId: reconcileSelection(accounts),
        tokenExpiresAt: typeof data?.tokenExpiresAt === 'number' ? data.tokenExpiresAt : null,
        fetchedAt: typeof data?.fetchedAt === 'number' ? data.fetchedAt : Date.now(),
        error: null
      });
    } catch {
      setState({ status: 'error', error: 'network' });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Clears local balance state (e.g. on logout). */
export function resetBalances(): void {
  state = {
    status: 'idle',
    accounts: [],
    selectedAccountId: null,
    tokenExpiresAt: null,
    fetchedAt: null,
    error: null
  };
  emit();
}

/**
 * Selects an account and forces a fresh read, so a switch always revalidates
 * rather than showing a figure cached under the previous selection.
 */
export function selectAccount(accountId: string): void {
  if (accountId === state.selectedAccountId) return;
  setState({ selectedAccountId: accountId });
  void refreshBalances({ force: true });
}

/** Called when the market socket reconnects, to revalidate balances. */
export function onReconnect(): void {
  void refreshBalances({ force: true });
}

/* ------------------------------ hooks --------------------------------- */

export function useBalances(): BalancesState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The selected account's balance record, or null when there is none. */
export function useSelectedBalance(): AccountBalance | null {
  const s = useBalances();
  if (!s.selectedAccountId) return null;
  return s.accounts.find((a) => a.accountId === s.selectedAccountId) ?? null;
}

/** A 1s-ticking clock, for relative-time rendering that ages while idle. */
export function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
