import { Blocks, CheckCircle2, GitBranch, Layers, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { Card, SectionCard, StatusPill } from '../ui/primitives';

/**
 * BOT BUILDER — entry state for the visual strategy workspace.
 *
 * This phase ships the destination, not the editor. The panel is deliberately honest:
 * it describes what the builder will do and how it will plug into the existing engine,
 * and it offers no control that pretends a strategy can be built, generated or saved
 * yet. Every claim below maps to an existing capability in this codebase (the top-down
 * price-action engine, the deterministic risk rules, the DEMO execution gateway).
 */

const PLANNED_BLOCKS: { label: string; detail: string }[] = [
  { label: 'Market & instrument', detail: 'Pick the synthetic index and contract family a bot trades.' },
  { label: 'Conditions', detail: 'Structure, momentum and regime reads the engine already computes.' },
  { label: 'Indicators', detail: 'Parameters for the indicators the analyser uses today.' },
  { label: 'Logic operators', detail: 'AND / OR / NOT between condition blocks.' },
  { label: 'Entry conditions', detail: 'The confirmation that must hold before a bot may act.' },
  { label: 'Exit conditions', detail: 'Stop, target and invalidation rules.' },
  { label: 'Risk configuration', detail: 'The same deterministic limits the risk engine enforces.' },
  { label: 'Execution settings', detail: 'Duration, stake and mode — DEMO only.' },
];

const PIPELINE: { icon: typeof Blocks; title: string; detail: string }[] = [
  {
    icon: Workflow,
    title: 'Compose blocks',
    detail: 'Drag market, condition and risk blocks into one connected strategy graph.',
  },
  {
    icon: Sparkles,
    title: 'Generate from language',
    detail: 'Describe a strategy in plain words and receive editable blocks to review.',
  },
  {
    icon: GitBranch,
    title: 'Validate deterministically',
    detail: 'Reject bad connections, missing parameters and anything over your risk limits.',
  },
  {
    icon: ShieldCheck,
    title: 'Execute through the gateway',
    detail: 'Approved bots route through the existing risk engine and DEMO execution path.',
  },
];

export function BotBuilderView() {
  const ws = useWorkspace();

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-faint">
                Visual strategy workspace
              </span>
              <StatusPill
                label="In preparation"
                className="bg-accent/12 text-accent border-accent/25"
                dotClass="bg-accent"
              />
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-ink mt-1">
              Bot Builder
            </h1>
            <p className="text-xs sm:text-sm text-muted leading-relaxed mt-1.5 max-w-2xl">
              Build a trading bot by connecting blocks instead of writing code. The visual
              editor is being prepared; when it opens it will produce a structured, versioned
              strategy definition that is validated before it can run — and it will only ever
              execute on a DEMO account through the existing gateway.
            </p>
          </div>
          <div className="shrink-0">
            <div className="bg-panel border border-line rounded-lg px-3 py-2.5 min-w-[190px]">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                Current market
              </div>
              <div className="text-sm font-bold text-ink mt-0.5 truncate">{ws.marketName}</div>
              <div className="text-[11px] font-mono text-muted mt-0.5">
                {ws.marketFamily} · {ws.timeframe}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-raised/40 px-4 py-8">
          <div className="flex flex-col items-center text-center gap-3">
            <div className="p-3.5 rounded-full bg-panel text-accent border border-line">
              <Blocks className="w-6 h-6" aria-hidden="true" />
            </div>
            <div className="max-w-lg space-y-1">
              <h2 className="text-base font-bold text-ink">The canvas is not open yet</h2>
              <p className="text-xs sm:text-sm text-muted leading-relaxed">
                Drag-and-drop editing, AI generation and saving arrive in a later phase. Nothing
                on this screen creates, saves or runs a strategy today — so there is no strategy
                state to lose.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => ws.navigate('mybots')}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 transition-colors cursor-pointer"
              >
                <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                View My Bots
              </button>
              <button
                type="button"
                onClick={() => ws.navigate('scanner')}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-bold text-accent bg-accent/12 border border-accent/30 rounded-md hover:bg-accent/20 transition-colors cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                Open Pro Scanner
              </button>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard
          title="Block palette"
          subtitle="The categories the editor will provide"
          icon={<Blocks className="w-4 h-4" />}
        >
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {PLANNED_BLOCKS.map((block) => (
              <li
                key={block.label}
                className="rounded-lg border border-line bg-panel px-3 py-2"
              >
                <div className="text-xs font-bold text-ink">{block.label}</div>
                <div className="text-[11px] text-muted leading-snug mt-0.5">{block.detail}</div>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard
          title="How a bot will work"
          subtitle="From blocks to a validated, DEMO-only strategy"
          icon={<Workflow className="w-4 h-4" />}
        >
          <ol className="space-y-2.5">
            {PIPELINE.map((step) => {
              const Icon = step.icon;
              return (
                <li key={step.title} className="flex items-start gap-2.5">
                  <span className="shrink-0 mt-0.5 w-6 h-6 rounded-md bg-elevated border border-line text-accent flex items-center justify-center">
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-ink">{step.title}</div>
                    <div className="text-[11px] text-muted leading-snug">{step.detail}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        </SectionCard>
      </div>

      <SectionCard
        title="Safety guarantees"
        subtitle="These hold for every bot, now and after the editor ships"
        icon={<ShieldCheck className="w-4 h-4" />}
      >
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            'A bot cannot execute until its strategy passes deterministic validation.',
            'Every execution passes through the existing risk engine — never a direct broker call.',
            'AI suggestions are advisory: they produce blocks you review and edit, never a trade.',
            'REAL-money execution stays disabled. DEMO is the only execution path.',
          ].map((line) => (
            <li key={line} className="flex items-start gap-2 text-xs text-muted leading-relaxed">
              <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
