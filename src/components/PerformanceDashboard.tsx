import React, { useEffect, useState } from 'react';
import { IndexedDbStorage, PerformanceAnalytics } from '../services/IndexedDbStorage';
import { PerformanceRecord } from '../types/scanner';
import {
  ShieldCheck,
  Percent,
  TrendingUp,
  Award,
  Trash2,
  RefreshCw,
  Clock,
  Activity,
  Layers
} from 'lucide-react';

interface PerformanceDashboardProps {
  storage: IndexedDbStorage;
}

export const PerformanceDashboard: React.FC<PerformanceDashboardProps> = ({ storage }) => {
  const [analytics, setAnalytics] = useState<PerformanceAnalytics | null>(null);
  const [records, setRecords] = useState<PerformanceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const data = await storage.computeAnalytics();
      const rawRecords = await storage.getAllPerformanceRecords();
      setAnalytics(data);
      setRecords(rawRecords.reverse());
    } catch (e) {
      console.error('Failed to load performance analytics:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [storage]);

  const handleClearHistory = async () => {
    if (window.confirm('Are you sure you want to clear all historical tracking records?')) {
      await storage.clearAll();
      loadData();
    }
  };

  if (isLoading || !analytics) {
    return (
      <div className="p-8 text-center text-slate-400 font-mono text-sm">
        <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-indigo-400" />
        Loading performance records & calibration engine...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Controls & Explanation */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-slate-900/60 border border-slate-800">
        <div>
          <h2 className="text-base font-bold text-white flex items-center space-x-2">
            <Award className="w-4 h-4 text-indigo-400" />
            <span>Historical Out-Of-Sample Performance & Probability Calibration</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Recorded strictly from live path-dependent tick excursions and actual Deriv contract expirations.
            Prevents look-ahead bias and verifies touch-risk calibration against realized market behavior.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={loadData}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleClearHistory}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-rose-950/60 hover:bg-rose-900 text-rose-300 text-xs font-semibold border border-rose-800/50 transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Reset History</span>
          </button>
        </div>
      </div>

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 shadow-sm">
          <div className="text-[11px] text-slate-400 uppercase font-mono font-medium">
            Total Logged Opportunities
          </div>
          <div className="text-2xl font-bold font-mono text-white mt-1">
            {analytics.totalLogged}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            {analytics.totalSettled} Expired & Settled
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 shadow-sm">
          <div className="text-[11px] text-emerald-400 uppercase font-mono font-medium">
            Barrier Survival Rate
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">
            {analytics.barrierSurvivalRate.toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Unbroken during lifetime
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 shadow-sm">
          <div className="text-[11px] text-cyan-400 uppercase font-mono font-medium">
            Contract Win Rate
          </div>
          <div className="text-2xl font-bold font-mono text-cyan-400 mt-1">
            {analytics.contractWinRate.toFixed(1)}%
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Actual settlement outcome
          </div>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 shadow-sm">
          <div className="text-[11px] text-indigo-400 uppercase font-mono font-medium">
            Simulated Net Profit ($10)
          </div>
          <div
            className={`text-2xl font-bold font-mono mt-1 ${
              analytics.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {analytics.netProfit >= 0 ? `+$${analytics.netProfit.toFixed(2)}` : `-$${Math.abs(analytics.netProfit).toFixed(2)}`}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Based on Deriv ask vs payout
          </div>
        </div>
      </div>

      {/* Probability Calibration Curve & Market Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Calibration Comparison */}
        <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">
              Model Probability Calibration (Predicted vs Observed)
            </h3>
            <span className="text-[10px] text-slate-500 font-mono">First-Passage Model</span>
          </div>

          <div className="space-y-3 font-mono text-xs">
            {analytics.calibrationCurve.length > 0 ? (
              analytics.calibrationCurve.map((bin, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-300">Predicted Survival: {bin.bucket}</span>
                    <span className="text-emerald-400 font-bold">
                      Observed: {bin.actualSurvivalRate.toFixed(1)}% ({bin.count} contracts)
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden flex">
                    <div
                      className="bg-cyan-500 h-full"
                      style={{ width: `${bin.actualSurvivalRate}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="text-slate-500 text-xs py-4 text-center">
                Calibration requires settled contract events. As live opportunities run to expiry, calibration metrics will populate automatically.
              </div>
            )}
          </div>
        </div>

        {/* Results by Market Type (Standard vs 1-Second) */}
        <div className="p-5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">
            Standard vs. 1-Second Markets
          </h3>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-slate-950/70 rounded-lg border border-slate-800">
              <div className="text-[10px] text-slate-400 font-mono uppercase">Standard Volatility Indices</div>
              <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                {analytics.resultsByMarketType.standardWinRate.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">Win Rate</div>
            </div>

            <div className="p-3 bg-slate-950/70 rounded-lg border border-slate-800">
              <div className="text-[10px] text-slate-400 font-mono uppercase">1-Second High-Tick Markets</div>
              <div className="text-xl font-bold font-mono text-cyan-400 mt-1">
                {analytics.resultsByMarketType.oneSecWinRate.toFixed(1)}%
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">Win Rate</div>
            </div>
          </div>

          {/* Results by Expiry Duration */}
          <div className="pt-2">
            <div className="text-[10px] font-mono uppercase font-bold text-slate-400 mb-2">
              Performance by Expiry Duration
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs font-mono">
              {analytics.resultsByExpiry.map((exp) => (
                <div key={exp.durationMinutes} className="p-2 bg-slate-950/50 rounded border border-slate-800/80">
                  <div className="text-slate-400 text-[10px]">{exp.durationMinutes}m Horizon</div>
                  <div className="text-white font-bold mt-0.5">{exp.winRate.toFixed(1)}% Win</div>
                  <div className="text-[9px] text-slate-500">{exp.total} contracts</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Historical Record Log Table */}
      <div className="rounded-xl border border-slate-800/80 bg-slate-900/60 overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800/80 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">
            Audited Contract Log ({records.length} Entries)
          </h3>
        </div>

        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="w-full text-left text-xs font-mono border-collapse">
            <thead className="bg-slate-950/80 text-[10px] uppercase text-slate-400 sticky top-0 border-b border-slate-800">
              <tr>
                <th className="p-3">Time</th>
                <th className="p-3">Market</th>
                <th className="p-3">Direction</th>
                <th className="p-3">Score</th>
                <th className="p-3">Barrier Level</th>
                <th className="p-3">Predicted Touch</th>
                <th className="p-3">Outcome</th>
                <th className="p-3 text-right">Profit / Loss</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50 text-slate-300">
              {records.length > 0 ? (
                records.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/30">
                    <td className="p-3 text-[11px] text-slate-400">
                      {new Date(r.detectedEpoch * 1000).toLocaleTimeString()}
                    </td>
                    <td className="p-3 font-sans font-medium text-white flex items-center space-x-1.5">
                      <span>{r.displayName}</span>
                      {r.is1s && (
                        <span className="text-[9px] px-1 py-0.2 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                          1s
                        </span>
                      )}
                    </td>
                    <td className="p-3">
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          r.direction === 'BULLISH'
                            ? 'bg-emerald-950 text-emerald-400'
                            : 'bg-rose-950 text-rose-400'
                        }`}
                      >
                        {r.direction}
                      </span>
                    </td>
                    <td className="p-3 font-bold">{r.technicalScore}%</td>
                    <td className="p-3 text-slate-200">{r.barrierLevel.toFixed(3)}</td>
                    <td className="p-3 text-slate-400">
                      {(r.predictedTouchProb * 100).toFixed(1)}%
                    </td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          r.contractSettledWon
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : 'bg-rose-950 text-rose-400 border border-rose-800'
                        }`}
                      >
                        {r.contractSettledWon ? 'WON (SURVIVED)' : 'TOUCHED (LOST)'}
                      </span>
                    </td>
                    <td
                      className={`p-3 text-right font-bold ${
                        r.profit >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {r.profit >= 0 ? `+$${r.profit.toFixed(2)}` : `-$${Math.abs(r.profit).toFixed(2)}`}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-500 font-sans">
                    No completed contracts recorded yet. When high-scoring opportunities trigger, they will be logged here and monitored until expiration.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
