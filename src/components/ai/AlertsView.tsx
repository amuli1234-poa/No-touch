import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  CheckCheck,
  ChevronDown,
  ExternalLink,
  Filter,
  History,
  Info,
  Settings2,
  ShieldAlert,
  Sliders,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import type { AlertManagerHookValue } from '../../hooks/useAlertManager';
import { AI_MODULE_DEFINITIONS } from '../../hooks/useAiModules';
import { TIMEFRAMES } from '../../config/deriv';
import {
  ALERT_CATEGORY_LABELS,
  ALERT_PRIORITY_LABELS,
  ALERT_PRIORITY_ORDER,
  ALERT_STATUS_LABELS,
  type AiAlert,
  type AlertPriority,
  type AlertStatus,
} from '../../types/alerts';
import { isNotificationSupported, notificationPermission } from '../../utils/notify';
import { formatPrice } from '../../utils/derivParser';
import { Card, EmptyState, SectionCard, StatTile, StatusPill } from '../ui/primitives';

interface AlertsViewProps {
  manager: AlertManagerHookValue;
}

const PRIORITY_STYLE: Record<AlertPriority, string> = {
  CRITICAL: 'bg-red-500/15 text-bear border-red-500/40',
  HIGH: 'bg-amber-500/12 text-warn border-amber-500/35',
  MEDIUM: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  LOW: 'bg-elevated text-muted border-line',
};

