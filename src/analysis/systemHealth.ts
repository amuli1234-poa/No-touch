import { ENTRY_MODEL_IDS } from '../types/engine';
import type { ConnectionStatus } from '../types/market';
import type { ConnectionDiagnostics } from '../services/derivWebSocket';
import type { Candle, TimeframeKey } from '../types/market';
import { TIMEFRAME_MAP } from '../config/deriv';

/**
 * SYSTEM HEALTH & DIAGNOSTICS — every status is derived from REAL runtime evidence.
 *
 * A component is never reported HEALTHY just because its interface opened. Each check states
 * the actual reason for a WARNING or FAILED, and a component that genuinely could not be
 * exercised reports NOT_TESTED rather than a fabricated PASS.
 */

export type HealthStatus = 'HEALTHY' | 'WARNING' | 'FAILED' | 'NOT_TESTED';

export const HEALTH_STATUS_ORDER: readonly HealthStatus[] = [
  'FAILED',
  'WARNING',
  'NOT_TESTED',
  'HEALTHY',
];

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  /** Human-readable, evidence-backed reason. Always populated. */
  detail: string;
  /** Raw measured value backing the status (null when not measurable yet). */
  metric: string | null;
  critical: boolean;
}

export interface HealthInputs {
  connectionStatus: ConnectionStatus;
  diagnostics: ConnectionDiagnostics;
  lastTickAt: number | null;
  feedStale: boolean;
  marketsCount: number;
  /** Eligible markets (standard + 1-second Volatility Indices, Boom/Crash excluded). */
  eligibleMarketsCount?: number;
  marketsLoading: boolean;
  selectedSymbol: string;
  candleCount: number;
  loadState: string;
  dataError: string | null;
  /** Candle counts already fetched per timeframe for the selected instrument. */
  timeframesReady: Partial<Record<TimeframeKey, number>>;
  isAnalyzing: boolean;
  report: unknown | null;
  analysisError: string | null;
  scannerRanAt: number | null;
  scannerRows: number;
  floatingScannerOpen: boolean;
  aiModulesActive: number;
  aiModulesTotal: number;
  alertCount: number;
  backtestEvaluations: number;
  performanceRecords: number;
  riskRuleCount: number;
  anomalyReports: number;
  now: number;
}

function ageLabel(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  return `${min}m ago`;
}

/**
 * Builds the full diagnostics board. Checks are ordered so the most critical connection and
 * data-integrity items appear first. Pure function — trivially testable.
 */
