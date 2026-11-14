import React, { useMemo, useState } from 'react';
import { CandlestickChart, LineChart, Wallet } from 'lucide-react';
import type {
  ActiveSymbol,
  Candle,
  OpportunitySignal,
  Timeframe,
  WhatsAppProviderStatus
} from '../../types/scanner';
import { Card, CardHeader } from '../ui/Card';
import { formatPrice } from '../ui/format';
import { ChartStructureEngine } from '../../engines/ChartStructureEngine';
import { TradingChart, type ChartKind, type ChartLevel } from './TradingChart';
import { buildOverlays, type OverlayPreferences } from './chartOverlays';
import { OverlayLegend } from './OverlayLegend';
import { WorkspaceHeader } from './WorkspaceHeader';
import { ScannerSummary } from '../views/ScannerSummary';
import { TradePanel } from '../views/TradePanel';
import { useOverlayPreferences } from '../../lib/overlayPreferences';

/**
 * The trading workspace: watchlist, chart and account panel.
 *
 * The chart is the dominant element. A single compact status strip under the
 * chart carries the scanner read (state, condition, indicators, timestamp,
 * freshness), replacing the former grid of indicator and signal cards. The
 * watchlist and account panel stay narrow so the chart keeps the most width at
 * every breakpoint; on smaller screens the account panel moves behind a tab.
 *
 * All market data is owned by `App.tsx` and passed down - this component holds
 * only view state (selected symbol, chart type), never market data.
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
  waStatus: WhatsAppProviderStatus;
  alertsAutoSend: boolean;
  onOpenAnalysis: () => void;
}

type MobileTab = 'chart' | 'account';

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
  waStatus,
  alertsAutoSend,
  onOpenAnalysis
}) => {
  const [chartKind, setChartKind] = useState<ChartKind>('candles');
  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');
  const [overlayPrefs, setOverlayPrefs] = useOverlayPreferences();

  const digits = (activeSymbolInfo?.pipSize ?? 0.01) < 0.01 ? 3 : 2;

  const structure = useMemo(
    () => ChartStructureEngine.derive(candles, selectedTimeframe),
    [candles, selectedTimeframe]
  );

  const overlays = useMemo(() => {
    const lastEpoch = candles.length > 0 ? candles[candles.length - 1].epoch : 0;
    return buildOverlays({
      structure,
      opportunity: activeOpp,
      preferences: overlayPrefs,
      lastEpoch
    });
  }, [structure, activeOpp, overlayPrefs, candles]);

  const overlayAvailability = useMemo<Record<keyof OverlayPreferences, boolean>>(
    () => ({
      showSupportResistance: structure.supportZones.length + structure.resistanceZones.length > 0,
      showSupplyDemand: [...structure.supportZones, ...structure.resistanceZones].some(
        (z) => !z.isFlip && (z.hasBaseFormation || z.causedDisplacement)
      ),
      showTrendlines: structure.trendlines.length > 0,
      showProtectedSwings: Boolean(structure.protectedHigh || structure.protectedLow),
      showChartPatterns: Boolean(structure.confirmedPattern),
      showBreakoutLevels:
        Boolean(activeOpp?.tradingRange.isValid) &&
        activeOpp?.tradingRange.breakoutState !== 'INSIDE_RANGE'
    }),
    [structure, activeOpp]
  );

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
    <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-12">
      {/* Region A - watchlist. Narrow column on xl. */}
      <aside className="xl:col-span-2">
        <Card className="overflow-hidden p-0">
          <CardHeader
            title="Markets"
            subtitle={`${symbols.length} instruments`}
            icon={<LineChart className="h-4 w-4" />}
          />
          <div className="max-h-[260px] divide-y divide-line-soft overflow-y-auto xl:max-h-[680px]">
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
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${
                    active ? 'bg-surface-raised text-fg-1' : 'text-fg-3 hover:bg-surface-raised'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-semibold">{sym.displayName}</div>
                    <div className="text-[10px] text-fg-5">
                      {opp ? opp.marketCondition : 'Scanning'}
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

      {/* Region B - chart + scanner summary. The dominant region. */}
      <div className="min-w-0 space-y-3 xl:col-span-7">
        {/* Mobile tab switch: chart / account. Hidden on xl where both show. */}
        <div className="flex items-center gap-1 rounded-[var(--radius-md)] border border-line bg-surface-deepest p-0.5 xl:hidden">
          {(
            [
              { id: 'chart', label: 'Chart', icon: CandlestickChart },
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
            <div className="p-3">
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
            <div className="px-3 pb-3">
              <TradingChart
                candles={candles}
                symbol={selectedSymbol}
                timeframe={selectedTimeframe}
                kind={chartKind}
                priceDigits={digits}
                isStale={activeSymbolInfo?.isStale}
                connectionState={connectionState}
                levels={levels}
                overlays={overlays}
                height={440}
              />
            </div>
            <div className="border-t border-line-soft px-3 py-1.5">
              <OverlayLegend
                preferences={overlayPrefs}
                onToggle={setOverlayPrefs}
                availability={overlayAvailability}
              />
            </div>
          </Card>

          {/* Compact scanner status strip - replaces the indicator/signal cards. */}
          <ScannerSummary
            opportunity={activeOpp}
            lastTickAt={activeSymbolInfo?.lastTickEpoch ? activeSymbolInfo.lastTickEpoch * 1000 : null}
            isStale={activeSymbolInfo?.isStale}
            connectionState={connectionState}
            onOpenAnalysis={onOpenAnalysis}
          />
        </div>

        <div className={mobileTab === 'account' ? 'block' : 'hidden xl:block'}>
          <div className="xl:hidden">
            <TradePanel
              activeSymbol={activeSymbolInfo}
              opportunity={activeOpp}
              waStatus={waStatus}
              alertsAutoSend={alertsAutoSend}
            />
          </div>
        </div>
      </div>

      {/* Region C - account panel. Narrow, desktop only. */}
      <aside className="hidden xl:col-span-3 xl:block">
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
