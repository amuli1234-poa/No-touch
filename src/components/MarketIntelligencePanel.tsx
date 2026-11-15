import { useMemo } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, Brain, Crosshair, Minus, Radar } from 'lucide-react';
import type {
  IntelligenceScenario,
  MajorZone,
  MarketIntelligence,
} from '../types/intelligence';
import { formatPrice } from '../utils/derivParser';

/**
 * Market Intelligence panel — PHASE 1/2 read of the market, shown BEFORE any signal.
 * The scanner thinks first (bias, major structure, zones, liquidity, scenarios) and
 * only then searches for an opportunity, so this panel explains the "why" behind a
 * trade decision — or why there is nothing worth trading yet.
 */

interface MarketIntelligencePanelProps {
  intelligence: MarketIntelligence | null;
  precision: number;
}

const BIAS_STYLE = {
  bullish: { label: 'BULLISH BIAS', cls: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30', Icon: ArrowUpRight },
  bearish: { label: 'BEARISH BIAS', cls: 'bg-red-500/12 text-bear border-red-500/30', Icon: ArrowDownRight },
  neutral: { label: 'NEUTRAL BIAS', cls: 'bg-panel text-muted border-line', Icon: Minus },
} as const;

const CONDITION_STYLE: Record<MarketIntelligence['condition'], string> = {
  TRENDING: 'bg-sky-500/12 text-sky-400 border-sky-500/30',
  RANGING: 'bg-indigo-500/12 text-indigo-300 border-indigo-500/30',
  TRANSITIONING: 'bg-amber-500/12 text-warn border-amber-500/30',
};

function zoneTone(zone: MajorZone): string {
  if (zone.freshness === 'INVALIDATED' || zone.freshness === 'WEAKENED') {
    return 'text-muted border-line';
  }
  return zone.role === 'support'
    ? 'text-emerald-400 border-emerald-500/30'
    : 'text-bear border-red-500/30';
}

function ScenarioCard({
  scenario,
  precision,
}: {
  scenario: IntelligenceScenario;
  precision: number;
}) {
  const isBull = scenario.direction === 'bullish';
  const cls = isBull
    ? 'border-emerald-500/25 bg-emerald-500/6'
    : 'border-red-500/25 bg-red-500/6';
  const accent = isBull ? 'text-emerald-400' : 'text-bear';
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${cls}`}>
      <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide ${accent}`}>
        {isBull ? (
          <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
        ) : (
          <ArrowDownRight className="w-3 h-3" aria-hidden="true" />
        )}
        {isBull ? 'Bullish scenario' : 'Bearish scenario'}
      </div>
      <p className="mt-1 text-[11px] text-ink leading-snug">{scenario.summary}</p>
      <div className="mt-1.5 space-y-0.5 text-[10px] font-mono text-faint">
        <div>
          <span className="text-muted">Trigger:</span> {scenario.trigger}
        </div>
        {scenario.targets.length > 0 && (
          <div>
            <span className="text-muted">Targets:</span>{' '}
            {scenario.targets.map((t) => formatPrice(t, precision)).join(' → ')}
          </div>
        )}
        <div>
          <span className="text-muted">Invalidation:</span> {scenario.invalidation}
        </div>
      </div>
    </div>
  );
}

