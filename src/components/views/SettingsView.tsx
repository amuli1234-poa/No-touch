import { BellRing, Palette, RotateCcw, Sliders } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import type { AccentMode, DirectionPreference } from '../../hooks/useAppSettings';
import { MANUAL_ACCENT_TO_STATUS, ACCENT_HUES } from '../../theme/accents';
import { notificationPermission, requestNotificationPermission } from '../../utils/notify';
import { Card, SectionCard } from '../ui/primitives';

const DIRECTION_OPTIONS: readonly { key: DirectionPreference; label: string; cls: string }[] = [
  { key: 'RISE', label: 'Rise', cls: 'bg-emerald-500' },
  { key: 'FALL', label: 'Fall', cls: 'bg-red-500' },
  { key: 'BOTH', label: 'Both', cls: 'bg-accent' },
] as const;

const ACCENT_OPTIONS: readonly { key: AccentMode; label: string }[] = [
  { key: 'auto', label: 'Auto (follows status)' },
  { key: 'blue', label: 'Blue — AI analysis' },
  { key: 'green', label: 'Green — bullish' },
  { key: 'red', label: 'Red — bearish' },
  { key: 'purple', label: 'Purple — training' },
  { key: 'orange', label: 'Orange — developing' },
] as const;

const OVERLAY_LABELS: Record<string, string> = {
  supportResistance: 'Support & Resistance',
  supplyDemand: 'Supply & Demand Zones',
  trendlines: 'Trendlines',
  patterns: 'Chart Patterns',
  structureBreaks: 'BOS / CHOCH Markers',
  liquiditySweeps: 'Liquidity Sweeps',
  swingLabels: 'Swing Labels (HH / HL / LH / LL)',
  entryLevels: 'Entry / TP / SL Levels',
  entryZone: 'High-Probability Entry Zone',
  rangeZones: 'Sideways Range Zones (Support / Resistance / Equilibrium)',
  targets: 'Target 1 / Target 2 Levels',
  structureZones: 'Structure: Future Reaction Zones (WATCH RISE / FALL)',
  fvgZones: 'Structure: Fair Value Gaps (Imbalances)',
  showTestedZones: 'Structure: Show Tested & Mitigated Zones',
  legends: 'On-chart Legends',
};

const OVERLAY_DESCRIPTIONS: Record<string, string> = {
  structureZones: 'Fresh support/resistance & rejection zones the engine is watching',
  fvgZones: 'Unfilled three-candle imbalances price may return to (removed once filled)',
  showTestedZones: 'Also draw zones already probed or mitigated (usually hidden)',
};

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-start justify-between gap-3 py-2.5 border-b border-line-soft last:border-0 cursor-pointer">
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        {description && (
          <span className="block text-[12px] text-faint leading-snug">{description}</span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onChange}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          checked ? 'bg-emerald-500' : 'bg-line'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-ink transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </button>
    </label>
  );
}

