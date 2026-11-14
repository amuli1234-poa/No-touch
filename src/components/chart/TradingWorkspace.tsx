import React, { useMemo, useState } from 'react';
import { CandlestickChart, Gauge, LineChart, Wallet } from 'lucide-react';
import type {
  ActiveSymbol,
  Candle,
  OpportunitySignal,
  Timeframe,
  WhatsAppProviderStatus
} from '../../types/scanner';
import { Card, CardHeader, CardBody } from '../ui/Card';
import { formatPrice } from '../ui/format';
import { TradingChart, type ChartKind, type ChartLevel } from './TradingChart';
import { WorkspaceHeader } from './WorkspaceHeader';
import { IndicatorPanel } from '../views/IndicatorPanel';
import { SignalPanel } from '../views/SignalPanel';
import { TradePanel } from '../views/TradePanel';

/**
 * The trading workspace: watchlist, chart, analysis and account panel.
 *
 * Layout is a three-region grid on desktop (watchlist · chart+analysis ·
 * account panel) that collapses cleanly on tablet and mobile. The chart is the
 * visual anchor and keeps the most horizontal space at every breakpoint; the
 * side panels become stacked sections below it rather than forcing horizontal
 * overflow.
 *
 * All data is owned by `App.tsx` and passed down — this component holds only
 * view state (which symbol is highlighted, chart type), never market data.
 */

interface TradingWorkspaceProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  selectedTimeframe: Timeframe;
  onSelectTimeframe: (tf: Timeframe) => void;
  candles: Candle[];
  activeSymbolInfo?: ActiveSymbol;
  activeOpp?: OpportunitySignal;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  latencyMs: number | null;
  waStatus: WhatsAppProviderStatus;
  alertsAutoSend: boolean;
  onOpenAnalysis: () => void;
}

type MobileTab = 'chart' | 'analysis' | 'account';

