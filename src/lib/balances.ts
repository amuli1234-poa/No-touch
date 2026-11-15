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

/* ---------------------------- presentation ---------------------------- */

/**
 * Money with its currency, or an em dash when there is no figure. A failed read
 * is never rendered as 0 — the caller passes null and gets "—".
 */
export function formatMoney(balance: number | null, currency: string | null): string {
  if (balance === null) return '—';
  const amount = balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${amount} ${currency}` : amount;
}

/**
 * Picks the record to show for a mode: the customer's selected account when it
 * matches the mode, otherwise the first of that mode. Only chooses among records
 * the server returned — it never invents one.
 */
export function pickAccount(
  accounts: AccountBalance[],
  mode: 'demo' | 'real',
  selectedAccountId: string | null
): AccountBalance | null {
  const selected = accounts.find((a) => a.accountId === selectedAccountId);
  if (selected && selected.mode === mode) return selected;
  return accounts.find((a) => a.mode === mode) ?? null;
}

/** Splits accounts into DEMO and REAL, order preserved. Modes are never merged. */
export function splitByMode(accounts: AccountBalance[]): {
  demo: AccountBalance[];
  real: AccountBalance[];
} {
  return {
    demo: accounts.filter((a) => a.mode === 'demo'),
    real: accounts.filter((a) => a.mode === 'real')
  };
}

/**
 * Sum of the known balances in a set, or null when a total would be fabricated.
 *
 * A total is only produced when at least one balance is known AND every known
 * balance shares one currency — adding across currencies would invent a figure.
 * Accounts whose read failed (null balance) never contribute.
 */
export function totalBalance(
  accounts: AccountBalance[]
): { total: number; currency: string | null } | null {
  const known = accounts.filter(
    (a) => a.balance !== null && (a.state === 'ok' || a.state === 'stale')
  );
  if (known.length === 0) return null;
  if (new Set(known.map((a) => a.currency ?? '')).size > 1) return null;
  return {
    total: known.reduce((sum, a) => sum + (a.balance ?? 0), 0),
    currency: known[0].currency
  };
}

export const BALANCE_STATE_LABEL: Record<BalanceState, string> = {
  ok: 'Live',
  stale: 'Stale',
  unavailable: 'Unavailable',
  disconnected: 'Disconnected'
};

/**
 * Short age of the last good read, for the compact nav bar: "12s", "3m", "2h",
 * or "—" when there has never been a good read. Never a number when the age is
 * unknown, so a missing read cannot read as fresh.
 */
export function lastUpdatedShort(lastUpdated: number | null, now: number): string {
  if (lastUpdated === null) return '—';
  const seconds = Math.max(0, Math.floor((now - lastUpdated) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/** Full "Updated 12s ago" label, for the dropdown; "Never updated" when none. */
export function lastUpdatedLabel(lastUpdated: number | null, now: number): string {
  if (lastUpdated === null) return 'Never updated';
  const seconds = Math.max(0, Math.floor((now - lastUpdated) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.floor(minutes / 60)}h ago`;
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
