import { Activity, Brain, Cpu, GraduationCap, Radio, ShieldCheck, Zap } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { ACCENT_HUES } from '../../theme/accents';
import { SIGNAL_STATUS_STYLE } from '../../utils/signalStatus';

/**
 * AI LIVE STATUS strip. It reports, at a glance, what the engines are doing right now
 * and re-tints with the live system status accent (blue analysing, purple training,
 * green confirmed, amber developing, red invalidated).
 */
export function AiLiveStatus() {
  const ws = useWorkspace();
  const lifecycle = ws.lifecycle;
  const style = lifecycle ? SIGNAL_STATUS_STYLE[lifecycle.status] : null;
  const trainingRunning = ws.training.progress.status === 'RUNNING';

  const activity: { label: string; value: string; tone: string; icon: typeof Activity }[] = [
    {
      label: 'Analyser',
      value: ws.isAnalyzing ? 'Analysing…' : ws.report ? 'Idle · report ready' : 'Standby',
      tone: ws.isAnalyzing ? 'text-accent' : 'text-muted',
      icon: Cpu,
    },
    {
      label: 'Scanner',
      value: ws.isScanning ? `Scanning ${ws.scanProgress}%` : 'Idle',
      tone: ws.isScanning ? 'text-accent' : 'text-muted',
      icon: Radio,
    },
    {
      label: 'Training',
      value: trainingRunning
        ? `Training ${ws.training.progressPercent}%`
        : ws.training.result
          ? 'Model ready'
          : 'Not trained',
      tone: trainingRunning ? 'text-violet' : 'text-muted',
      icon: GraduationCap,
    },
    {
      label: 'Feed',
      value:
        ws.connectionStatus === 'connected'
          ? ws.feedStale
            ? 'Live · stale'
            : 'Live'
          : ws.connectionStatus,
      tone:
        ws.connectionStatus === 'connected' && !ws.feedStale
          ? 'text-emerald-400'
          : 'text-warn',
      icon: Zap,
    },
  ];

  return (
    <section
      aria-label="AI live status"
      className="relative overflow-hidden bg-surface border border-line rounded-xl"
    >
      <div
        className="absolute inset-x-0 top-0 h-px shimmer-line"
        aria-hidden="true"
      />
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative inline-flex items-center justify-center w-9 h-9 rounded-xl bg-accent/12 text-accent border border-accent/30">
            <Brain className="w-4 h-4" aria-hidden="true" />
            {ws.isAnalyzing && (
              <span
                className="absolute inset-0 rounded-xl bg-accent/25 animate-radar-pulse"
                aria-hidden="true"
              />
            )}
          </span>
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-faint">
              AI live status
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`text-sm font-extrabold tracking-tight ${style?.text ?? 'text-ink'}`}
              >
                {lifecycle?.label ?? 'STANDBY'}
              </span>
              {style && (
                <span className={`w-1.5 h-1.5 rounded-full ${style.dot} animate-pulse`} aria-hidden="true" />
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 ml-auto">
          {activity.map((a) => {
            const Icon = a.icon;
            return (
              <div key={a.label} className="flex items-center gap-1.5">
                <Icon className={`w-3.5 h-3.5 ${a.tone}`} aria-hidden="true" />
                <div className="leading-tight">
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-faint">
                    {a.label}
                  </div>
                  <div className={`text-[11px] font-bold ${a.tone}`}>{a.value}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {lifecycle && (
        <div className="px-4 pb-3 -mt-1">
          <p className="text-[11px] text-muted leading-relaxed">{lifecycle.description}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-[10px]">
        {(['bullish', 'bearish', 'analysis', 'training', 'warning'] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1 text-faint">
            <span
              className="w-2.5 h-2.5 rounded-full border border-black/10"
              style={{ backgroundColor: ACCENT_HUES[s].dark }}
              aria-hidden="true"
            />
            {ACCENT_HUES[s].label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1 ml-auto text-faint">
          <ShieldCheck className="w-3 h-3" aria-hidden="true" />
          Accent follows system status
        </span>
      </div>
    </section>
  );
}
