import type { AlertObservation } from './alertEngine';
import type { StrategyRecommendation } from './strategyOptimizer';
import {
  ANOMALY_SEVERITY_ORDER,
  type AnomalyReport,
  type AnomalySeverity,
} from './marketAnomaly';
import type { AiInstrumentAnalysis, AiSignal } from '../types/aiModule';
import type { DsInstrumentAnalysis } from '../types/demandSupply';
import type { TrendlineInstrumentAnalysis } from '../types/trendline';

/**
 * Adapters that translate each independent module's OWN published output into an
 * observation the alert manager can collect. The adapters never analyse the market and
 * never invent a setup — an observation exists only when a module published one.
 */

function fromAiSignal(module: string, moduleId: string, signal: AiSignal): AlertObservation {
  const actionable = signal.lifecycle === 'CONFIRMED' || signal.lifecycle === 'ACTIVE';
  return {
    symbol: signal.symbol,
    displayName: signal.displayName,
    module,
    moduleId,
    modelId: signal.modelId,
    modelLabel: signal.modelLabel,
    direction: signal.direction,
    price: signal.entryPrice,
    timeframe: 'M15',
    status: actionable ? 'CONFIRMED' : 'DEVELOPING',
    quality: signal.score,
    entryPrice: signal.entryPrice,
    entryZoneLow: signal.entryZoneLow,
    entryZoneHigh: signal.entryZoneHigh,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit1,
    takeProfit2: signal.takeProfit2,
    takeProfit3: signal.takeProfit3,
    riskRewardRatio: signal.riskRewardRatio,
    explanation: signal.confirmations[0] ?? signal.invalidationCondition,
    evidence: [...signal.reasons, ...signal.confirmations].slice(0, 6),
  };
}

/** Every published signal from every AI module (one observation per published signal). */
export function observationsFromAiModules(
  scanners: Record<string, { analyses: readonly AiInstrumentAnalysis[] }>,
  labels: Record<string, string>
): AlertObservation[] {
  const out: AlertObservation[] = [];
  for (const [id, scanner] of Object.entries(scanners)) {
    const label = labels[id] ?? id;
    for (const analysis of scanner.analyses) {
      if (analysis.signal) out.push(fromAiSignal(label, id, analysis.signal));
    }
  }
  return out;
}

/** Trendline AI — its own signal shape, adapted without interpretation. */
export function observationsFromTrendline(
  module: string,
  analyses: readonly TrendlineInstrumentAnalysis[]
): AlertObservation[] {
  const out: AlertObservation[] = [];
  for (const a of analyses) {
    const s = a.signal;
    if (!s) continue;
    out.push({
      symbol: s.symbol,
      displayName: s.displayName,
      module,
      moduleId: 'trendlines',
      modelId: s.model,
      modelLabel: s.modelLabel,
      direction: s.direction,
      price: s.entryPrice,
      timeframe: s.structureTimeframe,
      status: 'CONFIRMED',
      quality: s.score,
      entryPrice: s.entryPrice,
      entryZoneLow: s.entryPrice,
      entryZoneHigh: s.entryPrice,
      stopLoss: s.stopLoss,
      takeProfit1: s.takeProfit,
      takeProfit2: null,
      takeProfit3: null,
      riskRewardRatio: s.riskRewardRatio,
      explanation: s.confirmations[0] ?? s.invalidationCondition,
      evidence: [...s.reasons, ...s.confirmations].slice(0, 6),
    });
  }
  return out;
}

/** Demand & Supply AI — its own signal shape, adapted without interpretation. */
export function observationsFromDemandSupply(
  module: string,
  analyses: readonly DsInstrumentAnalysis[]
): AlertObservation[] {
  const out: AlertObservation[] = [];
  for (const a of analyses) {
    const s = a.signal;
    if (!s) continue;
    out.push({
      symbol: s.symbol,
      displayName: s.displayName,
      module,
      moduleId: 'demandsupply',
      modelId: s.model,
      modelLabel: s.modelLabel,
      direction: s.direction,
      price: s.entryPrice,
      timeframe: s.structureTimeframe,
      status: 'CONFIRMED',
      quality: s.score,
      entryPrice: s.entryPrice,
      entryZoneLow: s.entryZoneLow,
      entryZoneHigh: s.entryZoneHigh,
      stopLoss: s.stopLoss,
      takeProfit1: s.takeProfit1,
      takeProfit2: s.takeProfit2,
      takeProfit3: s.takeProfit3,
      riskRewardRatio: s.riskRewardRatio,
      explanation: s.confirmations[0] ?? s.invalidationCondition,
      evidence: [...s.reasons, ...s.confirmations].slice(0, 6),
    });
  }
  return out;
}

/**
 * MARKET INTELLIGENCE & ANOMALY DETECTION → alerts. High-severity anomalies and confirmed
 * regime changes are surfaced through the same notification manager (no duplicate channel).
 */
