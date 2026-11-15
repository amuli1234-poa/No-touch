import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, Hand, Info, Lock, ShieldAlert } from 'lucide-react';

import { useWorkspace } from '../../context/WorkspaceContext';
import { useAuth } from '../../lib/auth';
import { useBalances, formatMoney, pickAccount } from '../../lib/balances';
import {
  DEFAULT_DURATION_BOUNDS,
  fetchExecutionPreferences,
  saveExecutionPreferences,
  toMinutes,
  type ContractFamily,
  type DurationBounds,
  type ExecutionMode,
  type ExecutionPreferences
} from '../../lib/trade';
import { Card, StatTile } from '../ui/primitives';

/** Live Deriv floor: the smallest stake the platform accepts. */
const MIN_STAKE = 0.35;

/**
 * TRADE — the order ticket.
 *
 * The left sidebar opens this panel beside the shared chart. It lets the
 * customer set *how* they want to trade: manual or automatic, the contract
 * family, the stake and the duration (5–300 minutes). Manual and automatic both
 * run through the same server-side execution layer, so every kill switch, the
 * risk engine and signal single-use apply identically.
 *
 * This panel only records preferences. Placing a trade is a separate, explicit
 * step — see the confirm flow. Nothing here can move money on its own.
 */
export function TradeView() {
  const ws = useWorkspace();
  const auth = useAuth();
  const balances = useBalances();

  const [prefs, setPrefs] = useState<ExecutionPreferences | null>(null);
  const [bounds, setBounds] = useState<DurationBounds>(DEFAULT_DURATION_BOUNDS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);

  // Draft fields, so typing is responsive and a save is deliberate.
  const [mode, setMode] = useState<ExecutionMode>('manual');
  const [family, setFamily] = useState<ContractFamily>('rise_fall');
  const [stakeInput, setStakeInput] = useState('1');
  const [durationMinutes, setDurationMinutes] = useState('5');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetchExecutionPreferences();
      if (cancelled) return;
      if (res) {
        setPrefs(res.preferences);
        setBounds(res.durationBounds);
        setMode(res.preferences.mode);
        setFamily(res.preferences.contractFamily);
        setStakeInput(String(res.preferences.stake.amount));
        setDurationMinutes(String(toMinutes(res.preferences.parameters.duration, res.preferences.parameters.durationUnit) ?? 5));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const authenticated = auth.status === 'authenticated';
  const accounts = balances.accounts;
  const selectedAccount = useMemo(() => {
    const preferredMode = mode === 'automatic' ? 'demo' : 'demo';
    return pickAccount(accounts, preferredMode, balances.selectedAccountId);
  }, [accounts, balances.selectedAccountId, mode]);

  const realAccount = useMemo(() => pickAccount(accounts, 'real', balances.selectedAccountId), [
    accounts,
    balances.selectedAccountId
  ]);

  const stake = Number(stakeInput);
  const stakeValid = Number.isFinite(stake) && stake >= MIN_STAKE;
  const minutes = Number(durationMinutes);
  const durationValid =
    Number.isFinite(minutes) && minutes >= bounds.minMinutes && minutes <= bounds.maxMinutes;

  const save = useCallback(
    async (patch: Partial<ExecutionPreferences>) => {
      setSaving(true);
      const result = await saveExecutionPreferences(patch);
      setSaving(false);
      if (result.ok) {
        setPrefs(result.preferences);
        setNotice({ tone: 'ok', text: 'Trade settings saved.' });
      } else {
        setNotice({ tone: 'error', text: result.message });
      }
    },
    []
  );

  const onModeChange = (next: ExecutionMode) => {
    setMode(next);
    void save({ mode: next });
  };

  const onFamilyChange = (next: ContractFamily) => {
    setFamily(next);
    void save({ contractFamily: next });
  };

  const saveStake = () => {
    if (!stakeValid) {
      setNotice({ tone: 'error', text: `Enter a stake of at least ${MIN_STAKE}.` });
      return;
    }
    void save({ stake: { basis: 'stake', amount: stake, currency: prefs?.stake.currency ?? null } });
  };

  const saveDuration = () => {
    if (!durationValid) {
      setNotice({
        tone: 'error',
        text: `Duration must be between ${bounds.minMinutes} and ${bounds.maxMinutes} minutes.`
      });
      return;
    }
    void save({
      parameters: {
        ...(prefs?.parameters ?? {
          duration: 5,
          durationUnit: 'm' as const,
          multiplier: null,
          cancellation: null,
          stopLoss: null,
          takeProfit: null
        }),
        duration: minutes,
        durationUnit: 'm'
      }
    });
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3 space-y-3">
      <header className="flex items-start gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-accent/12 text-accent border border-accent/25 flex items-center justify-center shrink-0">
          <ArrowUpRight className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0">
          <h2 className="text-[14px] font-extrabold tracking-tight text-ink leading-tight">Trade</h2>
          <p className="text-[11px] text-muted leading-snug">
            Place a trade by hand, or let the scanner trade the setups it finds.
          </p>
        </div>
      </header>

      {!authenticated && (
        <Card className="p-3">
          <div className="flex items-start gap-2">
            <Lock className="w-4 h-4 text-warn shrink-0 mt-0.5" />
            <div>
              <div className="text-[12px] font-bold text-ink">Connect your Deriv account</div>
              <p className="text-[11px] text-muted mt-0.5">
                Trading needs a live Deriv session. Sign in to load your accounts, stake and duration.
              </p>
            </div>
          </div>
        </Card>
      )}

      {loading && (
        <Card className="p-3">
          <div className="text-[11px] text-muted">Loading your trade settings…</div>
        </Card>
      )}

      {!loading && (
        <>
          {/* ------------------------------ mode ------------------------------ */}
          <Card className="p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-faint mb-2">Mode</div>
            <div className="grid grid-cols-2 gap-2">
              <ModeButton
                active={mode === 'manual'}
                icon={<Hand className="w-3.5 h-3.5" />}
                label="Manual"
                hint="You approve each trade"
                onClick={() => onModeChange('manual')}
                disabled={!authenticated || saving}
              />
              <ModeButton
                active={mode === 'automatic'}
                icon={<Bot className="w-3.5 h-3.5" />}
                label="Automatic"
                hint="Scanner trades for you"
                onClick={() => onModeChange('automatic')}
                disabled={!authenticated || saving}
              />
            </div>

            {mode === 'automatic' && (
              <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-line-soft bg-panel px-2.5 py-2">
                <Info className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
                <p className="text-[10.5px] text-muted leading-snug">
                  Automatic execution runs on your <strong className="text-ink">demo</strong> account in this
                  build. Real-money automation stays switched off until it is explicitly released.
                </p>
              </div>
            )}
          </Card>

          {/* ---------------------------- instrument -------------------------- */}
          <Card className="p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-faint mb-2">Contract</div>
            <div className="grid grid-cols-2 gap-2">
              <ModeButton
                active={family === 'rise_fall'}
                icon={<ArrowUpRight className="w-3.5 h-3.5" />}
                label="Rise / Fall"
                hint="Fixed duration"
                onClick={() => onFamilyChange('rise_fall')}
                disabled={!authenticated || saving}
              />
              <ModeButton
                active={family === 'multipliers'}
                icon={<ArrowDownRight className="w-3.5 h-3.5" />}
                label="Multipliers"
                hint="Higher risk"
                onClick={() => onFamilyChange('multipliers')}
                disabled={!authenticated || saving}
              />
            </div>
            <div className="mt-2.5 text-[10.5px] text-muted">
              Trading on{' '}
              <span className="font-bold text-ink">{ws.marketName || ws.selectedSymbol || '—'}</span>
              {ws.timeframe ? <span className="text-faint"> · {ws.timeframe}</span> : null}
            </div>
          </Card>

          {/* ------------------------------ stake ----------------------------- */}
          <Card className="p-3">
            <label htmlFor="trade-stake" className="text-[10px] font-bold uppercase tracking-wider text-faint">
              Stake
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-[12px] font-bold text-muted">
                {selectedAccount?.currency ?? prefs?.stake.currency ?? 'USD'}
              </span>
              <input
                id="trade-stake"
                type="number"
                min={MIN_STAKE}
                step="0.01"
                inputMode="decimal"
                value={stakeInput}
                onChange={(e) => setStakeInput(e.target.value)}
                onBlur={saveStake}
                disabled={!authenticated}
                className="flex-1 min-w-0 bg-panel border border-line rounded-lg px-2.5 py-2 text-[13px] font-mono tabular-nums text-ink outline-none focus:border-accent/50"
              />
            </div>
            <p className="text-[10px] text-faint mt-1">
              Minimum {MIN_STAKE}. {family === 'multipliers' ? 'Staked per contract.' : 'Fixed stake per trade.'}
            </p>
          </Card>

          {/* ----------------------------- duration --------------------------- */}
          <Card className="p-3">
            <label htmlFor="trade-duration" className="text-[10px] font-bold uppercase tracking-wider text-faint">
              Duration
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                id="trade-duration"
                type="number"
                min={bounds.minMinutes}
                max={bounds.maxMinutes}
                step="1"
                inputMode="numeric"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
                onBlur={saveDuration}
                disabled={!authenticated || family === 'multipliers'}
                className="flex-1 min-w-0 bg-panel border border-line rounded-lg px-2.5 py-2 text-[13px] font-mono tabular-nums text-ink outline-none focus:border-accent/50 disabled:opacity-50"
              />
              <span className="text-[12px] font-bold text-muted">minutes</span>
            </div>
            {family === 'multipliers' ? (
              <p className="text-[10px] text-faint mt-1">
                Multipliers contracts have no fixed duration; they run until you close them.
              </p>
            ) : (
              <p className="text-[10px] text-faint mt-1">
                Between {bounds.minMinutes} and {bounds.maxMinutes} minutes.
              </p>
            )}
          </Card>

          {/* ------------------------------ account --------------------------- */}
          <Card className="p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-faint mb-2">Account</div>
            <div className="grid grid-cols-2 gap-2">
              <StatTile
                label="Demo"
                value={
                  pickAccount(accounts, 'demo', balances.selectedAccountId)
                    ? formatMoney(
                        pickAccount(accounts, 'demo', balances.selectedAccountId)!.balance,
                        pickAccount(accounts, 'demo', balances.selectedAccountId)!.currency
                      )
                    : '—'
                }
                hint={mode === 'automatic' ? 'Trades here' : undefined}
              />
              <StatTile
                label="Real"
                value={realAccount ? formatMoney(realAccount.balance, realAccount.currency) : '—'}
                valueClass={realAccount ? 'text-ink' : 'text-faint'}
                hint={mode === 'manual' ? 'Manual only' : undefined}
              />
            </div>
            {!realAccount && (
              <p className="text-[10px] text-faint mt-1.5">No real account is linked to this session.</p>
            )}
          </Card>

          {/* ------------------------------ summary --------------------------- */}
          <Card className="p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-faint mb-2">Summary</div>
            <dl className="space-y-1.5 text-[11.5px]">
              <Row label="Mode" value={mode === 'manual' ? 'Manual' : 'Automatic'} />
              <Row label="Contract" value={family === 'rise_fall' ? 'Rise / Fall' : 'Multipliers'} />
              <Row label="Stake" value={stakeValid ? `${stake.toFixed(2)} ${selectedAccount?.currency ?? 'USD'}` : '—'} />
              <Row
                label="Duration"
                value={family === 'multipliers' ? 'No expiry' : durationValid ? `${minutes} min` : '—'}
              />
            </dl>
          </Card>

          {prefs?.autoStopped && (
            <Card className="p-3 border-danger/40">
              <div className="flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                <div>
                  <div className="text-[12px] font-bold text-danger">Automatic execution is stopped</div>
                  <p className="text-[11px] text-muted mt-0.5">
                    Risk controls engaged the emergency stop. It will not resume until you turn it back on.
                  </p>
                </div>
              </div>
            </Card>
          )}

          <Card className="p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-0.5" />
              <p className="text-[10.5px] text-muted leading-snug">
                Trading is a real risk to your capital. The next step adds the confirm-and-place flow; these
                settings alone place nothing.
              </p>
            </div>
          </Card>
        </>
      )}

      {notice && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 text-[11px] font-semibold ${
            notice.tone === 'ok'
              ? 'border-success/40 text-success bg-success/8'
              : notice.tone === 'error'
                ? 'border-danger/40 text-danger bg-danger/8'
                : 'border-line text-muted bg-panel'
          }`}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="font-bold text-ink font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function ModeButton({
  active,
  icon,
  label,
  hint,
  onClick,
  disabled
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
        active ? 'border-accent/40 bg-accent/10' : 'border-line bg-panel hover:border-accent/25'
      }`}
    >
      <span className={`flex items-center gap-1.5 text-[11.5px] font-bold ${active ? 'text-accent' : 'text-ink'}`}>
        {icon}
        {label}
      </span>
      <span className="text-[9.5px] text-faint leading-tight">{hint}</span>
    </button>
  );
}
