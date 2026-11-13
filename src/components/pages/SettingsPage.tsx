import React from 'react';
import { ScannerSettings } from '../../types/scanner';
import { DisplayPreferences } from '../../types/preferences';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  SectionTitle,
  SegmentedControl,
  Select,
  Toggle
} from '../ui';
import { TONE_HEX } from '../ui/format';
import {
  Sliders,
  Zap,
  Shield,
  RefreshCw,
  Volume2,
  Monitor,
  Layers,
  Info,
  Wifi,
  Gauge
} from 'lucide-react';

interface SettingsPageProps {
  settings: ScannerSettings;
  onUpdateSettings: (settings: ScannerSettings) => void;
  display: DisplayPreferences;
  onUpdateDisplay: (prefs: DisplayPreferences) => void;
  onReconnectWs: () => void;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  symbolCount: number;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  settings,
  onUpdateSettings,
  display,
  onUpdateDisplay,
  onReconnectWs,
  connectionState,
  symbolCount
}) => {
  const set = <K extends keyof ScannerSettings>(key: K, value: ScannerSettings[K]) =>
    onUpdateSettings({ ...settings, [key]: value });

  const setDisplay = <K extends keyof DisplayPreferences>(key: K, value: DisplayPreferences[K]) =>
    onUpdateDisplay({ ...display, [key]: value });

  return (
    <div className="space-y-5">
      <SectionTitle
        eyebrow="Configuration"
        title="Settings"
        description="Scanner, expiry, scoring and display preferences. Changes apply immediately and persist locally."
        actions={
          <Badge tone={connectionState === 'CONNECTED' ? 'success' : 'warning'} dot>
            Feed {connectionState.toLowerCase()}
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Connection */}
        <Card>
          <CardHeader
            icon={<Wifi className="h-4 w-4" />}
            title="Deriv connection"
            subtitle="WebSocket endpoint configuration"
          />
          <div className="space-y-4 p-4">
            <Field
              label="Deriv App ID"
              hint="The public sandbox ID is 1089. Changing this reconnects the feed."
            >
              <input
                type="number"
                value={settings.appId}
                onChange={(e) => set('appId', parseInt(e.target.value, 10) || 1089)}
                className="h-9 w-full rounded-[10px] border border-line bg-surface-deepest px-3 font-mono text-[13px] text-fg-1 transition-colors hover:border-line-strong focus:border-accent focus:outline-none"
              />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line-soft bg-surface-deep px-3 py-2.5">
              <div className="text-[11.5px] text-fg-4">
                <span className="block font-medium text-fg-3">Connection status</span>
                <span className="tabular">
                  {symbolCount} synthetic markets tracked
                </span>
              </div>
              <Button
                size="sm"
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={onReconnectWs}
              >
                Reconnect
              </Button>
            </div>
          </div>
        </Card>

        {/* Scanner */}
        <Card>
          <CardHeader
            icon={<Layers className="h-4 w-4" />}
            title="Scanner configuration"
            subtitle="Market selection and scan cadence"
          />
          <div className="space-y-4 p-4">
            <Field label="Markets included in scans">
              <Select
                value={settings.filterMarket}
                onChange={(e) =>
                  set('filterMarket', e.target.value as ScannerSettings['filterMarket'])
                }
                options={[
                  { value: 'ALL', label: 'All synthetic markets' },
                  { value: 'STANDARD', label: 'Standard markets only' },
                  { value: '1S', label: '1-second markets only' }
                ]}
              />
            </Field>
            <Field label="Automatic scan interval" hint="How often the scanner re-evaluates all markets.">
              <Select
                value={String(settings.autoRefreshIntervalSec)}
                onChange={(e) => set('autoRefreshIntervalSec', parseInt(e.target.value, 10))}
                options={[5, 10, 15, 30, 60].map((s) => ({
                  value: String(s),
                  label: `${s} seconds`
                }))}
              />
            </Field>
          </div>
        </Card>

        {/* Expiry engine */}
        <Card>
          <CardHeader
            icon={<Zap className="h-4 w-4" />}
            title="Dual expiry engine"
            subtitle="Contract horizon selection strategy"
          />
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ExpiryOption
                active={settings.expiryMode === 'AUTO'}
                icon={<Zap className="h-4 w-4" />}
                title="Automatic expiry"
                description="Autonomously selects the duration maximising path survival and positive expectation."
                onClick={() => set('expiryMode', 'AUTO')}
              />
              <ExpiryOption
                active={settings.expiryMode === 'FIXED'}
                icon={<Shield className="h-4 w-4" />}
                title="Fixed duration"
                description="Evaluates every setup against a predetermined contract horizon."
                onClick={() => set('expiryMode', 'FIXED')}
              />
            </div>
            {settings.expiryMode === 'FIXED' && (
              <Field label="Fixed duration">
                <Select
                  value={String(settings.fixedDurationMinutes)}
                  onChange={(e) => set('fixedDurationMinutes', parseInt(e.target.value, 10))}
                  options={[
                    { value: '2', label: '2 minutes' },
                    { value: '3', label: '3 minutes' },
                    { value: '5', label: '5 minutes (default strategy)' },
                    { value: '10', label: '10 minutes' },
                    { value: '15', label: '15 minutes' }
                  ]}
                />
              </Field>
            )}
          </div>
        </Card>

        {/* Scoring */}
        <Card>
          <CardHeader
            icon={<Gauge className="h-4 w-4" />}
            title="Scoring & imbalance filters"
            subtitle="Qualification threshold and displacement sensitivity"
          />
          <div className="space-y-5 p-4">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium text-fg-3">
                  Minimum qualification score
                </span>
                <span className="tabular text-[13px] font-bold" style={{ color: TONE_HEX.accent }}>
                  {settings.minScoreThreshold}%
                </span>
              </div>
              <input
                type="range"
                min={80}
                max={95}
                step={1}
                value={settings.minScoreThreshold}
                onChange={(e) => set('minScoreThreshold', parseInt(e.target.value, 10))}
                className="w-full cursor-pointer accent-accent"
              />
              <div className="mt-1 flex justify-between text-[10px] text-fg-5">
                <span>80% · watchlist</span>
                <span>90% · strict</span>
                <span>95% · elite</span>
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-medium text-fg-3">
                  FVG minimum imbalance size
                </span>
                <span className="tabular text-[13px] font-bold" style={{ color: TONE_HEX.info }}>
                  {(settings.fvgMinDisplacement * 100).toFixed(2)}%
                </span>
              </div>
              <input
                type="range"
                min={0.0001}
                max={0.001}
                step={0.00005}
                value={settings.fvgMinDisplacement}
                onChange={(e) => set('fvgMinDisplacement', parseFloat(e.target.value))}
                className="w-full cursor-pointer accent-accent-cyan"
              />
              <p className="mt-1 text-[11px] text-fg-5">
                Filters out micro-noise gaps that lack institutional displacement.
              </p>
            </div>
          </div>
        </Card>

        {/* Display */}
        <Card>
          <CardHeader
            icon={<Monitor className="h-4 w-4" />}
            title="Display preferences"
            subtitle="Workspace presentation"
          />
          <div className="space-y-4 p-4">
            <Field label="Default chart timeframe" hint="The timeframe the chart workspace opens on.">
              <SegmentedControl
                options={['1m', '2m', '5m', '15m', '1h'] as const}
                value={display.defaultTimeframe}
                onChange={(tf) => setDisplay('defaultTimeframe', tf)}
                size="md"
              />
            </Field>
            <Field label="Table density">
              <SegmentedControl
                options={['comfortable', 'compact'] as const}
                value={display.density}
                onChange={(v) => setDisplay('density', v)}
                labels={{ comfortable: 'Comfortable', compact: 'Compact' }}
                size="md"
              />
            </Field>
            <SettingToggle
              icon={<Sliders className="h-4 w-4" />}
              label="Live path monitor"
              description="Show the in-flight contract excursion strip on the scanner page."
              checked={display.showPathMonitor}
              onChange={(v) => setDisplay('showPathMonitor', v)}
            />
          </div>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader
            icon={<Volume2 className="h-4 w-4" />}
            title="Notifications"
            subtitle="Alerts for qualified setups"
          />
          <div className="space-y-4 p-4">
            <SettingToggle
              icon={<Volume2 className="h-4 w-4" />}
              label="Sound alerts"
              description="Play an audible tone when a new setup crosses the qualification threshold."
              checked={settings.soundAlerts}
              onChange={(v) => set('soundAlerts', v)}
            />
          </div>
        </Card>

        {/* Application info */}
        <Card className="lg:col-span-2">
          <CardHeader
            icon={<Info className="h-4 w-4" />}
            title="Application information"
            subtitle="Build and engine details"
          />
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <InfoRow label="Product" value="Deriv No Touch Scanner" />
            <InfoRow label="Version" value="V4.0 PRO" />
            <InfoRow label="Model" value="2m displacement / 5m alignment" />
            <InfoRow label="Storage" value="IndexedDB (local)" />
            <InfoRow label="Qualification gates" value="7-step mandatory sequence" />
            <InfoRow label="Scoring model" value="7-component weighted (100)" />
            <InfoRow label="Settlement" value="Live path-dependent tracking" />
            <InfoRow label="Data source" value="Deriv WebSocket API" />
          </div>
        </Card>
      </div>
    </div>
  );
};

