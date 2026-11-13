import React, { useState } from 'react';
import { ActiveSymbol, OpportunitySignal } from '../../types/scanner';
import { Search, ArrowUpDown } from 'lucide-react';

interface LiveMarketScannerTableProps {
  title: string;
  subtitle: string;
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string, openChart?: boolean) => void;
}

export const LiveMarketScannerTable: React.FC<LiveMarketScannerTableProps> = ({
  title,
  subtitle,
  symbols,
  opportunities,
  selectedSymbol,
  onSelectSymbol
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'score' | 'symbol' | 'price'>('score');
  const [sortAsc, setSortAsc] = useState(false);

  const handleSort = (field: 'score' | 'symbol' | 'price') => {
    if (sortBy === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(field);
      setSortAsc(false);
    }
  };

  const filtered = symbols.filter((sym) => {
    if (
      searchQuery &&
      !sym.displayName.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !sym.symbol.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const oppA = opportunities.get(a.symbol);
    const oppB = opportunities.get(b.symbol);

    if (sortBy === 'score') {
      const scoreA = oppA?.score.total || 0;
      const scoreB = oppB?.score.total || 0;
      return sortAsc ? scoreA - scoreB : scoreB - scoreA;
    }
    if (sortBy === 'price') {
      const pA = a.lastQuote || oppA?.currentPrice || 0;
      const pB = b.lastQuote || oppB?.currentPrice || 0;
      return sortAsc ? pA - pB : pB - pA;
    }
    return sortAsc
      ? a.displayName.localeCompare(b.displayName)
      : b.displayName.localeCompare(a.displayName);
  });

  return (
    <div className="rounded-xl border border-line/90 bg-surface overflow-hidden flex flex-col">
      <div className="p-4 bg-surface-deep/60 border-b border-line/80 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-fg-1 tracking-tight">{title}</h2>
          <p className="text-[11px] text-fg-4 mt-0.5">{subtitle}</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-fg-4 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Filter index..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-surface-deepest border border-line rounded-lg pl-8 pr-3 py-1.5 text-xs text-fg-2 placeholder-slate-500 focus:outline-none focus:border-accent w-44 font-mono"
            />
          </div>
          <span className="text-[11px] text-fg-4 font-mono tabular-nums">
            {filtered.length} markets
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead className="bg-surface-deepest/90 text-[10px] uppercase font-mono tracking-wider text-fg-4 border-b border-line/80">
            <tr>
              <th onClick={() => handleSort('symbol')} className="p-3 cursor-pointer hover:text-fg-1">
                <div className="flex items-center gap-1">
                  <span>Instrument</span>
                  <ArrowUpDown className="w-3 h-3 text-fg-5" />
                </div>
              </th>
              <th onClick={() => handleSort('price')} className="p-3 cursor-pointer hover:text-fg-1">
                <div className="flex items-center gap-1">
                  <span>Live Spot</span>
                  <ArrowUpDown className="w-3 h-3 text-fg-5" />
                </div>
              </th>
              <th className="p-3">Condition / Strategy</th>
              <th className="p-3">H4 · H1 · M15 · M5 · M1</th>
              <th className="p-3">Signal / Momentum</th>
              <th className="p-3">Entry / SL / TP</th>
              <th onClick={() => handleSort('score')} className="p-3 cursor-pointer hover:text-fg-1">
                <div className="flex items-center gap-1">
                  <span>Confluence</span>
                  <ArrowUpDown className="w-3 h-3 text-fg-5" />
                </div>
              </th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-line/50 font-mono text-xs tabular-nums">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-fg-5 font-sans">
                  No instruments discovered yet in this category. Waiting for Deriv active symbol feed...
                </td>
              </tr>
            )}

            {filtered.map((sym) => {
              const opp = opportunities.get(sym.symbol);
              const isSelected = selectedSymbol === sym.symbol;
              const price = sym.lastQuote || opp?.currentPrice || 0;
              const dec = sym.pipSize < 0.01 ? 3 : 2;

              const biasText = (dir?: string) =>
                dir === 'BULLISH'
                  ? 'text-success'
                  : dir === 'BEARISH'
                  ? 'text-danger'
                  : 'text-fg-5';

              return (
                <tr
                  key={sym.symbol}
                  onClick={() => onSelectSymbol(sym.symbol, false)}
                  className={`cursor-pointer transition-colors ${
                    isSelected ? 'bg-surface-raised/70 text-fg-1' : 'hover:bg-surface-deep/60 text-fg-3'
                  }`}
                >
                  <td className="p-3 font-sans">
                    <div>
                      <div className="font-semibold text-fg-1">{sym.displayName}</div>
                      <div className="text-[10px] font-mono text-fg-5">
                        {sym.symbol} ·{' '}
                        <span
                          className={
                            sym.isStale
                              ? 'text-warning'
                              : sym.isOpen
                              ? 'text-success'
                              : 'text-danger'
                          }
                        >
                          {sym.isStale ? 'STALE' : sym.isOpen ? 'LIVE' : 'CLOSED'}
                        </span>
                      </div>
                    </div>
                  </td>

                  <td className="p-3 font-semibold text-fg-1">
                    {price > 0 ? price.toFixed(dec) : '—'}
                  </td>

                  <td className="p-3 text-[11px]">
                    {opp ? (
                      <div>
                        <span className="text-fg-2 block">{opp.marketCondition}</span>
                        <span className="text-[10px] text-accent-cyan block truncate max-w-[165px]">
                          {opp.selectedStrategy.label}
                        </span>
                        <span
                          className={`text-[10px] ${
                            opp.tradingRange.isValid ? 'text-success' : 'text-danger'
                          }`}
                        >
                          {opp.tradingRange.isValid ? 'M15 Range Valid' : 'Invalid Range'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-fg-5">Loading</span>
                    )}
                  </td>

                  <td className="p-3 text-[11px]">
                    {opp ? (
                      <div className="flex items-center gap-1.5">
                        <span className={biasText(opp.timeframeMatrix.h4.bias)}>
                          H4:{opp.timeframeMatrix.h4.bias[0]}
                        </span>
                        <span className="text-fg-6">·</span>
                        <span className={biasText(opp.timeframeMatrix.h1.bias)}>
                          H1:{opp.timeframeMatrix.h1.bias[0]}
                        </span>
                        <span className="text-fg-6">·</span>
                        <span className={biasText(opp.timeframeMatrix.m15.bias)}>
                          15:{opp.timeframeMatrix.m15.bias[0]}
                        </span>
                        <span className="text-fg-6">·</span>
                        <span className={biasText(opp.timeframeMatrix.m5.bias)}>
                          5:{opp.timeframeMatrix.m5.bias[0]}
                        </span>
                        <span className="text-fg-6">·</span>
                        <span className={biasText(opp.timeframeMatrix.m1.bias)}>
                          1:{opp.timeframeMatrix.m1.bias[0]}
                        </span>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>

                  <td className="p-3 text-[11px]">
                    {opp ? (
                      <div>
                        <div
                          className={
                            opp.entryAndTp.confirmed
                              ? opp.direction === 'BULLISH'
                                ? 'text-success font-bold'
                                : 'text-danger font-bold'
                              : 'text-warning font-semibold'
                          }
                        >
                          {opp.entryAndTp.confirmed ? opp.riseFallLabel : 'WAIT'}
                        </div>
                        <div
                          className={`text-[10px] ${
                            opp.momentum.classification === 'STRONG'
                              ? 'text-success'
                              : opp.momentum.classification === 'MODERATE'
                              ? 'text-accent-soft'
                              : opp.momentum.classification === 'DEVELOPING'
                              ? 'text-warning'
                              : 'text-fg-4'
                          }`}
                        >
                          Mom: {opp.momentum.classification}
                        </div>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>

                  <td className="p-3 text-[11px]">
                    {opp?.entryAndTp.confirmed ? (
                      <div>
                        <div>
                          <span className="text-accent-cyan">{opp.entryAndTp.entryPrice?.toFixed(dec)}</span>
                          <span className="text-fg-5 mx-1">→</span>
                          <span className="text-success">{opp.entryAndTp.takeProfit?.toFixed(dec)}</span>
                        </div>
                        <div className="text-[10px] text-danger">
                          SL {opp.entryAndTp.invalidationLevel?.toFixed(dec)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-fg-5">WAIT</span>
                    )}
                  </td>

                  <td className="p-3">
                    {opp ? (
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-bold ${
                            opp.setupTier === 'HIGH_QUALITY'
                              ? 'text-success'
                              : opp.setupTier === 'DEVELOPING'
                              ? 'text-warning'
                              : 'text-fg-4'
                          }`}
                        >
                          {opp.score.total}%
                        </span>
                        <span className="text-[10px] text-fg-5">
                          {opp.setupTier === 'HIGH_QUALITY' ? 'READY' : opp.setupTier}
                        </span>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>

                  <td className="p-3 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectSymbol(sym.symbol, true);
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-surface-raised hover:bg-surface-elevated text-[11px] font-sans font-semibold text-accent-cyan transition whitespace-nowrap"
                    >
                      Open Chart
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
