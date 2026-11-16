import type { AiJournalRecord } from './aiJournal';
import type { AiSignal } from '../types/aiModule';
import type { Candle, TimeframeKey } from '../types/market';
import {
  DEFAULT_ALERT_SETTINGS,
  type AiAlert,
  type AlertCategory,
  type AlertPriority,
  type AlertSettings,
  type AlertStatus,
  type QuietHours,
} from '../types/alerts';

/**
 * AI ALERTS & NOTIFICATION MANAGER — pure alert intelligence.
 *
 * This module contains NO market analysis. It receives already-published state from the
 * independent AI modules (and the independent journal), classifies the event, assigns a
 * priority, prevents duplicate notifications and tracks the alert lifecycle. Nothing here
 * ever fabricates a setup: an alert exists only because a module actually published one.
 */

export interface AlertObservation {
  symbol: string;
  displayName: string;
  module: string;
  moduleId: string;
  modelId: string;
  modelLabel: string;
  direction: 'RISE' | 'FALL' | null;
  price: number;
  timeframe: TimeframeKey;
  /** Module-reported status (drives category/priority, never invented here). */
  status: AlertStatus;
  quality: number;
  entryPrice: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskRewardRatio: number | null;
  explanation: string;
  evidence: string[];
  /** Optional explicit classification (used by the Strategy Lab / market-intelligence feeds). */
  category?: AlertCategory;
  priority?: AlertPriority;
  source?: AlertObservationSource;
}

type AlertObservationSource = 'AI_MODULE' | 'JOURNAL' | 'SYSTEM';

/** Stable de-duplication key: market + direction + model + the relevant price zone. */
export function alertId(params: {
  symbol: string;
  direction: 'RISE' | 'FALL' | null;
  modelId: string;
  entryZoneLow?: number | null;
  entryZoneHigh?: number | null;
}): string {
  const dir = params.direction ?? 'NONE';
  const low = params.entryZoneLow ?? 0;
  const high = params.entryZoneHigh ?? 0;
  const zone = `${round5(low)}-${round5(high)}`;
  return `${params.symbol}|${dir}|${params.modelId}|${zone}`;
}

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

/** Maps an observed lifecycle to the alert category that best describes it. */
export function categoryForStatus(status: AlertStatus): AlertCategory {
  switch (status) {
    case 'DEVELOPING':
      return 'SETUP_DEVELOPING';
    case 'APPROACHING':
      return 'ZONE_APPROACHING';
    case 'CONFIRMED':
      return 'EXECUTION_READY';
    case 'ACTIVE':
      return 'EXECUTION_READY';
    case 'TARGET_REACHED':
      return 'TARGET_REACHED';
    case 'STOP_LOSS':
      return 'STOP_LOSS_REACHED';
    case 'INVALIDATED':
      return 'SETUP_INVALIDATED';
    case 'MISSED':
      return 'ENTRY_MISSED';
    case 'EXPIRED':
      return 'QUALITY_LOST';
    default:
      return 'SETUP_DEVELOPING';
  }
}

/**
 * Priority rules. A confirmed setup that later invalidates is CRITICAL (a real entry was
 * broken); a mere developing idea that fades is only MEDIUM. Priority therefore depends on
 * the alert's PRIOR state, which is why the previous alert is passed in.
 */
export function priorityFor(params: {
  status: AlertStatus;
  quality: number;
  previousStatus?: AlertStatus | null;
}): AlertPriority {
  const { status, quality, previousStatus = null } = params;
  const wasActionable = previousStatus === 'CONFIRMED' || previousStatus === 'ACTIVE';

  switch (status) {
    case 'STOP_LOSS':
      return 'CRITICAL';
    case 'INVALIDATED':
      return wasActionable ? 'CRITICAL' : 'MEDIUM';
    case 'CONFIRMED':
    case 'ACTIVE':
      return quality >= 85 ? 'HIGH' : 'MEDIUM';
    case 'TARGET_REACHED':
      return 'HIGH';
    case 'APPROACHING':
      return 'MEDIUM';
    case 'MISSED':
      return 'MEDIUM';
    case 'DEVELOPING':
      return quality >= 85 ? 'MEDIUM' : 'LOW';
    case 'EXPIRED':
      return 'LOW';
    default:
      return 'LOW';
  }
}

function statusLabel(status: AlertStatus): string {
  return status.replace(/_/g, ' ').toLowerCase();
}

