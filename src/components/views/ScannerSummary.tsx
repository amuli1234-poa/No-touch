import React from 'react';
import { Target } from 'lucide-react';
import type { OpportunitySignal } from '../../types/scanner';
import { Badge } from '../ui/Badge';
import { formatNumber } from '../ui/format';
import type { Tone } from '../ui/format';

/**
 * One compact status strip for the selected instrument.
 *
 * This replaces the former grid of indicator and signal cards. It shows only
 * what is needed to read the market at a glance: the RISE / FALL / WAIT state,
 * the market condition, the headline indicator values, the signal timestamp and
 * the data freshness. Every value is computed by WickSentinel's own engines and
 * carried on the opportunity snapshot - nothing is estimated, and there is no
 * "confidence" figure because the engine does not produce one.
 */

interface ScannerSummaryProps {
  opportunity?: OpportunitySignal;
  /** Epoch (ms) of the most recent market tick, for the freshness read. */
  lastTickAt?: number | null;
  isStale?: boolean;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  /** Opens the full multi-timeframe breakdown for the selected instrument. */
  onOpenAnalysis?: () => void;
}

const RSI_TONE: Record<string, Tone> = {
  OVERSOLD: 'success',
  BULLISH: 'success',
  NEUTRAL: 'neutral',
  BEARISH: 'danger',
  OVERBOUGHT: 'danger'
};

const RSI_LABEL: Record<string, string> = {
  OVERSOLD: 'Oversold',
  BULLISH: 'Bullish',
  NEUTRAL: 'Neutral',
  BEARISH: 'Bearish',
  OVERBOUGHT: 'Overbought'
};

export const ScannerSummary: React.FC<ScannerSummaryProps> = ({
  opportunity,
  lastTickAt,
  isStale,
  connectionState,
  onOpenAnalysis
}) => {
  const ind = opportunity?.indicators;
  const confirmed = opportunity?.entryAndTp.confirmed ?? false;

  const stateLabel = !opportunity
    ? 'NO DATA'
    : confirmed
      ? opportunity.riseFallLabel
      : 'WAIT';
  const stateTone: Tone = !opportunity ? 'neutral' : confirmed ? 'success' : 'warning';
  const stateClass = !opportunity
    ? 'text-fg-5'
    : confirmed
      ? opportunity.direction === 'BULLISH'
        ? 'text-success'
        : 'text-danger'
      : 'text-warning';

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[var(--radius-md)] border border-line-soft bg-surface px-3 py-2.5">
      {/* State */}
      <div className="flex items-center gap-2">
        <span className={`text-[14px] font-bold tracking-tight ${stateClass}`}>{stateLabel}</span>
        <Badge tone={stateTone} dot>
          {opportunity ? (confirmed ? 'Confirmed' : 'No signal') : 'Awaiting scan'}
        </Badge>
      </div>

      <Divider />

      {/* Market condition */}
      <Cell
        label="Condition"
        value={opportunity ? opportunity.marketRegimeLabel || opportunity.marketCondition : '—'}
      />

      {/* Indicator values */}
      {ind ? (
        <>
          <Cell label="RSI 14" value={`${formatNumber(ind.rsi14, 1)} · ${RSI_LABEL[ind.rsiState] ?? ''}`} tone={RSI_TONE[ind.rsiState]} />
          <Cell label="ADX 14" value={formatNumber(ind.adx14, 1)} />
          <Cell
            label="EMA bias"
            value={ind.emaBias === 'BULLISH' ? 'Bullish' : ind.emaBias === 'BEARISH' ? 'Bearish' : 'Neutral'}
            tone={ind.emaBias === 'BULLISH' ? 'success' : ind.emaBias === 'BEARISH' ? 'danger' : 'neutral'}
          />
        </>
      ) : (
        <Cell label="Indicators" value="Buffers filling…" />
      )}

      <Divider />

      {/* Timestamp + freshness */}
      <Cell
        label="Signal"
        value={opportunity ? new Date(opportunity.detectedEpoch).toLocaleTimeString() : '—'}
      />
      <FreshnessCell connectionState={connectionState} lastTickAt={lastTickAt} isStale={isStale} />

      {/* Confluence score — labelled as a score, never as confidence. */}
      {opportunity && (
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-fg-6">
              Score
            </span>
            <span className="tabular text-[15px] font-bold text-fg-1">
              {formatNumber(opportunity.score.total, 0)}%
            </span>
          </div>
          {onOpenAnalysis && (
            <button
              onClick={onOpenAnalysis}
              className="inline-flex items-center gap-1 rounded-[7px] border border-line-soft px-2 py-1 text-[11px] font-semibold text-fg-4 transition-colors hover:border-line-strong hover:text-fg-1"
            >
              <Target className="h-3.5 w-3.5" />
              Analysis
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const Divider: React.FC = () => <span className="hidden h-6 w-px bg-line-soft sm:block" />;

const Cell: React.FC<{ label: string; value: string; tone?: Tone }> = ({ label, value, tone }) => (
  <div className="min-w-0">
    <span className="block text-[9.5px] font-semibold uppercase tracking-[0.09em] text-fg-6">{label}</span>
    <span
      className={`tabular block truncate text-[12px] font-semibold ${
        tone === 'success'
          ? 'text-success'
          : tone === 'danger'
            ? 'text-danger'
            : tone === 'warning'
              ? 'text-warning'
              : 'text-fg-2'
      }`}
    >
      {value}
    </span>
  </div>
);

/** Age of the most recent tick, distinct from the socket state. */
const FreshnessCell: React.FC<{
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  lastTickAt?: number | null;
  isStale?: boolean;
}> = ({ connectionState, lastTickAt, isStale }) => {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  let label = '—';
  let tone: Tone = 'neutral';
  if (connectionState === 'DISCONNECTED') {
    label = 'Offline';
    tone = 'danger';
  } else if (!lastTickAt) {
    label = '—';
  } else {
    const age = now - lastTickAt;
    label = age < 3000 ? 'Live' : `${(age / 1000).toFixed(1)}s ago`;
    tone = age < 10000 ? 'success' : 'warning';
  }

  return <Cell label="Freshness" value={label} tone={tone} />;
};