export const TradingWorkspace: React.FC<TradingWorkspaceProps> = ({
  symbols,
  opportunities,
  selectedSymbol,
  onSelectSymbol,
  selectedTimeframe,
  onSelectTimeframe,
  candles,
  activeSymbolInfo,
  activeOpp,
  connectionState,
  latencyMs,
  waStatus,
  alertsAutoSend,
  onOpenAnalysis
}) => {
  const [chartKind, setChartKind] = useState<ChartKind>('candles');
  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');

  const digits = (activeSymbolInfo?.pipSize ?? 0.01) < 0.01 ? 3 : 2;

  // Published signal levels only. A WAIT signal carries no entry/TP, so the
  // chart stays clean rather than inventing levels to fill the space. Memoised
  // so the chart's price-line effect only re-runs when the levels truly change.
  const levels = useMemo<ChartLevel[]>(() => {
    const tp = activeOpp?.entryAndTp;
    if (!tp) return [];
    const out: ChartLevel[] = [];
    if (tp.entryPrice !== undefined) out.push({ price: tp.entryPrice, tone: 'entry', title: 'Entry' });
    if (tp.takeProfit !== undefined) out.push({ price: tp.takeProfit, tone: 'target', title: 'TP1' });
    if (tp.takeProfit2 !== undefined) out.push({ price: tp.takeProfit2, tone: 'target', title: 'TP2' });
    if (tp.invalidationLevel !== undefined)
      out.push({ price: tp.invalidationLevel, tone: 'invalidation', title: 'SL' });
    return out;
  }, [activeOpp]);

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
      {/* Region A — watchlist. Full-width list on mobile, narrow column on xl. */}
      <aside className="xl:col-span-2">
        <Card className="overflow-hidden p-0">
          <CardHeader
            title="Markets"
            subtitle={`${symbols.length} instruments`}
            icon={<LineChart className="h-4 w-4" />}
          />
          <div className="max-h-[300px] divide-y divide-line-soft overflow-y-auto xl:max-h-[720px]">
            {symbols.length === 0 && (
              <p className="px-3.5 py-4 text-[11.5px] text-fg-5">
                Discovering instruments from the feed…
              </p>
            )}
            {symbols.map((sym) => {
              const opp = opportunities.get(sym.symbol);
              const active = sym.symbol === selectedSymbol;
              const dec = sym.pipSize < 0.01 ? 3 : 2;
              return (
                <button
                  key={sym.symbol}
                  onClick={() => onSelectSymbol(sym.symbol)}
                  aria-current={active ? 'true' : undefined}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors ${
                    active ? 'bg-surface-raised text-fg-1' : 'text-fg-3 hover:bg-surface-raised'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-semibold">{sym.displayName}</div>
                    <div className="flex items-center gap-1.5 text-[10px] text-fg-5">
                      <span>{sym.is1s ? '1s' : 'Plain'}</span>
                      <span className="h-2.5 w-px bg-line" />
                      <span>{opp ? opp.marketCondition : 'Scanning'}</span>
                    </div>
                  </div>
                  <div className="tabular shrink-0 text-right">
                    <div className="text-[12px] font-semibold text-fg-2">
                      {sym.lastQuote ? formatPrice(sym.lastQuote, dec) : '—'}
                    </div>
                    <div
                      className={`text-[10px] font-bold ${
                        (opp?.score.total || 0) >= 75
                          ? 'text-success'
                          : (opp?.score.total || 0) >= 60
                            ? 'text-warning'
                            : 'text-fg-5'
                      }`}
                    >
                      {opp ? `${opp.score.total}%` : '—'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>
      </aside>

      {/* Region B — chart + analysis. */}
      <div className="min-w-0 space-y-4 xl:col-span-7">
        {/* Mobile tab switch: chart / analysis / account. Hidden on xl where
            all three regions are visible at once. */}
        <div className="flex items-center gap-1 rounded-[var(--radius-md)] border border-line bg-surface-deepest p-0.5 xl:hidden">
          {(
            [
              { id: 'chart', label: 'Chart', icon: CandlestickChart },
              { id: 'analysis', label: 'Analysis', icon: Gauge },
              { id: 'account', label: 'Account', icon: Wallet }
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            const active = mobileTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setMobileTab(t.id)}
                aria-pressed={active}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-[8px] px-2 py-1.5 text-[11.5px] font-semibold transition-colors ${
                  active ? 'bg-accent text-on-accent' : 'text-fg-4 hover:text-fg-1'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className={mobileTab === 'chart' ? 'block' : 'hidden xl:block'}>
          <Card className="overflow-hidden p-0">
            <div className="p-3.5">
              <WorkspaceHeader
                symbols={symbols}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={onSelectSymbol}
                selectedTimeframe={selectedTimeframe}
                onSelectTimeframe={onSelectTimeframe}
                chartKind={chartKind}
                onSelectChartKind={setChartKind}
                candles={candles}
                activeSymbol={activeSymbolInfo}
                isStale={activeSymbolInfo?.isStale}
              />
            </div>
            <div className="px-3.5 pb-3.5">
              <TradingChart
                candles={candles}
                symbol={selectedSymbol}
                timeframe={selectedTimeframe}
                kind={chartKind}
                priceDigits={digits}
                isStale={activeSymbolInfo?.isStale}
                connectionState={connectionState}
                levels={levels}
                height={440}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft px-3.5 py-2 text-[10.5px] text-fg-5">
              <span>
                Feed{' '}
                <strong className={connectionState === 'CONNECTED' ? 'text-success' : 'text-warning'}>
                  {connectionState}
                </strong>
              </span>
              {latencyMs !== null && <span className="tabular">{latencyMs} ms latency</span>}
              {!!activeSymbolInfo?.missedTicks && (
                <span className="text-warning">{activeSymbolInfo.missedTicks} missed ticks</span>
              )}
              <span className="ml-auto">
                Charting by TradingView Lightweight Charts™ · indicators by WickSentinel
              </span>
            </div>
          </Card>
        </div>

        <div className={mobileTab === 'analysis' ? 'block' : 'hidden xl:block'}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <IndicatorPanel opportunity={activeOpp} />
            <SignalPanel
              opportunity={activeOpp}
              pipSize={activeSymbolInfo?.pipSize ?? 0.01}
              onOpenAnalysis={onOpenAnalysis}
            />
          </div>
        </div>
      </div>

      {/* Region C — account + signal context. */}
      <aside className={`${mobileTab === 'account' ? 'block' : 'hidden'} xl:col-span-3 xl:block`}>
        <TradePanel
          activeSymbol={activeSymbolInfo}
          opportunity={activeOpp}
          waStatus={waStatus}
          alertsAutoSend={alertsAutoSend}
        />
      </aside>
    </div>
  );
};
