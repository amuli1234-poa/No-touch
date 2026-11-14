import React from 'react';
import { Layers } from 'lucide-react';
import type { OverlayPreferences } from './chartOverlays';

/**
 * Overlay visibility controls for the chart.
 *
 * Every toggle drives real behaviour (it adds or removes a drawn overlay), which
 * is the project rule for controls. Toggles are disabled when there is nothing
 * to show, so the legend never implies data that is not there.
 */

interface OverlayLegendProps {
  preferences: OverlayPreferences;
  onToggle: (key: keyof OverlayPreferences) => void;
  /** Whether each overlay currently has anything to draw. */
  availability: Record<keyof OverlayPreferences, boolean>;
}

const ITEMS: { key: keyof OverlayPreferences; label: string }[] = [
  { key: 'showSupportResistance', label: 'S/R & Flips' },
  { key: 'showSupplyDemand', label: 'Supply/Demand' },
  { key: 'showTrendlines', label: 'Trendlines' },
  { key: 'showProtectedSwings', label: 'Protected H/L' },
  { key: 'showChartPatterns', label: 'Patterns' },
  { key: 'showBreakoutLevels', label: 'Breakout' }
];

export const OverlayLegend: React.FC<OverlayLegendProps> = ({
  preferences,
  onToggle,
  availability
}) => {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-fg-5">
        <Layers className="h-3 w-3" />
        Overlays
      </span>
      {ITEMS.map((item) => {
        const on = preferences[item.key];
        const available = availability[item.key];
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onToggle(item.key)}
            disabled={!available && !on}
            aria-pressed={on}
            title={available ? `Toggle ${item.label}` : `No ${item.label} detected`}
            className={`rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[10.5px] font-medium transition-colors ${
              on
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-line-soft bg-surface-raised text-fg-5 hover:text-fg-2'
            } ${!available && !on ? 'cursor-not-allowed opacity-40' : ''}`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
};