export function SettingsView() {
  const ws = useWorkspace();

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[820px] w-full mx-auto">
      <Card className="p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="p-2 rounded-lg bg-elevated text-muted">
            <Sliders className="w-4 h-4" />
          </span>
          <div>
            <h1 className="text-lg font-extrabold tracking-tight text-ink">Settings</h1>
            <p className="text-xs text-faint">
              Signal filters, chart preferences and application configuration. Market analysis is
              driven purely by price action, structure and momentum.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={ws.resetSettings}
          className="inline-flex items-center gap-1.5 h-9 px-3 text-xs font-semibold text-muted bg-surface border border-line rounded-md hover:bg-elevated cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </button>
      </Card>

      <SectionCard title="Trade Direction Preference" subtitle="Restrict the Chart Analyser to one direction or allow both">
        <div className="inline-flex items-center gap-0.5 p-1 bg-elevated rounded-lg border border-line">
          {DIRECTION_OPTIONS.map((opt) => {
            const active = ws.settings.directionPreference === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => ws.setDirectionPreference(opt.key)}
                aria-pressed={active}
                className={`min-h-[34px] px-4 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  active ? `${opt.cls} text-app ` : 'text-muted hover:text-ink hover:bg-surface'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="Signal Quality Filter"
        subtitle="Minimum setup quality required to present a signal — and to trade it automatically"
      >
        <div className="inline-flex items-center gap-0.5 p-1 bg-elevated rounded-lg border border-line">
          {(
            [
              { key: 'ANY', label: 'Any' },
              { key: 'MODERATE', label: 'Moderate+' },
              { key: 'HIGH', label: 'High only' },
            ] as const
          ).map((opt) => {
            const active = ws.settings.minQuality === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => ws.setMinQuality(opt.key)}
                aria-pressed={active}
                className={`min-h-[34px] px-4 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  active ? 'bg-accent text-app ' : 'text-muted hover:text-ink hover:bg-surface'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="text-[12px] text-faint mt-2">
          The engine still computes every setup; this filter only affects which confirmed setups
          are surfaced as actionable — and, because the automatic trader acts on exactly the
          signals you are shown, which ones it may enter on your behalf. It never fabricates or
          downgrades a signal.
        </p>
      </SectionCard>

      <SectionCard title="Chart Overlays" subtitle="Control which analysis drawings appear on the live chart">
        {Object.entries(OVERLAY_LABELS).map(([key, label]) => (
          <ToggleRow
            key={key}
            label={label}
            description={OVERLAY_DESCRIPTIONS[key]}
            checked={ws.settings.overlays[key as keyof typeof ws.settings.overlays]}
            onChange={() => ws.toggleOverlay(key as keyof typeof ws.settings.overlays)}
          />
        ))}
      </SectionCard>

      <SectionCard
        title="Appearance"
        subtitle="Theme and the accent colour that tracks the live system status"
      >
        <div className="flex items-center justify-between gap-3 py-2.5 border-b border-line-soft">
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-ink">Theme</span>
            <span className="block text-[12px] text-faint leading-snug">
              Switch between the dark trading terminal and a light workspace.
            </span>
          </span>
          <div className="inline-flex items-center gap-0.5 p-0.5 bg-elevated rounded-lg border border-line shrink-0">
            {(['dark', 'light'] as const).map((mode) => {
              const active = ws.settings.theme === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => ws.setTheme(mode)}
                  aria-pressed={active}
                  className={`h-7 px-3 text-[12px] font-bold rounded-md capitalize transition-colors cursor-pointer ${
                    active ? 'bg-accent text-app' : 'text-muted hover:text-ink hover:bg-surface'
                  }`}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </div>

        <div className="py-2.5">
          <div className="flex items-center gap-2 mb-2">
            <Palette className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
            <span className="text-xs font-semibold text-ink">Accent colour</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ACCENT_OPTIONS.map((opt) => {
              const active = ws.settings.accentMode === opt.key;
              const swatch =
                opt.key === 'auto' ? '#38bdf8' : ACCENT_HUES[MANUAL_ACCENT_TO_STATUS[opt.key]].dark;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => ws.setAccentMode(opt.key)}
                  aria-pressed={active}
                  className={`flex items-center gap-2 h-9 px-2.5 rounded-lg border text-[12px] font-semibold transition-colors cursor-pointer ${
                    active
                      ? 'border-accent/60 bg-accent/12 text-ink glow-accent'
                      : 'border-line bg-panel text-muted hover:text-ink hover:border-accent/40'
                  }`}
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full border border-black/20 shrink-0"
                    style={{
                      background:
                        opt.key === 'auto'
                          ? 'conic-gradient(from 0deg, #38bdf8, #22c55e, #f59e0b, #ef4444, #a78bfa, #38bdf8)'
                          : swatch,
                    }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{opt.label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-faint mt-2 leading-snug">
            In Auto mode the whole interface shifts hue with the live state: green for a
            confirmed bullish setup, red for bearish, blue while analysing, purple while
            training and amber for a developing setup.
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Layout" subtitle="Adjust the chart workspace">
        <ToggleRow
          label="Compact chart height"
          description="Reduce the chart height on smaller laptop screens."
          checked={ws.settings.compactChart}
          onChange={() => ws.setCompactChart(!ws.settings.compactChart)}
        />
      </SectionCard>

      <SectionCard title="Notifications" subtitle="Sound, desktop and voice alerts for confirmed and validated signals">
        <ToggleRow
          label="Signal sound"
          description="Play a short chime when either engine confirms a setup, or when both engines validate one."
          checked={ws.settings.soundEnabled}
          onChange={() => ws.setSoundEnabled(!ws.settings.soundEnabled)}
        />
        <ToggleRow
          label="In-app signal toasts"
          description="Show a dismissible card (and a desktop notification where permitted) whenever a new setup is confirmed. Clicking a toast opens its exact chart."
          checked={ws.settings.notificationsEnabled}
          onChange={() => {
            const next = !ws.settings.notificationsEnabled;
            ws.setNotificationsEnabled(next);
            if (next) void requestNotificationPermission();
          }}
        />
        <ToggleRow
          label="Spoken signal alerts"
          description="Read new confirmed setups aloud using the browser speech engine. Off by default."
          checked={ws.settings.voiceEnabled}
          onChange={() => ws.setVoiceEnabled(!ws.settings.voiceEnabled)}
        />
        <div className="flex items-center justify-between gap-3 py-2.5 border-b border-line-soft">
          <span className="min-w-0">
            <span className="block text-xs font-semibold text-ink">Chime volume</span>
            <span className="block text-[12px] text-faint leading-snug">
              {ws.settings.soundVolume}% · scales every signal alert.
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={ws.settings.soundVolume}
            onChange={(e) => ws.setSoundVolume(Number(e.target.value))}
            aria-label="Chime volume"
            className="w-40 accent-[var(--color-accent)] cursor-pointer"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <button
            type="button"
            onClick={() => ws.playSignalSound('validated')}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-[12px] font-semibold text-ink bg-elevated border border-line rounded-md hover:border-accent/50 cursor-pointer"
          >
            <BellRing className="w-3.5 h-3.5" aria-hidden="true" />
            Test validated chime
          </button>
          <button
            type="button"
            onClick={() => ws.playSignalSound('scanner')}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-[12px] font-semibold text-muted bg-elevated border border-line rounded-md hover:text-ink cursor-pointer"
          >
            Test scanner chime
          </button>
          <span className="text-[11px] text-faint">
            Desktop permission:{' '}
            <span className="font-mono">{notificationPermission()}</span>
          </span>
        </div>
      </SectionCard>

      <SectionCard title="Connection" subtitle="Deriv market-data feed">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-ink">
              Status:{' '}
              <span
                className={
                  ws.connectionStatus === 'connected'
                    ? 'text-emerald-400'
                    : ws.connectionStatus === 'error'
                      ? 'text-bear'
                      : 'text-warn'
                }
              >
                {ws.connectionStatus.toUpperCase()}
              </span>
            </div>
            <div className="text-[12px] text-faint">
              {ws.connectionError?.message ?? 'Live WebSocket feed to Deriv synthetic indices.'}
            </div>
          </div>
          <button
            type="button"
            onClick={ws.reconnect}
            className="h-9 px-3 text-xs font-semibold text-app bg-accent rounded-md hover:bg-accent-soft cursor-pointer"
          >
            Reconnect
          </button>
        </div>
      </SectionCard>
    </div>
  );
}
