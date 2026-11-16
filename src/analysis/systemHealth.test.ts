import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHealthChecks, summarizeHealth, type HealthInputs } from './systemHealth';

function baseInputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    connectionStatus: 'connected',
    diagnostics: {
      status: 'connected',
      url: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
      reconnectAttempt: 0,
      maxReconnectAttempts: 10,
      lastError: null,
      lastMessageAt: 1_700_000_000_000,
      lastTickAt: 1_700_000_000_000,
      activeSubscriptions: 1,
      queuedRequests: 0,
      rateLimitedUntil: 0,
      hasReceivedData: true,
      isManual: false,
    },
    lastTickAt: 1_700_000_000_000,
    feedStale: false,
    marketsCount: 30,
    marketsLoading: false,
    selectedSymbol: 'R_100',
    candleCount: 200,
    loadState: 'ready',
    dataError: null,
    timeframesReady: {
      M30: 40,
      M15: 40,
      M10: 40,
      M7: 40,
      M6: 40,
      M5: 40,
      M4: 40,
      M3: 40,
      M2: 40,
      M1: 40,
    },
    isAnalyzing: false,
    report: { overlays: { signal: { id: 's1' } } },
    analysisError: null,
    scannerRanAt: 1_700_000_000_000,
    scannerRows: 12,
    floatingScannerOpen: true,
    aiModulesRun: 9,
    aiModulesActive: 9,
    aiModulesTotal: 9,
    aiScanError: null,
    alertCount: 4,
    backtestEvaluations: 3,
    performanceRecords: 5,
    riskRuleCount: 4,
    anomalyReports: 2,
    now: 1_700_000_000_000 + 5_000,
    ...overrides,
  };
}

function find(checks: ReturnType<typeof buildHealthChecks>, id: string) {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `expected a check with id ${id}`);
  return c!;
}

describe('buildHealthChecks', () => {
  it('reports every component HEALTHY when the runtime evidence is complete', () => {
    const summary = summarizeHealth(buildHealthChecks(baseInputs()));
    assert.equal(summary.failed, 0);
    assert.equal(summary.warning, 0);
    assert.equal(summary.notTested, 0);
    assert.equal(summary.overall, 'READY');
  });

  it('fails the WebSocket check and returns NOT READY when disconnected', () => {
    const checks = buildHealthChecks(
      baseInputs({
        connectionStatus: 'disconnected',
        diagnostics: { ...baseInputs().diagnostics, status: 'disconnected', lastError: { message: 'socket closed' } },
      })
    );
    assert.equal(find(checks, 'websocket').status, 'FAILED');
    assert.match(find(checks, 'websocket').detail, /socket closed/);
    assert.equal(summarizeHealth(checks).overall, 'NOT READY');
  });

  it('marks NOT_TESTED rather than PASS for things that were never exercised', () => {
    const checks = buildHealthChecks(
      baseInputs({
        scannerRanAt: null,
        floatingScannerOpen: false,
        backtestEvaluations: 0,
        performanceRecords: 0,
        anomalyReports: 0,
        report: null,
      })
    );
    assert.equal(find(checks, 'scanner').status, 'NOT_TESTED');
    assert.equal(find(checks, 'floating').status, 'NOT_TESTED');
    assert.equal(find(checks, 'backtest').status, 'NOT_TESTED');
    assert.equal(find(checks, 'performance').status, 'NOT_TESTED');
    assert.equal(find(checks, 'intelligence').status, 'NOT_TESTED');
    assert.equal(find(checks, 'analyser').status, 'NOT_TESTED');
  });

  it('warns (not fails) when analysis ran but no setup qualifies', () => {
    const checks = buildHealthChecks(baseInputs({ report: { overlays: { signal: null } } }));
    assert.equal(find(checks, 'signals').status, 'WARNING');
    assert.equal(find(checks, 'analyser').status, 'HEALTHY');
  });

  it('flags stale ticks as a warning with the measured age', () => {
    const now = 1_700_000_000_000;
    const checks = buildHealthChecks(
      baseInputs({ now, lastTickAt: now - 45_000, feedStale: true })
    );
    const ticks = find(checks, 'ticks');
    assert.equal(ticks.status, 'WARNING');
    assert.match(ticks.detail, /stale/);
    assert.match(ticks.metric!, /tick age/);
  });

  it('warns when only some core timeframes have loaded candles', () => {
    const checks = buildHealthChecks(
      baseInputs({
        timeframesReady: { M30: 40, M15: 40, M10: 40, M7: 40, M6: 40, M5: 0, M4: 40, M3: 40, M2: 40, M1: 40 },
      })
    );
    const tf = find(checks, 'timeframes');
    assert.equal(tf.status, 'WARNING');
    assert.match(tf.detail, /M5/);
  });

  it('reports NOT_TESTED for timeframe sync when nothing is loaded', () => {
    const checks = buildHealthChecks(baseInputs({ timeframesReady: {} }));
    assert.equal(find(checks, 'timeframes').status, 'NOT_TESTED');
  });

  it('fails market discovery when the feed returns nothing and is not loading', () => {
    const checks = buildHealthChecks(baseInputs({ marketsCount: 0, marketsLoading: false }));
    assert.equal(find(checks, 'markets').status, 'FAILED');
  });

  it('gives every check a non-empty reason and a raw metric', () => {
    const checks = buildHealthChecks(baseInputs());
    for (const c of checks) {
      assert.ok(c.detail.length > 0, `${c.id} must explain its status`);
      assert.ok(c.metric !== undefined, `${c.id} must expose a metric`);
    }
  });

  it('counts totals and only marks READY when nothing is failed, warned or untested', () => {
    const summary = summarizeHealth(
      buildHealthChecks(baseInputs({ scannerRanAt: null, floatingScannerOpen: false }))
    );
    assert.equal(summary.total, summary.healthy + summary.warning + summary.failed + summary.notTested);
    assert.equal(summary.overall, 'READY WITH WARNINGS');
  });

  it('reports un-run AI modules as NOT_TESTED, never as a failure', () => {
    const check = find(
      buildHealthChecks(baseInputs({ aiModulesRun: 0, aiModulesActive: 0 })),
      'ai-modules'
    );
    assert.equal(check.status, 'NOT_TESTED');
  });

  it('reports AI modules as HEALTHY once they have run and produced analysis', () => {
    const check = find(buildHealthChecks(baseInputs()), 'ai-modules');
    assert.equal(check.status, 'HEALTHY');
  });

  it('reports AI modules as FAILED only when a run produced no data at all', () => {
    const check = find(
      buildHealthChecks(
        baseInputs({
          aiModulesRun: 10,
          aiModulesActive: 0,
          aiScanError: 'No instrument could be analysed (23/23 data fetches failed).',
        })
      ),
      'ai-modules'
    );
    assert.equal(check.status, 'FAILED');
    assert.match(check.detail, /could not analyse any instrument/);
  });

  it('reports AI modules as WARNING when they ran but nothing qualified', () => {
    const check = find(
      buildHealthChecks(baseInputs({ aiModulesRun: 10, aiModulesActive: 0, aiScanError: null })),
      'ai-modules'
    );
    assert.equal(check.status, 'WARNING');
  });
});
