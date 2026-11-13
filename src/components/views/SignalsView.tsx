import React, { useState } from 'react';
import {
  OpportunitySignal,
  WhatsAppProviderStatus,
  WhatsAppSignalRecord
} from '../../types/scanner';
import { WhatsAppService } from '../../services/WhatsAppService';
import { Send, CheckCircle2, AlertTriangle, RefreshCw, MessageSquare } from 'lucide-react';

interface SignalsViewProps {
  opportunities: OpportunitySignal[];
  waStatus: WhatsAppProviderStatus;
  waLogs: WhatsAppSignalRecord[];
  waService: WhatsAppService;
  onRefreshStatus: () => void;
  onManualDispatch: (opp: OpportunitySignal) => Promise<void>;
  onOpenChart: (symbol: string) => void;
}

export const SignalsView: React.FC<SignalsViewProps> = ({
  opportunities,
  waStatus,
  waLogs,
  waService,
  onRefreshStatus,
  onManualDispatch,
  onOpenChart
}) => {
  const [sendingSymbol, setSendingSymbol] = useState<string | null>(null);
  const [previewSymbol, setPreviewSymbol] = useState<string | null>(null);

  const confirmedSignals = opportunities
    .filter((o) => o.setupTier === 'HIGH_QUALITY' && o.entryAndTp.confirmed && o.score.total >= 75)
    .sort((a, b) => b.score.total - a.score.total);

  const developingSignals = opportunities
    .filter((o) => o.setupTier === 'DEVELOPING')
    .sort((a, b) => b.score.total - a.score.total);

  const previewTarget =
    confirmedSignals.find((s) => s.symbol === previewSymbol) ||
    confirmedSignals[0] ||
    developingSignals[0];

  const handleDispatch = async (opp: OpportunitySignal) => {
    setSendingSymbol(opp.symbol);
    try {
      await onManualDispatch(opp);
    } finally {
      setSendingSymbol(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* WhatsApp Provider Status Strip */}
      <div className="rounded-xl border border-line/90 bg-surface p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          {waStatus.configured ? (
            <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          )}
          <div>
            <div className="text-sm font-bold text-fg-1 flex items-center gap-2">
              <span>WhatsApp Signal Distribution</span>
              <span className="text-xs font-mono text-fg-4">
                {waStatus.configured
                  ? `Connected (${waStatus.provider?.toUpperCase()} · ${waStatus.recipientMasked})`
                  : 'Provider Not Configured'}
              </span>
            </div>
            <p className="text-xs text-fg-4 mt-0.5">
              {waStatus.configured
                ? 'Confirmed signals (≥75% confluence + mandatory momentum) dispatch automatically without duplicates.'
                : `Configure server environment variables to enable live WhatsApp delivery. Missing: ${waStatus.missingFields.join(', ')}`}
            </p>
          </div>
        </div>

        <button
          onClick={onRefreshStatus}
          className="px-3 py-2 rounded-lg bg-surface-raised hover:bg-surface-elevated text-xs font-mono text-fg-2 flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Provider Status</span>
        </button>
      </div>

      {/* Confirmed Signals Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-fg-3 font-mono">
              Confirmed Signals Ready (≥75% Confluence · {confirmedSignals.length})
            </h3>
            <span className="text-[11px] font-mono text-fg-5">
              Only validated setups appear here
            </span>
          </div>

          {confirmedSignals.length === 0 ? (
            <div className="rounded-xl border border-line/80 bg-surface p-8 text-center space-y-2">
              <div className="text-sm font-bold text-warning font-mono">
                WAITING FOR SETUP — NO CONFIRMED SIGNALS
              </div>
              <p className="text-xs text-fg-4 max-w-md mx-auto">
                The strict confirmation gate requires HTF alignment, a valid POI, structural confirmation, decisive momentum, and ≥75% confluence. Incomplete setups are withheld.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {confirmedSignals.map((opp) => {
                const dec = opp.pipSize < 0.01 ? 3 : 2;
                return (
                  <div
                    key={opp.id}
                    className="rounded-xl border border-success/35 bg-surface p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-bold text-fg-1">
                          {opp.displayName}{' '}
                          <span className="text-xs font-mono text-fg-4">
                            · {opp.is1s ? '1s Vol' : 'Plain Vol'} · {opp.selectedStrategy.label}
                          </span>
                        </div>
                        <div className="text-xs font-mono text-fg-4 mt-0.5 tabular-nums">
                          Direction:{' '}
                          <strong className={opp.direction === 'BULLISH' ? 'text-success' : 'text-danger'}>
                            {opp.riseFallLabel}
                          </strong>
                          {' · '}Confluence: <strong className="text-success">{opp.score.total}%</strong>
                          {' · '}Condition: {opp.marketCondition}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setPreviewSymbol(opp.symbol)}
                          className="px-2.5 py-1.5 rounded-lg bg-surface-raised hover:bg-surface-elevated text-xs text-fg-2"
                        >
                          Preview
                        </button>
                        <button
                          onClick={() => onOpenChart(opp.symbol)}
                          className="px-2.5 py-1.5 rounded-lg bg-surface-raised hover:bg-surface-elevated text-xs text-accent-cyan"
                        >
                          Chart
                        </button>
                        <button
                          onClick={() => handleDispatch(opp)}
                          disabled={sendingSymbol === opp.symbol}
                          className="px-3 py-1.5 rounded-lg bg-success hover:bg-success disabled:opacity-50 text-xs font-semibold text-fg-1 flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>{sendingSymbol === opp.symbol ? 'Sending...' : 'Send WhatsApp'}</span>
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3 pt-2 border-t border-line/80 text-xs font-mono tabular-nums">
                      <div>
                        <span className="text-[10px] text-fg-5 block">ENTRY PRICE</span>
                        <strong className="text-accent-cyan">{opp.entryAndTp.entryPrice?.toFixed(dec)}</strong>
                      </div>
                      <div>
                        <span className="text-[10px] text-fg-5 block">STOP LOSS</span>
                        <strong className="text-danger">{opp.entryAndTp.invalidationLevel?.toFixed(dec)}</strong>
                      </div>
                      <div>
                        <span className="text-[10px] text-fg-5 block">TAKE PROFIT</span>
                        <strong className="text-success">{opp.entryAndTp.takeProfit?.toFixed(dec)}</strong>
                      </div>
                    </div>
                    <p className="text-xs text-fg-3">{opp.explanation}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* WhatsApp Message Format Preview */}
        <div className="lg:col-span-5 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-3 font-mono flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5 text-accent-soft" />
            <span>WhatsApp Dispatch Payload Preview</span>
          </h3>
          <div className="rounded-xl border border-line/90 bg-surface-deepest p-4 font-mono text-[11px] text-fg-3 whitespace-pre-wrap leading-relaxed min-h-[260px]">
            {previewTarget
              ? waService.formatSignalMessage(previewTarget, 'NEW_SIGNAL')
              : 'No active or developing candidate available to preview.'}
          </div>
        </div>
      </div>

      {/* WhatsApp Dispatch Audit Log */}
      <div className="rounded-xl border border-line/90 bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-line/80 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-3 font-mono">
            WhatsApp Delivery Log ({waLogs.length})
          </h3>
          <span className="text-[11px] font-mono text-fg-5">
            Real server API responses only
          </span>
        </div>

        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
            <thead className="bg-surface-deepest text-[10px] uppercase text-fg-4 border-b border-line">
              <tr>
                <th className="p-3">Time</th>
                <th className="p-3">Instrument</th>
                <th className="p-3">Event</th>
                <th className="p-3">Confluence</th>
                <th className="p-3">Delivery Status</th>
                <th className="p-3">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {waLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-fg-5 font-sans">
                    No WhatsApp dispatch attempts recorded yet.
                  </td>
                </tr>
              ) : (
                waLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-surface-deep/50">
                    <td className="p-3 text-fg-4">
                      {new Date(log.timestampEpoch * 1000).toLocaleTimeString()}
                    </td>
                    <td className="p-3 text-fg-1 font-sans font-medium">{log.displayName}</td>
                    <td className="p-3 text-accent-cyan">{log.eventType}</td>
                    <td className="p-3">{log.confluenceScore}%</td>
                    <td className="p-3">
                      <span className={log.sent ? 'text-success font-bold' : 'text-danger font-bold'}>
                        {log.sent ? `SENT (${log.provider || 'api'})` : 'FAILED'}
                      </span>
                    </td>
                    <td className="p-3 text-fg-4 text-[11px] font-sans">
                      {log.sent ? `ID: ${log.messageId || 'delivered'}` : log.error}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