/** Builds an alert from a module observation (pure, no side effects). */
export function buildAlert(obs: AlertObservation, now: number): AiAlert {
  const id = alertId({
    symbol: obs.symbol,
    direction: obs.direction,
    modelId: obs.modelId,
    entryZoneLow: obs.entryZoneLow,
    entryZoneHigh: obs.entryZoneHigh,
  });
  const priority = obs.priority ?? priorityFor({ status: obs.status, quality: obs.quality });
  return {
    id,
    symbol: obs.symbol,
    displayName: obs.displayName,
    direction: obs.direction,
    price: obs.price,
    timeframe: obs.timeframe,
    module: obs.module,
    moduleId: obs.moduleId,
    source: obs.source ?? 'AI_MODULE',
    modelId: obs.modelId,
    modelLabel: obs.modelLabel,
    entryPrice: obs.entryPrice,
    entryZoneLow: obs.entryZoneLow,
    entryZoneHigh: obs.entryZoneHigh,
    stopLoss: obs.stopLoss,
    takeProfit1: obs.takeProfit1,
    takeProfit2: obs.takeProfit2,
    takeProfit3: obs.takeProfit3,
    riskRewardRatio: obs.riskRewardRatio,
    quality: obs.quality,
    priority,
    category: obs.category ?? categoryForStatus(obs.status),
    status: obs.status,
    explanation: obs.explanation,
    evidence: obs.evidence,
    confidence: obs.quality,
    firstSeenAt: now,
    createdAt: now,
    updatedAt: now,
    revisions: 0,
    read: false,
    dismissed: false,
    notified: false,
  };
}