export function MarketIntelligencePanel({ intelligence, precision }: MarketIntelligencePanelProps) {
  const bias = intelligence ? BIAS_STYLE[intelligence.bias] : null;
  const topZones = useMemo(() => {
    if (!intelligence) return [];
    return [...intelligence.zones]
      .filter((z) => z.freshness !== 'INVALIDATED')
      .sort((a, b) => (b.freshness === 'FRESH' ? 1 : 0) - (a.freshness === 'FRESH' ? 1 : 0))
      .slice(0, 4);
  }, [intelligence]);

  if (!intelligence) {
    return (
      <div className="rounded-xl border border-line bg-panel px-3 py-3">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted">
          <Brain className="w-3.5 h-3.5" aria-hidden="true" />
          Market Intelligence
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          Run the analysis to read the market before any setup is searched for.
        </p>
      </div>
    );
  }

  const BiasIcon = bias!.Icon;

  return (
    <div className="rounded-xl border border-line bg-panel overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-surface">
        <Brain className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-wide text-ink">
          Market Intelligence
        </span>
        <span className="ml-auto text-[10px] font-mono text-faint uppercase">
          {intelligence.timeframe} · Phase 1
        </span>
      </div>

      <div className="p-3 space-y-3">
        {/* Bias + condition */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            data-testid="intel-bias"
            data-bias={intelligence.bias}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${bias!.cls}`}
          >
            <BiasIcon className="w-3 h-3" aria-hidden="true" />
            {bias!.label}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${CONDITION_STYLE[intelligence.condition]}`}
          >
            <Activity className="w-3 h-3" aria-hidden="true" />
            {intelligence.condition}
          </span>
        </div>
        <p className="text-[11px] text-muted leading-snug">{intelligence.conditionExplanation}</p>

        {/* Tradeability verdict */}
        {!intelligence.tradeable && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-[11px] text-warn">
            <span className="font-bold uppercase tracking-wide">No trade — </span>
            {intelligence.noTradeReason ?? 'No clean structural edge right now.'}
          </div>
        )}

        {/* Key structural levels */}
        {intelligence.report.structuralLevels.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-faint">
              <Crosshair className="w-3 h-3" aria-hidden="true" />
              Key levels
            </div>
            <div className="mt-1 space-y-0.5">
              {intelligence.report.structuralLevels.slice(0, 5).map((lvl, i) => (
                <div key={i} className="flex items-center justify-between text-[10px] font-mono">
                  <span className={lvl.kind === 'support' ? 'text-emerald-400' : 'text-bear'}>
                    {lvl.label}
                  </span>
                  <span className="text-ink">{formatPrice(lvl.price, precision)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Strongest zones */}
        {topZones.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-faint">
              <Radar className="w-3 h-3" aria-hidden="true" />
              Strongest zones
            </div>
            <div className="mt-1 space-y-1">
              {topZones.map((zone) => (
                <div
                  key={zone.id}
                  className={`rounded-md border px-2 py-1 text-[10px] font-mono ${zoneTone(zone)}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold uppercase">
                      {zone.roleReversed ? `${zone.role} (flip)` : zone.role} · {zone.strength}
                    </span>
                    <span className="text-muted uppercase">{zone.freshness}</span>
                  </div>
                  <div className="text-faint">
                    {formatPrice(zone.lowerPrice, precision)} – {formatPrice(zone.upperPrice, precision)}
                    {' · '}
                    {zone.reactions} reaction{zone.reactions === 1 ? '' : 's'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Liquidity objectives */}
        {intelligence.report.liquidityObjectives.length > 0 && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-faint">
              Liquidity objectives
            </div>
            <div className="mt-1 space-y-0.5">
              {intelligence.report.liquidityObjectives.slice(0, 4).map((pool) => (
                <div key={pool.id} className="flex items-center justify-between text-[10px] font-mono">
                  <span className={pool.swept ? 'text-faint line-through' : 'text-muted'}>
                    {pool.side === 'above' ? 'Buy-side' : 'Sell-side'} ({pool.distanceAtr.toFixed(1)}× ATR)
                  </span>
                  <span className={pool.swept ? 'text-faint' : 'text-ink'}>
                    {formatPrice(pool.price, precision)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scenarios */}
        <div className="grid grid-cols-1 gap-2">
          <ScenarioCard scenario={intelligence.report.bullishScenario} precision={precision} />
          <ScenarioCard scenario={intelligence.report.bearishScenario} precision={precision} />
        </div>
      </div>
    </div>
  );
}
