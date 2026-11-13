import React, { useState } from 'react';
import { OpportunitySignal } from '../../types/scanner';
import {
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Clock,
  ChevronDown,
  ChevronUp,
  LineChart,
  Send
} from 'lucide-react';

interface OpportunityCardProps {
  opp: OpportunitySignal;
  onOpenChart: (symbol: string) => void;
  onSendWhatsApp?: (opp: OpportunitySignal) => void;
  isSelected?: boolean;
}

export const OpportunityCard: React.FC<OpportunityCardProps> = ({
  opp,
  onOpenChart,
  onSendWhatsApp
}) => {
  const [showFullAudit, setShowFullAudit] = useState(false);

  const dec = opp.pipSize < 0.01 ? 3 : 2;
  const fmt = (n?: number) => (typeof n === 'number' ? n.toFixed(dec) : '—');
  const isBull = opp.direction === 'BULLISH';
  const isConfirmed = opp.entryAndTp.confirmed && opp.setupTier === 'HIGH_QUALITY';

  return (
    <div className="rounded-xl border border-line/90 bg-surface overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-line/80 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <h2 className="text-base font-bold text-fg-1 tracking-tight">{opp.displayName}</h2>
            <span className="text-fg-6">·</span>
            <span className="font-mono text-fg-4">
              {opp.is1s ? 'Volatility 1s' : 'Plain Volatility'} · {opp.symbol}
            </span>
          </div>
          <div className="text-xs font-mono text-fg-4 mt-1 tabular-nums flex flex-wrap items-center gap-x-2">
            <span>
              Spot: <strong className="text-fg-1">{fmt(opp.currentPrice)}</strong>
            </span>
            <span>·</span>
            <span>
              Regime: <strong className="text-fg-2">{opp.marketRegimeLabel || opp.marketCondition}</strong>
            </span>
            <span>·</span>
            <span>
              Strategy: <strong className="text-accent-cyan">{opp.selectedStrategy.label}</strong>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono">
          <div className="text-right">
            <div className="text-[10px] text-fg-5 uppercase">Signal &amp; Quality</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span
                className={`inline-flex items-center gap-1 text-xs font-bold ${
                  isConfirmed
                    ? isBull
                      ? 'text-success'
                      : 'text-danger'
                    : 'text-warning'
                }`}
              >
                {isBull ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                {isConfirmed ? opp.riseFallLabel : `WAITING FOR SETUP`}
              </span>
              <span className="text-fg-6">·</span>
              <span
                className={`text-sm font-bold tabular-nums ${
                  opp.score.total >= 75
                    ? 'text-success'
                    : opp.score.total >= 60
                    ? 'text-warning'
                    : 'text-fg-4'
                }`}
              >
                {opp.score.total}%
              </span>
            </div>
          </div>

          <button
            onClick={() => onOpenChart(opp.symbol)}
            className="px-3 py-2 rounded-lg bg-surface-raised hover:bg-surface-elevated text-xs font-sans font-semibold text-accent-cyan flex items-center gap-1.5 whitespace-nowrap transition"
          >
            <LineChart className="w-3.5 h-3.5" />
            <span>View Chart</span>
          </button>
        </div>
      </div>

      <div className="p-4 space-y-5">
        {/* Signal Output & Strategy Selection */}
        {isConfirmed ? (
          <div className="rounded-lg border border-success/40 bg-success/20 p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-mono font-bold text-success">
                <ShieldCheck className="w-4 h-4" />
                <span>
                  {opp.riseFallLabel} — {opp.selectedStrategy.label.toUpperCase()}
                </span>
              </div>
              {onSendWhatsApp && (
                <button
                  onClick={() => onSendWhatsApp(opp)}
                  className="px-2.5 py-1 rounded bg-success hover:bg-success text-fg-1 text-[11px] font-semibold flex items-center gap-1 whitespace-nowrap"
                >
                  <Send className="w-3 h-3" />
                  <span>Send to WhatsApp</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs font-mono tabular-nums">
              <div>
                <div className="text-[10px] text-fg-4 uppercase">Entry Price</div>
                <div className="text-base font-bold text-accent-cyan mt-0.5">{fmt(opp.entryAndTp.entryPrice)}</div>
                <div className="text-[10px] text-fg-4">{opp.entryAndTp.entryRationale}</div>
              </div>
              <div>
                <div className="text-[10px] text-fg-4 uppercase">Stop Loss</div>
                <div className="text-base font-bold text-danger mt-0.5">{fmt(opp.entryAndTp.invalidationLevel)}</div>
                <div className="text-[10px] text-fg-4">Protected swing boundary</div>
              </div>
              <div>
                <div className="text-[10px] text-fg-4 uppercase">TP1 / TP2</div>
                <div className="text-sm font-bold text-success mt-0.5 tabular-nums">
                  {fmt(opp.entryAndTp.takeProfit)} <span className="text-xs text-success font-normal">/ {fmt(opp.entryAndTp.takeProfit2)}</span>
                </div>
                <div className="text-[10px] text-fg-4">{opp.entryAndTp.tpRationale}</div>
              </div>
              <div>
                <div className="text-[10px] text-fg-4 uppercase">Reward : Risk</div>
                <div className="text-base font-bold text-fg-1 mt-0.5">
                  {opp.entryAndTp.riskRewardRatio ? `${opp.entryAndTp.riskRewardRatio} : 1` : '—'}
                </div>
                <div className="text-[10px] text-fg-4">Quality score ≠ guaranteed win</div>
              </div>
              <div>
                <div className="text-[10px] text-fg-4 uppercase">Expected Hold</div>
                <div className="text-xs font-bold text-fg-1 font-sans mt-1">
                  {opp.expectedHoldingTime || '15 – 45 mins'}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-fg-4 uppercase">Timeframes</div>
                <div className="text-xs font-bold text-accent-cyan mt-1">
                  {(opp.timeframesUsed || ['4H', '1H', '15M', '5M', '1M']).join(' · ')}
                </div>
              </div>
            </div>

            <div className="text-xs text-fg-2 border-t border-success/20 pt-2 space-y-1">
              <div>{opp.explanation}</div>
              {opp.confirmationReasons && opp.confirmationReasons.length > 0 && (
                <div className="text-[11px] font-mono text-success/90">
                  Confirmations: {opp.confirmationReasons.join(' · ')}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-warning/30 bg-warning/15 p-3.5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-mono font-bold text-warning">
                WAITING FOR SETUP — {opp.selectedStrategy.label.toUpperCase()} ({opp.marketRegimeLabel || opp.marketCondition})
              </div>
              <div className="text-xs text-fg-3 mt-0.5">
                {opp.entryAndTp.waitReason || opp.explanation}
              </div>
              <div className="text-[11px] font-mono text-fg-4 mt-1">
                Timeframes: {(opp.timeframesUsed || ['4H', '1H', '15M', '5M', '1M']).join(' · ')} · Est. Hold: {opp.expectedHoldingTime || '15 – 45 mins'}
              </div>
            </div>
            <div className="text-[11px] font-mono text-fg-4 tabular-nums">
              Confluence: {opp.score.total}% / 75% min
            </div>
          </div>
        )}

        {/* Mandatory M15 Trading Range & Active Strategy Selection */}
        <div
          className={`rounded-lg border p-3 text-xs font-mono flex flex-wrap items-center justify-between gap-3 ${
            opp.tradingRange.isValid
              ? 'border-success/30 bg-success/15'
              : 'border-danger/35 bg-danger/15'
          }`}
        >
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-fg-4 font-semibold">
                Mandatory M15 Trading Range
              </span>
              <span className={`text-[11px] font-bold ${opp.tradingRange.isValid ? 'text-success' : 'text-danger'}`}>
                {opp.tradingRange.isValid ? 'VALID RANGE' : 'INVALID / NO TRADE'}
              </span>
              <span className="text-fg-5">·</span>
              <span className="text-[11px] text-fg-2">{opp.tradingRange.breakoutState.replace(/_/g, ' ')}</span>
            </div>
            <div className="text-[11px] text-fg-3 font-sans">
              {opp.tradingRange.isValid
                ? `Range ${fmt(opp.tradingRange.rangeLow)} – ${fmt(opp.tradingRange.rangeHigh)} · EQ ${fmt(opp.tradingRange.equilibrium)} · Price in ${opp.tradingRange.currentPosition} · ${opp.tradingRange.poisInsideRangeCount} valid POIs`
                : opp.tradingRange.invalidReason || 'No valid M15 trading range detected.'}
            </div>
          </div>
          <div className="text-[11px] text-fg-4 tabular-nums">
            Strategy: <strong className="text-accent-cyan">{opp.selectedStrategy.label}</strong>
          </div>
        </div>

        {/* Top-Down Multi-Timeframe Matrix: H4 -> H1 -> M15 -> M5 -> M1 */}
        <div>
          <div className="text-[11px] font-mono uppercase tracking-wider text-fg-4 font-semibold mb-2">
            Top-Down Multi-Timeframe Alignment (H4 → H1 → M15 → M5 → M1)
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {(['h4', 'h1', 'm15', 'm5', 'm1'] as const).map((k) => {
              const tf = opp.timeframeMatrix[k];
              const tfLabel =
                tf.timeframe === '4h'
                  ? 'H4'
                  : tf.timeframe === '1h'
                  ? 'H1'
                  : tf.timeframe === '15m'
                  ? 'M15'
                  : tf.timeframe === '5m'
                  ? 'M5'
                  : 'M1';
              return (
                <div key={k} className="p-3 rounded-lg bg-surface-deepest/80 border border-line/80 text-xs">
                  <div className="flex items-center justify-between font-mono">
                    <span className="font-bold text-fg-1">{tfLabel}</span>
                    <span
                      className={`font-bold text-[11px] ${
                        tf.bias === 'BULLISH'
                          ? 'text-success'
                          : tf.bias === 'BEARISH'
                          ? 'text-danger'
                          : 'text-fg-4'
                      }`}
                    >
                      {tf.bias}
                    </span>
                  </div>
                  <div className="text-[10px] text-fg-5 mt-0.5">{tf.role}</div>
                  <div className="text-[11px] text-fg-2 font-medium mt-1.5">{tf.structureSummary}</div>
                  <div className="text-[10px] text-fg-4 font-mono mt-1">{tf.keyNote}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Price Action Structural Confluences (Patterns, Fib, S/R Flip, Trendline, Candle Close) */}
        {(opp.confirmedPattern ||
          (opp.fibConfluence && opp.fibConfluence.zoneLevel !== 'NONE') ||
          opp.srFlipDetected ||
          opp.trendlineEvent ||
          opp.candleCloseConfirmed) && (
          <div className="px-3 py-2 rounded-lg bg-surface-deepest/75 border border-line/80 text-[11px] font-mono text-fg-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            {opp.confirmedPattern && (
              <span>
                Pattern:{' '}
                <strong className="text-accent-soft">
                  {opp.confirmedPattern.label} ({opp.confirmedPattern.direction})
                </strong>
              </span>
            )}
            {opp.fibConfluence && opp.fibConfluence.zoneLevel !== 'NONE' && (
              <span>
                Fib:{' '}
                <strong className={opp.fibConfluence.inGoldenZone ? 'text-warning' : 'text-accent-cyan'}>
                  {opp.fibConfluence.zoneLevel} ({opp.fibConfluence.retracementPct}%)
                </strong>
              </span>
            )}
            {opp.srFlipDetected && (
              <span>
                S/R Flip: <strong className="text-success">Confirmed</strong>
              </span>
            )}
            {opp.trendlineEvent && (
              <span>
                Trendline: <strong className="text-accent-cyan">{opp.trendlineEvent}</strong>
              </span>
            )}
            {opp.candleCloseConfirmed !== undefined && (
              <span>
                Candle Close:{' '}
                <strong className={opp.candleCloseConfirmed ? 'text-success' : 'text-warning'}>
                  {opp.candleCloseConfirmed ? 'Closed Confirmed' : 'Pending Close'}
                </strong>
              </span>
            )}
          </div>
        )}

        {/* Momentum & Secondary Technical Confirmation */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="p-3.5 rounded-lg bg-surface-deepest/70 border border-line/80 space-y-2 text-xs">
            <div className="flex items-center justify-between font-mono">
              <span className="text-[11px] uppercase text-fg-4 font-semibold">
                Momentum Classification (15% Weight)
              </span>
              <span
                className={`font-bold ${
                  opp.momentum.classification === 'STRONG'
                    ? 'text-success'
                    : opp.momentum.classification === 'MODERATE'
                    ? 'text-accent-soft'
                    : opp.momentum.classification === 'DEVELOPING'
                    ? 'text-warning'
                    : 'text-fg-4'
                }`}
              >
                {opp.momentum.classification} ({opp.momentum.score}/100)
              </span>
            </div>
            <p className="text-fg-3 text-xs">{opp.momentum.reason}</p>
            <div className="grid grid-cols-4 gap-2 pt-1 font-mono text-[11px] tabular-nums text-fg-4">
              <div>
                Body Avg: <strong className="text-fg-1">{(opp.momentum.avgBodyRatio * 100).toFixed(0)}%</strong>
              </div>
              <div>
                Opp Wick: <strong className="text-fg-1">{(opp.momentum.opposingWickRatio * 100).toFixed(0)}%</strong>
              </div>
              <div>
                ATR Mult: <strong className="text-fg-1">{opp.momentum.displacementMultiple.toFixed(2)}x</strong>
              </div>
              <div>
                Follow: <strong className="text-fg-1">{opp.momentum.followThroughCandles}/3</strong>
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-surface-deepest/70 border border-line/80 space-y-2 text-xs">
            <div className="flex items-center justify-between font-mono">
              <span className="text-[11px] uppercase text-fg-4 font-semibold">
                Supporting Technical Indicators (10% Max)
              </span>
              <span
                className={`font-bold ${
                  opp.indicators.technicalVerdict === 'BULLISH'
                    ? 'text-success'
                    : opp.indicators.technicalVerdict === 'BEARISH'
                    ? 'text-danger'
                    : 'text-fg-4'
                }`}
              >
                {opp.indicators.technicalVerdict}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 font-mono text-[11px] tabular-nums">
              <div>
                <span className="text-fg-5 block text-[10px]">RSI(14)</span>
                <strong className="text-accent-cyan">{opp.indicators.rsi14.toFixed(1)}</strong>
              </div>
              <div>
                <span className="text-fg-5 block text-[10px]">MACD</span>
                <strong
                  className={
                    opp.indicators.macdBias === 'BULLISH'
                      ? 'text-success'
                      : opp.indicators.macdBias === 'BEARISH'
                      ? 'text-danger'
                      : 'text-fg-2'
                  }
                >
                  {opp.indicators.macdBias || 'NEUTRAL'}
                </strong>
              </div>
              <div>
                <span className="text-fg-5 block text-[10px]">ADX(14)</span>
                <strong className="text-warning">{opp.indicators.adx14.toFixed(1)}</strong>
              </div>
              <div>
                <span className="text-fg-5 block text-[10px]">EMA 20/50</span>
                <strong className="text-fg-2">{opp.indicators.emaBias}</strong>
              </div>
              <div>
                <span className="text-fg-5 block text-[10px]">BB Band</span>
                <strong className="text-fg-2">{opp.indicators.bbPosition.replace('_BAND', '')}</strong>
              </div>
              <div>
                <span className="text-fg-5 block text-[10px]">ATR(14)</span>
                <strong className="text-fg-2">{opp.indicators.atr14.toFixed(dec)}</strong>
              </div>
            </div>
            <div className="text-[11px] text-fg-4">{opp.indicators.confirmationNotes[0]}</div>
          </div>
        </div>

        {/* Exact Weighted Confluence Breakdown (20/20/20/15/15/10) */}
        <div className="space-y-2">
          <div className="flex flex-wrap justify-between items-center text-xs gap-2">
            <span className="text-fg-4 font-medium">
              Weighted Confluence Score{' '}
              <span className="text-[11px] text-fg-5">(Setup quality only, not guaranteed win probability)</span>
            </span>
            <span className="font-mono font-bold text-accent-soft tabular-nums">{opp.score.total} / 100</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-[11px] font-mono tabular-nums">
            <div className="p-2 rounded bg-surface-deepest/70 border border-line/80">
              <span className="text-fg-5 block text-[10px]">Market Structure</span>
              <strong className="text-fg-1">{opp.score.marketStructure}/20</strong>
            </div>
            <div className="p-2 rounded bg-surface-deepest/70 border border-line/80">
              <span className="text-fg-5 block text-[10px]">Range &amp; POI</span>
              <strong className="text-fg-1">{opp.score.rangeAndPoi}/20</strong>
            </div>
            <div className="p-2 rounded bg-surface-deepest/70 border border-line/80">
              <span className="text-fg-5 block text-[10px]">Price Action</span>
              <strong className="text-fg-1">{opp.score.priceActionConfirmation}/20</strong>
            </div>
            <div className="p-2 rounded bg-surface-deepest/70 border border-line/80">
              <span className="text-fg-5 block text-[10px]">Momentum/Disp</span>
              <strong className="text-fg-1">{opp.score.momentumAndDisplacement}/15</strong>
            </div>
            <div className="p-2 rounded bg-surface-deepest/70 border border-line/80">
              <span className="text-fg-5 block text-[10px]">MTF Alignment</span>
              <strong className="text-fg-1">{opp.score.multiTimeframeAlignment}/15</strong>
            </div>
            <div className="p-2 rounded bg-surface-deepest/70 border border-line/80">
              <span className="text-fg-5 block text-[10px]">Tech Indicators</span>
              <strong className="text-fg-1">{opp.score.technicalConfirmation}/10</strong>
            </div>
          </div>
        </div>

        {/* 8-Step Signal Validation Audit */}
        <div className="bg-surface-deepest/60 rounded-lg p-3 border border-line/70 text-xs space-y-2">
          {opp.rejectionReasons.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-mono uppercase font-bold text-warning block">
                Pending / Failed Gates:
              </span>
              <ul className="space-y-1 text-fg-4 font-mono text-[11px]">
                {opp.rejectionReasons.map((reason, idx) => (
                  <li key={idx}>· {reason}</li>
                ))}
              </ul>
            </div>
          )}

          <button
            onClick={() => setShowFullAudit(!showFullAudit)}
            className="flex items-center gap-1 text-[11px] text-accent-soft hover:text-accent-cyan font-medium"
          >
            <span>{showFullAudit ? 'Hide 8-Check Validation Audit' : 'Show 8-Check Validation Audit'}</span>
            {showFullAudit ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {showFullAudit && (
            <div className="mt-2 space-y-3 pt-2 border-t border-line">
              <div className="space-y-1.5">
                {opp.stepAudit.map((item) => (
                  <div
                    key={item.step}
                    className="flex flex-wrap items-start justify-between gap-2 text-[11px] font-mono py-0.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={item.passed ? 'text-success' : 'text-danger'}>
                        {item.passed ? '✓' : '✗'}
                      </span>
                      <span className="text-fg-2">
                        Check {item.step}: {item.name}
                      </span>
                    </div>
                    <span className="text-fg-4 text-[10px]">{item.detail}</span>
                  </div>
                ))}
              </div>

              {opp.strategySetups && opp.strategySetups.filter((s) => s.status !== 'INACTIVE').length > 0 && (
                <div className="pt-2 border-t border-line/80 space-y-1.5">
                  <span className="text-[10px] font-mono uppercase font-bold text-accent-cyan block">
                    Independent Strategy Evaluators (Regime-Prioritized):
                  </span>
                  {opp.strategySetups
                    .filter((s) => s.status !== 'INACTIVE')
                    .slice(0, 6)
                    .map((s) => (
                      <div
                        key={s.strategyId}
                        className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono py-0.5"
                      >
                        <span className="text-fg-2">
                          {s.category} · <strong>{s.label}</strong>
                        </span>
                        <span
                          className={
                            s.status === 'CONFIRMED' ? 'text-success font-bold' : 'text-warning'
                          }
                        >
                          {s.status} ({s.confluenceScore}%)
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between text-[11px] font-mono text-fg-5">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Evaluated {new Date(opp.detectedEpoch * 1000).toLocaleTimeString()}
          </span>
          <span>
            {opp.zones.length} S&amp;D zones · {opp.trendlines.length} trendlines · {opp.allFvgs.length} FVGs
          </span>
        </div>
      </div>
    </div>
  );
};
