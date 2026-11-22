import {
  Activity,
  BrainCircuit,
  Crosshair,
  FlaskConical,
  Gauge,
  HeartPulse,
  ShieldCheck,
} from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { Card, SectionCard, StatTile } from '../ui/primitives';
import { AiLiveStatus } from '../dashboard/AiLiveStatus';

/**
 * AI INTELLIGENCE — the central advisory workspace.
 *
 * This is a hub, not a new engine: it reports the state of the AI modules that already
 * run in the workspace and routes into their detailed views. Every number here is read
 * from live state (`WorkspaceContext`), never estimated, and nothing on this page can
 * place a trade — the AI is advisory only.
 */

const MODULES: {
  section: 'entrymodel' | 'alerts' | 'risk' | 'strategylab' | 'health';
  title: string;
  detail: string;
  icon: typeof ShieldCheck;
}[] = [
  {
    section: 'entrymodel',
    title: 'Entry Model AI',
    detail: 'Chooses the entry model for each qualified setup and explains the choice.',
    icon: Crosshair,
  },
  {
    section: 'alerts',
    title: 'AI Alerts',
    detail: 'Observations raised by the engines, with acknowledgement and history.',
    icon: Activity,
  },
  {
    section: 'risk',
    title: 'Risk Management',
    detail: 'Deterministic risk rules, the live trade plan and execution guardrails.',
    icon: ShieldCheck,
  },
  {
    section: 'strategylab',
    title: 'Strategy Optimization',
    detail: 'Regime-change and anomaly studies over real Deriv history.',
    icon: FlaskConical,
  },
  {
    section: 'health',
    title: 'System Health',
    detail: 'Feed, engine and model diagnostics for the running workspace.',
    icon: HeartPulse,
  },
];

export function AiIntelligenceView() {
  const ws = useWorkspace();
  const report = ws.report;

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-faint">
                Advisory intelligence
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-panel border border-line text-muted font-bold">
                {ws.timeframe}
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-ink mt-1">
              AI Intelligence
            </h1>
            <p className="text-xs sm:text-sm text-muted leading-relaxed mt-1.5 max-w-2xl">
              What the engines currently think about {ws.marketName}, and where to inspect each
              module in detail. Intelligence here is advisory: it informs your decisions and can
              never purchase a contract or change a safety limit.
            </p>
          </div>
        </div>
      </Card>

      <AiLiveStatus />

      <SectionCard
        title="Current read"
        subtitle="Live analyser output for the selected market"
        icon={<BrainCircuit className="w-4 h-4" />}
        right={
          <button
            type="button"
            onClick={() => ws.navigate('analyser')}
            className="text-[12px] font-semibold text-accent hover:text-accent-soft cursor-pointer"
          >
            Open analyser
          </button>
        }
      >
        {report ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            <StatTile label="Market Regime" value={report.currentStructureSummary} />
            <StatTile label="Setup Quality" value={report.setupQuality} />
            <StatTile
              label="Momentum"
              value={<span className="text-ink text-xs">{report.momentum.state}</span>}
              hint={`Efficiency ${report.momentum.directionalEfficiency}`}
            />
            <StatTile
              label="Confluence"
              value={`${report.confluenceScore}/${report.maxConfluenceScore}`}
              hint="Confirmation factors satisfied"
            />
          </div>
        ) : (
          <p className="text-xs text-muted leading-relaxed">
            No analysis yet for {ws.marketName}. Open the Chart Analyser to populate regime,
            momentum and confluence readings — this panel reports them, it does not invent them.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Modules"
        subtitle="Each module keeps its own view, tests and behaviour"
        icon={<Gauge className="w-4 h-4" />}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {MODULES.map((mod) => {
            const Icon = mod.icon;
            return (
              <button
                key={mod.section}
                type="button"
                onClick={() => ws.navigate(mod.section)}
                className="text-left rounded-lg border border-line bg-panel px-3 py-2.5 hover:border-accent/50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-md bg-elevated border border-line text-accent flex items-center justify-center shrink-0">
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  </span>
                  <span className="text-xs font-bold text-ink truncate">{mod.title}</span>
                </div>
                <p className="text-[11px] text-muted leading-snug mt-1.5">{mod.detail}</p>
              </button>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="Guardrails"
        subtitle="Why the intelligence cannot move money on its own"
        icon={<ShieldCheck className="w-4 h-4" />}
      >
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            'AI output is a recommendation; every order still passes the deterministic risk engine.',
            'AI confidence is never treated as proof of profitability or as an execution trigger.',
            'REAL-money execution stays disabled; DEMO is the only execution path.',
            'Risk rules are server-side and cannot be loosened from this interface.',
          ].map((line) => (
            <li key={line} className="flex items-start gap-2 text-xs text-muted leading-relaxed">
              <ShieldCheck className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