export function observationsFromAnomalies(
  reports: readonly AnomalyReport[],
  sensitivity: 'LOW' | 'MEDIUM' | 'HIGH'
): AlertObservation[] {
  const threshold: AnomalySeverity =
    sensitivity === 'HIGH' ? 'LOW' : sensitivity === 'MEDIUM' ? 'MODERATE' : 'HIGH';
  const minRank = ANOMALY_SEVERITY_ORDER.indexOf(threshold);
  const out: AlertObservation[] = [];
  for (const report of reports) {
    for (const finding of report.findings) {
      if (ANOMALY_SEVERITY_ORDER.indexOf(finding.severity) < minRank) continue;
      const isData = finding.class === 'DATA';
      out.push({
        symbol: report.symbol,
        displayName: report.displayName,
        module: 'Market Intelligence & Anomaly Detection AI',
        moduleId: 'strategylab',
        modelId: `ANOMALY_${finding.kind}`,
        modelLabel: finding.kind.replace(/_/g, ' '),
        direction: null,
        price: report.price,
        timeframe: report.timeframe,
        status: isData ? 'INVALIDATED' : 'DEVELOPING',
        quality: isData
          ? 100
          : Math.min(100, 50 + ANOMALY_SEVERITY_ORDER.indexOf(finding.severity) * 12),
        entryPrice: null,
        entryZoneLow: null,
        entryZoneHigh: null,
        stopLoss: null,
        takeProfit1: null,
        takeProfit2: null,
        takeProfit3: null,
        riskRewardRatio: null,
        explanation: `${finding.evidence} ${finding.action}`,
        evidence: [finding.evidence, `Impact: ${finding.impact}`, `Action: ${finding.action}`],
        category: isData ? 'DATA_ISSUE' : 'REGIME_CHANGE',
        priority: isData ? 'CRITICAL' : finding.severity === 'HIGH' ? 'HIGH' : 'MEDIUM',
        source: 'SYSTEM',
      });
    }
  }
  return out;
}

/** Regime transitions observed while monitoring → one alert per confirmed change. */
export function observationsFromRegimeChanges(
  changes: readonly {
    symbol: string;
    displayName: string;
    from: string;
    to: string;
    at: number;
  }[]
): AlertObservation[] {
  return changes.map((c) => ({
    symbol: c.symbol,
    displayName: c.displayName,
    module: 'Market Intelligence & Anomaly Detection AI',
    moduleId: 'strategylab',
    modelId: `REGIME_${c.from}_TO_${c.to}`,
    modelLabel: 'Regime change',
    direction: null,
    price: 0,
    timeframe: 'M5' as const,
    status: 'DEVELOPING' as const,
    quality: 60,
    entryPrice: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    takeProfit3: null,
    riskRewardRatio: null,
    explanation: `Market regime changed from ${c.from.replace(/_/g, ' ').toLowerCase()} to ${c.to.replace(/_/g, ' ').toLowerCase()}.`,
    evidence: [`Previous: ${c.from}`, `Current: ${c.to}`],
    category: 'REGIME_CHANGE' as const,
    priority: 'MEDIUM' as const,
    source: 'SYSTEM' as const,
  }));
}

/** Strategy deterioration / improvement surfaced by the Strategy Lab → alerts. */
export function observationsFromRecommendations(
  recommendations: readonly StrategyRecommendation[]
): AlertObservation[] {
  const out: AlertObservation[] = [];
  for (const r of recommendations) {
    if (r.severity === 'INFO' && r.id === 'insufficient-evidence') continue;
    const deterioration = r.severity === 'ACTION';
    out.push({
      symbol: 'STRATEGY_LAB',
      displayName: r.title,
      module: 'Strategy Optimization & Backtesting AI',
      moduleId: 'strategylab',
      modelId: `REC_${r.id}`,
      modelLabel: 'Strategy review',
      direction: null,
      price: 0,
      timeframe: 'M5' as const,
      status: deterioration ? 'INVALIDATED' : 'DEVELOPING',
      quality: deterioration ? 85 : 70,
      entryPrice: null,
      entryZoneLow: null,
      entryZoneHigh: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      riskRewardRatio: null,
      explanation: r.detail,
      evidence: [r.detail, 'Requires user approval before any change is applied.'],
      category: deterioration ? 'QUALITY_LOST' : 'SETUP_DEVELOPING',
      priority: deterioration ? 'HIGH' : 'LOW',
      source: 'SYSTEM',
    });
  }
  return out;
}

/** SYSTEM HEALTH — a validated live integration test result → a single system alert. */
export function observationsFromHealthTest(result: {
  status: 'PASS' | 'FAIL' | 'NOT_TESTED';
  probes: readonly { symbol: string; displayName: string; ticksReceived: number; candlesReceived: number }[];
  notes: readonly string[];
}): AlertObservation[] {
  if (result.status === 'NOT_TESTED') return [];
  const liveMarkets = result.probes.filter((p) => p.ticksReceived > 0).length;
  const failed = result.status === 'FAIL';
  return [
    {
      symbol: 'SYSTEM_HEALTH',
      displayName: 'Deriv live integration',
      module: 'System Health & Diagnostics',
      moduleId: 'health',
      modelId: 'HEALTH_LIVE_TEST',
      modelLabel: 'Live integration test',
      direction: null,
      price: 0,
      timeframe: 'M5' as const,
      status: failed ? 'INVALIDATED' : 'CONFIRMED',
      quality: failed ? 90 : 80,
      entryPrice: null,
      entryZoneLow: null,
      entryZoneHigh: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      riskRewardRatio: null,
      explanation: failed
        ? `Live integration test FAILED — ${liveMarkets}/${result.probes.length} probed markets received real data.`
        : `Live integration test PASSED — ${liveMarkets}/${result.probes.length} probed Volatility Indices received real ticks and candles.`,
      evidence: [...result.notes, `Probed: ${result.probes.map((p) => p.displayName).join(', ')}`].filter(
        Boolean
      ),
      category: failed ? 'DATA_ISSUE' : 'EXECUTION_READY',
      priority: failed ? 'HIGH' : 'LOW',
      source: 'SYSTEM' as const,
    },
  ];
}
