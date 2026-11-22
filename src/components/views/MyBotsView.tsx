import { useMemo, useState } from 'react';
import {
  Archive,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  Download,
  FileWarning,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2
} from 'lucide-react';
import {
  COMPATIBILITY_LABEL,
  COMPATIBILITY_STYLE,
  BotApiError,
  deleteBot,
  duplicateBot,
  sourceUrl,
  updateBotStatus,
  useBots,
  type BotRecord
} from '../../lib/bots';
import { Card, EmptyState, SectionCard, StatusPill } from '../ui/primitives';
import { BotImporter } from '../bots/BotImporter';

/**
 * MY BOTS — the manager for imported DBot strategies.
 *
 * Every value shown comes from a stored import. There is no placeholder bot and
 * no invented performance figure: a bot with no verified history shows nothing
 * rather than a zero, and the status column reflects the stored record only.
 *
 * The actions here change an inert record's lifecycle. None of them start
 * trading — the execution gateway is a separate, flag-gated path.
 */

const STATUS_STYLE: Record<BotRecord['status'], string> = {
  imported: 'bg-accent/10 text-accent border-accent/30',
  paused: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  archived: 'bg-slate-500/10 text-slate-400 border-slate-500/30'
};

const STATUS_LABEL: Record<BotRecord['status'], string> = {
  imported: 'Ready to review',
  paused: 'Paused',
  archived: 'Archived'
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function BotRow({
  bot,
  busy,
  onAction
}: {
  bot: BotRecord;
  busy: boolean;
  onAction: (action: 'pause' | 'resume' | 'archive' | 'duplicate' | 'delete') => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const symbol = bot.bot.market.symbol ?? 'symbol not specified';
  const contracts =
    bot.bot.contract.contractTypes.length > 0 ? bot.bot.contract.contractTypes.join(', ') : 'not specified';

  return (
    <Card className="p-3.5">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-lg bg-panel border border-line text-accent flex items-center justify-center shrink-0">
          <Bot className="w-4 h-4" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <h4 className="text-sm font-bold text-ink truncate">{bot.name}</h4>
              <p className="text-[11px] text-faint mt-0.5 truncate">{bot.originalFilename}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${COMPATIBILITY_STYLE[bot.compatibility]}`}
              >
                {COMPATIBILITY_LABEL[bot.compatibility]}
              </span>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${STATUS_STYLE[bot.status]}`}
              >
                {STATUS_LABEL[bot.status]}
              </span>
            </div>
          </div>

          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5 mt-2.5">
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-faint">Imported</dt>
              <dd className="text-[11px] text-ink">{formatDate(bot.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-faint">Source</dt>
              <dd className="text-[11px] text-ink">DBot XML</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-faint">Market</dt>
              <dd className="text-[11px] text-ink font-mono truncate">{symbol}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-faint">Contract</dt>
              <dd className="text-[11px] text-ink font-mono truncate">{contracts}</dd>
            </div>
          </dl>

          <p className="text-[11px] text-muted mt-2 leading-relaxed">{bot.compatibilityReason}</p>

          {bot.warnings.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 hover:text-amber-300 cursor-pointer"
              aria-expanded={expanded}
            >
              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
              {bot.warnings.length} warning{bot.warnings.length === 1 ? '' : 's'}
              <span className="text-faint">{expanded ? '· hide' : '· show'}</span>
            </button>
          )}
          {expanded && (
            <ul className="mt-1.5 space-y-1 pl-4">
              {bot.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`} className="text-[11px] text-muted list-disc">
                  {w.message}
                </li>
              ))}
            </ul>
          )}

          {bot.bot.unsupportedBlocks.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2">
              <p className="text-[10px] font-bold uppercase tracking-wide text-amber-400 flex items-center gap-1">
                <FileWarning className="w-3 h-3" aria-hidden="true" />
                {bot.bot.unsupportedBlocks.length} unsupported block
                {bot.bot.unsupportedBlocks.length === 1 ? '' : 's'}
              </p>
              <p className="text-[11px] text-muted mt-0.5">
                {bot.bot.unsupportedBlocks.map((b) => b.type).join(', ')}
              </p>
            </div>
          )}

          <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-2.5 border-t border-line/60">
            <a
              href={sourceUrl(bot.id)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink hover:border-accent/50 transition-colors"
            >
              <Download className="w-3 h-3" aria-hidden="true" />
              Original file
            </a>
            <button
              type="button"
              onClick={() => onAction('duplicate')}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink hover:border-accent/50 disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Copy className="w-3 h-3" aria-hidden="true" />
              Duplicate
            </button>
            {bot.status === 'paused' ? (
              <button
                type="button"
                onClick={() => onAction('resume')}
                disabled={busy}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink hover:border-accent/50 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Play className="w-3 h-3" aria-hidden="true" />
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onAction('pause')}
                disabled={busy || bot.status === 'archived'}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink hover:border-accent/50 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Pause className="w-3 h-3" aria-hidden="true" />
                Pause
              </button>
            )}
            <button
              type="button"
              onClick={() => onAction('archive')}
              disabled={busy || bot.status === 'archived'}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink hover:border-accent/50 disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Archive className="w-3 h-3" aria-hidden="true" />
              Archive
            </button>
            <button
              type="button"
              onClick={() => onAction('delete')}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-line text-[11px] font-semibold text-rose-400 hover:text-rose-300 hover:border-rose-500/50 disabled:opacity-50 transition-colors cursor-pointer ml-auto"
            >
              <Trash2 className="w-3 h-3" aria-hidden="true" />
              Delete
            </button>
          </div>

          <p className="text-[10px] text-faint mt-2 leading-relaxed">{bot.executionNote}</p>
        </div>
      </div>
    </Card>
  );
}

export function MyBotsView() {
  const { bots, status, error, refresh } = useBots();
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const active = bots.filter((b) => b.status === 'imported').length;
    const paused = bots.filter((b) => b.status === 'paused').length;
    const archived = bots.filter((b) => b.status === 'archived').length;
    return { active, paused, archived, total: bots.length };
  }, [bots]);

  const runAction = async (
    bot: BotRecord,
    action: 'pause' | 'resume' | 'archive' | 'duplicate' | 'delete'
  ) => {
    setPending(bot.id);
    setActionError(null);
    try {
      if (action === 'pause') await updateBotStatus(bot.id, 'paused');
      if (action === 'resume') await updateBotStatus(bot.id, 'imported');
      if (action === 'archive') await updateBotStatus(bot.id, 'archived');
      if (action === 'duplicate') await duplicateBot(bot.id);
      if (action === 'delete') await deleteBot(bot.id);
      await refresh();
    } catch (e) {
      setActionError(e instanceof BotApiError ? e.message : 'That action could not be completed.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-faint">
            Imported strategies
          </p>
          <h1 className="text-lg sm:text-xl font-bold text-ink mt-0.5">My Bots</h1>
          <p className="text-xs text-muted mt-1 max-w-2xl leading-relaxed">
            Bots you have imported from Deriv DBot. Importing records a strategy for review — it does
            not authorise execution, and REAL trading remains disabled.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={status === 'loading'}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-line text-[11px] font-semibold text-muted hover:text-ink hover:border-accent/50 disabled:opacity-50 transition-colors cursor-pointer"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${status === 'loading' ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          Refresh
        </button>
      </header>

      <BotImporter onImported={() => void refresh()} />

      {actionError && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" aria-hidden="true" />
          <p className="text-xs text-rose-300 leading-relaxed">{actionError}</p>
        </div>
      )}

      <SectionCard
        title="Imported bots"
        subtitle={
          counts.total > 0
            ? `${counts.total} imported · ${counts.active} ready · ${counts.paused} paused · ${counts.archived} archived`
            : 'Nothing imported yet'
        }
        icon={<Bot className="w-4 h-4" aria-hidden="true" />}
      >
        {status === 'loading' && bots.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
            <Loader2 className="w-4 h-4 animate-spin text-accent" aria-hidden="true" />
            Loading your bots…
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" aria-hidden="true" />
            <p className="text-xs text-rose-300">{error ?? 'The bot list could not be loaded.'}</p>
          </div>
        )}

        {status === 'ready' && bots.length === 0 && (
          <EmptyState
            icon={<Bot className="w-6 h-6" aria-hidden="true" />}
            title="No bots imported yet"
            description="Use the importer above to bring in a .xml strategy exported from Deriv DBot. Nothing is listed here until you import a real file."
          />
        )}

        {bots.length > 0 && (
          <div className="space-y-2.5">
            {bots.map((bot) => (
              <BotRow
                key={bot.id}
                bot={bot}
                busy={pending === bot.id}
                onAction={(action) => void runAction(bot, action)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      <Card className="p-3.5">
        <h3 className="text-xs font-bold uppercase tracking-wide text-faint flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
          What importing does and does not do
        </h3>
        <ul className="mt-2 space-y-1.5 text-[11px] text-muted leading-relaxed">
          <li>• The original file is stored verbatim and can always be downloaded again.</li>
          <li>• A bot marked partially supported or unsupported is kept for reference but cannot run.</li>
          <li>• No imported bot executes on import. DEMO execution is a separate, gated step.</li>
          <li>• REAL execution stays disabled regardless of what a bot contains.</li>
        </ul>
      </Card>

      {status === 'ready' && bots.length > 0 && (
        <StatusPill
          label={`${counts.total} bot${counts.total === 1 ? '' : 's'} stored`}
          className="bg-panel text-muted border-line"
        />
      )}
    </div>
  );
}
