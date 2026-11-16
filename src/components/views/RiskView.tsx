import { useMemo, useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import {
  buildRiskPlan,
  DEFAULT_RISK_PROFILE,
  RISK_RULES,
  type RiskProfile,
} from '../../analysis/riskManagement';
import { Card, SectionCard, StatTile } from '../ui/primitives';
import { formatPrice } from '../../utils/derivParser';

const TIER_CLASS: Record<string, string> = {
  EXCEPTIONAL: 'text-[#089981]',
  HIGH_QUALITY: 'text-[#089981]',
  DEVELOPING: 'text-[#d97706]',
  REJECTED: 'text-[#f23645]',
};

/**
 * RISK MANAGEMENT & TRADE EXECUTION AI — a live plan for the current validated setup, plus the
 * active execution guardrails. It reads the analyser's published signal and the managed
 * position so the numbers match what the chart is showing.
 */
export function RiskView() {
  const ws = useWorkspace();
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_RISK_PROFILE);

  const setup = useMemo(() => {
    const signal = ws.report?.overlays.signal ?? null;
    const managed =
      ws.managedSignals.find(
        (m) => m.symbol === ws.selectedSymbol && m.timeframe === ws.timeframe
      ) ?? null;
    if (managed) {
      return {
        entry: managed.entry,
        stopLoss: managed.stopLoss,
        takeProfit: managed.takeProfit,
        tier: managed.quality.tier,
        source: 'Managed position',
        direction: managed.direction,
      };
    }
    if (signal) {
      return {
        entry: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit1,
        tier: signal.quality.tier,
        source: 'Validated setup',
        direction: signal.direction,
      };
    }
    return null;
  }, [ws.report, ws.managedSignals, ws.selectedSymbol, ws.timeframe]);

  const plan = useMemo(
    () =>
      setup
        ? buildRiskPlan({
            entry: setup.entry,
            stopLoss: setup.stopLoss,
            takeProfit: setup.takeProfit,
            tier: setup.tier,
            precision: ws.precision,
            profile,
          })
        : null,
    [setup, ws.precision, profile]
  );

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <header className="flex items-center gap-2">
        <span className="w-8 h-8 rounded-lg bg-accent/12 text-accent border border-accent/25 flex items-center justify-center">
          <ShieldCheck className="w-4 h-4" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-ink leading-none">
            Risk Management &amp; Trade Execution AI
          </h1>
          <p className="text-[12px] text-muted leading-none mt-1">
            Position sizing, stop validity and reward-to-risk gates for the current setup.
          </p>
        </div>
      </header>

      <Card className="p-4">
        <h2 className="text-[13px] font-semibold text-ink">Account profile</h2>
        <div className="grid grid-cols-2 gap-3 mt-2 max-w-md">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-muted">Account size</span>
            <input
              type="number"
              min={100}
              step={100}
              value={profile.accountSize}
              onChange={(e) =>
                setProfile((p) => ({ ...p, accountSize: Math.max(100, Number(e.target.value) || 0) }))
              }
              className="h-9 px-2.5 rounded-lg bg-elevated border border-line text-[13px] text-ink tabular-nums outline-none focus:border-accent/50"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-muted">Risk per trade (%)</span>
            <input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={profile.riskPercent}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  riskPercent: Math.min(10, Math.max(0.1, Number(e.target.value) || 0.1)),
                }))
              }
              className="h-9 px-2.5 rounded-lg bg-elevated border border-line text-[13px] text-ink tabular-nums outline-none focus:border-accent/50"
            />
          </label>
        </div>
      </Card>

      {setup && plan ? (
        <SectionCard
          title={`Execution plan — ${setup.direction} ${ws.marketName}`}
          subtitle={`Source: ${setup.source} · ${ws.timeframe} · ${setup.tier} tier`}
          icon={<ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <StatTile label="Entry" value={formatPrice(setup.entry, ws.precision)} />
            <StatTile
              label="Stop"
              value={formatPrice(setup.stopLoss, ws.precision)}
              valueClass="text-[#f23645]"
            />
            <StatTile
              label="Target"
              value={formatPrice(setup.takeProfit, ws.precision)}
              valueClass="text-[#089981]"
            />
            <StatTile label="Risk amount" value={`$${plan.riskAmount.toLocaleString()}`} />
            <StatTile label="Position size" value={plan.positionSize} />
            <StatTile
              label="R:R"
              value={`${plan.riskRewardRatio.toFixed(2)}:1`}
              valueClass={plan.riskRewardRatio >= 1.5 ? 'text-[#089981]' : 'text-[#d97706]'}
            />
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <StatTile label="Notional exposure" value={`$${plan.notional.toLocaleString()}`} />
            <StatTile label="Stop distance" value={plan.stopDistance} />
          </div>
          {plan.warnings.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {plan.warnings.map((w) => (
                <li key={w} className="flex items-start gap-1.5 text-[12px] text-[#d97706]">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[12px] text-[#089981]">
              All execution guardrails satisfied for this setup.
            </p>
          )}
        </SectionCard>
      ) : (
        <Card className="p-4">
          <p className="text-[13px] text-muted leading-snug">
            No validated setup is published for {ws.marketName} on {ws.timeframe}. Run the Chart
            Analyser, or open a managed position, to produce a live risk plan. Position sizing and
            guardrails below remain active.
          </p>
        </Card>
      )}

      <SectionCard
        title="Execution guardrails"
        subtitle="Applied to every plan, on every market"
        icon={<ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />}
      >
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {RISK_RULES.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-panel px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-ink">{r.label}</span>
                <span className={`ml-auto text-[11px] font-semibold ${TIER_CLASS[setup?.tier ?? 'DEVELOPING']}`}>
                  active
                </span>
              </div>
              <p className="text-[12px] text-muted leading-snug mt-0.5">{r.detail}</p>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
