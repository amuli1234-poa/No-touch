import React, { useState } from 'react';
import { OpportunitySignal } from '../types/scanner';
import {
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronUp,
  Info,
  Clock,
  Target,
  Zap
} from 'lucide-react';

interface OpportunityCardProps {
  opp: OpportunitySignal;
  onSelectMarket: (symbol: string) => void;
  isSelected: boolean;
}

export const OpportunityCard: React.FC<OpportunityCardProps> = ({
  opp,
  onSelectMarket,
  isSelected
}) => {
  const [showFullAudit, setShowFullAudit] = useState(false);

  const isBullish = opp.direction === 'BULLISH';
  const isQualified = opp.status === 'QUALIFIED';
  const isWatchlist = opp.status === 'WATCHLIST';
  const statusLabel: Record<string, string> = {
    QUALIFIED: 'QUALIFIED', WATCHLIST: 'WATCHLIST', REJECTED: 'REJECTED',
    WAITING: 'PENDING', DATA_UNAVAILABLE: 'INSUFFICIENT DATA', INVALIDATED: 'INVALIDATED', EXPIRED: 'EXPIRED'
  };

  const statusBadge = () => {
    if (isQualified) {
      return (
        <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>QUALIFIED ({opp.score.total}%)</span>
        </span>
      );
    }
    if (isWatchlist) {
      return (
        <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">
          <Zap className="w-3.5 h-3.5" />
          <span>WATCHLIST ({opp.score.total}%)</span>
        </span>
      );
    }
    if (opp.status === 'WAITING' || opp.status === 'DATA_UNAVAILABLE') {
      return <span className="inline-flex items-center space-x-1 rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-1 text-xs font-bold text-slate-300"><Info className="h-3.5 w-3.5" /><span>{statusLabel[opp.status]}</span></span>;
    }
    return (
      <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-bold bg-slate-800 text-slate-400 border border-slate-700">
        <ShieldAlert className="w-3.5 h-3.5" />
        <span>{statusLabel[opp.status] || opp.status} ({opp.score.total}%)</span>
      </span>
    );
  };

  return (
    <div
      className={`rounded-xl border transition-all duration-200 overflow-hidden ${
        isSelected
          ? 'bg-slate-900/95 border-indigo-500/60 shadow-lg shadow-indigo-500/10'
          : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700 hover:bg-slate-900/80'
      }`}
    >
      {/* Top Header */}
      <div className="p-4 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center space-x-3">
          <button
            onClick={() => onSelectMarket(opp.symbol)}
            className="text-left group cursor-pointer"
          >
            <div className="flex items-center space-x-2">
              <span className="font-bold text-white group-hover:text-indigo-400 transition text-base">
                {opp.displayName}
              </span>
              {opp.is1s ? (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-950/80 text-indigo-300 border border-indigo-700/50">
                  1-Second
                </span>
              ) : (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  Standard
                </span>
              )}
            </div>
            <div className="text-xs text-slate-400 font-mono mt-0.5">
              Spot: <span className="text-slate-200 font-semibold">{opp.currentPrice.toFixed(3)}</span> • Vol: {opp.volatilityRegime}
            </div>
          </button>
        </div>

        <div className="flex items-center space-x-2">
          <span
            className={`flex items-center space-x-1 px-2.5 py-1 rounded-md text-xs font-bold font-mono ${
              isBullish
                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                : 'bg-rose-950 text-rose-400 border border-rose-800/60'
            }`}
          >
            {isBullish ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            <span>{opp.direction} 2M/5M</span>
          </span>
          {statusBadge()}
        </div>
      </div>

      {/* Main Body */}
      <div className="p-4 space-y-4">
        {/* Real Deriv Contract Proposal Box */}
        {opp.barrierProposal ? (
          <div className="bg-slate-950/80 rounded-lg p-3 border border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Contract Type</div>
              <div className="font-bold text-indigo-300 mt-0.5">NO TOUCH ({opp.barrierProposal.direction})</div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Barrier Level</div>
              <div className="font-bold text-rose-400 mt-0.5">
                {opp.barrierProposal.barrierLevel.toFixed(3)} ({opp.barrierProposal.barrier})
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Path Survival Prob</div>
              <div className="font-bold text-emerald-400 mt-0.5">
                {(opp.barrierProposal.pathSurvivalProb * 100).toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Deriv Payout</div>
              <div className="font-bold text-cyan-400 mt-0.5">
                ${opp.barrierProposal.payout.toFixed(2)}{' '}
                <span className="text-[10px] text-slate-400 font-normal">
                  (+$({opp.barrierProposal.expectedValue.toFixed(2)}) EV)
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-slate-950/40 rounded-lg p-3 border border-slate-800/60 text-xs text-amber-400/90 flex items-center space-x-2">
            <Info className="w-4 h-4 shrink-0" />
            <span>No economically viable barrier available meeting minimum mathematical expectation.</span>
          </div>
        )}

        {/* Structural Strategy Metrics (Tradeable Range, Protected Swing, Adaptive Fill) */}
        {opp.tradeableRange && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/60">
              <span className="text-[10px] text-slate-500 block uppercase font-mono">Protected Swing</span>
              <span className="font-mono font-semibold text-amber-400">
                {opp.tradeableRange.newlyProtectedSwing.toFixed(3)}
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">Must remain unbroken</span>
            </div>

            <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/60">
              <span className="text-[10px] text-slate-500 block uppercase font-mono">Adaptive Retracement Target</span>
              <span className="font-mono font-semibold text-cyan-400">
                {opp.tradeableRange.adaptiveFillTarget.toFixed(3)}
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">
                {opp.tradeableRange.fillDepthType}
              </span>
            </div>

            <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/60">
              <span className="text-[10px] text-slate-500 block uppercase font-mono">Displacement High/Low</span>
              <span className="font-mono font-semibold text-slate-200">
                {opp.tradeableRange.displacementBreakLevel.toFixed(3)}
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">Range: {opp.tradeableRange.rangeDistance.toFixed(2)}</span>
            </div>
          </div>
        )}

        {/* Technical Score Component Breakdown (Weighted Model) */}
        <div className="space-y-1.5">
          <div className="flex justify-between items-center text-xs">
            <span className="text-slate-400 font-medium">Technical Scoring Engine</span>
            <span className="font-mono font-bold text-indigo-400">{opp.score.total} / 100</span>
          </div>
          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden flex">
            <div
              className="bg-indigo-500 h-full"
              style={{ width: `${opp.score.structureAlignment}%` }}
              title="Structure Alignment (Max 20%)"
            />
            <div
              className="bg-amber-500 h-full"
              style={{ width: `${opp.score.liquidityAndProtectedSwing}%` }}
              title="Liquidity & Protected Swing (Max 15%)"
            />
            <div
              className="bg-emerald-500 h-full"
              style={{ width: `${opp.score.candlestickConfirmation}%` }}
              title="Candlestick Confirmation (Max 10%)"
            />
            <div
              className="bg-purple-500 h-full"
              style={{ width: `${opp.score.confirmedMarketShift}%` }}
              title="Confirmed Shift (Max 15%)"
            />
            <div
              className="bg-cyan-500 h-full"
              style={{ width: `${opp.score.fvgAndDisplacement}%` }}
              title="FVG & Displacement (Max 15%)"
            />
            <div
              className="bg-blue-500 h-full"
              style={{ width: `${opp.score.tradeableRangeAndRetracement}%` }}
              title="Tradeable Range (Max 15%)"
            />
            <div
              className="bg-rose-500 h-full"
              style={{ width: `${opp.score.barrierSurvival}%` }}
              title="Barrier Survival (Max 10%)"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px] text-slate-400 font-mono pt-1">
            <div>Align: <span className="text-white">{opp.score.structureAlignment}/20</span></div>
            <div>Sweep: <span className="text-white">{opp.score.liquidityAndProtectedSwing}/15</span></div>
            <div>Candle: <span className="text-white">{opp.score.candlestickConfirmation}/10</span></div>
            <div>Shift: <span className="text-white">{opp.score.confirmedMarketShift}/15</span></div>
            <div>FVG: <span className="text-white">{opp.score.fvgAndDisplacement}/15</span></div>
            <div>Range: <span className="text-white">{opp.score.tradeableRangeAndRetracement}/15</span></div>
            <div>Survival: <span className="text-white">{opp.score.barrierSurvival}/10</span></div>
          </div>
        </div>

        {/* Explanation & Audit Accordion */}
        <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/70 text-xs space-y-2">
          <div className="text-slate-300 leading-relaxed font-sans">
            {opp.explanation}
          </div>

          {opp.rejectionReasons.length > 0 && (
            <div className="pt-2 border-t border-slate-800/80 space-y-1">
              <span className="text-[10px] font-mono uppercase font-bold text-rose-400 block">
                Disqualification Rejection Reasons:
              </span>
              <ul className="space-y-1 text-slate-400 font-mono text-[11px]">
                {opp.rejectionReasons.map((reason, idx) => (
                  <li key={idx} className="flex items-start space-x-1.5">
                    <span className="text-rose-500">✕</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 7-Step Sequence Full Audit Toggle */}
          <div className="pt-1">
            <button
              onClick={() => setShowFullAudit(!showFullAudit)}
              className="flex items-center space-x-1 text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
            >
              <span>{showFullAudit ? 'Hide 7-Step Sequence Audit' : 'Show 7-Step Sequence Audit'}</span>
              {showFullAudit ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {showFullAudit && (
              <div className="mt-2 space-y-1.5 pt-2 border-t border-slate-800">
                {opp.stepAudit.map((item) => (
                  <div
                    key={item.step}
                    className="flex items-start justify-between text-[11px] font-mono py-0.5"
                  >
                    <div className="flex items-center space-x-1.5">
                      <span className={item.passed ? 'text-emerald-400' : 'text-rose-400'}>
                        {item.passed ? '✓' : '✗'}
                      </span>
                      <span className="text-slate-300">
                        Step {item.step}: {item.name}
                      </span>
                    </div>
                    <span className="text-slate-500 text-[10px]">{item.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Action Bar */}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center space-x-1 text-slate-500 text-[10px] font-mono">
            <Clock className="w-3 h-3" />
            <span>Updated {new Date(opp.detectedEpoch * 1000).toLocaleTimeString()}</span>
          </div>

          <button
            onClick={() => onSelectMarket(opp.symbol)}
            className="flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 text-xs font-semibold border border-indigo-500/30 transition"
          >
            <Target className="w-3.5 h-3.5" />
            <span>Inspect On Chart</span>
          </button>
        </div>
      </div>
    </div>
  );
};
