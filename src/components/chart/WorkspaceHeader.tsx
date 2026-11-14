import React from 'react';
import { CandlestickChart, LineChart as LineChartIcon } from 'lucide-react';
import type { ActiveSymbol, Candle, Timeframe } from '../../types/scanner';
import { SegmentedControl, Select } from '../ui/Controls';
import { Badge } from '../ui/Badge';
import { formatPrice } from '../ui/format';
import { priceChange, lastClose, TIMEFRAME_LABELS } from './chartData';
import type { ChartKind } from './TradingChart';

/**
 * Formats a signed value without a currency symbol. Deriv synthetic indices are
 * quoted in points, not currency, so a `$` prefix would be wrong — as would a
 * currency mark on a percentage.
 */
function signed(value: number, digits: number): string {
  const sign = value >= 0 ? '+' : '−';
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

/**
 * The instrument strip above the chart: symbol, timeframe, chart type and the
 * live price with its change over the visible window.
 *
 * Only symbols the feed has actually discovered are offered, and the change is
 * computed from real bars — when there are not yet two bars to compare it
 * shows "—" rather than a zero that would read as "flat".
 */

interface WorkspaceHeaderProps {
  symbols: ActiveSymbol[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  selectedTimeframe: Timeframe;
  onSelectTimeframe: (tf: Timeframe) => void;
  chartKind: ChartKind;
  onSelectChartKind: (kind: ChartKind) => void;
  candles: Candle[];
  activeSymbol?: ActiveSymbol;
  isStale?: boolean;
  crosshairPrice?: number | null;
}

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = ({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  selectedTimeframe,
  onSelectTimeframe,
  chartKind,
  onSelectChartKind,
  candles,
  activeSymbol,
  isStale,
  crosshairPrice
}) => {
  const digits = (activeSymbol?.pipSize ?? 0.01) < 0.01 ? 3 : 2;
  const live = lastClose(candles);
  const change = priceChange(candles);
  const shown = crosshairPrice ?? activeSymbol?.lastQuote ?? live;

  const changeTone =
    change?.direction === 'up' ? 'text-success' : change?.direction === 'down' ? 'text-danger' : 'text-fg-4';

  return (
    <div className="flex flex-col gap-3 border-b border-line-soft pb-3 lg:flex-row lg:items-center lg:justify-between">
      {/* Instrument identity + price */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[17px] font-bold tracking-tight text-fg-1">
              {activeSymbol?.displayName || selectedSymbol}
            </h2>
            <Badge tone={activeSymbol?.is1s ? 'info' : 'accent'}>
              {activeSymbol?.is1s ? '1s' : 'Plain'}
            </Badge>
            {isStale && <Badge tone="warning">Stale</Badge>}
          </div>
          <div className="mt-1 flex items-baseline gap-2.5">
            <span className="tabular text-[22px] font-bold leading-none text-fg-1">
              {shown !== undefined && shown !== null ? formatPrice(shown, digits) : '—'}
            </span>
            {change ? (
              <span className={`tabular text-[12.5px] font-semibold ${changeTone}`}>
                {signed(change.abs, digits)} ({signed(change.pct, 2)}%)
                <span className="ml-1 font-normal text-fg-6">· window</span>
              </span>
            ) : (
              <span className="text-[11.5px] text-fg-6">change unavailable</span>
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Select market"
          value={selectedSymbol}
          onChange={(e) => onSelectSymbol(e.target.value)}
          options={symbols.map((s) => ({
            value: s.symbol,
            label: `${s.displayName}${s.isOpen ? '' : ' (closed)'}`
          }))}
          className="w-[190px]"
        />
        <SegmentedControl
          options={TIMEFRAME_LABELS.map((t) => t.tf)}
          value={selectedTimeframe}
          onChange={onSelectTimeframe}
          labels={Object.fromEntries(TIMEFRAME_LABELS.map((t) => [t.tf, t.label]))}
        />
        <SegmentedControl<ChartKind>
          options={['candles', 'line'] as const}
          value={chartKind}
          onChange={onSelectChartKind}
          labels={{ candles: 'Candles', line: 'Line' }}
        />
        <span className="hidden items-center gap-1 text-fg-6 sm:inline-flex" aria-hidden="true">
          {chartKind === 'candles' ? (
            <CandlestickChart className="h-4 w-4" />
          ) : (
            <LineChartIcon className="h-4 w-4" />
          )}
        </span>
      </div>
    </div>
  );
};
