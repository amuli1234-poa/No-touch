import React from 'react';
import { Button, Card } from '../ui';
import { TONE_HEX } from '../ui/format';
import {
  ArrowRight,
  ShieldCheck,
  BarChart3,
  Zap,
  Activity,
  Layers,
  Crosshair,
  LineChart
} from 'lucide-react';

interface OverviewPageProps {
  onEnterScanner: () => void;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  symbolCount: number;
}

const FEATURES: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <Layers className="h-4 w-4" />,
    title: 'Structure-aware scanning',
    body: 'Market pivots, liquidity sweeps and directional context combined into one read across every synthetic index.'
  },
  {
    icon: <Crosshair className="h-4 w-4" />,
    title: 'Imbalance qualification',
    body: 'A strict seven-step sequence gates every setup on displacement, CHoCH confirmation and a clean fair value gap.'
  },
  {
    icon: <BarChart3 className="h-4 w-4" />,
    title: 'Adaptive barrier risk',
    body: 'First-passage survival probability and live Deriv proposals inform an adaptive No Touch barrier recommendation.'
  },
  {
    icon: <Activity className="h-4 w-4" />,
    title: 'Path-dependent tracking',
    body: 'Every qualified setup is monitored tick-by-tick to settlement and recorded against realised outcomes.'
  }
];

export const OverviewPage: React.FC<OverviewPageProps> = ({
  onEnterScanner,
  connectionState,
  symbolCount
}) => (
  <div className="relative min-h-screen overflow-hidden bg-app">
    <div className="surface-grid pointer-events-none absolute inset-0 opacity-[0.35]" />
    <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-accent/10 blur-[120px]" />

    <div className="relative z-10 mx-auto max-w-6xl px-5 pb-20 pt-14 sm:px-8 lg:pt-24">
      {/* Hero */}
      <div className="flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[11px] font-semibold text-fg-3">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: connectionState === 'CONNECTED' ? TONE_HEX.success : TONE_HEX.warning }}
          />
          {connectionState === 'CONNECTED'
            ? `${symbolCount} synthetic markets streaming`
            : 'Connecting to market feed…'}
        </div>

        <h1 className="mt-6 max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-[-0.03em] text-fg-1 sm:text-5xl lg:text-6xl">
          Read the market with
          <span className="block bg-gradient-to-r from-accent-strong via-accent-strong to-accent-cyan bg-clip-text text-transparent">
            institutional clarity.
          </span>
        </h1>

        <p className="mt-5 max-w-2xl text-[14.5px] leading-relaxed text-fg-4 sm:text-base">
          A focused analytics workspace for Deriv synthetic indices — multi-timeframe structure,
          liquidity and imbalance analysis, and adaptive No Touch barrier risk in one professional
          environment.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button variant="primary" size="md" onClick={onEnterScanner} className="h-10 px-5 text-[13.5px]">
            Enter live scanner
            <ArrowRight className="h-4 w-4" />
          </Button>
          <span className="inline-flex items-center gap-2 text-[12px] text-fg-5">
            <ShieldCheck className="h-4 w-4 text-success" />
            Analysis tools for informed review
          </span>
        </div>
      </div>

      {/* Preview panel */}
      <div className="mx-auto mt-14 w-full max-w-3xl">
        <Card variant="elevated" className="overflow-hidden p-1.5">
          <div className="rounded-[10px] border border-line bg-surface-deep p-4">
            <div className="flex items-center justify-between border-b border-line-soft pb-3">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-gradient-to-br from-accent to-accent-cyan">
                  <Activity className="h-4 w-4 text-on-accent" />
                </span>
                <span className="text-[12px] font-bold text-fg-1">MARKET OVERVIEW</span>
              </div>
              <span className="rounded-md border border-line bg-surface-raised px-2 py-0.5 text-[10px] font-semibold text-fg-4">
                SAMPLE VIEW
              </span>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2.5">
              {[
                ['MARKETS', symbolCount || 20, TONE_HEX.info],
                ['QUALIFIED', '04', TONE_HEX.success],
                ['WATCHLIST', '07', TONE_HEX.warning]
              ].map(([label, value, color]) => (
                <div key={label as string} className="rounded-[10px] border border-line-soft bg-surface p-3">
                  <div className="text-[9.5px] font-semibold tracking-wider text-fg-5">
                    {label}
                  </div>
                  <div className="tabular mt-1.5 text-[20px] font-bold" style={{ color: color as string }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-2.5 rounded-[10px] border border-line-soft bg-surface p-3.5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[12px] font-bold text-fg-2">
                    R_100 <span className="font-normal text-fg-5">Volatility 100 Index</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-fg-5">2m structure · 5m confirmation</div>
                </div>
                <div className="text-right">
                  <div className="tabular text-[13px] font-bold text-fg-1">8,426.18</div>
                  <div className="text-[10px] text-success">+0.42%</div>
                </div>
              </div>
              <div className="relative mt-4 h-32 overflow-hidden rounded-[8px] bg-app px-2 pt-4">
                <div className="absolute inset-x-2 top-1/2 border-t border-dashed border-line" />
                <div className="absolute inset-x-2 top-[28%] border-t border-dashed border-danger/40" />
                <div className="absolute right-2 top-[21%] rounded bg-danger/10 px-1.5 py-0.5 text-[8px] font-semibold text-danger">
                  BARRIER
                </div>
                <div className="flex h-full items-end gap-1.5 px-1">
                  {[33, 45, 40, 57, 49, 62, 54, 70, 61, 75, 65, 81, 72, 88, 76, 94, 82, 90, 73, 85, 68, 79, 62, 72, 58, 70, 55, 65, 48, 60, 52, 69, 58, 76].map(
                    (h, i) => (
                      <div
                        key={i}
                        className={`w-full rounded-t-[2px] ${i % 5 === 1 ? 'bg-danger/60' : 'bg-success/60'}`}
                        style={{ height: `${h}%` }}
                      />
                    )
                  )}
                </div>
              </div>
              <div className="mt-2.5 flex items-center justify-between rounded-[8px] border border-success/20 bg-success/[0.06] px-3 py-2">
                <div>
                  <div className="text-[9.5px] font-semibold tracking-wider text-fg-5">
                    SIGNAL STATUS
                  </div>
                  <div className="mt-0.5 text-[12px] font-bold text-success">
                    Setup under review
                  </div>
                </div>
                <div className="rounded-md border border-success/25 bg-success/10 px-2 py-1 text-[12px] font-bold text-success">
                  92
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Feature grid */}
      <div className="mt-16 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <Card key={f.title} className="p-4" interactive>
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-line bg-surface-raised text-accent-strong">
              {f.icon}
            </span>
            <h3 className="mt-3 text-[13px] font-bold text-fg-1">{f.title}</h3>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-4">{f.body}</p>
          </Card>
        ))}
      </div>

      {/* Footer */}
      <div className="mt-14 flex flex-col gap-2 border-t border-line-soft pt-6 text-[11px] text-fg-5 sm:flex-row sm:items-center sm:justify-between">
        <span className="inline-flex items-center gap-2">
          <LineChart className="h-3.5 w-3.5 text-accent-strong" />
          Market analysis workspace · Deriv synthetic indices
        </span>
        <span className="inline-flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-warning" />
          Signals are analytical observations, not guarantees of outcome.
        </span>
      </div>
    </div>
  </div>
);
