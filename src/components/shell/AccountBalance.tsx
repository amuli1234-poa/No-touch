import React from 'react';
import { ChevronDown, RefreshCw, Wallet } from 'lucide-react';
import { Badge, StatusDot, type Tone } from '../ui';
import {
  BALANCE_STATE_LABEL,
  formatMoney,
  refreshBalances,
  selectAccount,
  useBalances,
  useNowTick,
  type AccountBalance,
  type BalanceState
} from '../../lib/balances';

/**
 * Selected-account balance for the workspace header.
 *
 * The figure is informational only. It is never treated as proof of funds or of
 * authorization to trade — the backend re-validates the account and every
 * execution requirement independently.
 *
 * DEMO and REAL are never merged: the chip shows one account at a time and the
 * picker lists them separately, each with its own mode, currency and balance.
 */

const STATE_TONE: Record<BalanceState, Tone> = {
  ok: 'success',
  stale: 'warning',
  unavailable: 'neutral',
  disconnected: 'danger'
};

const STATE_LABEL = BALANCE_STATE_LABEL;

/** "Updated 12s ago" style label; "Never" when there has been no good read. */
function lastUpdatedLabel(lastUpdated: number | null, now: number): string {
  if (lastUpdated === null) return 'Never updated';
  const seconds = Math.max(0, Math.floor((now - lastUpdated) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.floor(minutes / 60)}h ago`;
}

export const AccountBalanceChip: React.FC = () => {
  const { status, accounts, selectedAccountId, error } = useBalances();
  const now = useNowTick(1000);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const selected = accounts.find((a) => a.accountId === selectedAccountId) ?? null;

  // Loading: no figure yet and a request in flight.
  if (status === 'loading' && accounts.length === 0) {
    return (
      <div className="hidden items-center gap-2 rounded-[9px] border border-line-soft bg-surface px-2.5 py-1.5 lg:flex">
        <Wallet className="h-3.5 w-3.5 text-fg-5" />
        <span className="text-[11px] text-fg-5">Loading balance…</span>
      </div>
    );
  }

  // Error with nothing cached: say so plainly rather than showing a number.
  if (status === 'error' && accounts.length === 0) {
    return (
      <button
        onClick={() => void refreshBalances({ force: true })}
        className="hidden items-center gap-2 rounded-[9px] border border-line-soft bg-surface px-2.5 py-1.5 lg:flex"
        title={error ?? 'Balance unavailable'}
      >
        <StatusDot tone="danger" label="Balance unavailable" />
        <RefreshCw className="h-3 w-3 text-fg-5" />
      </button>
    );
  }

  // No accounts at all (e.g. not signed in, or none authorized).
  if (!selected) {
    return (
      <div className="hidden items-center gap-2 rounded-[9px] border border-line-soft bg-surface px-2.5 py-1.5 lg:flex">
        <Wallet className="h-3.5 w-3.5 text-fg-5" />
        <span className="text-[11px] text-fg-5">No accounts</span>
      </div>
    );
  }

  const handleRefresh = async () => {
    setBusy(true);
    await refreshBalances({ force: true });
    setBusy(false);
  };

  return (
    <div className="relative hidden lg:block" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-[9px] border border-line-soft bg-surface px-2.5 py-1.5 transition-colors hover:border-line-strong"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${selected.mode.toUpperCase()} account ${selected.accountId}`}
      >
        <Badge tone={selected.mode === 'real' ? 'warning' : 'info'} className="!px-1.5 !py-0 !text-[9.5px]">
          {selected.mode === 'real' ? 'Real' : 'Demo'}
        </Badge>
        <span className="tabular text-[12px] font-semibold text-fg-1">
          {formatMoney(selected.balance, selected.currency)}
        </span>
        <StatusDot
          tone={STATE_TONE[selected.state]}
          pulse={selected.state === 'ok'}
          label={STATE_LABEL[selected.state]}
        />
        <ChevronDown className="h-3.5 w-3.5 text-fg-5" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-40 w-72 overflow-hidden rounded-[12px] border border-line-soft bg-surface shadow-[var(--shadow-modal)]"
        >
          <div className="flex items-center justify-between border-b border-line-soft px-3.5 py-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-6">
              Deriv accounts
            </span>
            <button
              onClick={handleRefresh}
              disabled={busy}
              className="flex items-center gap-1 text-[10.5px] font-medium text-fg-4 transition-colors hover:text-fg-1 disabled:opacity-60"
            >
              <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

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

          <p className="border-t border-line-soft px-3.5 py-2 text-[10px] leading-relaxed text-fg-6">
            Informational only. Balances never authorize a trade — every order is validated
            server-side.
          </p>
        </div>
      )}
    </div>
  );
};

const AccountRow: React.FC<{
  account: AccountBalance;
  now: number;
  active: boolean;
  onSelect: () => void;
}> = ({ account, now, active, onSelect }) => (
  <button
    role="menuitemradio"
    aria-checked={active}
    onClick={onSelect}
    className={`flex w-full items-start justify-between gap-2 px-3.5 py-2 text-left transition-colors ${
      active ? 'bg-surface-raised' : 'hover:bg-surface-raised'
    }`}
  >
    <span className="min-w-0">
      <span className="flex items-center gap-1.5">
        <Badge tone={account.mode === 'real' ? 'warning' : 'info'} className="!px-1.5 !py-0 !text-[9px]">
          {account.mode === 'real' ? 'Real' : 'Demo'}
        </Badge>
        <span className="truncate text-[11.5px] font-semibold text-fg-2">{account.accountId}</span>
      </span>
      <span className="mt-0.5 block text-[10px] text-fg-6">
        {account.state === 'ok'
          ? lastUpdatedLabel(account.lastUpdated, now)
          : `${STATE_LABEL[account.state]}${account.lastUpdated ? ` · ${lastUpdatedLabel(account.lastUpdated, now)}` : ''}`}
      </span>
    </span>
    <span className="shrink-0 text-right">
      <span className="tabular block text-[12px] font-semibold text-fg-1">
        {formatMoney(account.balance, account.currency)}
      </span>
      <span className="mt-0.5 block text-[10px] text-fg-6">
        {account.currency ?? '—'}
      </span>
    </span>
  </button>
);