const STATUS_STYLE: Record<AlertStatus, string> = {
  DEVELOPING: 'bg-elevated text-muted border-line',
  APPROACHING: 'bg-blue-500/12 text-blue-400 border-blue-500/30',
  CONFIRMED: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  ACTIVE: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30',
  TARGET_REACHED: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  STOP_LOSS: 'bg-red-500/15 text-bear border-red-500/40',
  INVALIDATED: 'bg-red-500/12 text-bear border-red-500/30',
  EXPIRED: 'bg-panel text-faint border-line',
  MISSED: 'bg-amber-500/12 text-warn border-amber-500/30',
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function price(v: number | null, precision: number): string {
  return v === null ? '—' : formatPrice(v, precision);
}

function AlertCard({
  alert,
  precision,
  onOpen,
  onRead,
  onDismiss,
}: {
  alert: AiAlert;
  precision: number;
  onOpen: (alert: AiAlert) => void;
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card className={`overflow-hidden ${alert.read ? '' : 'border-accent/40'}`}>
      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <span
          className={`mt-0.5 shrink-0 inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wide ${PRIORITY_STYLE[alert.priority]}`}
        >
          {ALERT_PRIORITY_LABELS[alert.priority]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-bold text-ink truncate">{alert.displayName}</span>
            {alert.direction && (
              <span
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  alert.direction === 'RISE'
                    ? 'bg-emerald-500/12 text-emerald-400'
                    : 'bg-red-500/12 text-bear'
                }`}
              >
                {alert.direction}
              </span>
            )}
            <span
              className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${STATUS_STYLE[alert.status]}`}
            >
              {ALERT_STATUS_LABELS[alert.status]}
            </span>
            {!alert.read && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-label="Unread" />
            )}
          </div>
          <div className="text-[11px] text-muted mt-0.5 truncate">
            {alert.module} · {alert.modelLabel} · {ALERT_CATEGORY_LABELS[alert.category]}
          </div>
          <div className="text-[11px] text-faint mt-0.5">
            {fmtTime(alert.updatedAt)} · Q{alert.quality}/100 ·{' '}
            {alert.riskRewardRatio !== null ? `R:R ${alert.riskRewardRatio.toFixed(2)}` : 'R:R —'}
            {alert.revisions > 0 && ` · ${alert.revisions} update${alert.revisions > 1 ? 's' : ''}`}
          </div>
          <p className="text-[11px] text-muted mt-1 leading-snug">{alert.explanation}</p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-faint hover:text-ink hover:bg-elevated transition-colors cursor-pointer"
          title="Details"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 border-t border-line-soft pt-2.5 space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile label="Price" value={price(alert.price, precision)} />
            <StatTile label="Entry" value={price(alert.entryPrice, precision)} />
            <StatTile label="Stop" value={price(alert.stopLoss, precision)} valueClass="text-bear" />
            <StatTile label="TF" value={alert.timeframe} />
            <StatTile label="TP1" value={price(alert.takeProfit1, precision)} valueClass="text-emerald-400" />
            <StatTile label="TP2" value={price(alert.takeProfit2, precision)} valueClass="text-emerald-400" />
            <StatTile label="TP3" value={price(alert.takeProfit3, precision)} valueClass="text-emerald-400" />
            <StatTile
              label="Entry zone"
              value={
                alert.entryZoneLow !== null && alert.entryZoneHigh !== null
                  ? `${price(alert.entryZoneLow, precision)} – ${price(alert.entryZoneHigh, precision)}`
                  : '—'
              }
            />
          </div>
          {alert.evidence.length > 0 && (
            <ul className="space-y-1">
              {alert.evidence.map((e, i) => (
                <li key={i} className="text-[11px] text-muted flex items-start gap-1.5">
                  <Info className="w-3 h-3 text-faint mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => onOpen(alert)}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-bold text-app bg-accent rounded-md hover:bg-accent-soft transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              Open in Chart Analyser
            </button>
            {!alert.read && (
              <button
                type="button"
                onClick={() => onRead(alert.id)}
                className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 transition-colors cursor-pointer"
              >
                <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
                Mark read
              </button>
            )}
            <button
              type="button"
              onClick={() => onDismiss(alert.id)}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-muted bg-panel border border-line rounded-md hover:text-ink transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
              Dismiss
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SettingsPanel({ manager }: { manager: AlertManagerHookValue }) {
  const s = manager.settings;
  const browserSupported = isNotificationSupported();
  const permission = notificationPermission();
  const moduleIds = useMemo(
    () => [
      ...AI_MODULE_DEFINITIONS.map((d) => ({ id: d.id, label: d.label })),
      { id: 'journal', label: 'Trade Performance & Learning AI' },
    ],
    []
  );

  return (
    <SectionCard
      title="Notification settings"
      subtitle="Channels, filters and quiet hours — every control is wired to live behaviour."
      icon={<Settings2 className="w-4 h-4" aria-hidden="true" />}
    >
      <div className="space-y-4">
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span className="text-[12px] font-semibold text-ink">Enable all alerts</span>
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => manager.updateSettings({ enabled: e.target.checked })}
            className="w-4 h-4 accent-sky-500"
          />
        </label>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1.5">
            Notification channels
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => manager.toggleChannel('IN_APP')}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer ${
                s.channels.IN_APP ? 'bg-accent/12 text-accent border-accent/30' : 'bg-elevated text-muted border-line'
              }`}
            >
              <BellRing className="w-3.5 h-3.5" aria-hidden="true" /> In-app
            </button>
            <button
              type="button"
              onClick={() => manager.toggleChannel('SOUND')}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer ${
                s.channels.SOUND ? 'bg-accent/12 text-accent border-accent/30' : 'bg-elevated text-muted border-line'
              }`}
            >
              {s.channels.SOUND ? (
                <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <VolumeX className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              Sound
            </button>
            <button
              type="button"
              onClick={() => manager.toggleChannel('BROWSER')}
              disabled={!browserSupported}
              title={
                browserSupported
                  ? `Browser notifications (${permission})`
                  : 'Browser notifications are not supported in this environment'
              }
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-[11px] font-semibold transition-colors ${
                !browserSupported
                  ? 'bg-panel text-faint border-line cursor-not-allowed'
                  : s.channels.BROWSER
                    ? 'bg-accent/12 text-accent border-accent/30 cursor-pointer'
                    : 'bg-elevated text-muted border-line cursor-pointer'
              }`}
            >
              <Info className="w-3.5 h-3.5" aria-hidden="true" />
              Browser {browserSupported ? '' : '(unsupported)'}
            </button>
          </div>
          <p className="text-[10px] text-faint mt-1.5">
            Only implemented channels are shown. Email / external messaging are not connected in
            this build, so they are not offered.
          </p>
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1.5">
            Alert priorities
          </div>
          <div className="flex flex-wrap gap-2">
            {ALERT_PRIORITY_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => manager.togglePriority(p)}
                className={`h-8 px-3 rounded-md border text-[11px] font-bold uppercase tracking-wide transition-colors cursor-pointer ${
                  s.enabledPriorities[p] ? PRIORITY_STYLE[p] : 'bg-elevated text-faint border-line'
                }`}
              >
                {ALERT_PRIORITY_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-faint">
              Minimum setup quality: {s.minQuality}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={s.minQuality}
              onChange={(e) => manager.updateSettings({ minQuality: Number(e.target.value) })}
              className="w-full accent-sky-500"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-faint">
              Max notifications / hour: {s.maxPerHour}
            </span>
            <input
              type="range"
              min={1}
              max={60}
              step={1}
              value={s.maxPerHour}
              onChange={(e) => manager.updateSettings({ maxPerHour: Number(e.target.value) })}
              className="w-full accent-sky-500"
            />
          </label>
        </div>

        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span className="text-[12px] font-semibold text-ink">
            Alert on developing (not-yet-confirmed) setups
          </span>
          <input
            type="checkbox"
            checked={s.developingAlerts}
            onChange={(e) => manager.updateSettings({ developingAlerts: e.target.checked })}
            className="w-4 h-4 accent-sky-500"
          />
        </label>

        <div className="rounded-lg border border-line p-2.5 space-y-2">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-[12px] font-semibold text-ink">Quiet hours</span>
            <input
              type="checkbox"
              checked={s.quietHours.enabled}
              onChange={(e) =>
                manager.updateSettings({
                  quietHours: { ...s.quietHours, enabled: e.target.checked },
                })
              }
              className="w-4 h-4 accent-sky-500"
            />
          </label>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span>From</span>
            <select
              value={s.quietHours.startHour}
              onChange={(e) =>
                manager.updateSettings({
                  quietHours: { ...s.quietHours, startHour: Number(e.target.value) },
                })
              }
              className="bg-elevated border border-line rounded-md px-2 py-1 text-ink"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
            <span>to</span>
            <select
              value={s.quietHours.endHour}
              onChange={(e) =>
                manager.updateSettings({
                  quietHours: { ...s.quietHours, endHour: Number(e.target.value) },
                })
              }
              className="bg-elevated border border-line rounded-md px-2 py-1 text-ink"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </div>
          <p className="text-[10px] text-faint">
            Events are still recorded in the history during quiet hours; only delivery is paused.
          </p>
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1.5">
            Timeframes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TIMEFRAMES.map((tf) => {
              const active = s.enabledTimeframes.length === 0 || s.enabledTimeframes.includes(tf.key);
              return (
                <button
                  key={tf.key}
                  type="button"
                  onClick={() =>
                    manager.updateSettings({
                      enabledTimeframes: s.enabledTimeframes.includes(tf.key)
                        ? s.enabledTimeframes.filter((t) => t !== tf.key)
                        : [...s.enabledTimeframes, tf.key],
                    })
                  }
                  className={`h-7 px-2.5 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer ${
                    active ? 'bg-accent/12 text-accent border-accent/30' : 'bg-elevated text-faint border-line'
                  }`}
                >
                  {tf.label}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-faint mt-1">
            No selection = all timeframes.
          </p>
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1.5">
            AI modules
          </div>
          <div className="flex flex-wrap gap-1.5">
            {moduleIds.map((m) => {
              const enabled = s.enabledModules[m.id] ?? true;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => manager.toggleModule(m.id)}
                  className={`h-7 px-2.5 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer ${
                    enabled ? 'bg-accent/12 text-accent border-accent/30' : 'bg-elevated text-faint border-line'
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

/**
 * AI ALERTS & NOTIFICATION MANAGER — dashboard. Every filter, channel and control is wired
 * to the real alert engine; nothing here is decorative.
 */
export function AlertsView({ manager }: AlertsViewProps) {
  const ws = useWorkspace();
  const [showSettings, setShowSettings] = useState(false);

  const openAlert = (alert: AiAlert) => {
    manager.markRead(alert.id);
    ws.openAnalyser(alert.symbol, alert.timeframe);
  };

  const summary = manager.summary;
  const symbols = useMemo(
    () => Array.from(new Set(manager.alerts.map((a) => a.symbol))).sort(),
    [manager.alerts]
  );
  const modules = useMemo(
    () => Array.from(new Set(manager.alerts.map((a) => a.module))).sort(),
    [manager.alerts]
  );

  const statuses: AlertStatus[] = [
    'DEVELOPING',
    'APPROACHING',
    'CONFIRMED',
    'ACTIVE',
    'TARGET_REACHED',
    'STOP_LOSS',
    'INVALIDATED',
    'MISSED',
    'EXPIRED',
  ];

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-accent">
          <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
          AI Alerts &amp; Notification Manager
        </span>
        <span className="text-[11px] text-faint">
          Collects verified events from every module — never generates a signal of its own.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className={`inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold rounded-md border transition-colors cursor-pointer ${
              showSettings ? 'bg-accent/12 text-accent border-accent/30' : 'bg-elevated text-muted border-line'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
            Settings
          </button>
          <button
            type="button"
            onClick={manager.markAllRead}
            disabled={manager.unreadCount === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 disabled:opacity-50 transition-colors cursor-pointer"
          >
            <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
            Mark all read
          </button>
          <button
            type="button"
            onClick={manager.clear}
            disabled={manager.alerts.length === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-muted bg-panel border border-line rounded-md hover:text-ink disabled:opacity-50 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            Clear
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <StatTile label="All alerts" value={summary.total} />
        <StatTile label="Unread" value={manager.unreadCount} valueClass={manager.unreadCount > 0 ? 'text-accent' : 'text-ink'} />
        <StatTile label="Critical" value={summary.byPriority.CRITICAL} valueClass="text-bear" />
        <StatTile label="High" value={summary.byPriority.HIGH} valueClass="text-warn" />
        <StatTile
          label="Resolved accuracy"
          value={summary.accuracyPercent === null ? 'n/a' : `${summary.accuracyPercent}%`}
          hint="TP vs SL resolved alerts"
        />
        <StatTile label="Delivered / hr" value={manager.deliveredLastHour} hint={`limit ${manager.settings.maxPerHour}`} />
      </div>

      {showSettings && <SettingsPanel manager={manager} />}

      <SectionCard
        title="Alerts"
        subtitle="Filter by index, direction, module, priority, timeframe, status and date."
        icon={<Filter className="w-4 h-4" aria-hidden="true" />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={manager.filters.symbol}
            onChange={(e) => manager.setFilters({ symbol: e.target.value })}
            className="bg-elevated border border-line rounded-md px-2 py-1.5 text-[11px] text-ink"
            aria-label="Filter by index"
          >
            <option value="ALL">All indices</option>
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={manager.filters.direction}
            onChange={(e) => manager.setFilters({ direction: e.target.value as never })}
            className="bg-elevated border border-line rounded-md px-2 py-1.5 text-[11px] text-ink"
            aria-label="Filter by direction"
          >
            <option value="ALL">Both directions</option>
            <option value="RISE">RISE</option>
            <option value="FALL">FALL</option>
          </select>
          <select
            value={manager.filters.module}
            onChange={(e) => manager.setFilters({ module: e.target.value })}
            className="bg-elevated border border-line rounded-md px-2 py-1.5 text-[11px] text-ink"
            aria-label="Filter by module"
          >
            <option value="ALL">All modules</option>
            {modules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={manager.filters.priority}
            onChange={(e) => manager.setFilters({ priority: e.target.value as never })}
            className="bg-elevated border border-line rounded-md px-2 py-1.5 text-[11px] text-ink"
            aria-label="Filter by priority"
          >
            <option value="ALL">All priorities</option>
            {ALERT_PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {ALERT_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <select
            value={manager.filters.timeframe}
            onChange={(e) => manager.setFilters({ timeframe: e.target.value as never })}
            className="bg-elevated border border-line rounded-md px-2 py-1.5 text-[11px] text-ink"
            aria-label="Filter by timeframe"
          >
            <option value="ALL">All timeframes</option>
            {TIMEFRAMES.map((tf) => (
              <option key={tf.key} value={tf.key}>
                {tf.label}
              </option>
            ))}
          </select>
          <select
            value={manager.filters.status}
            onChange={(e) => manager.setFilters({ status: e.target.value as never })}
            className="bg-elevated border border-line rounded-md px-2 py-1.5 text-[11px] text-ink"
            aria-label="Filter by status"
          >
            <option value="ALL">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {ALERT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <select
            value={manager.filters.since === null ? 'ALL' : String(manager.filters.since)}
            onChange={(e) =>
              manager.setFilters({ since: e.target.value === 'ALL' ? null : Number(e.target.value) })
            }
            className="bg-elevated border border-line rounded-md px-2 py-1.5 text-[11px] text-ink"
            aria-label="Filter by date"
          >
            <option value="ALL">Any time</option>
            <option value={String(Date.now() - 3_600_000)}>Last hour</option>
            <option value={String(Date.now() - 24 * 3_600_000)}>Last 24h</option>
            <option value={String(Date.now() - 7 * 24 * 3_600_000)}>Last 7 days</option>
          </select>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={manager.filters.unreadOnly}
              onChange={(e) => manager.setFilters({ unreadOnly: e.target.checked })}
              className="w-3.5 h-3.5 accent-sky-500"
            />
            Unread only
          </label>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={manager.filters.includeDismissed}
              onChange={(e) => manager.setFilters({ includeDismissed: e.target.checked })}
              className="w-3.5 h-3.5 accent-sky-500"
            />
            Show dismissed
          </label>
          <button
            type="button"
            onClick={manager.resetFilters}
            className="h-8 px-3 text-[11px] font-semibold text-muted bg-panel border border-line rounded-md hover:text-ink transition-colors cursor-pointer"
          >
            Reset
          </button>
          <span className="text-[11px] text-faint ml-auto">
            {manager.filtered.length} of {manager.alerts.length}
          </span>
        </div>
      </SectionCard>

      <div className="grid lg:grid-cols-2 gap-3">
        <SectionCard
          title="Accuracy by module"
          subtitle="Generated alerts vs. resolved outcomes (never conflated with executed trades)."
          icon={<History className="w-4 h-4" aria-hidden="true" />}
        >
          {manager.byModule.length === 0 ? (
            <div className="text-[11px] text-faint py-3 text-center">No alerts yet.</div>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-faint text-left">
                  <th className="py-1.5 pr-2 font-semibold">Module</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Alerts</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Resolved</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {manager.byModule.map((r) => (
                  <tr key={r.key} className="border-t border-line-soft">
                    <td className="py-1.5 pr-2 text-ink font-semibold truncate max-w-[180px]">{r.key}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">{r.total}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">{r.resolved}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-muted">
                      {r.accuracyPercent === null ? 'n/a' : `${r.accuracyPercent}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard
          title="Accuracy by index"
          subtitle="Where the alert layer is actually finding useful opportunities."
          icon={<AlertTriangle className="w-4 h-4" aria-hidden="true" />}
        >
          {manager.bySymbol.length === 0 ? (
            <div className="text-[11px] text-faint py-3 text-center">No alerts yet.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {manager.bySymbol.map((r) => (
                <StatusPill
                  key={r.key}
                  label={`${r.key} · ${r.total}${r.accuracyPercent === null ? '' : ` · ${r.accuracyPercent}%`}`}
                  className="bg-elevated text-muted border-line"
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {manager.filtered.length === 0 ? (
        <EmptyState
          icon={<BellRing className="w-6 h-6" aria-hidden="true" />}
          title="No alerts to show"
          description="The manager raises alerts only when a module publishes a verified, material development. Run a scan or open the analyser to begin monitoring."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {manager.filtered.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              precision={ws.precision}
              onOpen={openAlert}
              onRead={manager.markRead}
              onDismiss={manager.dismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}