/** Maps a published AI signal to an observation for the alert layer. */
export function observationFromSignal(params: {
  module: string;
  moduleId: string;
  signal: AiSignal;
}): AlertObservation {
  const { signal } = params;
  const actionable = signal.lifecycle === 'CONFIRMED' || signal.lifecycle === 'ACTIVE';
  const status: AlertStatus = actionable ? 'CONFIRMED' : 'DEVELOPING';
  return {
    symbol: signal.symbol,
    displayName: signal.displayName,
    module: params.module,
    moduleId: params.moduleId,
    modelId: signal.modelId,
    modelLabel: signal.modelLabel,
    direction: signal.direction,
    price: signal.entryPrice,
    timeframe: signal.timeframes[0]?.timeframe ?? 'M15',
    status,
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

/** Maps an independently-settled journal record to a lifecycle alert. */
export function observationFromJournal(record: AiJournalRecord): AlertObservation {
  const status: AlertStatus =
    record.outcome === 'WIN'
      ? 'TARGET_REACHED'
      : record.outcome === 'LOSS'
        ? 'STOP_LOSS'
        : record.outcome === 'INVALIDATED'
          ? 'INVALIDATED'
          : record.outcome === 'EXPIRED'
            ? 'EXPIRED'
            : record.outcome === 'NO_TRIGGER'
              ? 'MISSED'
              : 'DEVELOPING';
  return {
    symbol: record.symbol,
    displayName: record.displayName,
    module: record.module,
    moduleId: 'journal',
    modelId: record.modelId,
    modelLabel: record.modelLabel,
    direction: record.direction,
    price: record.exitPrice ?? record.entryPrice,
    timeframe: (record.timeframe.split('→')[0] as TimeframeKey) ?? 'M15',
    status,
    quality: record.qualityScore,
    entryPrice: record.entryPrice,
    entryZoneLow: record.entryPrice,
    entryZoneHigh: record.entryPrice,
    stopLoss: record.stopLoss,
    takeProfit1: record.takeProfit1,
    takeProfit2: record.takeProfit2,
    takeProfit3: record.takeProfit3,
    riskRewardRatio: record.riskRewardRatio,
    explanation: `Journal settled this setup as ${record.outcome} against verified candles.`,
    evidence: [
      `Outcome ${record.outcome}`,
      `Highest target reached: TP${record.highestTargetReached}`,
      `MFE ${record.mfePct}% / MAE ${record.maePct}%`,
    ],
  };
}

/** True when the incoming observation represents a *material* change worth notifying about. */
export function isMaterialChange(previous: AiAlert | undefined, next: AiAlert): boolean {
  if (!previous) return true;
  if (previous.status !== next.status) return true;
  if (Math.abs(previous.quality - next.quality) >= 3) return true;
  if (previous.category !== next.category) return true;
  if (previous.priority !== next.priority) return true;
  // New evidence appearing is material (a fresh confirmation).
  if (next.evidence.length > previous.evidence.length) return true;
  return false;
}

const TERMINAL_STATUSES: ReadonlySet<AlertStatus> = new Set([
  'TARGET_REACHED',
  'STOP_LOSS',
  'INVALIDATED',
  'EXPIRED',
  'MISSED',
]);

export function isTerminalAlert(status: AlertStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Merges an incoming observation into the alert list. Never creates a duplicate for an
 * unchanged setup — it updates the existing alert in place and only flags a material change.
 */
export function mergeAlert(
  existing: readonly AiAlert[],
  obs: AlertObservation,
  now: number
): { alerts: AiAlert[]; changed: AiAlert | null } {
  const incoming = buildAlert(obs, now);
  const idx = existing.findIndex((a) => a.id === incoming.id);
  if (idx === -1) {
    return { alerts: [incoming, ...existing].slice(0, 400), changed: incoming };
  }
  const previous = existing[idx];
  const priority = priorityFor({
    status: incoming.status,
    quality: incoming.quality,
    previousStatus: previous.status,
  });
  const next: AiAlert = {
    ...previous,
    price: incoming.price,
    quality: incoming.quality,
    priority,
    category: incoming.category,
    status: incoming.status,
    explanation: incoming.explanation,
    evidence: incoming.evidence,
    entryPrice: incoming.entryPrice ?? previous.entryPrice,
    stopLoss: incoming.stopLoss ?? previous.stopLoss,
    takeProfit1: incoming.takeProfit1 ?? previous.takeProfit1,
    takeProfit2: incoming.takeProfit2 ?? previous.takeProfit2,
    takeProfit3: incoming.takeProfit3 ?? previous.takeProfit3,
    riskRewardRatio: incoming.riskRewardRatio ?? previous.riskRewardRatio,
    updatedAt: now,
    // A terminal resolution is new information: re-surface it even if it was read.
    read: isTerminalAlert(incoming.status) ? false : previous.read,
  };
  const material = isMaterialChange(previous, next);
  if (material) next.revisions = previous.revisions + 1;
  const alerts = [...existing];
  alerts[idx] = next;
  return { alerts, changed: material ? next : null };
}

/** Aggregated alert accuracy — generated alerts, never conflated with executed trades. */
export function summarizeAlerts(alerts: readonly AiAlert[]) {
  const byPriority: Record<AlertPriority, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let confirmed = 0;
  let invalidated = 0;
  let targetReached = 0;
  let stopLoss = 0;
  let missed = 0;
  let expired = 0;
  let read = 0;
  let dismissed = 0;

  for (const a of alerts) {
    byPriority[a.priority] += 1;
    if (a.read) read += 1;
    if (a.dismissed) dismissed += 1;
    if (a.status === 'CONFIRMED' || a.status === 'ACTIVE') confirmed += 1;
    else if (a.status === 'INVALIDATED') invalidated += 1;
    else if (a.status === 'TARGET_REACHED') targetReached += 1;
    else if (a.status === 'STOP_LOSS') stopLoss += 1;
    else if (a.status === 'MISSED') missed += 1;
    else if (a.status === 'EXPIRED') expired += 1;
  }

  const resolved = targetReached + stopLoss;
  const accuracyPercent = resolved > 0 ? Number(((targetReached / resolved) * 100).toFixed(1)) : null;

  return {
    total: alerts.length,
    read,
    dismissed,
    byPriority,
    confirmed,
    invalidated,
    targetReached,
    stopLoss,
    missed,
    expired,
    accuracyPercent,
  };
}

/** Segmented accuracy by a key extractor (module / symbol / model). */
export function segmentAlertAccuracy(
  alerts: readonly AiAlert[],
  key: 'module' | 'symbol' | 'modelId'
): { key: string; label: string; total: number; resolved: number; accuracyPercent: number | null }[] {
  const buckets = new Map<string, { label: string; total: number; target: number; stop: number }>();
  for (const a of alerts) {
    const id = a[key];
    const bucket = buckets.get(id) ?? { label: a.displayName || a.modelLabel || id, total: 0, target: 0, stop: 0 };
    bucket.total += 1;
    if (a.status === 'TARGET_REACHED') bucket.target += 1;
    if (a.status === 'STOP_LOSS') bucket.stop += 1;
    buckets.set(id, bucket);
  }
  return Array.from(buckets.entries())
    .map(([id, b]) => {
      const resolved = b.target + b.stop;
      return {
        key: id,
        label: key === 'symbol' ? b.label : id,
        total: b.total,
        resolved,
        accuracyPercent: resolved > 0 ? Number(((b.target / resolved) * 100).toFixed(1)) : null,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** Quiet-hours check on the user's LOCAL clock. */
export function inQuietHours(quiet: QuietHours, date: Date): boolean {
  if (!quiet.enabled) return false;
  const hour = date.getHours();
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Window wraps midnight (e.g. 22 → 07).
  return hour >= startHour || hour < endHour;
}

/**
 * Whether an alert may be DELIVERED right now. Recording always happens; delivery is gated
 * by the master switch, module/priority/symbol/timeframe filters, quality, quiet hours and
 * the per-hour rate limit. A terminal resolution always bypasses the rate limit and quiet
 * hours (the user must learn a live entry was invalidated), but never the master switch.
 */
export function shouldDeliver(params: {
  alert: AiAlert;
  settings: AlertSettings;
  now: number;
  priorDeliveryCount: number;
}): { deliver: boolean; reason: string } {
  const { alert, settings, now, priorDeliveryCount } = params;
  if (!settings.enabled) return { deliver: false, reason: 'alerts disabled' };
  if (alert.dismissed) return { deliver: false, reason: 'dismissed' };

  const terminal = isTerminalAlert(alert.status);
  const critical = alert.priority === 'CRITICAL';
  const bypass = terminal || critical;

  if (settings.enabledModules[alert.moduleId] === false && !bypass) {
    return { deliver: false, reason: 'module disabled' };
  }

  if (!settings.enabledPriorities[alert.priority] && !bypass) {
    return { deliver: false, reason: 'priority filtered' };
  }
  if (
    settings.enabledSymbols.length > 0 &&
    !settings.enabledSymbols.includes(alert.symbol) &&
    !bypass
  ) {
    return { deliver: false, reason: 'index filtered' };
  }
  if (
    settings.enabledTimeframes.length > 0 &&
    !settings.enabledTimeframes.includes(alert.timeframe) &&
    !bypass
  ) {
    return { deliver: false, reason: 'timeframe filtered' };
  }
  if (alert.quality < settings.minQuality && !terminal) {
    return { deliver: false, reason: 'below quality threshold' };
  }
  if (alert.status === 'DEVELOPING' && !settings.developingAlerts && !bypass) {
    return { deliver: false, reason: 'developing alerts disabled' };
  }

  if (inQuietHours(settings.quietHours, new Date(now)) && !terminal) {
    return { deliver: false, reason: 'quiet hours' };
  }

  if (priorDeliveryCount >= settings.maxPerHour && !bypass) {
    return { deliver: false, reason: 'rate limited' };
  }

  return { deliver: true, reason: 'ok' };
}

export function defaultAlertSettings(): AlertSettings {
  return {
    ...DEFAULT_ALERT_SETTINGS,
    enabledPriorities: { ...DEFAULT_ALERT_SETTINGS.enabledPriorities },
    channels: { ...DEFAULT_ALERT_SETTINGS.channels },
    quietHours: { ...DEFAULT_ALERT_SETTINGS.quietHours },
    enabledModules: {},
    enabledSymbols: [],
    enabledTimeframes: [],
  };
}

/** True when the alert's entry zone has been passed by price (entry no longer available). */
export function entryWindowPassed(alert: AiAlert, candles: readonly Candle[]): boolean {
  if (alert.entryZoneLow === null || alert.entryZoneHigh === null || alert.direction === null) {
    return false;
  }
  const fresh = candles.filter((c) => c.time * 1000 >= alert.createdAt);
  if (fresh.length === 0) return false;
  const last = fresh[fresh.length - 1];
  return alert.direction === 'RISE'
    ? last.low > alert.entryZoneHigh
    : last.high < alert.entryZoneLow;
}

export function describeAlert(alert: AiAlert): string {
  const dir = alert.direction ? alert.direction.toLowerCase() : 'no-bias';
  return `${alert.displayName} ${dir} ${alert.modelLabel} — ${statusLabel(alert.status)} (${alert.quality}/100)`;
}
