import React from 'react';
import { ScannerSettings } from '../types/scanner';
import { Sliders, Shield, Zap, RefreshCw, X } from 'lucide-react';

interface ScannerSettingsModalProps {
  settings: ScannerSettings;
  onUpdateSettings: (newSettings: ScannerSettings) => void;
  onClose: () => void;
  onReconnectWs: () => void;
}

export const ScannerSettingsModal: React.FC<ScannerSettingsModalProps> = ({
  settings,
  onUpdateSettings,
  onClose,
  onReconnectWs
}) => {
  const handleChange = <K extends keyof ScannerSettings>(key: K, value: ScannerSettings[K]) => {
    onUpdateSettings({
      ...settings,
      [key]: value
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#0c121e] border border-slate-800 rounded-2xl max-w-xl w-full overflow-hidden shadow-2xl space-y-0">
        {/* Header */}
        <div className="p-5 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <Sliders className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-bold text-white tracking-wide">
              Scanner & Strategy Parameters
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-6 space-y-6 text-xs max-h-[75vh] overflow-y-auto font-sans">
          {/* 1. Deriv Connection Config */}
          <div className="space-y-3 pb-4 border-b border-slate-800/80">
            <label className="text-slate-300 font-bold uppercase tracking-wider block font-mono text-[11px]">
              Deriv WebSocket Connection
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <span className="text-slate-400 block mb-1">Deriv App ID</span>
                <input
                  type="number"
                  value={settings.appId}
                  onChange={(e) => handleChange('appId', parseInt(e.target.value) || 1089)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-white font-mono focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  Public sandbox ID: 1089
                </span>
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={onReconnectWs}
                  className="w-full flex items-center justify-center space-x-1.5 p-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 font-semibold rounded-lg border border-indigo-500/30 transition"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Reconnect WebSocket</span>
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-b border-slate-800/80 pb-4">
            <label className="text-slate-400">Markets included in scans
              <select value={settings.filterMarket} onChange={(e) => handleChange('filterMarket', e.target.value as ScannerSettings['filterMarket'])} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-white">
                <option value="ALL">All synthetic markets</option><option value="STANDARD">Standard markets</option><option value="1S">1-second markets</option>
              </select>
            </label>
            <label className="text-slate-400">Automatic scan interval
              <select value={settings.autoRefreshIntervalSec} onChange={(e) => handleChange('autoRefreshIntervalSec', parseInt(e.target.value, 10))} className="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-white">
                {[5, 10, 15, 30, 60].map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
              </select>
            </label>
          </div>

          {/* 2. Expiry Mode Selection */}
          <div className="space-y-3 pb-4 border-b border-slate-800/80">
            <label className="text-slate-300 font-bold uppercase tracking-wider block font-mono text-[11px]">
              Dual Expiry Mode Engine
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleChange('expiryMode', 'AUTO')}
                className={`p-3 rounded-xl border text-left transition ${
                  settings.expiryMode === 'AUTO'
                    ? 'bg-indigo-950/60 border-indigo-500 text-white shadow-sm'
                    : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold flex items-center space-x-1.5">
                  <Zap className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Automatic Expiry</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-1 font-normal leading-relaxed">
                  Autonomously selects the duration maximizing path survival & positive expectation.
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleChange('expiryMode', 'FIXED')}
                className={`p-3 rounded-xl border text-left transition ${
                  settings.expiryMode === 'FIXED'
                    ? 'bg-indigo-950/60 border-indigo-500 text-white shadow-sm'
                    : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold flex items-center space-x-1.5">
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Fixed Duration</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-1 font-normal leading-relaxed">
                  Evaluates setups against a predetermined contract horizon (e.g. 5 minutes).
                </div>
              </button>
            </div>

            {settings.expiryMode === 'FIXED' && (
              <div className="pt-2">
                <span className="text-slate-400 block mb-1">Fixed Duration (Minutes)</span>
                <select
                  value={settings.fixedDurationMinutes}
                  onChange={(e) => handleChange('fixedDurationMinutes', parseInt(e.target.value))}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-white font-mono focus:border-indigo-500 focus:outline-none"
                >
                  <option value={2}>2 Minutes</option>
                  <option value={3}>3 Minutes</option>
                  <option value={5}>5 Minutes (Default Strategy)</option>
                  <option value={10}>10 Minutes</option>
                  <option value={15}>15 Minutes</option>
                </select>
              </div>
            )}
          </div>

          {/* 3. Scoring & Strategy Sensitivity */}
          <div className="space-y-4 pb-4 border-b border-slate-800/80">
            <label className="text-slate-300 font-bold uppercase tracking-wider block font-mono text-[11px]">
              Scoring & Imbalance Filters
            </label>

            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-slate-300">Minimum Qualification Score</span>
                <span className="text-indigo-400 font-mono font-bold">
                  {settings.minScoreThreshold}%
                </span>
              </div>
              <input
                type="range"
                min={80}
                max={95}
                step={1}
                value={settings.minScoreThreshold}
                onChange={(e) => handleChange('minScoreThreshold', parseInt(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-slate-500 font-mono mt-0.5">
                <span>80% (Watchlist)</span>
                <span>90% (Strict Strategy)</span>
                <span>95% (Elite Only)</span>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-slate-300">FVG Minimum Imbalance Size</span>
                <span className="text-cyan-400 font-mono font-bold">
                  {(settings.fvgMinDisplacement * 100).toFixed(2)}%
                </span>
              </div>
              <input
                type="range"
                min={0.0001}
                max={0.0010}
                step={0.00005}
                value={settings.fvgMinDisplacement}
                onChange={(e) => handleChange('fvgMinDisplacement', parseFloat(e.target.value))}
                className="w-full accent-cyan-500 cursor-pointer"
              />
              <span className="text-[10px] text-slate-500 mt-0.5 block">
                Filters out micro-noise gaps lacking institutional displacement.
              </span>
            </div>
          </div>

          {/* 4. Audio Alerts & Notifications */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-slate-200 font-semibold block">Sound Alerts for Qualified Setups</span>
              <span className="text-slate-500 text-[11px] block">
                Play an audible tone when a new 90%+ setup is confirmed.
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleChange('soundAlerts', !settings.soundAlerts)}
              className={`w-11 h-6 rounded-full transition-colors relative ${
                settings.soundAlerts ? 'bg-indigo-600' : 'bg-slate-800'
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                  settings.soundAlerts ? 'left-6' : 'left-1'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950/80 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow-md shadow-indigo-600/20 transition"
          >
            Apply & Save
          </button>
        </div>
      </div>
    </div>
  );
};
