import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Settings2 } from 'lucide-react';

import {
  BotApiError,
  fetchBotCompatibility,
  fetchBotMarkets,
  type BotCompatibility,
  type BotCompatibilityState,
  type BotEditorPayload,
  type BotMarketCatalog,
  type BotMarketSymbol
} from '../../lib/bots';
import { readStrategyConfig } from './strategyConfig';
import { STATE_COPY } from './compatibilityCopy';

/**
 * TRADING CONFIGURATION — what this strategy actually trades.
 *
 * The values shown are read from the strategy's own blocks, not from a form
 * this panel invented: the market, contract type, stake and duration come from
 * `trade_definition_market` / `trade_definition_contracttype` /
 * `trade_definition_tradeoptions`. Editing those values here would mean a
 * second source of truth, so the panel reports them and links the change back
 * to the block that owns it.
 *
 * The one control that does write is the market check: it asks the server
 * whether this strategy would run on a symbol, using the live Deriv contract
 * catalogue. That is a real request against real data, never a guess.
 */

export interface TradingConfigPanelProps {
  botId: string;
  payload: BotEditorPayload;
  /** Disabled while the canvas has unsaved changes, since checks use saved XML. */
  dirty: boolean;
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-line-soft/60 last:border-0">
      <dt className="text-[10.5px] uppercase tracking-wide text-faint font-semibold shrink-0">
        {label}
      </dt>
      <dd className="text-[11.5px] text-ink font-medium text-right truncate" title={value ?? undefined}>
        {value ?? <span className="text-muted/60 font-normal">not set</span>}
      </dd>
    </div>
  );
}

export function TradingConfigPanel({ botId, payload, dirty }: TradingConfigPanelProps) {
  const config = useMemo(() => readStrategyConfig(payload.tree), [payload.tree]);

  const [catalog, setCatalog] = useState<BotMarketCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [compat, setCompat] = useState<BotCompatibility | null>(null);
  const [compatError, setCompatError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchBotMarkets()
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((e) => {
        if (!cancelled) {
          setCatalogError(e instanceof BotApiError ? e.message : 'The market catalogue could not be loaded.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Default the check to the symbol the strategy itself names.
  useEffect(() => {
    if (!selected && config.symbol) setSelected(config.symbol);
  }, [config.symbol, selected]);

  const grouped = useMemo(() => {
    if (!catalog) return [];
    const byCategory = new Map<string, BotMarketSymbol[]>();
    for (const symbol of catalog.symbols) {
      const list = byCategory.get(symbol.categoryLabel) ?? [];
      list.push(symbol);
      byCategory.set(symbol.categoryLabel, list);
    }
    return [...byCategory.entries()];
  }, [catalog]);

  const check = useCallback(async () => {
    setChecking(true);
    setCompatError(null);
    try {
      setCompat(await fetchBotCompatibility(botId, selected || undefined));
    } catch (e) {
      setCompat(null);
      setCompatError(e instanceof BotApiError ? e.message : 'Compatibility could not be checked.');
    } finally {
      setChecking(false);
    }
  }, [botId, selected]);

  const state: BotCompatibilityState | null = compat?.state ?? null;
  const stateCopy = state ? STATE_COPY[state] : null;
  const reason =
    compat && typeof compat.reason === 'string'
      ? compat.reason
      : compat && Array.isArray(compat.details) && compat.details.length > 0
        ? String(compat.details[0])
        : null;

  return (
    <section aria-label="Trading configuration" className="flex flex-col gap-3 p-3">
      <header className="flex items-center gap-2">
        <Settings2 className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted">
          Trading configuration
        </h2>
      </header>

      <div className="rounded-xl border border-line bg-surface/60 px-3 py-1">
        <dl>
          <Row label="Symbol" value={config.symbol} />
          <Row label="Market" value={config.market} />
          <Row label="Submarket" value={config.submarket} />
          <Row label="Contract" value={config.contractType} />
          <Row label="Trade type" value={config.tradeType} />
          <Row label="Prediction" value={config.prediction} />
          <Row label="Stake" value={config.stake ? `${config.stake} ${config.currency ?? ''}`.trim() : null} />
          <Row label="Duration" value={config.duration} />
          <Row label="Candle interval" value={config.candleInterval ? `${config.candleInterval}s` : null} />
          <Row label="Restart on error" value={config.restartOnError} />
        </dl>
      </div>

      <p className="text-[10.5px] leading-relaxed text-faint">
        These values come from the strategy&rsquo;s own blocks. Change them on the canvas — the
        Trade, Market and Trade options categories — so the blocks stay the single source of truth.
      </p>

      <div className="pt-2 border-t border-line">
        <h3 className="text-[10.5px] font-bold uppercase tracking-widest text-muted mb-2">
          Contract availability
        </h3>

        {catalogError && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{catalogError}</span>
          </div>
        )}

        {!catalog && !catalogError && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
            Loading the Deriv Synthetic catalogue…
          </p>
        )}

        {catalog && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <select
                aria-label="Symbol to check"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setCompat(null);
                  setCompatError(null);
                }}
                className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-line bg-canvas text-[11px] text-ink cursor-pointer"
              >
                <option value="">Strategy&rsquo;s own symbol</option>
                {grouped.map(([label, symbols]) => (
                  <optgroup key={label} label={label}>
                    {symbols.map((s) => (
                      <option key={s.symbol} value={s.symbol} disabled={!s.available}>
                        {s.symbol} · {s.displayName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void check()}
                disabled={checking || dirty}
                title={dirty ? 'Save the strategy before checking availability' : 'Check against live Deriv contracts'}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink hover:border-accent/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
              >
                {checking ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                Check
              </button>
            </div>

            {dirty && (
              <p className="text-[10.5px] text-warning">
                Save first — the check runs against the saved strategy.
              </p>
            )}

            {compatError && (
              <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] text-danger">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                <span>{compatError}</span>
              </div>
            )}

            {compat && (
              <div className="rounded-lg border border-line bg-surface-raised/50 px-2.5 py-2 space-y-1">
                <p
                  className={`flex items-center gap-1.5 text-[11px] font-semibold ${stateCopy?.tone ?? 'text-muted'}`}
                >
                  {stateCopy?.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {stateCopy?.label ?? (state ? `Unexpected result: ${state}` : 'Checked')}
                  {typeof compat.symbol === 'string' && (
                    <span className="text-muted font-normal">· {compat.symbol}</span>
                  )}
                </p>
                {reason && <p className="text-[10.5px] text-muted leading-relaxed">{reason}</p>}
                {Array.isArray(compat.availableContracts) && compat.availableContracts.length > 0 && (
                  <p className="text-[10px] text-faint leading-relaxed">
                    Offered here: {compat.availableContracts.slice(0, 8).join(', ')}
                    {compat.availableContracts.length > 8 ? '…' : ''}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
