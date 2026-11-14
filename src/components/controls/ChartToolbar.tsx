import React from 'react';
import {
  CandlestickChart,
  Eye,
  EyeOff,
  LineChart as LineChartIcon,
  Maximize2,
  Trash2
} from 'lucide-react';
import type { Timeframe } from '../../types/scanner';
import type { ChartKind } from '../chart/TradingChart';
import { IconButton } from '../ui/Controls';
import { TIMEFRAME_LABELS } from '../chart/chartData';

/**
 * Compact chart toolbar: timeframes plus the chart/drawing/indicator controls.
 *
 * The timeframe buttons reflect the *data* state, not the click: a timeframe is
 * only shown active once its candle buffer is non-empty, so a failed or
 * not-yet-arrived request can never look like a successful switch.
 */

interface ChartToolbarProps {
  selectedTimeframe: Timeframe;
  onSelectTimeframe: (tf: Timeframe) => void;
  /** Timeframes that currently have a non-empty candle buffer. */
  availableTimeframes: ReadonlySet<Timeframe>;
  chartKind: ChartKind;
  onSelectChartKind: (kind: ChartKind) => void;
  onResetChart: () => void;
  drawingsVisible: boolean;
  onToggleDrawings: () => void;
  onClearDrawings: () => void;
  drawingCount: number;
  overlaysVisible: boolean;
  onToggleOverlays: () => void;
}

export const ChartToolbar: React.FC<ChartToolbarProps> = ({
  selectedTimeframe,
  onSelectTimeframe,
  availableTimeframes,
  chartKind,
  onSelectChartKind,
  onResetChart,
  drawingsVisible,
  onToggleDrawings,
  onClearDrawings,
  drawingCount,
  overlaysVisible,
  onToggleOverlays
}) => {
  // Show the required compact set first, then the rest of the timeframes.
  const ordered = TIMEFRAME_LABELS;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft px-3 py-1.5">
      <div className="inline-flex items-center gap-0.5 rounded-[10px] border border-line bg-surface-deepest p-0.5">
        {ordered.map(({ tf, label }) => {
          const active = tf === selectedTimeframe;
          const hasData = availableTimeframes.has(tf);
          return (
            <button
              key={tf}
              onClick={() => onSelectTimeframe(tf)}
              aria-pressed={active}
              title={hasData ? `${label} — data loaded` : `${label} — loading…`}
              className={`rounded-[8px] px-2 py-1 text-[11.5px] font-semibold tabular transition-colors ${
                active
                  ? 'bg-accent text-on-accent shadow-[var(--shadow-control)]'
                  : hasData
                    ? 'text-fg-3 hover:bg-surface-raised hover:text-fg-1'
                    : 'text-fg-6 hover:bg-surface-raised'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <span className="mx-0.5 hidden h-5 w-px bg-line-soft sm:block" />

      <IconButton
        label={chartKind === 'candles' ? 'Candlestick display' : 'Line display'}
        active={chartKind === 'candles'}
        onClick={() => onSelectChartKind(chartKind === 'candles' ? 'line' : 'candles')}
      >
        {chartKind === 'candles' ? (
          <CandlestickChart className="h-3.5 w-3.5" />
        ) : (
          <LineChartIcon className="h-3.5 w-3.5" />
        )}
      </IconButton>

      <IconButton label="Reset chart view" onClick={onResetChart}>
        <Maximize2 className="h-3.5 w-3.5" />
      </IconButton>

      <IconButton
        label={drawingsVisible ? 'Hide drawings' : 'Show drawings'}
        active={drawingsVisible}
        onClick={onToggleDrawings}
      >
        {drawingsVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      </IconButton>

      <IconButton
        label={`Clear drawings${drawingCount > 0 ? ` (${drawingCount})` : ''}`}
        onClick={onClearDrawings}
        disabled={drawingCount === 0}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>

      <IconButton
        label={overlaysVisible ? 'Hide indicators' : 'Show indicators'}
        active={overlaysVisible}
        onClick={onToggleOverlays}
      >
        <span className="text-[10px] font-bold">{overlaysVisible ? 'IND' : 'IND'}</span>
      </IconButton>
    </div>
  );
};
