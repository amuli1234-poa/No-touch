import React from 'react';
import { ActiveSymbol, OpportunitySignal } from '../../types/scanner';
import { ArrowRight, ShieldAlert, TrendingUp, TrendingDown, Minus, LineChart } from 'lucide-react';

interface BestMarketViewProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string, goToTab?: 'LIVE_CHART' | 'ANALYSIS') => void;
}

export const BestMarketView: React.FC<BestMarketViewProps> = ({
  symbols,
  opportunities,
  selectedSymbol,
  onSelectSymbol
}) => {
  const ranked = symbols
    .map((sym) => ({
      sym,
      opp: opportunities.get(sym.symbol)
    }))
    .sort((a, b) => {
      const tierWeight = (opp?: OpportunitySignal) => {
        if (!opp) return 0;
        if (opp.setupTier === 'HIGH_QUALITY') return 4;
        if (opp.setupTier === 'DEVELOPING') return 3;
        if (opp.setupTier === 'WEAK') return 2;
        return 1;
      };
      const wDiff = tierWeight(b.opp) - tierWeight(a.opp);
      if (wDiff !== 0) return wDiff;
      return (b.opp?.score.total || 0) - (a.opp?.score.total || 0);
    });

  const highQualityCount = ranked.filter((r) => r.opp?.setupTier === 'HIGH_QUALITY').length;
  const topCandidate = ranked[0];

  const tierLabel = (tier?: OpportunitySignal['setupTier']) => {
    switch (tier) {
      case 'HIGH_QUALITY':
        return { text: 'HIGH QUALITY', cls: 'text-success' };
      case 'DEVELOPING':
        return { text: 'DEVELOPING', cls: 'text-warning' };
      case 'WEAK':
        return { text: 'WEAK', cls: 'text-fg-4' };
      default:
        return { text: 'AVOID', cls: 'text-danger' };
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Gate Banner */}
      {highQualityCount === 0 ? (
        <div className="rounded-xl border border-warning/30 bg-warning/20 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-bold text-warning font-mono tracking-tight">
                WAITING FOR SETUP — NO QUALITY SETUP READY
              </h2>
              <p className="text-xs text-fg-3 mt-0.5">
                No Volatility instrument currently satisfies all mandatory requirements: clear market condition, valid M15 trading range, matched strategy, supporting structure, M1 entry trigger, and ≥75% weighted setup quality.
              </p>
            </div>
          </div>
          {topCandidate?.opp && (
            <button
              onClick={() => onSelectSymbol(topCandidate.sym.symbol, 'ANALYSIS')}
              className="px-3 py-2 rounded-lg bg-surface-deep hover:bg-surface-raised border border-line-strong text-xs font-mono text-fg-2 flex items-center gap-1.5"
            >
              <span>Inspect Top Developing ({topCandidate.sym.symbol})</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-success/40 bg-success/20 p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-success font-mono tracking-tight">
              {highQualityCount} HIGH-QUALITY CONFIRMED SETUP{highQualityCount > 1 ? 'S' : ''} READY
            </h2>
            <p className="text-xs text-fg-3 mt-0.5">
              Confluence represents multi-timeframe technical alignment, not a guaranteed win rate. Top candidate: <strong className="text-fg-1">{topCandidate.sym.displayName}</strong> ({topCandidate.opp?.score.total}%).
            </p>
          </div>
          <button
            onClick={() => onSelectSymbol(topCandidate.sym.symbol, 'LIVE_CHART')}
            className="px-3.5 py-2 rounded-lg bg-success hover:bg-success text-xs font-semibold text-fg-1 flex items-center gap-1.5"
          >
            <LineChart className="w-3.5 h-3.5" />
            <span>Open Top Chart</span>
          </button>
        </div>
      )}

      {/* Ranked Leaderboard Table / Cards */}
      <div className="rounded-xl border border-line/90 bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-line/80 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-fg-2 font-mono">
              Best Market Ranking — All Volatility Indices ({ranked.length})
            </h3>
            <p className="text-[11px] text-fg-4 mt-0.5">
              Ranked by market structure (20%), valid range &amp; POI (20%), price-action trigger (20%), momentum (15%), MTF alignment (15%), and technical confirmation (10%).
            </p>
          </div>
          <span className="text-[11px] font-mono text-fg-5">
            Min Entry Confluence: 75%
          </span>
        </div>

        <div className="divide-y divide-line/60">
          {ranked.length === 0 && (
            <div className="p-8 text-center text-xs font-mono text-fg-5">
              Connecting to Deriv active Volatility markets...
            </div>
          )}

          {ranked.map(({ sym, opp }, index) => {
            const tier = tierLabel(opp?.setupTier);
            const isSelected = sym.symbol === selectedSymbol;
            const dec = sym.pipSize < 0.01 ? 3 : 2;
            const spot = sym.lastQuote ?? opp?.currentPrice;

            return (
              <div
                key={sym.symbol}
                className={`p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 transition ${
                  isSelected ? 'bg-surface-deep/90' : 'hover:bg-surface-deep/45'
                }`}
              >
                {/* Rank + Identity */}
                <div className="flex items-start gap-3.5 min-w-[240px]">
                  <span className="text-xs font-mono font-bold text-fg-5 w-6 pt-0.5 tabular-nums">
                    #{index + 1}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-fg-1">{sym.displayName}</span>
                      <span className="text-[11px] font-mono text-fg-4">
                        {sym.is1s ? '1s Vol' : 'Plain Vol'}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-fg-4 mt-0.5 tabular-nums">
                      Spot: <span className="text-fg-2">{spot ? spot.toFixed(dec) : '—'}</span>
                      {' · '}
                      <span className={sym.isStale ? 'text-warning' : sym.isOpen ? 'text-success' : 'text-danger'}>
                        {sym.isStale ? 'STALE' : sym.isOpen ? 'LIVE' : 'CLOSED'}
                      </span>
                      {opp && (
                        <>
                          {' · '}
                          <span className="text-fg-3">{opp.marketRegimeLabel || opp.marketCondition}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Key Decision Columns */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 flex-1 text-xs font-mono tabular-nums">
                  <div>
                    <div className="text-[10px] text-fg-5 uppercase">Signal &amp; Strategy</div>
                    <div className="mt-0.5 flex items-center gap-1 font-semibold">
                      {opp?.direction === 'BULLISH' ? (
                        <TrendingUp className="w-3.5 h-3.5 text-success" />
                      ) : opp?.direction === 'BEARISH' ? (
                        <TrendingDown className="w-3.5 h-3.5 text-danger" />
                      ) : (
                        <Minus className="w-3.5 h-3.5 text-fg-5" />
                      )}
                      <span
                        className={
                          opp?.entryAndTp.confirmed
                            ? opp.direction === 'BULLISH'
                              ? 'text-success'
                              : 'text-danger'
                            : 'text-warning'
                        }
                      >
                        {opp ? (opp.entryAndTp.confirmed ? opp.riseFallLabel : 'WAITING FOR SETUP') : 'PENDING'}
                      </span>
                    </div>
                    {opp && (
                      <div className="text-[10px] text-fg-4 mt-0.5 truncate max-w-[210px]">
                        {opp.selectedStrategy.label} ·{' '}
                        <span className={opp.tradingRange.isValid ? 'text-success' : 'text-danger'}>
                          {opp.tradingRange.isValid ? 'M15 Range OK' : 'Invalid Range'}
                        </span>
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-[10px] text-fg-5 uppercase">Momentum</div>
                    <div
                      className={`mt-0.5 font-semibold ${
                        opp?.momentum.classification === 'STRONG'
                          ? 'text-success'
                          : opp?.momentum.classification === 'MODERATE'
                          ? 'text-accent-soft'
                          : opp?.momentum.classification === 'DEVELOPING'
                          ? 'text-warning'
                          : 'text-fg-4'
                      }`}
                    >
                      {opp ? opp.momentum.classification : '—'}
                    </div>
                    {opp && (
                      <div className="text-[10px] text-fg-5 mt-0.5">
                        Score {opp.momentum.score}/100 · {opp.momentum.followThroughCandles}/3 bars
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-[10px] text-fg-5 uppercase">Entry / TP Status</div>
                    {opp?.entryAndTp.confirmed ? (
                      <div className="mt-0.5">
                        <span className="text-accent-cyan font-bold">
                          {opp.entryAndTp.entryPrice?.toFixed(dec)}
                        </span>
                        <span className="text-fg-5 mx-1">→</span>
                        <span className="text-success font-bold">
                          {opp.entryAndTp.takeProfit?.toFixed(dec)}
                        </span>
                        <div className="text-[10px] text-fg-5">
                          RR {opp.entryAndTp.riskRewardRatio}:1
                        </div>
                      </div>
                    ) : (
                      <div className="mt-0.5 text-fg-4 font-semibold">WAITING FOR SETUP</div>
                    )}
                  </div>

                  <div>
                    <div className="text-[10px] text-fg-5 uppercase">Confluence & Tier</div>
                    <div className="mt-0.5 flex items-baseline gap-2">
                      <span
                        className={`text-sm font-bold ${
                          (opp?.score.total || 0) >= 75
                            ? 'text-success'
                            : (opp?.score.total || 0) >= 60
                            ? 'text-warning'
                            : 'text-fg-4'
                        }`}
                      >
                        {opp ? `${opp.score.total}%` : '—'}
                      </span>
                      <span className={`text-[11px] font-bold ${tier.cls}`}>{tier.text}</span>
                    </div>
                    <div className="text-[10px] text-fg-5 truncate max-w-[200px]">
                      {opp?.rankingReasons[0] || opp?.rejectionReasons[0] || 'Scanning history...'}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => onSelectSymbol(sym.symbol, 'LIVE_CHART')}
                    className="px-3 py-2 min-h-[38px] rounded-lg bg-surface-raised hover:bg-surface-elevated text-xs font-medium text-fg-2 transition"
                  >
                    Chart
                  </button>
                  <button
                    onClick={() => onSelectSymbol(sym.symbol, 'ANALYSIS')}
                    className="px-3 py-2 min-h-[38px] rounded-lg bg-accent/20 hover:bg-accent/30 border border-accent/40 text-xs font-medium text-accent-cyan transition"
                  >
                    Analyze
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
