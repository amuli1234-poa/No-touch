import { AlertTriangle, CheckCircle2, CircleSlash, FileWarning, Info } from 'lucide-react';
import {
  COMPATIBILITY_LABEL,
  COMPATIBILITY_STYLE,
  type BotPreview,
  type CompatibilityLevel
} from '../../lib/bots';
import { Card } from '../ui/primitives';

/**
 * IMPORT PREVIEW — everything the parser established, plus everything it could
 * not. Nothing here is inferred: a field the file did not contain is shown as
 * "not specified" rather than filled with a plausible-looking default.
 */

const LEVEL_ICON: Record<CompatibilityLevel, typeof CheckCircle2> = {
  full: CheckCircle2,
  partial: AlertTriangle,
  unsupported: FileWarning,
  invalid: CircleSlash
};

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  const missing = value === null || value === undefined || value === '';
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-line/50 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-faint shrink-0">{label}</span>
      <span className={`text-xs text-right ${missing ? 'text-faint italic' : 'text-ink font-medium'}`}>
        {missing ? 'not specified' : value}
      </span>
    </div>
  );
}

export function ImportPreview({ preview }: { preview: BotPreview }) {
  const { bot, compatibility } = preview;
  const Icon = LEVEL_ICON[compatibility];

  if (!bot) {
    return (
      <Card className="p-4">
        <div className="flex items-start gap-2.5">
          <CircleSlash className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" aria-hidden="true" />
          <div>
            <h4 className="text-sm font-bold text-ink">This file could not be interpreted</h4>
            <p className="text-xs text-muted mt-1 leading-relaxed">{preview.compatibilityReason}</p>
            {preview.errors.length > 0 && (
              <ul className="mt-2 space-y-1">
                {preview.errors.map((e) => (
                  <li key={e.code} className="text-[11px] text-rose-400">
                    {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-ink truncate">{bot.name}</h3>
            <p className="text-[11px] text-faint mt-0.5">
              Deriv DBot XML · {(preview.sourceBytes / 1024).toFixed(1)} KB
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide border ${COMPATIBILITY_STYLE[compatibility]}`}
          >
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            {COMPATIBILITY_LABEL[compatibility]}
          </span>
        </div>
        <p className="text-xs text-muted mt-2.5 leading-relaxed">{preview.compatibilityReason}</p>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4">
          <h4 className="text-xs font-bold uppercase tracking-wide text-faint mb-1">Market & contract</h4>
          <Row label="Market" value={bot.market.market} />
          <Row label="Submarket" value={bot.market.submarket} />
          <Row label="Symbol" value={bot.market.symbol} />
          <Row
            label="Candle interval"
            value={bot.market.candleInterval ? `${bot.market.candleInterval}s` : null}
          />
          <Row label="Trade type" value={bot.contract.tradeType} />
          <Row
            label="Contract type"
            value={bot.contract.contractTypes.length > 0 ? bot.contract.contractTypes.join(', ') : null}
          />
        </Card>

        <Card className="p-4">
          <h4 className="text-xs font-bold uppercase tracking-wide text-faint mb-1">Stake & duration</h4>
          <Row label="Stake" value={bot.stake.amount !== null ? String(bot.stake.amount) : null} />
          <Row label="Currency" value={bot.stake.currency} />
          <Row label="Duration" value={bot.stake.duration !== null ? String(bot.stake.duration) : null} />
          <Row label="Duration unit" value={bot.stake.durationUnit} />
        </Card>

        <Card className="p-4">
          <h4 className="text-xs font-bold uppercase tracking-wide text-faint mb-1.5">
            Entry conditions ({bot.entryConditions.length})
          </h4>
          {bot.entryConditions.length === 0 ? (
            <p className="text-xs text-faint italic">No entry conditions were found in this file.</p>
          ) : (
            <ul className="space-y-1.5">
              {bot.entryConditions.map((c, i) => (
                <li key={`${c.kind}-${i}`} className="text-xs text-ink flex items-start gap-1.5">
                  <span className="text-accent mt-0.5">•</span>
                  {c.description}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h4 className="text-xs font-bold uppercase tracking-wide text-faint mb-1.5">
            Exit conditions ({bot.exitConditions.length})
          </h4>
          {bot.exitConditions.length === 0 ? (
            <p className="text-xs text-faint italic">No exit conditions were found in this file.</p>
          ) : (
            <ul className="space-y-1.5">
              {bot.exitConditions.map((c, i) => (
                <li key={`${c.kind}-${i}`} className="text-xs text-ink flex items-start gap-1.5">
                  <span className="text-accent mt-0.5">•</span>
                  {c.description}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <h4 className="text-xs font-bold uppercase tracking-wide text-faint mb-1.5">
          Indicators ({bot.indicators.length})
        </h4>
        {bot.indicators.length === 0 ? (
          <p className="text-xs text-faint italic">No indicator blocks were found in this file.</p>
        ) : (
          <ul className="space-y-1.5">
            {bot.indicators.map((ind, i) => (
              <li key={`${ind.kind}-${i}`} className="text-xs text-ink">
                {ind.summary}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {bot.unsupportedBlocks.length > 0 && (
        <Card className="p-4 border-amber-500/30">
          <h4 className="text-xs font-bold uppercase tracking-wide text-amber-400 mb-1.5 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
            Blocks No-touch cannot interpret ({bot.unsupportedBlocks.length})
          </h4>
          <ul className="space-y-1.5">
            {bot.unsupportedBlocks.map((b) => (
              <li key={b.type} className="text-xs">
                <code className="text-ink font-mono">{b.type}</code>
                {b.count > 1 && <span className="text-faint"> ×{b.count}</span>}
                <span className="text-muted"> — {b.reason}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted mt-2 leading-relaxed">
            These blocks are preserved in the original file but are not understood, so this bot is not
            treated as runnable.
          </p>
        </Card>
      )}

      {bot.unknownBlocks.length > 0 && (
        <Card className="p-4 border-orange-500/30">
          <h4 className="text-xs font-bold uppercase tracking-wide text-orange-400 mb-1.5 flex items-center gap-1.5">
            <FileWarning className="w-3.5 h-3.5" aria-hidden="true" />
            Unrecognised blocks ({bot.unknownBlocks.length})
          </h4>
          <ul className="space-y-1">
            {bot.unknownBlocks.map((b) => (
              <li key={b.type} className="text-xs">
                <code className="text-ink font-mono">{b.type}</code>
                <span className="text-faint"> ×{b.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(preview.errors.length > 0 || bot.warnings.length > 0) && (
        <Card className="p-4">
          <h4 className="text-xs font-bold uppercase tracking-wide text-faint mb-1.5 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" aria-hidden="true" />
            Warnings
          </h4>
          <ul className="space-y-1">
            {[...preview.errors, ...bot.warnings].map((w, i) => (
              <li key={`${w.code}-${i}`} className="text-[11px] text-muted">
                {w.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-3 bg-panel">
        <p className="text-[11px] text-muted leading-relaxed">
          Importing records this strategy for reference. It does not authorise execution: every future
          trade must still pass the deterministic risk engine and the DEMO-only execution gateway.
        </p>
      </Card>
    </div>
  );
}
