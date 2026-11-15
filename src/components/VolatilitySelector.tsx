import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Search } from 'lucide-react';
import type { SyntheticMarket } from '../types/market';
import {
  groupVolatilityMarkets,
  isOneSecondVolatility,
} from '../utils/volatilityMarkets';

interface VolatilitySelectorProps {
  markets: SyntheticMarket[];
  marketsLoading: boolean;
  selectedSymbol: string;
  selectedMarket: SyntheticMarket | null;
  onSelect: (symbol: string) => void;
}

/**
 * Instrument picker for the chart analyser. Shows EVERY eligible Deriv Volatility Index —
 * all standard and all 1-second variants — grouped by standard vs 1-second. Non-Volatility
 * families (Boom, Crash, Jump, Step, Range Break, …) are excluded by construction because
 * `groupVolatilityMarkets` delegates to the canonical `eligibleMarkets` module. Selecting an
 * instrument loads its live data automatically because selection flows through the shared
 * data hook.
 */
export function VolatilitySelector({
  markets,
  marketsLoading,
  selectedSymbol,
  selectedMarket,
  onSelect,
}: VolatilitySelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(() => groupVolatilityMarkets(markets), [markets]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        markets: g.markets.filter(
          (m) =>
            m.displayName.toLowerCase().includes(q) ||
            m.symbol.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.markets.length > 0);
  }, [groups, query]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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

  const label = selectedMarket?.displayName ?? selectedSymbol;

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="volatility-selector-trigger"
        className="inline-flex items-center gap-2 h-8 px-2.5 max-w-[190px] sm:max-w-[240px] bg-elevated border border-line rounded-lg text-xs font-semibold text-ink hover:border-accent/50 transition-colors cursor-pointer"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-teal shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="absolute z-40 mt-1.5 w-[280px] sm:w-[320px] max-w-[calc(100vw-2rem)] bg-panel border border-line rounded-xl shadow-2xl overflow-hidden">
          <div className="p-2 border-b border-line-soft">
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint"
                aria-hidden="true"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search volatility indices"
                aria-label="Search volatility indices"
                className="w-full h-8 pl-8 pr-2 bg-app border border-line rounded-md text-xs text-ink placeholder:text-faint focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <div className="max-h-[52vh] overflow-y-auto py-1">
            {marketsLoading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Loading instruments from Deriv...
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="px-3 py-4 text-xs text-faint">
                No volatility indices match your search.
              </div>
            ) : (
              filteredGroups.map((group) => (
                <div key={group.id} className="py-1">
                  <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-faint">
                    {group.label}
                  </div>
                  <ul role="listbox" aria-label={group.label}>
                    {group.markets.map((market) => {
                      const active = market.symbol === selectedSymbol;
                      return (
                        <li key={market.symbol}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            data-testid={`volatility-option-${market.symbol}`}
                            onClick={() => {
                              onSelect(market.symbol);
                              setOpen(false);
                              setQuery('');
                            }}
                            className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors cursor-pointer ${
                              active
                                ? 'bg-accent/12 text-accent'
                                : 'text-ink hover:bg-elevated'
                            }`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="font-semibold truncate">
                                {market.displayName}
                              </span>
                              {isOneSecondVolatility(market) && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-teal/15 text-teal border border-teal/25">
                                  1s
                                </span>
                              )}
                            </span>
                            {active ? (
                              <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            ) : (
                              <span className="text-[10px] font-mono text-faint shrink-0">
                                {market.symbol}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
