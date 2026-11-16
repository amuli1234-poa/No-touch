import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  HeartPulse,
  Loader2,
  Plug,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import type { HealthCheck, HealthStatus } from '../../analysis/systemHealth';
import { HEALTH_TIMEFRAMES } from '../../analysis/systemHealth';
import type { HealthReport } from '../../hooks/useSystemHealth';
import { Card, StatTile } from '../ui/primitives';

const STATUS_STYLE: Record<
  HealthStatus,
  { text: string; bg: string; border: string; icon: typeof CheckCircle2 }
> = {
  HEALTHY: { text: 'text-[#089981]', bg: 'bg-[#089981]/10', border: 'border-[#089981]/30', icon: CheckCircle2 },
  WARNING: { text: 'text-[#d97706]', bg: 'bg-[#d97706]/10', border: 'border-[#d97706]/30', icon: AlertTriangle },
  FAILED: { text: 'text-[#f23645]', bg: 'bg-[#f23645]/10', border: 'border-[#f23645]/30', icon: XCircle },
  NOT_TESTED: { text: 'text-muted', bg: 'bg-elevated', border: 'border-line', icon: CircleDashed },
};

const OVERALL_STYLE: Record<string, string> = {
  READY: 'text-[#089981] border-[#089981]/30 bg-[#089981]/10',
  'READY WITH WARNINGS': 'text-[#d97706] border-[#d97706]/30 bg-[#d97706]/10',
  'NOT READY': 'text-[#f23645] border-[#f23645]/30 bg-[#f23645]/10',
};