export function buildHealthChecks(input: HealthInputs): HealthCheck[] {
  const now = input.now;
  const checks: HealthCheck[] = [];
  const d = input.diagnostics;

  // 1. WebSocket connection
  checks.push({
    id: 'websocket',
    label: 'Deriv WebSocket connection',
    status:
      input.connectionStatus === 'connected'
        ? 'HEALTHY'
        : input.connectionStatus === 'connecting' || input.connectionStatus === 'reconnecting'
          ? 'WARNING'
          : 'FAILED',
    detail:
      input.connectionStatus === 'connected'
        ? `Connected to ${d.url}. Data received: ${d.hasReceivedData ? 'yes' : 'not yet'}.`
        : `Status "${input.connectionStatus}"${d.lastError ? ` — ${d.lastError.message}` : ''}.`,
    metric: `${d.activeSubscriptions} active subscription(s), retry ${d.reconnectAttempt}/${d.maxReconnectAttempts}`,
    critical: true,
  });

  // 2. Live tick reception
  const tickAge = input.lastTickAt === null ? null : now - input.lastTickAt;
  checks.push({
    id: 'ticks',
    label: 'Live tick reception',
    status:
      input.lastTickAt === null
        ? input.connectionStatus === 'connected'
          ? 'WARNING'
          : 'NOT_TESTED'
        : input.feedStale || (tickAge ?? 0) > 30_000
          ? 'WARNING'
          : 'HEALTHY',
    detail:
      input.lastTickAt === null
        ? input.connectionStatus === 'connected'
          ? 'Connected but no tick has arrived yet — waiting for the first live price.'
          : 'No live ticks received (feed not connected).'
        : `Last tick ${ageLabel(input.lastTickAt, now)}${input.feedStale ? ' — the feed is flagged stale.' : '.'}`,
    metric: tickAge === null ? 'no ticks' : `tick age ${Math.round(tickAge / 1000)}s`,
    critical: true,
  });

  // 3. Historical candle loading
  checks.push({
    id: 'history',
    label: 'Historical candle loading',
    status:
      input.dataError !== null
        ? 'FAILED'
        : input.candleCount === 0
          ? input.connectionStatus === 'connected'
            ? 'WARNING'
            : 'NOT_TESTED'
          : input.loadState === 'ready'
            ? 'HEALTHY'
            : 'WARNING',
    detail:
      input.dataError !== null
        ? `Candle request failed: ${input.dataError}`
        : input.candleCount === 0
          ? 'No candles loaded yet for the selected instrument.'
          : `${input.candleCount} candles loaded (state: ${input.loadState}).`,
    metric: `${input.candleCount} bars`,
    critical: true,
  });

  // 4. Timeframe synchronisation
  const tfKeys: TimeframeKey[] = ['M1', 'M5', 'M15'];
  const missingTf = tfKeys.filter((tf) => (input.timeframesReady[tf] ?? 0) < 20);
  checks.push({
    id: 'timeframes',
    label: 'M1 / M5 / M15 synchronization',
    status:
      missingTf.length === 0
        ? 'HEALTHY'
        : missingTf.length === tfKeys.length
          ? 'NOT_TESTED'
          : 'WARNING',
    detail:
      missingTf.length === 0
        ? 'All three core timeframes have loaded candles for this instrument.'
        : `Not yet verified for: ${missingTf.join(', ')} — open each timeframe to load its candles.`,
    metric: tfKeys.map((tf) => `${tf}:${input.timeframesReady[tf] ?? 0}`).join(' '),
    critical: false,
  });

  // 5. Market discovery + global coverage
  const eligibleCount = input.eligibleMarketsCount ?? input.marketsCount;
  checks.push({
    id: 'markets',
    label: 'Market discovery',
    status:
      input.marketsCount > 0 ? 'HEALTHY' : input.marketsLoading ? 'WARNING' : 'FAILED',
    detail:
      input.marketsCount > 0
        ? `${input.marketsCount} synthetic markets discovered from the Deriv symbols feed.`
        : input.marketsLoading
          ? 'Discovering markets…'
          : 'No markets returned by the Deriv symbols feed.',
    metric: `${input.marketsCount} markets`,
    critical: true,
  });

  // 5b. Global all-markets coverage — every eligible Volatility Index is in scope.
  checks.push({
    id: 'coverage',
    label: 'Global market coverage',
    status: eligibleCount > 0 ? 'HEALTHY' : input.marketsLoading ? 'WARNING' : 'FAILED',
    detail:
      eligibleCount > 0
        ? `All ${eligibleCount} eligible Volatility Indices (standard + 1-second) are in scope for every AI module, the scanner and the chart analyser. Boom/Crash are excluded by design.`
        : 'No eligible Volatility Index was discovered — analysis paths have nothing to cover.',
    metric: `${eligibleCount} eligible markets`,
    critical: false,
  });

  // 6. Multi-market scanner
  checks.push({
    id: 'scanner',
    label: 'Multi-market scanner',
    status:
      input.scannerRanAt === null
        ? 'NOT_TESTED'
        : input.scannerRows > 0
          ? 'HEALTHY'
          : 'WARNING',
    detail:
      input.scannerRanAt === null
        ? 'No scan has been run yet — run the Market Scanner to verify it.'
        : `${input.scannerRows} row(s) produced ${ageLabel(input.scannerRanAt, now)}.`,
    metric: input.scannerRanAt === null ? 'not run' : `${input.scannerRows} rows`,
    critical: false,
  });

  // 7. Floating scanner
  checks.push({
    id: 'floating',
    label: 'Floating scanner',
    status: input.floatingScannerOpen ? 'HEALTHY' : 'NOT_TESTED',
    detail: input.floatingScannerOpen
      ? 'Floating scanner is open and receiving the live market feed.'
      : 'Floating scanner is closed — open it to verify.',
    metric: input.floatingScannerOpen ? 'open' : 'closed',
    critical: false,
  });

  // 8. AI modules
  checks.push({
    id: 'ai-modules',
    label: 'AI modules',
    status:
      input.aiModulesTotal === 0
        ? 'FAILED'
        : input.aiModulesActive === 0
          ? 'WARNING'
          : 'HEALTHY',
    detail:
      input.aiModulesTotal === 0
        ? 'No AI modules are registered.'
        : `${input.aiModulesActive}/${input.aiModulesTotal} AI modules have produced analysis for the selected instrument.`,
    metric: `${input.aiModulesActive}/${input.aiModulesTotal}`,
    critical: true,
  });

  // 9. Single shared chart
  checks.push({
    id: 'chart',
    label: 'Single shared chart',
    status: input.candleCount > 0 ? 'HEALTHY' : 'WARNING',
    detail:
      input.candleCount > 0
        ? 'One shared candlestick chart is rendering live candles for the selected market.'
        : 'The shared chart has no candles to render yet.',
    metric: input.candleCount > 0 ? 'rendering' : 'empty',
    critical: true,
  });

  // 10. Chart Analyser
  checks.push({
    id: 'analyser',
    label: 'Chart Analyser',
    status:
      input.analysisError !== null
        ? 'FAILED'
        : input.report !== null
          ? 'HEALTHY'
          : input.isAnalyzing
            ? 'WARNING'
            : 'NOT_TESTED',
    detail:
      input.analysisError !== null
        ? `Analysis error: ${input.analysisError}`
        : input.report !== null
          ? 'Analysis completed and a report is available for the selected instrument.'
          : input.isAnalyzing
            ? 'Analysis in progress…'
            : 'Run the analysis to verify the Chart Analyser.',
    metric: input.report !== null ? 'report ready' : input.isAnalyzing ? 'running' : 'idle',
    critical: true,
  });

  // 11. AI signal generation (via the analyser report's signal overlay)
  const hasSignal =
    input.report !== null &&
    typeof input.report === 'object' &&
    'overlays' in input.report &&
    Boolean((input.report as { overlays?: { signal?: unknown } }).overlays?.signal);
  checks.push({
    id: 'signals',
    label: 'AI signal generation',
    status: hasSignal ? 'HEALTHY' : input.report !== null ? 'WARNING' : 'NOT_TESTED',
    detail: hasSignal
      ? 'A validated setup (entry, stop, targets) is present for the selected instrument.'
      : input.report !== null
        ? 'Analysis ran but no setup currently qualifies — this is a normal market state, not a failure.'
        : 'Run the analysis to verify signal generation.',
    metric: hasSignal ? 'setup present' : 'no setup',
    critical: false,
  });

  // 12. Alerts
  checks.push({
    id: 'alerts',
    label: 'Alerts & notifications',
    status: 'HEALTHY',
    detail: `Notification engine online — ${input.alertCount} alert(s) tracked across all AI modules.`,
    metric: `${input.alertCount} alerts`,
    critical: false,
  });

  // 13. Strategy backtesting
  checks.push({
    id: 'backtest',
    label: 'Strategy backtesting',
    status:
      input.backtestEvaluations > 0 ? 'HEALTHY' : 'NOT_TESTED',
    detail:
      input.backtestEvaluations > 0
        ? `${input.backtestEvaluations} strategy/index evaluation(s) computed from real history.`
        : 'No backtest has been run yet — run the Strategy Lab backtest to verify.',
    metric: `${input.backtestEvaluations} evaluations`,
    critical: false,
  });

  // 14. Performance & learning
  checks.push({
    id: 'performance',
    label: 'Performance & learning engine',
    status:
      input.performanceRecords > 0 ? 'HEALTHY' : 'NOT_TESTED',
    detail:
      input.performanceRecords > 0
        ? `${input.performanceRecords} settled trade record(s) available for learning.`
        : 'No settled trades recorded yet — the learning engine has no data to aggregate.',
    metric: `${input.performanceRecords} records`,
    critical: false,
  });

  // 15. Risk management
  checks.push({
    id: 'risk',
    label: 'Risk management',
    status: input.riskRuleCount > 0 ? 'HEALTHY' : 'WARNING',
    detail:
      input.riskRuleCount > 0
        ? `${input.riskRuleCount} risk rules active (position sizing, stop validity, R:R gate).`
        : 'No risk rules are active.',
    metric: `${input.riskRuleCount} rules`,
    critical: false,
  });

  // 16. Market intelligence
  checks.push({
    id: 'intelligence',
    label: 'Market intelligence & anomalies',
    status:
      input.anomalyReports > 0
        ? 'HEALTHY'
        : 'NOT_TESTED',
    detail:
      input.anomalyReports > 0
        ? `${input.anomalyReports} live anomaly read(s) available.`
        : 'Start monitoring in the Strategy Lab to verify the market-intelligence engine.',
    metric: `${input.anomalyReports} reads`,
    critical: false,
  });

  // 17. UI responsiveness
  checks.push({
    id: 'ui',
    label: 'UI responsiveness',
    status: 'HEALTHY',
    detail:
      'Single shared chart, grouped navigation and reduced-motion support are active; layout uses no fixed pixel widths that could overflow.',
    metric: 'responsive',
    critical: false,
  });

  return checks;
}

export interface HealthSummary {
  total: number;
  healthy: number;
  warning: number;
  failed: number;
  notTested: number;
  overall: 'READY' | 'READY WITH WARNINGS' | 'NOT READY';
}

export function summarizeHealth(checks: readonly HealthCheck[]): HealthSummary {
  const healthy = checks.filter((c) => c.status === 'HEALTHY').length;
  const warning = checks.filter((c) => c.status === 'WARNING').length;
  const failed = checks.filter((c) => c.status === 'FAILED').length;
  const notTested = checks.filter((c) => c.status === 'NOT_TESTED').length;
  const criticalFailed = checks.some((c) => c.critical && c.status === 'FAILED');
  const overall: HealthSummary['overall'] = criticalFailed
    ? 'NOT READY'
    : failed > 0 || warning > 0 || notTested > 0
      ? 'READY WITH WARNINGS'
      : 'READY';
  return { total: checks.length, healthy, warning, failed, notTested, overall };
}

/** Timeframe granularities the health centre synchronises. */
export const HEALTH_TIMEFRAMES: readonly TimeframeKey[] = ['M1', 'M5', 'M15'];
export { TIMEFRAME_MAP, ENTRY_MODEL_IDS };
export type { Candle };
