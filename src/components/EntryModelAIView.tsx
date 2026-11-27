import { useMemo, useState } from 'react';
import {
  Activity,
  Crosshair,
  Filter,
  Layers,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { AI_TIMEFRAME_KEYS, TIMEFRAME_ROLES } from '../config/deriv';
import { VolatilitySelector } from './VolatilitySelector';
import { formatPrice } from '../utils/derivParser';
import { Card, SectionCard, StatTile, StatusPill } from './ui/primitives';
import type { EntryDecisionState, EntryModelDecision } from '../types/entryModelAI';

const STATE_STYLE: Record<EntryDecisionState, string> = {
  WATCHING: 'bg-warn/12 text-warn border-warn/30',
  WAITING: 'bg-warn/12 text-warn border-warn/30',
  CONFIRMED: 'bg-[#089981]/12 text-[#089981] border-[#089981]/30',
  INVALIDATED: 'bg-[#f23645]/12 text-[#f23645] border-[#f23645]/30',
  MISSED: 'bg-faint/12 text-faint border-line',
  EXPIRED: 'bg-faint/12 text-faint border-line',
};

const STATE_ORDER: Record<EntryDecisionState, number> = {
  CONFIRMED: 0,
  WAITING: 1,
  WATCHING: 2,
  MISSED: 3,
  INVALIDATED: 4,
  EXPIRED: 5,
};

function price(value: number | null, precision: number): string {
  return value === null ? '—' : formatPrice(value, precision);
}

function range(low: number | null, high: number | null, precision: number): string {
  if (low === null || high === null) return '—';
  return `${price(low, precision)} – ${price(high, precision)}`;
}

/**
 * ENTRY MODEL AI — the dedicated workspace for the universal entry-model intelligence.
 *
 * One AI evaluates the best entry model for every opportunity produced by every specialised
 * strategy. This view surfaces, per opportunity: the selected model, its confirmation state,
 * the required entry confirmation, invalidation and target assessment, and the entry-quality
 * score — plus the sample-aware per-model performance record.
 */
export function EntryModelAIView() {
  const ws = useWorkspace();
  const ai = ws.entryModelAI;
  const [stateFilter, setStateFilter] = useState<EntryDecisionState | 'ALL'>('ALL');

  const decisions = useMemo(() => {
    const sorted = [...ai.decisions].sort((a, b) => {
      const s = STATE_ORDER[a.state] - STATE_ORDER[b.state];
      if (s !== 0) return s;
      return b.qualityScore - a.qualityScore;
    });
    return stateFilter === 'ALL' ? sorted : sorted.filter((d) => d.state === stateFilter);
  }, [ai.decisions, stateFilter]);

  const counts = useMemo(() => {
    const out: Record<EntryDecisionState, number> = {
      WATCHING: 0,
      WAITING: 0,
      CONFIRMED: 0,
      INVALIDATED: 0,
      EXPIRED: 0,
      MISSED: 0,
    };
    for (const d of ai.decisions) out[d.state] += 1;
    return out;
  }, [ai.decisions]);

  const focused = useMemo(
    () =>
      ai.decisions.find(
        (d) => d.symbol === ws.selectedSymbol && d.timeframe === ws.timeframe
      ) ??
      ai.decisions.find((d) => d.symbol === ws.selectedSymbol) ??
      null,
    [ai.decisions, ws.selectedSymbol, ws.timeframe]
  );

  const modelPerformance = useMemo(
    () => [...ai.performance].sort((a, b) => b.sampleSize - a.sampleSize),
    [ai.performance]
  );

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <Card className="p-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-accent" aria-hidden="true" />
              <h1 className="text-lg font-extrabold tracking-tight text-ink">Entry Model AI</h1>
            </div>
            <p className="text-[13px] text-muted leading-snug mt-1 max-w-2xl">
              One universal AI selects the best entry model for every qualified setup produced by
              every specialised strategy — it never forces one model onto every strategy and only
              reports an entry when the strategy produced a valid opportunity.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[200px]">
              <VolatilitySelector
                markets={ws.markets}
                marketsLoading={ws.marketsLoading}
                selectedSymbol={ws.selectedSymbol}
                selectedMarket={ws.selectedMarket}
                onSelect={ws.selectMarket}
              />
            </div>
            <div className="flex flex-wrap items-center gap-0.5 p-0.5 bg-elevated border border-line rounded-lg">
              {AI_TIMEFRAME_KEYS.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => ws.selectTimeframe(tf)}
                  aria-pressed={ws.timeframe === tf}
                  title={TIMEFRAME_ROLES[tf]}
                  className={`h-7 px-2.5 rounded-md text-[12px] font-semibold cursor-pointer ${
                    ws.timeframe === tf ? 'bg-accent text-white' : 'text-muted hover:text-ink'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatTile label="Evaluated" value={ai.decisions.length} />
        <StatTile label="Confirmed" value={counts.CONFIRMED} valueClass="text-[#089981]" />
        <StatTile label="Waiting" value={counts.WAITING + counts.WATCHING} valueClass="text-warn" />
        <StatTile label="Invalidated" value={counts.INVALIDATED} valueClass="text-[#f23645]" />
        <StatTile label="Missed" value={counts.MISSED} valueClass="text-faint" />
      </div>

      {focused && (
        <SectionCard
          title={`Focused: ${focused.marketName}`}
          subtitle={`${focused.originatingStrategy} · ${focused.timeframe} · ${focused.direction}`}
          icon={<Target className="w-4 h-4" />}
          right={
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wide ${STATE_STYLE[focused.state]}`}
            >
              {focused.state}
            </span>
          }
        >
          <DecisionDetail decision={focused} precision={ws.precision} />
        </SectionCard>
      )}

      <SectionCard
        title="Model evaluations"
        subtitle="Every opportunity the universal Entry Model AI has evaluated, strongest first."
        icon={<Layers className="w-4 h-4" />}
        right={
          <div className="flex items-center gap-1">
            <Filter className="w-3.5 h-3.5 text-faint" aria-hidden="true" />
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as EntryDecisionState | 'ALL')}
              className="h-7 px-2 rounded-md bg-elevated border border-line text-[12px] text-ink cursor-pointer"
              aria-label="Filter by state"
            >
              <option value="ALL">All states</option>
              <option value="CONFIRMED">Confirmed</option>
              <option value="WAITING">Waiting</option>
              <option value="WATCHING">Watching</option>
              <option value="MISSED">Missed</option>
              <option value="INVALIDATED">Invalidated</option>
            </select>
          </div>
        }
      >
        {decisions.length === 0 ? (
          <p className="text-[13px] text-muted leading-snug py-4 text-center">
            No opportunities to evaluate yet. The Entry Model AI only reports an entry when a
            specialised strategy produces a valid, qualified setup — it never manufactures one.
          </p>
        ) : (
          <ul className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {decisions.slice(0, 40).map((d) => (
              <li key={d.key}>
                <DecisionCard decision={d} precision={ws.precision} />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Entry-model performance"
        subtitle="Sample-aware — a win rate is withheld until the sample is meaningful (never fabricated)."
        icon={<Activity className="w-4 h-4" />}
      >
        {modelPerformance.length === 0 ? (
          <p className="text-[13px] text-muted leading-snug py-2">
            No recorded outcomes yet. Performance updates automatically as ranked setups settle at
            TP or SL.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-faint uppercase tracking-wide text-[11px]">
                  <th className="py-1.5 pr-3">Model</th>
                  <th className="py-1.5 px-3 text-right">Settled</th>
                  <th className="py-1.5 px-3 text-right">W / L</th>
                  <th className="py-1.5 px-3 text-right">Win rate</th>
                  <th className="py-1.5 pl-3 text-right">Avg R:R</th>
                </tr>
              </thead>
              <tbody>
                {modelPerformance.map((p) => (
                  <tr key={p.model} className="border-t border-line-soft">
                    <td className="py-1.5 pr-3 text-ink font-medium">{p.label}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-muted">{p.sampleSize}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-muted">
                      {p.wins} / {p.losses}
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-muted">
                      {p.winRatePercent === null ? '—' : `${p.winRatePercent}%`}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums text-muted">
                      {p.avgRiskReward === null ? '—' : `1:${p.avgRiskReward.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function DecisionCard({
  decision,
  precision,
}: {
  decision: EntryModelDecision;
  precision: number;
}) {
  const isRise = decision.direction === 'RISE';
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1 text-[13px] font-bold ${isRise ? 'text-[#089981]' : 'text-[#f23645]'}`}>
          {isRise ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          {decision.direction}
        </span>
        <span className="text-[13px] font-semibold text-ink truncate">{decision.marketName}</span>
        <span className="text-[11px] text-faint">{decision.timeframe}</span>
        <span
          className={`ml-auto inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wide ${STATE_STYLE[decision.state]}`}
        >
          {decision.state}
        </span>
      </div>

      <p className="mt-1.5 text-[13px] font-semibold text-accent">{decision.modelLabel}</p>
      <p className="text-[11px] text-faint">
        via {decision.originatingStrategy} · quality {decision.qualityScore}/100
      </p>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular-nums">
        <span className="flex justify-between gap-2">
          <span className="text-faint">Entry</span>
          <span className="text-ink">{price(decision.entryPrice, precision)}</span>
        </span>
        <span className="flex justify-between gap-2">
          <span className="text-faint">SL</span>
          <span className="text-[#f23645]">{price(decision.stopLoss, precision)}</span>
        </span>
        <span className="flex justify-between gap-2">
          <span className="text-faint">TP1</span>
          <span className="text-[#089981]">{price(decision.targets.tp1, precision)}</span>
        </span>
        <span className="flex justify-between gap-2">
          <span className="text-faint">R:R</span>
          <span className="text-ink">
            {decision.riskRewardRatio === null ? '—' : `1:${decision.riskRewardRatio.toFixed(2)}`}
          </span>
        </span>
      </div>

      <p className="mt-2 text-[11px] text-muted leading-snug line-clamp-2">{decision.explanation}</p>
    </div>
  );
}

function DecisionDetail({
  decision,
  precision,
}: {
  decision: EntryModelDecision;
  precision: number;
}) {
  const supported = decision.evaluations.filter((e) => e.supported);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold text-ink">{decision.modelLabel}</span>
        {decision.combinedWith.length > 0 && (
          <StatusPill
            label={`+${decision.combinedWith.length} reinforcing`}
            className="bg-accent/10 text-accent border-accent/30"
          />
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Watching zone" value={range(decision.watchingZone?.low ?? null, decision.watchingZone?.high ?? null, precision)} />
        <StatTile label="Entry area" value={range(decision.entryRange?.low ?? null, decision.entryRange?.high ?? null, precision)} />
        <StatTile label="Stop-loss" value={price(decision.stopLoss, precision)} valueClass="text-[#f23645]" />
        <StatTile
          label="Risk : Reward"
          value={decision.riskRewardRatio === null ? '—' : `1 : ${decision.riskRewardRatio.toFixed(2)}`}
        />
        <StatTile label="TP1" value={price(decision.targets.tp1, precision)} valueClass="text-[#089981]" />
        <StatTile label="TP2" value={price(decision.targets.tp2, precision)} valueClass="text-[#089981]" />
        <StatTile label="TP3" value={price(decision.targets.tp3, precision)} valueClass="text-[#089981]" />
        <StatTile label="Quality" value={`${decision.qualityScore}/100`} />
      </div>

      <div className="rounded-lg border border-line bg-app p-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-faint">Required confirmation</p>
        <p className="mt-0.5 text-[12px] text-muted leading-snug">{decision.requiredConfirmation}</p>
      </div>

      <div className="rounded-lg border border-line bg-app p-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-faint">Invalidation</p>
        <p className="mt-0.5 text-[12px] text-muted leading-snug">
          {price(decision.invalidation.level, precision)} — {decision.invalidation.condition}
        </p>
      </div>

      <div className="rounded-lg border border-line bg-app p-2.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-faint">Why this model</p>
        <p className="mt-0.5 text-[12px] text-muted leading-snug">{decision.explanation}</p>
      </div>

      {supported.length > 0 && (
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-faint mb-1">
            Model evaluation
          </p>
          <ul className="space-y-1">
            {supported.slice(0, 6).map((e) => (
              <li key={e.kind} className="flex items-start gap-2 text-[12px]">
                <span className="text-accent shrink-0 tabular-nums w-8">{e.supportScore}</span>
                <span className="text-ink font-medium shrink-0">{e.label}</span>
                <span className="text-muted leading-snug truncate">{e.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
