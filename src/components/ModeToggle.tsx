import { pickAccount, selectAccount, useBalances } from '../lib/balances';

/**
 * Real / Demo account switch for the workspace header.
 *
 * Switches the *selected* account to the first account of the chosen mode. It
 * only ever selects an account the server returned (via `pickAccount`) — it
 * never invents one — and a mode with no account is disabled rather than
 * silently selected. Balances are informational; the switch does not authorise
 * a trade.
 */
export function ModeToggle() {
  const { accounts, selectedAccountId } = useBalances();
  const selected = accounts.find((a) => a.accountId === selectedAccountId) ?? null;
  const mode = selected?.mode ?? 'demo';
  const hasDemo = accounts.some((a) => a.mode === 'demo');
  const hasReal = accounts.some((a) => a.mode === 'real');

  const switchTo = (next: 'demo' | 'real') => {
    const account = pickAccount(accounts, next, selectedAccountId);
    if (account && account.accountId !== selectedAccountId) selectAccount(account.accountId);
  };

  const base =
    'px-2.5 py-1 text-[13px] font-semibold tracking-tight rounded-[7px] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40';
  const active = 'bg-surface-raised text-fg-1 shadow-sm';
  const idle = 'text-fg-3 hover:text-fg-1';

  return (
    <div
      role="group"
      aria-label="Account mode"
      className="inline-flex items-center gap-0.5 rounded-[9px] border border-[var(--ws-hairline)] bg-surface p-0.5"
    >
      <button
        type="button"
        aria-pressed={mode === 'demo'}
        disabled={!hasDemo}
        onClick={() => switchTo('demo')}
        className={`${base} ${mode === 'demo' ? active : idle}`}
      >
        Demo
      </button>
      <button
        type="button"
        aria-pressed={mode === 'real'}
        disabled={!hasReal}
        onClick={() => switchTo('real')}
        className={`${base} ${mode === 'real' ? active : idle}`}
      >
        Real
      </button>
    </div>
  );
}