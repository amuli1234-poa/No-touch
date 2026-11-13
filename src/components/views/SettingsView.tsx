import React from 'react';
import { ScannerSettings, WhatsAppProviderStatus } from '../../types/scanner';
import { Sliders, RefreshCw, MessageSquare, ShieldCheck } from 'lucide-react';

interface SettingsViewProps {
  settings: ScannerSettings;
  onUpdateSettings: (next: ScannerSettings) => void;
  onReconnectWs: () => void;
  waStatus: WhatsAppProviderStatus;
  onRefreshWaStatus: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onUpdateSettings,
  onReconnectWs,
  waStatus,
  onRefreshWaStatus
}) => {
  const handleChange = <K extends keyof ScannerSettings>(key: K, value: ScannerSettings[K]) => {
    onUpdateSettings({
      ...settings,
      [key]: value
    });
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="rounded-xl border border-line/90 bg-surface p-5 space-y-6">
        <div className="flex items-center gap-2.5 border-b border-line pb-4">
          <Sliders className="w-5 h-5 text-accent-soft" />
          <div>
            <h2 className="text-base font-bold text-fg-1">Scanner & Strategy Configuration</h2>
            <p className="text-xs text-fg-4">
              Live Deriv WebSocket connection, confluence qualification gates, and WhatsApp alert automation.
            </p>
          </div>
        </div>

        {/* 1. Deriv WebSocket Connection */}
        <div className="space-y-3 pb-5 border-b border-line/80">
          <label className="text-[11px] font-mono font-bold uppercase tracking-wider text-fg-3 block">
            Deriv Live Feed Connection
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <span className="text-xs text-fg-4 block mb-1">Deriv App ID</span>
              <input
                type="number"
                value={settings.appId}
                onChange={(e) => handleChange('appId', parseInt(e.target.value, 10) || 1089)}
                className="w-full bg-surface-deepest border border-line rounded-lg px-3 py-2 text-xs text-fg-1 font-mono focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <span className="text-xs text-fg-4 block mb-1">Auto-Scan Interval (Seconds)</span>
              <select
                value={settings.autoRefreshIntervalSec}
                onChange={(e) => handleChange('autoRefreshIntervalSec', parseInt(e.target.value, 10))}
                className="w-full bg-surface-deepest border border-line rounded-lg px-3 py-2 text-xs text-fg-1 font-mono focus:border-accent focus:outline-none"
              >
                <option value={5}>5s (Ultra Responsive)</option>
                <option value={10}>10s (Standard)</option>
                <option value={15}>15s</option>
                <option value={30}>30s</option>
              </select>
            </div>

            <button
              type="button"
              onClick={onReconnectWs}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-surface-raised hover:bg-surface-elevated text-accent-cyan text-xs font-semibold rounded-lg border border-line-strong transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reconnect WebSocket</span>
            </button>
          </div>
        </div>

        {/* 2. Confluence & Price Action Thresholds */}
        <div className="space-y-4 pb-5 border-b border-line/80">
          <label className="text-[11px] font-mono font-bold uppercase tracking-wider text-fg-3 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-success" />
            <span>Strict Setup Validation & Confluence Gates</span>
          </label>

          <div>
            <div className="flex justify-between items-center text-xs mb-1">
              <span className="text-fg-3">Minimum Technical Confluence Score (Floor: 75%)</span>
              <span className="text-accent-soft font-mono font-bold tabular-nums">
                {Math.max(75, settings.minScoreThreshold)}%
              </span>
            </div>
            <input
              type="range"
              min={75}
              max={95}
              step={1}
              value={Math.max(75, settings.minScoreThreshold)}
              onChange={(e) => handleChange('minScoreThreshold', parseInt(e.target.value, 10))}
              className="w-full accent-accent cursor-pointer"
            />
            <p className="text-[11px] text-fg-5 mt-1">
              Confluence reflects multi-factor technical alignment, NOT a guaranteed win rate. Setups ≥75% still display WAIT if mandatory structure, M15 range, or M1 entry trigger fails.
            </p>
          </div>

          <div>
            <div className="flex justify-between items-center text-xs mb-1">
              <span className="text-fg-3">Minimum Fair Value Gap Imbalance Threshold</span>
              <span className="text-accent-soft font-mono font-bold tabular-nums">
                {(settings.fvgMinDisplacement * 100).toFixed(3)}%
              </span>
            </div>
            <input
              type="range"
              min={0.0001}
              max={0.001}
              step={0.00005}
              value={settings.fvgMinDisplacement}
              onChange={(e) => handleChange('fvgMinDisplacement', parseFloat(e.target.value))}
              className="w-full accent-accent cursor-pointer"
            />
          </div>
        </div>

        {/* 3. Alerts & WhatsApp Distribution */}
        <div className="space-y-4">
          <label className="text-[11px] font-mono font-bold uppercase tracking-wider text-fg-3 flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5 text-success" />
            <span>Alerts & Server-Side WhatsApp Delivery</span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex items-center justify-between p-3 rounded-lg bg-surface-deepest border border-line cursor-pointer">
              <div>
                <div className="text-xs font-semibold text-fg-2">Audible Signal Chime</div>
                <div className="text-[11px] text-fg-5">Chime on newly confirmed HIGH_QUALITY setups</div>
              </div>
              <input
                type="checkbox"
                checked={settings.soundAlerts}
                onChange={(e) => handleChange('soundAlerts', e.target.checked)}
                className="w-4 h-4 accent-accent"
              />
            </label>

            <label className="flex items-center justify-between p-3 rounded-lg bg-surface-deepest border border-line cursor-pointer">
              <div>
                <div className="text-xs font-semibold text-fg-2">Auto-Send Confirmed Signals to WhatsApp</div>
                <div className="text-[11px] text-fg-5">Dispatches only ≥75% setups passing all gates</div>
              </div>
              <input
                type="checkbox"
                checked={settings.whatsappAutoSend}
                onChange={(e) => handleChange('whatsappAutoSend', e.target.checked)}
                className="w-4 h-4 accent-success"
              />
            </label>

            <label className="flex items-center justify-between p-3 rounded-lg bg-surface-deepest border border-line cursor-pointer">
              <div>
                <div className="text-xs font-semibold text-fg-2">Notify Material Changes & Invalidations</div>
                <div className="text-[11px] text-fg-5">Sends follow-up alert if an active signal invalidates</div>
              </div>
              <input
                type="checkbox"
                checked={settings.whatsappNotifyUpdates}
                onChange={(e) => handleChange('whatsappNotifyUpdates', e.target.checked)}
                className="w-4 h-4 accent-success"
              />
            </label>

            <label className="flex items-center justify-between p-3 rounded-lg bg-surface-deepest border border-line cursor-pointer">
              <div>
                <div className="text-xs font-semibold text-fg-2">Show Secondary Indicators by Default</div>
                <div className="text-[11px] text-fg-5">EMA 20/50 and RSI/ADX sub-pane visibility</div>
              </div>
              <input
                type="checkbox"
                checked={settings.showSecondaryIndicators}
                onChange={(e) => handleChange('showSecondaryIndicators', e.target.checked)}
                className="w-4 h-4 accent-accent"
              />
            </label>
          </div>

          <div className="p-4 rounded-lg bg-surface-deepest border border-line text-xs space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono font-bold text-fg-2">
                Server Provider Status:{' '}
                <span className={waStatus.configured ? 'text-success' : 'text-warning'}>
                  {waStatus.configured
                    ? `ACTIVE (${waStatus.provider?.toUpperCase()} · ${waStatus.recipientMasked})`
                    : 'NOT CONFIGURED'}
                </span>
              </span>
              <button
                type="button"
                onClick={onRefreshWaStatus}
                className="px-2.5 py-1 rounded bg-surface-raised hover:bg-surface-elevated text-[11px] font-mono text-fg-2"
              >
                Re-check Server Env
              </button>
            </div>
            <p className="text-[11px] text-fg-4 leading-relaxed">
              Credentials stay strictly on the server via environment variables (<code className="text-accent-cyan">WHATSAPP_PROVIDER</code>, <code className="text-accent-cyan">WHATSAPP_RECIPIENT</code>, and Meta Cloud API / Twilio / CallMeBot / Webhook secrets). Never enter secrets in browser UI.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
