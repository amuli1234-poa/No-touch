import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertId,
  buildAlert,
  categoryForStatus,
  defaultAlertSettings,
  inQuietHours,
  isMaterialChange,
  isTerminalAlert,
  mergeAlert,
  priorityFor,
  segmentAlertAccuracy,
  shouldDeliver,
  summarizeAlerts,
  type AlertObservation,
} from './alertEngine';

const T0 = 1_700_000_000_000;

function obs(overrides: Partial<AlertObservation> = {}): AlertObservation {
  return {
    symbol: 'R_75',
    displayName: 'Volatility 75',
    module: 'BOS & CHOCH AI',
    moduleId: 'boschoch',
    modelId: 'BOS_RETEST',
    modelLabel: 'BOS retest',
    direction: 'RISE',
    price: 100,
    timeframe: 'M15',
    status: 'DEVELOPING',
    quality: 70,
    entryPrice: 100,
    entryZoneLow: 99.8,
    entryZoneHigh: 100.2,
    stopLoss: 98,
    takeProfit1: 104,
    takeProfit2: 106,
    takeProfit3: 108,
    riskRewardRatio: 2,
    explanation: 'structure break with retest',
    evidence: ['M15 BOS'],
    ...overrides,
  };
}

test('alertId is stable for the same market/direction/model/zone', () => {
  const a = alertId({ symbol: 'R_75', direction: 'RISE', modelId: 'M1', entryZoneLow: 99.8, entryZoneHigh: 100.2 });
  const b = alertId({ symbol: 'R_75', direction: 'RISE', modelId: 'M1', entryZoneLow: 99.8, entryZoneHigh: 100.2 });
  const c = alertId({ symbol: 'R_75', direction: 'FALL', modelId: 'M1', entryZoneLow: 99.8, entryZoneHigh: 100.2 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('priorityFor escalates a broken live entry to CRITICAL', () => {
  assert.equal(priorityFor({ status: 'STOP_LOSS', quality: 90 }), 'CRITICAL');
  assert.equal(
    priorityFor({ status: 'INVALIDATED', quality: 90, previousStatus: 'CONFIRMED' }),
    'CRITICAL'
  );
  assert.equal(
    priorityFor({ status: 'INVALIDATED', quality: 70, previousStatus: 'DEVELOPING' }),
    'MEDIUM'
  );
  assert.equal(priorityFor({ status: 'CONFIRMED', quality: 90 }), 'HIGH');
  assert.equal(priorityFor({ status: 'APPROACHING', quality: 60 }), 'MEDIUM');
});

test('categoryForStatus maps lifecycle to the right trigger category', () => {
  assert.equal(categoryForStatus('CONFIRMED'), 'EXECUTION_READY');
  assert.equal(categoryForStatus('TARGET_REACHED'), 'TARGET_REACHED');
  assert.equal(categoryForStatus('STOP_LOSS'), 'STOP_LOSS_REACHED');
  assert.equal(categoryForStatus('INVALIDATED'), 'SETUP_INVALIDATED');
  assert.equal(categoryForStatus('APPROACHING'), 'ZONE_APPROACHING');
});

test('mergeAlert never duplicates an unchanged setup', () => {
  const first = mergeAlert([], obs(), T0);
  assert.equal(first.alerts.length, 1);
  const second = mergeAlert(first.alerts, obs(), T0 + 1000);
  assert.equal(second.alerts.length, 1, 'same key must update in place');
  assert.equal(second.changed, null, 'an unchanged setup is not a material change');
  assert.equal(second.alerts[0].revisions, 0);
});

test('mergeAlert flags a material change when the setup confirms', () => {
  const first = mergeAlert([], obs({ status: 'DEVELOPING', quality: 70 }), T0);
  const second = mergeAlert(first.alerts, obs({ status: 'CONFIRMED', quality: 90 }), T0 + 5000);
  assert.equal(second.alerts.length, 1);
  assert.ok(second.changed, 'a confirmation is material');
  assert.equal(second.changed?.status, 'CONFIRMED');
  assert.equal(second.alerts[0].revisions, 1);
  assert.equal(second.alerts[0].priority, 'HIGH');
});

test('mergeAlert re-surfaces a resolved alert as unread', () => {
  const created = mergeAlert([], obs({ status: 'CONFIRMED' }), T0);
  const read = created.alerts.map((a) => ({ ...a, read: true }));
  const resolved = mergeAlert(read, obs({ status: 'TARGET_REACHED' }), T0 + 1000);
  assert.equal(resolved.alerts[0].read, false, 'a terminal outcome must be surfaced again');
  assert.ok(isTerminalAlert(resolved.alerts[0].status));
});

test('shouldDeliver respects the master switch and priority filters', () => {
  const settings = defaultAlertSettings();
  const alert = buildAlert(obs({ status: 'APPROACHING' }), T0);
  assert.equal(shouldDeliver({ alert, settings, now: T0, priorDeliveryCount: 0 }).deliver, true);

  const off = { ...settings, enabled: false };
  assert.equal(shouldDeliver({ alert, settings: off, now: T0, priorDeliveryCount: 0 }).deliver, false);

  // LOW is disabled by default; a LOW-priority developing alert is filtered.
  const low = buildAlert(obs({ status: 'DEVELOPING', quality: 50 }), T0);
  assert.equal(low.priority, 'LOW');
  assert.equal(shouldDeliver({ alert: low, settings, now: T0, priorDeliveryCount: 0 }).deliver, false);
});

test('shouldDeliver always delivers terminal outcomes even during quiet hours', () => {
  const settings = defaultAlertSettings();
  settings.quietHours = { enabled: true, startHour: 0, endHour: 23 };
  const terminal = buildAlert(obs({ status: 'STOP_LOSS' }), T0);
  assert.equal(terminal.priority, 'CRITICAL');
  const decision = shouldDeliver({ alert: terminal, settings, now: T0, priorDeliveryCount: 999 });
  assert.equal(decision.deliver, true, 'a stop-loss must break through quiet hours + rate limit');
});

test('shouldDeliver enforces the per-hour rate limit for non-critical alerts', () => {
  const settings = defaultAlertSettings();
  const alert = buildAlert(obs({ status: 'APPROACHING' }), T0);
  assert.equal(
    shouldDeliver({ alert, settings, now: T0, priorDeliveryCount: settings.maxPerHour }).deliver,
    false
  );
});

test('shouldDeliver respects the minimum quality threshold', () => {
  const settings = { ...defaultAlertSettings(), minQuality: 90 };
  const alert = buildAlert(obs({ status: 'CONFIRMED', quality: 80 }), T0);
  assert.equal(shouldDeliver({ alert, settings, now: T0, priorDeliveryCount: 0 }).deliver, false);
});

test('shouldDeliver blocks a disabled module but allows a critical through', () => {
  const settings = defaultAlertSettings();
  settings.enabledModules = { boschoch: false };
  const developing = buildAlert(obs({ status: 'APPROACHING' }), T0);
  assert.equal(shouldDeliver({ alert: developing, settings, now: T0, priorDeliveryCount: 0 }).deliver, false);
  const critical = buildAlert(obs({ status: 'STOP_LOSS' }), T0);
  assert.equal(shouldDeliver({ alert: critical, settings, now: T0, priorDeliveryCount: 0 }).deliver, true);
});

test('inQuietHours handles windows that wrap midnight', () => {
  const quiet = { enabled: true, startHour: 22, endHour: 7 };
  assert.equal(inQuietHours(quiet, new Date('2026-01-01T23:00:00')), true);
  assert.equal(inQuietHours(quiet, new Date('2026-01-01T03:00:00')), true);
  assert.equal(inQuietHours(quiet, new Date('2026-01-01T12:00:00')), false);
  assert.equal(inQuietHours({ ...quiet, enabled: false }, new Date('2026-01-01T23:00:00')), false);
});

test('isMaterialChange ignores noise but catches new evidence', () => {
  const base = buildAlert(obs(), T0);
  assert.equal(isMaterialChange(base, { ...base }), false);
  assert.equal(isMaterialChange(base, { ...base, quality: base.quality + 1 }), false);
  assert.equal(isMaterialChange(base, { ...base, quality: base.quality + 5 }), true);
  assert.equal(isMaterialChange(base, { ...base, status: 'CONFIRMED' }), true);
  assert.equal(isMaterialChange(base, { ...base, evidence: [...base.evidence, 'new'] }), true);
});

test('summarizeAlerts reports accuracy only from resolved alerts', () => {
  const list = [
    buildAlert(obs({ status: 'TARGET_REACHED', modelId: 'A' }), T0),
    buildAlert(obs({ status: 'STOP_LOSS', modelId: 'B' }), T0),
    buildAlert(obs({ status: 'CONFIRMED', modelId: 'C' }), T0),
  ];
  const summary = summarizeAlerts(list);
  assert.equal(summary.total, 3);
  assert.equal(summary.targetReached, 1);
  assert.equal(summary.stopLoss, 1);
  assert.equal(summary.accuracyPercent, 50);
});

test('summarizeAlerts withholds accuracy when nothing resolved', () => {
  const summary = summarizeAlerts([buildAlert(obs({ status: 'DEVELOPING' }), T0)]);
  assert.equal(summary.accuracyPercent, null);
});

test('segmentAlertAccuracy separates results by module', () => {
  const list = [
    buildAlert(obs({ module: 'A', moduleId: 'a', modelId: 'A1', status: 'TARGET_REACHED' }), T0),
    buildAlert(obs({ module: 'A', moduleId: 'a', modelId: 'A2', status: 'STOP_LOSS' }), T0),
    buildAlert(obs({ module: 'B', moduleId: 'b', modelId: 'B1', status: 'TARGET_REACHED' }), T0),
  ];
  const segments = segmentAlertAccuracy(list, 'module');
  const a = segments.find((s) => s.key === 'A');
  const b = segments.find((s) => s.key === 'B');
  assert.equal(a?.total, 2);
  assert.equal(a?.accuracyPercent, 50);
  assert.equal(b?.accuracyPercent, 100);
});