function StatusBadge({ status }: { status: HealthStatus }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-semibold ${s.text} ${s.bg} ${s.border}`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      {status.replace('_', ' ')}
    </span>
  );
}

function CheckRow({ check }: { check: HealthCheck }) {
  return (
    <li className="flex flex-col gap-1 py-2.5 border-b border-line-soft last:border-0">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-ink">{check.label}</span>
        {check.critical && (
          <span className="text-[9px] font-semibold uppercase tracking-wide text-faint border border-line rounded px-1">
            critical
          </span>
        )}
        <span className="ml-auto">
          <StatusBadge status={check.status} />
        </span>
      </div>
      <p className="text-[11px] text-muted leading-snug">{check.detail}</p>
      {check.metric && (
        <p className="text-[10px] font-mono text-faint">{check.metric}</p>
      )}
    </li>
  );
}

export function SystemHealthView({ health }: { health: HealthReport }) {
  const { checks, summary, live, running, runAt, runDiagnostics, timeframesReady } = health;
  const [showAll, setShowAll] = useState(false);

  const ordered = [...checks].sort((a, b) => {
    const order: HealthStatus[] = ['FAILED', 'WARNING', 'NOT_TESTED', 'HEALTHY'];
    const diff = order.indexOf(a.status) - order.indexOf(b.status);
    if (diff !== 0) return diff;
    return a.label.localeCompare(b.label);
  });
  const visible = showAll ? ordered : ordered.slice(0, 8);

  const eligibleProbed = live?.probes.length ?? 0;
  const liveMarkets = live?.probes.filter((p) => p.ticksReceived > 0).length ?? 0;

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <header className="flex flex-wrap items-center gap-2">
        <span className="w-8 h-8 rounded-lg bg-accent/12 text-accent border border-accent/25 flex items-center justify-center">
          <HeartPulse className="w-4 h-4" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-[17px] font-bold tracking-tight text-ink leading-none">
            System Health &amp; Diagnostics
          </h1>
          <p className="text-[11px] text-muted leading-none mt-1">
            Every status is derived from real runtime evidence — never assumed.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span
            data-testid="overall-status"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-semibold ${OVERALL_STYLE[summary.overall]}`}
          >
            {summary.overall}
          </span>
          <button
            type="button"
            onClick={() => void runDiagnostics()}
            disabled={running}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-semibold text-white bg-accent rounded-lg hover:bg-accent-soft active:scale-[0.98] disabled:opacity-50 transition-all duration-150 cursor-pointer"
          >
            {running ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            Run full diagnostics
          </button>
        </div>
      </header>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <StatTile label="Components" value={summary.total} />
        <StatTile label="Healthy" value={summary.healthy} valueClass="text-[#089981]" />
        <StatTile label="Warnings" value={summary.warning} valueClass="text-[#d97706]" />
        <StatTile label="Failed" value={summary.failed} valueClass="text-[#f23645]" />
        <StatTile label="Not tested" value={summary.notTested} valueClass="text-muted" />
        <StatTile
          label="AI modules"
          value={`${checks.find((c) => c.id === 'ai-modules')?.metric ?? '—'}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-3">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2 pb-1">
            <h2 className="text-[13px] font-semibold text-ink">Component diagnostics</h2>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="text-[11px] font-medium text-accent hover:underline cursor-pointer"
            >
              {showAll ? 'Show less' : `Show all ${ordered.length}`}
            </button>
          </div>
          <ul>
            {visible.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-3">
          <Card className="p-4">
            <div className="flex items-center gap-2">
              <Plug className="w-4 h-4 text-accent" aria-hidden="true" />
              <h2 className="text-[13px] font-semibold text-ink">Deriv live integration test</h2>
            </div>
            <p className="text-[11px] text-muted mt-1 leading-snug">
              Probes real Volatility Indices (standard + 1-second). Boom/Crash excluded. No
              simulated prices are used — if real data cannot be received, the result is reported
              honestly.
            </p>
            {live ? (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold ${
                      live.status === 'PASS'
                        ? 'text-[#089981] border-[#089981]/30 bg-[#089981]/10'
                        : live.status === 'FAIL'
                          ? 'text-[#f23645] border-[#f23645]/30 bg-[#f23645]/10'
                          : 'text-muted border-line bg-elevated'
                    }`}
                  >
                    {live.status === 'PASS' ? 'LIVE PASS' : live.status === 'FAIL' ? 'LIVE FAIL' : 'NOT TESTED'}
                  </span>
                  <span className="text-[11px] text-muted">
                    {liveMarkets}/{eligibleProbed} markets receiving live data · {live.marketsDiscovered} discovered
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {live.probes.map((p) => (
                    <li key={p.symbol} className="text-[11px] border border-line rounded-lg px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink truncate">{p.displayName}</span>
                        {p.isOneSecond && (
                          <span className="text-[9px] font-semibold text-accent border border-accent/30 rounded px-1">
                            1s
                          </span>
                        )}
                        <span className="ml-auto font-mono text-faint text-[10px]">{p.symbol}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-[10px] text-muted mt-0.5">
                        <span>ticks {p.ticksReceived}</span>
                        <span>candles {p.candlesReceived}</span>
                        <span>{p.candleFieldsValid ? 'fields valid' : 'fields invalid'}</span>
                        <span>{p.timestampsMonotonic ? 'timestamps ok' : 'timestamps bad'}</span>
                      </div>
                      {p.error && <p className="text-[10px] text-[#f23645] mt-0.5">{p.error}</p>}
                    </li>
                  ))}
                </ul>
                <div className="text-[10px] text-faint space-y-0.5">
                  <p>Symbols valid: {live.symbolsCorrect ? 'yes' : 'no'} · Subscription cleanup: {live.subscriptionCleanupOk ? 'ok' : 'pending'}</p>
                  {live.notes.map((n) => (
                    <p key={n}>· {n}</p>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-faint mt-3">
                {runAt ? 'Running…' : 'Not run yet — press “Run full diagnostics”.'}
              </p>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-[13px] font-semibold text-ink">Timeframe synchronisation</h2>
            <div className="grid grid-cols-5 gap-2 mt-2">
              {HEALTH_TIMEFRAMES.map((tf) => (
                <StatTile
                  key={tf}
                  label={tf}
                  value={timeframesReady[tf] ? `${timeframesReady[tf]} bars` : 'not loaded'}
                  valueClass={timeframesReady[tf] ? 'text-[#089981]' : 'text-muted'}
                />
              ))}
            </div>
            <p className="text-[10px] text-faint mt-2 leading-snug">
              The shared chart loads one timeframe at a time; the health centre fetches all ten
              (M30/M15/M10/M7/M6/M5/M4/M3/M2/M1) internally to verify synchronisation without cluttering the
              visible chart. M7 is built internally from M1; M3 is native 180s.
            </p>
          </Card>

          <Card className="p-4">
            <h2 className="text-[13px] font-semibold text-ink">Fixed in this build</h2>
            <ul className="mt-1.5 space-y-1 text-[11px] text-muted list-disc pl-4">
              {health.fixedIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
