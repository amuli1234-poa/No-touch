import { useMemo } from 'react';
import { Crosshair, Target, TrendingDown, TrendingUp } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { formatPrice } from '../utils/derivParser';
import type { EntryDecisionState, EntryModelDecision } from '../types/entryModelAI';

const STATE_STYLE: Record<EntryDecisionState, string> = {
  WATCHING: 'bg-warn/12 text-warn border-warn/30',
  WAITING: 'bg-warn/12 text-warn border-warn/30',
  CONFIRMED: 'bg-[#089981]/12 text-[#089981] border-[#089981]/30',
  INVALIDATED: 'bg-[#f23645]/12 text-[#f23645] border-[#f23645]/30',
  MISSED: 'bg-faint/12 text-faint border-line',
  EXPIRED: 'bg-faint/12 text-faint border-line',
};

function price(value: number | null, precision: number): string {
  return value === null ? '—' : formatPrice(value, precision);
}

function range(low: number | null, high: number | null, precision: number): string {
  if (low === null || high === null) return '—';
  return `${price(low, precision)} – ${price(high, precision)}`;
}

/**
 * ENTRY MODEL PANEL — displays the entry model the universal Entry Model AI selected for
 * the setup currently opened in Chart Analysis: the model, the confirmation required, the
 * entry area, stop-loss, take-profits and a short explanation of the selection.
 */
export function EntryModelPanel() {
  const ws = useWorkspace();
  const origin = ws.chartAnalysisSetup;
  const precision = ws.precision;

  const decision = useMemo<EntryModelDecision | null>(() => {
    const all = ws.entryModelAI.decisions;
    if (all.length === 0) return null;
    if (origin) {
      const match = all.find(
        (d) =>
          d.symbol === origin.symbol &&
          d.direction === origin.direction &&
          d.timeframe === origin.timeframe
      );
      if (match) return match;
      const bySymbol = all.find((d) => d.symbol === origin.symbol);
      if (bySymbol) return bySymbol;
    }
    // Fall back to the strongest decision for the currently selected market.
    return all.find((d) => d.symbol === ws.selectedSymbol) ?? all[0];
  }, [ws.entryModelAI.decisions, ws.selectedSymbol, origin]);

  if (!decision) {
    return (
      <div className="rounded-xl border border-line bg-panel p-3">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-faint">
          <Crosshair className="w-3.5 h-3.5" /> Entry Model AI
        </div>
        <p className="mt-1 text-[11px] text-muted leading-snug">
          No qualified setup is available yet. The Entry Model AI only reports an entry when a
          strategy produces a valid opportunity — it never manufactures one.
        </p>
      </div>
    );
  }

  const dirIcon =
    decision.direction === 'RISE' ? (
      <TrendingUp className="w-3.5 h-3.5" />
    ) : (
      <TrendingDown className="w-3.5 h-3.5" />
    );

  return (
    <div className="rounded-xl border border-line bg-panel p-3 space-y-2" data-testid="entry-model-panel">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-accent flex items-center gap-1.5">
          <Crosshair className="w-3.5 h-3.5" /> Entry Model AI
        </span>
        <span
          className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATE_STYLE[decision.state]}`}
        >
          {decision.state}
        </span>
      </div>

      <p className="text-[12px] text-ink font-semibold leading-snug">{decision.modelLabel}</p>
      <p className="text-[11px] text-muted leading-snug">
        {decision.marketName} · {decision.originatingStrategy} ·{' '}
        <span className="inline-flex items-center gap-1 text-ink">
          {dirIcon}
          {decision.direction}
        </span>
      </p>

      {decision.combinedWith.length > 0 && (
        <p className="text-[10px] text-faint leading-snug">
          Reinforced by:{' '}
          {decision.combinedWith
            .map((k) => k.replace(/_/g, ' ').toLowerCase())
            .join(', ')}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <Row label="Watching zone" value={range(decision.watchingZone?.low ?? null, decision.watchingZone?.high ?? null, precision)} />
        <Row label="Entry area" value={range(decision.entryRange?.low ?? null, decision.entryRange?.high ?? null, precision)} />
        <Row label="Stop-loss" value={price(decision.stopLoss, precision)} />
        <Row label="Risk : Reward" value={decision.riskRewardRatio === null ? '—' : `1 : ${decision.riskRewardRatio.toFixed(2)}`} />
        <Row label="TP1" value={price(decision.targets.tp1, precision)} />
        <Row label="TP2" value={price(decision.targets.tp2, precision)} />
        {decision.targets.tp3 !== null && <Row label="TP3" value={price(decision.targets.tp3, precision)} />}
        <Row label="Quality" value={`${decision.qualityScore}/100`} />
      </div>

      <div className="rounded-lg border border-line bg-app p-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-faint flex items-center gap-1">
          <Target className="w-3 h-3" /> Required confirmation
        </p>
        <p className="mt-0.5 text-[11px] text-muted leading-snug">{decision.requiredConfirmation}</p>
      </div>

      <div className="rounded-lg border border-line bg-app p-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-faint">Why this model</p>
        <p className="mt-0.5 text-[11px] text-muted leading-snug">{decision.explanation}</p>
      </div>

      {decision.model && <ModelPerformanceNote model={decision.model} />}
    </div>
  );
}

/**
 * Shows the REAL recorded performance for the selected entry model — sample-aware, so no
 * win rate is shown until the sample is meaningful (never fabricated).
 */
function ModelPerformanceNote({ model }: { model: EntryModelDecision['model'] }) {
  const ws = useWorkspace();
  const perf = ws.entryModelAI.performance.find((p) => p.model === model);
  if (!perf || perf.sampleSize === 0) {
    return (
      <p className="text-[10px] text-faint leading-snug">
        No recorded outcomes for this model yet — performance updates as setups settle.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-app p-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-faint">Recorded performance</p>
      <p className="mt-0.5 text-[11px] text-muted leading-snug tabular-nums">
        {perf.sampleSize} settled · {perf.wins}W/{perf.losses}L
        {perf.winRatePercent === null
          ? ' · win rate pending a larger sample'
          : ` · ${perf.winRatePercent}% win rate`}
        {perf.avgRiskReward !== null ? ` · avg R:R 1:${perf.avgRiskReward.toFixed(2)}` : ''}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-bold uppercase tracking-wide text-faint">{label}</span>
      <span className="text-[11px] text-ink tabular-nums">{value}</span>
    </div>
  );
}
