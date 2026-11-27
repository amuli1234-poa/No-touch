import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, LogOut, RefreshCw, Wallet } from 'lucide-react';
import {
  BALANCE_STATE_LABEL,
  formatMoney,
  isDerivTokenExpired,
  lastUpdatedLabel,
  refreshBalances,
  selectAccount,
  useBalances,
  useNowTick,
  type AccountBalance,
  type BalanceState,
} from '../lib/balances';
import { logout, useAuth } from '../lib/auth';
import { navigate } from '../lib/router';

/**
 * Deriv account + balance control for the workspace header.
 *
 * Shows the selected account's live balance and opens a menu of every account
 * the customer owns — DEMO and REAL listed separately, never merged. The figure
 * is informational only: it never authorises a trade, and a failed read renders
 * as an em dash, never as 0. The menu also carries the signed-in identity and
 * sign-out, so the whole account surface lives in one place.
 */

const STATE_DOT: Record<BalanceState, string> = {
  ok: 'bg-success',
  stale: 'bg-warn',
  unavailable: 'bg-faint',
  disconnected: 'bg-danger',
};

function ModePill({ mode }: { mode: 'demo' | 'real' }) {
  const real = mode === 'real';
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${
        real
          ? 'text-warn bg-warn/10 border-warn/25'
          : 'text-accent bg-accent/10 border-accent/25'
      }`}
    >
      {real ? 'Real' : 'Demo'}
    </span>
  );
}

function AccountRow({
  account,
  now,
  active,
  onSelect,
}: {
  account: AccountBalance;
  now: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onSelect}
      className={`w-full flex items-start justify-between gap-3 px-3.5 py-2.5 text-left transition-colors cursor-pointer ${
        active ? 'bg-elevated' : 'hover:bg-elevated'
      }`}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <ModePill mode={account.mode} />
          <span className="truncate text-[12.5px] font-semibold text-ink">{account.accountId}</span>
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[account.state]}`} />
          {account.state === 'ok'
            ? lastUpdatedLabel(account.lastUpdated, now)
            : BALANCE_STATE_LABEL[account.state]}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-mono text-[13.5px] font-bold tabular-nums text-ink">
          {formatMoney(account.balance, account.currency)}
        </span>
        <span className="mt-0.5 block text-[11px] text-faint">{account.currency ?? '—'}</span>
      </span>
    </button>
  );
}

export function AccountBalanceChip() {
  const { status, accounts, selectedAccountId, tokenExpiresAt, error } = useBalances();
  const auth = useAuth();
  const now = useNowTick(1000);
  const tokenExpired = isDerivTokenExpired(tokenExpiresAt, now);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = accounts.find((a) => a.accountId === selectedAccountId) ?? null;
  const loginId = auth.status === 'authenticated' ? auth.user.loginId : null;

  const handleRefresh = async () => {
    setBusy(true);
    await refreshBalances({ force: true });
    setBusy(false);
  };

  const handleSignOut = async () => {
    await logout();
    navigate('/login');
  };

  const triggerClass =
    'flex items-center gap-1 sm:gap-1.5 h-9 px-1.5 sm:px-2.5 rounded-lg bg-elevated border border-line text-muted hover:text-ink hover:border-accent/50 transition-colors cursor-pointer';

  if (status === 'loading' && accounts.length === 0) {
    return (
      <div className="hidden sm:flex items-center gap-1.5 h-9 px-2.5 rounded-lg bg-elevated border border-line">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-faint" aria-hidden="true" />
        <span className="text-[12px] text-faint">Loading…</span>
      </div>
    );
  }

  if (status === 'error' && accounts.length === 0) {
    return (
      <button
        type="button"
        onClick={() => void refreshBalances({ force: true })}
        className={triggerClass}
        title={error ?? 'Balance unavailable'}
        aria-label="Balance unavailable — retry"
      >
        <AlertTriangle className="w-3.5 h-3.5 text-danger" aria-hidden="true" />
        <span className="hidden md:inline text-[12px] text-faint">Unavailable</span>
      </button>
    );
  }

  if (!selected) {
    return (
      <div className="hidden sm:flex items-center gap-1.5 h-9 px-2.5 rounded-lg bg-elevated border border-line">
        <Wallet className="w-3.5 h-3.5 text-faint" aria-hidden="true" />
        <span className="text-[12px] text-faint">No accounts</span>
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-1 shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClass}
        title={
          tokenExpired
            ? `${selected.mode.toUpperCase()} account ${selected.accountId} — Deriv authorization expired, reconnect to refresh`
            : `${selected.mode.toUpperCase()} account ${selected.accountId}`
        }
      >
        <ModePill mode={selected.mode} />
        <span className="font-mono text-[12.5px] font-bold tabular-nums text-ink">
          {formatMoney(selected.balance, null)}
          {selected.currency && (
            <span className="hidden md:inline text-faint"> {selected.currency}</span>
          )}
        </span>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[selected.state]}`} />
        <ChevronDown className="w-3.5 h-3.5 text-faint" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-80 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        >
          <div className="flex items-start justify-between gap-2 px-3.5 py-3 border-b border-line-soft">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                Deriv accounts
              </div>
              <div className="mt-0.5 truncate text-[13px] font-semibold text-ink">
                {loginId ?? 'Signed in'}
              </div>
              <div className="mt-0.5 text-[11px] text-faint">
                {selected ? lastUpdatedLabel(selected.lastUpdated, now) : '—'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={busy}
              className="flex items-center gap-1 text-[11.5px] font-medium text-muted hover:text-ink transition-colors disabled:opacity-60 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>
          </div>

          {tokenExpired && (
            <div className="flex items-start gap-2 px-3.5 py-2.5 border-b border-line-soft bg-warn/10">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warn" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-warn">Deriv authorization expired</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-faint">
                  Balances cannot be read until you reconnect. Deriv tokens last about 24 hours and
                  cannot be refreshed.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate('/login');
                  }}
                  className="mt-1.5 text-[11.5px] font-semibold text-warn hover:underline cursor-pointer"
                >
                  Reconnect Deriv →
                </button>
              </div>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto py-1">
            {accounts.map((account) => (
              <AccountRow
                key={account.accountId}
                account={account}
                now={now}
                active={account.accountId === selectedAccountId}
                onSelect={() => {
                  selectAccount(account.accountId);
                  setOpen(false);
                }}
              />
            ))}
          </div>

          <div className="border-t border-line-soft px-3.5 py-2">
            <p className="text-[11px] leading-relaxed text-faint">
              Informational only. Balances never authorise a trade — every order is validated
              server-side.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="w-full flex items-center gap-2 px-3.5 py-2.5 border-t border-line-soft text-[13px] font-medium text-muted hover:text-danger hover:bg-elevated transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
