import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Hand,
  Info,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert
} from 'lucide-react';

import { useWorkspace } from '../../context/WorkspaceContext';
import { startDerivAuth, useAuth } from '../../lib/auth';
import { useBalances, formatMoney, pickAccount, refreshBalances } from '../../lib/balances';
import {
  DEFAULT_DURATION_BOUNDS,
  fetchExecutionPreferences,
  fetchScannerStatus,
  MULTIPLIERS_ENABLED,
  placeTrade,
  previewTrade,
  resetDemoRiskSession,
  saveExecutionPreferences,
  toMinutes,
  type ContractFamily,
  type DurationBounds,
  type ExecutionMode,
  type ExecutionParameters,
  type ExecutionPreferences,
  type ScannerStatus,
  type SignalDirection,
  type TradePreview
} from '../../lib/trade';
import { Card, StatTile } from '../ui/primitives';
import { ExecutionPositions } from './ExecutionPositions';

/** Live Deriv floor: the smallest stake the platform accepts. */
const MIN_STAKE = 0.35;
/** Multipliers must be chosen; Deriv's range for the synthetic indices starts at 40. */
const DEFAULT_MULTIPLIER = 40;

/**
 * TRADE — the order ticket.
 *
 * The left sidebar opens this panel beside the shared chart. It lets the
 * customer set *how* they want to trade (manual or automatic, the contract
 * family, the stake and the duration), price the trade, and — in manual mode —
 * place it.
 *
 * Everything a manual trade does goes through the server's single purchase path
 * (signal → intent → submit), so the kill switches, the risk engine and the
 * single-use signal all apply. This panel can never buy on its own: it can only
 * ask the server to.
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
  const [multiplierInput, setMultiplierInput] = useState(String(DEFAULT_MULTIPLIER));

  // Manual placement state.
  const [direction, setDirection] = useState<SignalDirection | null>(null);
  const [preview, setPreview] = useState<TradePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<{ contractId: number | null; payout: number | null } | null>(null);
  const [scanner, setScanner] = useState<ScannerStatus | null>(null);
  const [riskResetConfirm, setRiskResetConfirm] = useState(false);
  const [riskResetting, setRiskResetting] = useState(false);

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
        setDurationMinutes(
          String(toMinutes(res.preferences.parameters.duration, res.preferences.parameters.durationUnit) ?? 5)
        );
        if (res.preferences.parameters.multiplier) {
          setMultiplierInput(String(res.preferences.parameters.multiplier));
        }
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const authenticated = auth.status === 'authenticated';
  const accounts = balances.accounts;

  // Poll the scanner's status while signed in. In automatic mode this shows the
  // loop working; in manual mode it reports whether the server even permits
  // automatic trading, so the panel can disable the Automatic option.
  useEffect(() => {
    if (!authenticated) {
      setScanner(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const status = await fetchScannerStatus();
      if (!cancelled) setScanner(status);
    };
    void poll();
    const id = setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [authenticated]);

  // Keep the server's balance cache warm while the ticket is open. The risk
  // engine reads the balance at submit time; without this the read can fall
  // outside the cache window and the server opens a fresh Deriv OTP + WebSocket
  // just to price the risk check, which is the slowest part of placing a trade.
  // A non-forced read is served from that cache when it is still fresh.
  useEffect(() => {
    if (!authenticated) return;
    void refreshBalances();
    const id = setInterval(() => void refreshBalances(), 20_000);
    return () => clearInterval(id);
  }, [authenticated]);

  // A manual trade uses the account the customer has selected; automatic runs on
  // demo in this build. Either way the server re-checks ownership on submit.
  const tradingAccount = useMemo(() => {
    if (mode === 'automatic') return pickAccount(accounts, 'demo', balances.selectedAccountId);
    return (
      accounts.find((a) => a.accountId === balances.selectedAccountId) ??
      pickAccount(accounts, 'demo', balances.selectedAccountId)
    );
  }, [accounts, balances.selectedAccountId, mode]);

  /**
   * The scanner's live setup for the instrument the customer is looking at.
   * This is DISPLAY ONLY: manual trading is the customer's own call, so a live
   * setup is shown as context but never gates or picks the direction. Automatic
   * mode is the scanner's own domain, where the live setup is the entry reason.
   */
  const liveSetup = useMemo(
    () => scanner?.setups.find((s) => s.symbol === ws.selectedSymbol) ?? null,
    [scanner, ws.selectedSymbol]
  );
  const signalDirection = liveSetup?.direction ?? null;

  // Automatic trading is a server-side switch. Until the panel has heard from
  // the server it stays optimistic; once told, it is authoritative.
  const automaticEnabled = scanner ? scanner.automaticEnabled : true;

  // A stored preference may still say "automatic" from before the switch was
  // turned off. Once the server confirms automatic is off, fall the ticket back
  // to manual and say so, rather than sitting on a mode the server will refuse.
  useEffect(() => {
    if (scanner && !scanner.automaticEnabled && mode === 'automatic') {
      setMode('manual');
      setNotice({
        tone: 'info',
        text: 'Automatic trading is switched off on this server, so this ticket was reset to manual.'
      });
    }
  }, [scanner, mode]);

  // A Deriv OAuth token lasts a day and cannot be refreshed (Deriv issues no
  // refresh tokens), so after it lapses every trade and balance read fails. The
  // server reports the expiry, letting the panel say "reconnect" instead of
  // showing an opaque failure.
  const derivTokenExpired =
    balances.tokenExpiresAt !== null && balances.tokenExpiresAt <= Date.now();

  const realAccount = useMemo(() => pickAccount(accounts, 'real', balances.selectedAccountId), [
    accounts,
    balances.selectedAccountId
  ]);

  const stake = Number(stakeInput);
  const stakeValid = Number.isFinite(stake) && stake >= MIN_STAKE;
  const minutes = Number(durationMinutes);
  const durationValid =
    Number.isFinite(minutes) && minutes >= bounds.minMinutes && minutes <= bounds.maxMinutes;
  const multiplier = Number(multiplierInput);
  const multiplierValid = Number.isFinite(multiplier) && multiplier > 0;

  const currency = tradingAccount?.currency ?? prefs?.stake.currency ?? 'USD';

  useEffect(() => {
    setRiskResetConfirm(false);
  }, [tradingAccount?.accountId, prefs?.autoStopped]);

  const parameters: ExecutionParameters = useMemo(
    () => ({
      duration: minutes,
      durationUnit: 'm',
      multiplier: family === 'multipliers' ? multiplier : null,
      cancellation: null,
      stopLoss: null,
      takeProfit: null
    }),
    [minutes, family, multiplier]
  );

  const canTrade =
    authenticated &&
    !!tradingAccount &&
    stakeValid &&
    (family === 'multipliers' ? multiplierValid : durationValid) &&
    !!ws.selectedSymbol &&
    !derivTokenExpired &&
    !placing;

  // A manual trade is the customer's own decision — any direction, at any time,
  // bounded only by the risk engine and the kill switches. Automatic mode is the
  // scanner's domain, so a live setup is required there; it is never required to
  // place a trade by hand.
  const signalValid = mode !== 'automatic' || (!!signalDirection && direction === signalDirection);
  const canPlace = canTrade && signalValid;

  // Any change to the ticket invalidates a price that was quoted for the old one.
  useEffect(() => {
    setPreview(null);
    setPlaced(null);
  }, [stakeInput, durationMinutes, multiplierInput, family, direction, tradingAccount?.accountId]);

  // Auto-quote so the entry price is ready before the customer reaches for the
  // button; "Place" then only has to submit. Quoting is idempotent and cheap on
  // the server (a fresh snapshot), and every ticket change re-quotes.
  const quoteKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'manual') return;
    if (!tradingAccount || !direction || !canPlace) return;
    if (!stakeValid || (family === 'multipliers' ? !multiplierValid : !durationValid)) return;
    const key = [
      tradingAccount.accountId,
      ws.selectedSymbol,
      direction,
      family,
      stake,
      currency,
      minutes,
      multiplier
    ].join('|');
    if (quoteKeyRef.current === key) return;
    quoteKeyRef.current = key;

    let cancelled = false;
    setPreviewing(true);
    void previewTrade({
      accountId: tradingAccount.accountId,
      symbol: ws.selectedSymbol,
      direction,
      contractFamily: family,
      stake,
      currency,
      parameters
    }).then((result) => {
      if (cancelled) return;
      setPreviewing(false);
      if (result.ok) setPreview(result.preview);
      else setNotice({ tone: 'error', text: result.message });
    });
    return () => {
      cancelled = true;
    };
  }, [
    mode,
    tradingAccount,
    direction,
    canPlace,
    stakeValid,
    multiplierValid,
    durationValid,
    ws.selectedSymbol,
    family,
    stake,
    currency,
    minutes,
    multiplier,
    parameters
  ]);

  const save = useCallback(async (patch: Partial<ExecutionPreferences>) => {
    setSaving(true);
    const result = await saveExecutionPreferences(patch);
    setSaving(false);
    if (result.ok) {
      setPrefs(result.preferences);
      setNotice({ tone: 'ok', text: 'Trade settings saved.' });
    } else {
      setNotice({ tone: 'error', text: result.message });
    }
  }, []);

  const onModeChange = (next: ExecutionMode) => {
    if (next === 'automatic' && !automaticEnabled) {
      setNotice({ tone: 'info', text: 'Automatic trading is switched off on this server. Place trades manually.' });
      return;
    }
    setMode(next);
    void save({ mode: next });
  };

  const onFamilyChange = (next: ContractFamily) => {
    setFamily(next);
    setDirection(null);
    void save({ contractFamily: next });
  };

  const saveStake = () => {
    if (!stakeValid) {
      setNotice({ tone: 'error', text: `Enter a stake of at least ${MIN_STAKE}.` });
      return;
    }
    void save({ stake: { basis: 'stake', amount: stake, currency } });
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

  const resetRiskSession = async () => {
    if (!tradingAccount || tradingAccount.mode !== 'demo' || riskResetting) return;
    setRiskResetting(true);
    setNotice(null);
    const result = await resetDemoRiskSession(tradingAccount.accountId);
    setRiskResetting(false);
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.message });
      return;
    }
    setPrefs(result.preferences);
    setRiskResetConfirm(false);
    setNotice({
      tone: 'ok',
      text: 'New DEMO risk session started. Previous trades remain recorded and all other risk limits still apply.'
    });
  };

  const getQuote = async () => {
    if (!tradingAccount || !direction) return;
    setPreviewing(true);
    setNotice(null);
    const result = await previewTrade({
      accountId: tradingAccount.accountId,
      symbol: ws.selectedSymbol,
      direction,
      contractFamily: family,
      stake,
      currency,
      parameters
    });
    setPreviewing(false);
    if (result.ok) {
      setPreview(result.preview);
    } else {
      setNotice({ tone: 'error', text: result.message });
    }
  };

  const confirmTrade = async () => {
    if (!tradingAccount || !direction || !canPlace) return;
    setPlacing(true);
    setNotice(null);
    const result = await placeTrade({
      accountId: tradingAccount.accountId,
      symbol: ws.selectedSymbol,
      timeframe: ws.timeframe,
      direction,
      contractFamily: family,
      stake,
      currency,
      parameters,
      // Fresh per confirmation, so a genuine retry of a *new* trade is allowed
      // but a double-click on this one is a server-side no-op.
      idempotencyKey: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    });
    setPlacing(false);
    if (result.ok) {
      setPlaced({ contractId: result.contractId, payout: result.payout });
      setNotice({ tone: 'ok', text: 'Trade placed.' });
      setPreview(null);
    } else {
      setNotice({ tone: 'error', text: result.message });
    }
  };

  const payoutRatio = preview && preview.askPrice > 0 ? preview.payout / preview.askPrice : null;

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3 space-y-3">
      <header className="flex items-start gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-accent/12 text-accent border border-accent/25 flex items-center justify-center shrink-0">
          <ArrowUpRight className="w-[18px] h-[18px]" />
        </div>
        <div className="min-w-0">
          <h2 className="text-[14px] font-extrabold tracking-tight text-ink leading-tight">Trade</h2>
          <p className="text-[12px] text-muted leading-snug">
            Place a trade by hand, or let the scanner trade the setups it finds.
          </p>
        </div>
      </header>

      {!authenticated && (
        <Card className="p-3">
          <div className="flex items-start gap-2">
            <Lock className="w-4 h-4 text-warn shrink-0 mt-0.5" />
            <div>
              <div className="text-[13px] font-bold text-ink">Connect your Deriv account</div>
              <p className="text-[12px] text-muted mt-0.5">
                Trading needs a live Deriv session. Sign in to load your accounts, stake and duration.
              </p>
            </div>
          </div>
        </Card>
      )}

      {authenticated && derivTokenExpired && (
        <Card className="p-3 border-warn/40">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-0.5" />
            <div>
              <div className="text-[13px] font-bold text-ink">Your Deriv session has expired</div>
              <p className="text-[12px] text-muted mt-0.5">
                Deriv sessions last about a day and cannot be refreshed automatically. Reconnect your
                account to keep trading — until then, trades and balance reads will be refused.
              </p>
              <button
                type="button"
                onClick={() => {
                  startDerivAuth('login');
                }}
                className="mt-2 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[11px] font-bold text-accent hover:bg-accent/15 cursor-pointer"
              >
                Reconnect Deriv
              </button>
            </div>
          </div>
        </Card>
      )}

      {loading && (
        <Card className="p-3">
          <div className="text-[12px] text-muted">Loading your trade settings…</div>
        </Card>
      )}

      {!loading && (
        <>
          {/* ------------------------------ mode ------------------------------ */}
          <Card className="p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-faint mb-2">Mode</div>
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
                hint={automaticEnabled ? 'Scanner trades for you' : 'Disabled on this server'}
                onClick={() => onModeChange('automatic')}
                disabled={!authenticated || saving || !automaticEnabled}
              />
            </div>

            {mode === 'automatic' && (
              <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-line-soft bg-panel px-2.5 py-2">
                <Info className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-[11.5px] text-muted leading-snug">
                    Automatic execution runs on your <strong className="text-ink">demo</strong> account in this
                    build. Real-money automation stays switched off until it is explicitly released.
                  </p>
                  {authenticated && (
                    <p className="text-[11.5px] text-muted leading-snug mt-1.5 flex items-center gap-1.5">
                      <span
                        className={`inline-block w-1.5 h-1.5 rounded-full ${
                          scanner?.running ? 'bg-success' : 'bg-faint'
                        }`}
                      />
                      {scanner?.running
                        ? scanner.lastPassAt
                          ? `Scanner running · watching ${scanner.watchedMarkets.length} markets · last pass ${new Date(scanner.lastPassAt).toLocaleTimeString()}`
                          : `Scanner running · watching ${scanner.watchedMarkets.length} markets · first pass pending`
                        : scanner?.reason === 'execution_disabled'
                          ? 'Scanner off — the server master switch is off (set ALLOW_EXECUTION=true)'
                          : scanner?.reason === 'demo_execution_disabled'
                            ? 'Scanner off — demo execution is off (set ALLOW_DEMO_EXECUTION=true)'
                            : 'Scanner is not running on the server'}
                    </p>
                  )}
                  {scanner?.running && scanner.watchedMarkets.length > 0 && (
                    <p
                      className="mt-1 text-[10px] text-faint font-mono truncate"
                      title={scanner.watchedMarkets.map((market) => market.symbol).join(', ')}
                    >
                      Watching: {scanner.watchedMarkets.map((market) => market.symbol).join(', ')}
                    </p>
                  )}
                  {scanner && scanner.recent.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {scanner.recent
                        .slice(-3)
                        .reverse()
                        .map((r, i) => (
                          <li key={`${r.symbol}-${i}`} className="text-[11px] text-faint font-mono">
                            {r.symbol}
                            {r.direction ? ` · ${r.direction}` : ''}
                            {r.confidence !== null ? ` · ${r.confidence.toFixed(2)}` : ''}
                            {r.executed ? ' · traded' : ''}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* ---------------------------- instrument -------------------------- */}
          <Card className="p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-faint mb-2">Contract</div>
            <div className="grid grid-cols-2 gap-2">
              <ModeButton
                active={family === 'rise_fall'}
                icon={<ArrowUpRight className="w-3.5 h-3.5" />}
                label="Rise / Fall"
                hint="Fixed duration"
                onClick={() => onFamilyChange('rise_fall')}
                disabled={!authenticated || saving}
              />
              {MULTIPLIERS_ENABLED && (
                <ModeButton
                  active={family === 'multipliers'}
                  icon={<ArrowDownRight className="w-3.5 h-3.5" />}
                  label="Multipliers"
                  hint="Higher risk"
                  onClick={() => onFamilyChange('multipliers')}
                  disabled={!authenticated || saving}
                />
              )}
            </div>
            <div className="mt-2.5 text-[11.5px] text-muted">
              Trading on{' '}
              <span className="font-bold text-ink">{ws.marketName || ws.selectedSymbol || '—'}</span>
              {ws.timeframe ? <span className="text-faint"> · {ws.timeframe}</span> : null}
            </div>
          </Card>

          {/* ------------------------------ stake ----------------------------- */}
          <Card className="p-3">
            <label htmlFor="trade-stake" className="text-[11px] font-bold uppercase tracking-wider text-faint">
              Stake
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-[13px] font-bold text-muted">{currency}</span>
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
            <p className="text-[11px] text-faint mt-1">
              Minimum {MIN_STAKE}. {family === 'multipliers' ? 'Staked per contract.' : 'Fixed stake per trade.'}
            </p>
          </Card>

          {/* ----------------------------- duration --------------------------- */}
          <Card className="p-3">
            {MULTIPLIERS_ENABLED && family === 'multipliers' ? (
              <>
                <label htmlFor="trade-multiplier" className="text-[11px] font-bold uppercase tracking-wider text-faint">
                  Multiplier
                </label>
                <input
                  id="trade-multiplier"
                  type="number"
                  min={1}
                  step="1"
                  inputMode="numeric"
                  value={multiplierInput}
                  onChange={(e) => setMultiplierInput(e.target.value)}
                  disabled={!authenticated}
                  className="mt-1.5 w-full bg-panel border border-line rounded-lg px-2.5 py-2 text-[13px] font-mono tabular-nums text-ink outline-none focus:border-accent/50"
                />
                <p className="text-[11px] text-faint mt-1">
                  Multipliers contracts have no fixed duration; they run until you close them.
                </p>
              </>
            ) : (
              <>
                <label htmlFor="trade-duration" className="text-[11px] font-bold uppercase tracking-wider text-faint">
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
                    disabled={!authenticated}
                    className="flex-1 min-w-0 bg-panel border border-line rounded-lg px-2.5 py-2 text-[13px] font-mono tabular-nums text-ink outline-none focus:border-accent/50 disabled:opacity-50"
                  />
                  <span className="text-[13px] font-bold text-muted">minutes</span>
                </div>
                <p className="text-[11px] text-faint mt-1">
                  Between {bounds.minMinutes} and {bounds.maxMinutes} minutes.
                </p>
              </>
            )}
          </Card>

          {/* ------------------------------ account --------------------------- */}
          <Card className="p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-faint mb-2">Account</div>
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
            {tradingAccount && (
              <p className="text-[11px] text-faint mt-1.5">
                Placing on <span className="font-bold text-ink">{tradingAccount.accountId}</span> (
                {tradingAccount.mode}).
              </p>
            )}
          </Card>

          {/* --------------------------- manual placement --------------------- */}
          {mode === 'manual' && (
            <Card className="p-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-faint mb-2">Direction</div>

              {liveSetup && (
                <div className="mb-2.5 flex items-start gap-2 rounded-lg border border-line-soft bg-panel px-2.5 py-2">
                  <Info className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
                  <p className="text-[11.5px] text-muted leading-snug">
                    The scanner currently favours{' '}
                    <span className={`font-bold ${liveSetup.direction === 'RISE' ? 'text-success' : 'text-danger'}`}>
                      {liveSetup.direction}
                    </span>{' '}
                    on <span className="font-bold text-ink">{liveSetup.displayName || liveSetup.symbol}</span>
                    {liveSetup.confidence ? ` · confidence ${liveSetup.confidence.toFixed(2)}` : ''}. That is a
                    suggestion, not a restriction — trade whichever way you see it.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDirection('RISE')}
                  disabled={!authenticated}
                  aria-pressed={direction === 'RISE'}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-[13px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                    direction === 'RISE'
                      ? 'border-success/45 bg-success/10 text-success'
                      : 'border-line bg-panel text-ink hover:border-success/30'
                  }`}
                >
                  <ArrowUpRight className="w-3.5 h-3.5" /> Rise
                </button>
                <button
                  type="button"
                  onClick={() => setDirection('FALL')}
                  disabled={!authenticated}
                  aria-pressed={direction === 'FALL'}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-[13px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                    direction === 'FALL'
                      ? 'border-danger/45 bg-danger/10 text-danger'
                      : 'border-line bg-panel text-ink hover:border-danger/30'
                  }`}
                >
                  <ArrowDownRight className="w-3.5 h-3.5" /> Fall
                </button>
              </div>

              <button
                type="button"
                onClick={getQuote}
                disabled={!canPlace || !direction || previewing}
                className="mt-2.5 w-full flex items-center justify-center gap-1.5 rounded-lg border border-accent/40 bg-accent/8 text-accent px-3 py-2 text-[13px] font-bold hover:bg-accent/12 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {previewing ? 'Getting price…' : 'Get price'}
              </button>

              {preview && (
                <div className="mt-2.5 rounded-lg border border-line-soft bg-panel px-3 py-2.5">
                  <dl className="space-y-1.5 text-[12.5px]">
                    <Row label="Stake" value={`${preview.askPrice.toFixed(2)} ${currency}`} />
                    <Row label="Payout" value={`${preview.payout.toFixed(2)} ${currency}`} />
                    <Row
                      label="Return"
                      value={payoutRatio ? `${payoutRatio.toFixed(2)}×` : '—'}
                      valueClass={payoutRatio && payoutRatio >= 1.5 ? 'text-success' : 'text-ink'}
                    />
                    <Row label="Entry spot" value={preview.spot ? preview.spot.toFixed(2) : '—'} />
                  </dl>
                  <p className="text-[11px] text-faint mt-2 leading-snug">
                    A payout below 1.50× the stake is a poor return for the risk. This is a quote, not a
                    commitment — the price is re-taken when you confirm.
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={confirmTrade}
                disabled={!canPlace || !direction || placing}
                className="mt-2.5 w-full flex items-center justify-center gap-1.5 rounded-lg bg-accent text-on-accent px-3 py-2.5 text-[13.5px] font-extrabold hover:bg-accent-strong transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {placing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpRight className="w-4 h-4" />}
                {placing
                  ? 'Placing…'
                  : direction
                    ? `Place ${direction === 'RISE' ? 'Rise' : 'Fall'} · ${stakeValid ? stake.toFixed(2) : '—'} ${currency}`
                    : 'Choose a direction'}
              </button>

              {placed && (
                <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-success/40 bg-success/8 px-3 py-2">
                  <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                  <div>
                    <div className="text-[12.5px] font-bold text-success">Trade placed</div>
                    <p className="text-[11.5px] text-muted mt-0.5">
                      Contract {placed.contractId ?? '—'}
                      {placed.payout !== null ? ` · payout ${placed.payout.toFixed(2)} ${currency}` : ''}. Track
                      it in Trade History.
                    </p>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* ------------------------------ summary --------------------------- */}
          <Card className="p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-faint mb-2">Summary</div>
            <dl className="space-y-1.5 text-[12.5px]">
              <Row label="Mode" value={mode === 'manual' ? 'Manual' : 'Automatic'} />
              <Row label="Contract" value={family === 'rise_fall' ? 'Rise / Fall' : 'Multipliers'} />
              {mode === 'manual' && <Row label="Direction" value={direction ?? '—'} />}
              <Row label="Stake" value={stakeValid ? `${stake.toFixed(2)} ${currency}` : '—'} />
              <Row
                label="Duration"
                value={family === 'multipliers' ? 'No expiry' : durationValid ? `${minutes} min` : '—'}
              />
            </dl>
          </Card>

          {/* Live positions: open contracts with running P/L and a Close button,
              so a trade placed here can be cut or taken without leaving the panel. */}
          {authenticated && <ExecutionPositions key={placed?.contractId ?? 'positions'} />}

          {prefs?.autoStopped && (
            <Card className="p-3 border-danger/40">
              <div className="flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                <div>
                  <div className="text-[13px] font-bold text-danger">Automatic execution is stopped</div>
                  <p className="text-[12px] text-muted mt-0.5">
                    Risk controls stopped automatic execution after a loss limit was reached.
                  </p>
                  {tradingAccount?.mode === 'demo' && (
                    <div className="mt-2">
                      {!riskResetConfirm ? (
                        <button
                          type="button"
                          onClick={() => setRiskResetConfirm(true)}
                          className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] font-bold text-danger hover:bg-danger/15 cursor-pointer"
                        >
                          <span>Start new DEMO risk session</span>
                        </button>
                      ) : (
                        <div className="rounded-md border border-warn/30 bg-warn/10 p-2">
                          <p className="text-[11px] text-muted">
                            This resets the loss-streak baseline for {tradingAccount.accountId} and clears the
                            automatic stop. Old trades and audit records stay intact. Daily-loss, balance,
                            exposure, open-position, frequency and all other checks remain active.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void resetRiskSession()}
                              disabled={riskResetting}
                              className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] font-bold text-danger hover:bg-danger/15 disabled:opacity-50 cursor-pointer"
                            >
                              <span>{riskResetting ? 'Starting…' : 'Confirm reset'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setRiskResetConfirm(false)}
                              disabled={riskResetting}
                              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11px] font-bold text-muted hover:bg-elevated disabled:opacity-50 cursor-pointer"
                            >
                              <span>Cancel</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          )}

          <Card className="p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-0.5" />
              <p className="text-[11.5px] text-muted leading-snug">
                Trading is a real risk to your capital. Every trade is checked by the server's risk controls
                before it is sent to Deriv.
              </p>
            </div>
          </Card>
        </>
      )}

      {notice && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 text-[12px] font-semibold ${
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

function Row({ label, value, valueClass = 'text-ink' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className={`font-bold font-mono tabular-nums ${valueClass}`}>{value}</dd>
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
      <span className={`flex items-center gap-1.5 text-[12.5px] font-bold ${active ? 'text-accent' : 'text-ink'}`}>
        {icon}
        {label}
      </span>
      <span className="text-[10.5px] text-faint leading-tight">{hint}</span>
    </button>
  );
}