const ExpiryOption: React.FC<{
  active: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}> = ({ active, icon, title, description, onClick }) => (
  <button
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-[10px] border p-3 text-left transition-colors ${
      active
        ? 'border-accent/50 bg-accent/10'
        : 'border-line bg-surface-deep hover:border-line-strong'
    }`}
  >
    <div className={`flex items-center gap-2 text-[12.5px] font-semibold ${active ? 'text-fg-1' : 'text-fg-3'}`}>
      <span style={{ color: active ? TONE_HEX.accent : TONE_HEX.neutral }}>{icon}</span>
      {title}
    </div>
    <p className="mt-1.5 text-[11px] leading-relaxed text-fg-5">{description}</p>
  </button>
);

const SettingToggle: React.FC<{
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ icon, label, description, checked, onChange }) => (
  <div className="flex items-start justify-between gap-4">
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-0.5 text-fg-5">{icon}</span>
      <div>
        <div className="text-[12.5px] font-medium text-fg-2">{label}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-fg-5">{description}</div>
      </div>
    </div>
    <Toggle checked={checked} onChange={onChange} label={label} />
  </div>
);

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-3 border-b border-line-soft pb-2">
    <span className="text-[11.5px] text-fg-5">{label}</span>
    <span className="text-[11.5px] font-medium text-fg-2">{value}</span>
  </div>
);
