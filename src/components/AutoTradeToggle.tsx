import { Bot, Loader2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { toggleAutomaticTrading, useExecutionControl } from '../lib/execution';
import { automaticTradingDisabledMessage } from '../lib/trade';

/**
 * Header switch for automatic trading.
 *
 * It reflects the server's own permission and the customer's stored intent, and
 * writes the intent back through the same preferences endpoint the Trade panel
 * uses. It never places a trade itself: the server re-derives every permission on
 * each purchase, so this control only expresses what the customer wants.
 *
 * Only the signals that clear the customer's Signal Quality Filter are published
 * for automatic entry (see App.tsx), so what this switch acts on is exactly the
 * set the customer is shown.
 */
export function AutoTradeToggle({ mobileLabel }: { mobileLabel?: string } = {}) {
  const auth = useAuth();
  const control = useExecutionControl();

  if (auth.status !== 'authenticated') return null;

  const on = control.mode === 'automatic';
  const disabled = !control.automaticEnabled && !on;
  const reason = control.status?.reason ?? null;
  const title = disabled
    ? automaticTradingDisabledMessage(reason)
    : on
      ? 'Automatic trading is on — the scanner trades the signals you are shown. Click to switch to manual.'
      : 'Click to let the scanner trade the signals you are shown automatically';

  return (
    <button
      type="button"
      onClick={() => void toggleAutomaticTrading(!on)}
      disabled={control.saving || disabled}
      aria-pressed={on}
      aria-label={mobileLabel ?? 'Toggle automatic trading'}
      data-testid="auto-trade-toggle"
      title={title}
      className={`inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border text-[12px] font-bold transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer ${
        on
          ? 'bg-emerald-500/12 border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/20'
          : 'bg-elevated border-line text-muted hover:text-ink hover:border-accent/50'
      }`}
    >
      {control.saving ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Bot className="w-3.5 h-3.5" aria-hidden="true" />
      )}
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${on ? 'bg-emerald-500' : 'bg-faint'}`} />
      <span className="hidden lg:inline">{on ? 'Auto' : 'Manual'}</span>
    </button>
  );
}
