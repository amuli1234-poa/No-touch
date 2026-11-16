import { useState } from 'react';
import { Loader2, RefreshCw, Wallet } from 'lucide-react';
import {
  BALANCE_STATE_LABEL,
  formatMoney,
  lastUpdatedLabel,
  refreshBalances,
  selectAccount,
  splitByMode,
  totalBalance,
  useBalances,
  useNowTick,
  type AccountBalance,
  type BalanceState,
} from '../../lib/balances';
import { SectionCard, StatTile } from '../ui/primitives';

/**
 * Deriv accounts at a glance for the dashboard.
 *
 * Lists every account the signed-in customer owns, DEMO and REAL kept strictly
 * apart. Figures come only from the server; a failed read shows an em dash, and
 * a group total is withheld unless every known balance shares one currency — a
 * number is never invented. Selecting an account sets it as the active one.
 */

const STATE_DOT: Record<BalanceState, string> = {
  ok: 'bg-success',
  stale: 'bg-warn',
  unavailable: 'bg-faint',
  disconnected: 'bg-danger',
};

function AccountLine({
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
      onClick={onSelect}
      aria-pressed={active}
      className={`w-full flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer ${
        active
          ? 'border-accent/40 bg-accent/8'
          : 'border-line bg-panel hover:border-line-strong hover:bg-elevated'
      }`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[account.state]}`} />
        <span className="min-w-0">
          <span className="block truncate font-mono text-[13px] font-semibold text-ink">
            {account.accountId}
          </span>
          <span className="block text-[11px] text-faint">
            {account.state === 'ok'
              ? lastUpdatedLabel(account.lastUpdated, now)
              : BALANCE_STATE_LABEL[account.state]}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-mono text-[13.5px] font-bold tabular-nums text-ink">
          {formatMoney(account.balance, account.currency)}
        </span>
      </span>
    </button>
  );
}

function ModeGroup({
  title,
  tone,
  accounts,
  now,
  selectedAccountId,
  onSelect,
}: {
  title: string;
  tone: 'demo' | 'real';
  accounts: AccountBalance[];
  now: number;
  selectedAccountId: string | null;
  onSelect: (id: string) => void;
}) {
  const total = totalBalance(accounts);
  const accent = tone === 'real' ? 'text-warn' : 'text-accent';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[11px] font-bold uppercase tracking-wider ${accent}`}>{title}</span>
        <span className="text-[12px] text-faint">
          {accounts.length} account{accounts.length === 1 ? '' : 's'}
        </span>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12px] text-faint">
          No {title.toLowerCase()} accounts
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {accounts.map((a) => (
            <AccountLine
              key={a.accountId}
              account={a}
              now={now}
              active={a.accountId === selectedAccountId}
              onSelect={() => onSelect(a.accountId)}
            />
          ))}
        </div>
      )}

      {total && (
        <div className="flex items-baseline justify-between border-t border-line-soft pt-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Total</span>
          <span className="font-mono text-[13px] font-bold tabular-nums text-ink">
            {formatMoney(total.total, total.currency)}
          </span>
        </div>
      )}
    </div>
  );
}

export function AccountsOverview() {
  const { status, accounts, selectedAccountId, error } = useBalances();
  const now = useNowTick(1000);
  const [busy, setBusy] = useState(false);

  const { demo, real } = splitByMode(accounts);

  const handleRefresh = async () => {
    setBusy(true);
    await refreshBalances({ force: true });
    setBusy(false);
  };

  const refreshButton = (
    <button
      type="button"
      onClick={() => void handleRefresh()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 h-8 px-2.5 text-[12px] font-medium text-muted bg-elevated border border-line rounded-lg hover:text-ink hover:border-accent/50 transition-colors disabled:opacity-60 cursor-pointer"
    >
      <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
      Refresh
    </button>
  );

  return (
    <SectionCard
      title="Deriv Accounts"
      subtitle="DEMO and REAL accounts are listed separately; balances are read-only"
      icon={<Wallet className="w-4 h-4" />}
      right={refreshButton}
    >
      {status === 'loading' && accounts.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-faint">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          Loading accounts…
        </div>
      ) : status === 'error' && accounts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <p className="text-[13px] text-muted">
            {error === 'network' ? 'Network error' : 'Balance request failed'} — the figures are
            unavailable right now.
          </p>
          {refreshButton}
        </div>
      ) : accounts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <p className="text-[13px] text-muted">
            No accounts are authorized for this session. Re-authorize with Deriv to read balances.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ModeGroup
              title="Demo"
              tone="demo"
              accounts={demo}
              now={now}
              selectedAccountId={selectedAccountId}
              onSelect={selectAccount}
            />
            <ModeGroup
              title="Real"
              tone="real"
              accounts={real}
              now={now}
              selectedAccountId={selectedAccountId}
              onSelect={selectAccount}
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <StatTile
              label="Demo accounts"
              value={demo.length}
              hint="Practice funds, separate from real"
            />
            <StatTile
              label="Real accounts"
              value={real.length}
              valueClass={real.length > 0 ? 'text-warn' : 'text-ink'}
              hint="Live funds — never merged with demo"
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
}
