import React from 'react';
import { Activity, ShieldCheck, Crosshair } from 'lucide-react';

/* Illustrative candle series. Deterministic values so the preview renders
   identically on every load — this is a design mock, not market data. */
const CANDLES: { o: number; h: number; l: number; c: number }[] = [
  { o: 42, h: 47, l: 40, c: 45 }, { o: 45, h: 50, l: 43, c: 48 },
  { o: 48, h: 52, l: 44, c: 46 }, { o: 46, h: 49, l: 41, c: 43 },
  { o: 43, h: 51, l: 42, c: 50 }, { o: 50, h: 56, l: 49, c: 54 },
  { o: 54, h: 58, l: 51, c: 53 }, { o: 53, h: 57, l: 48, c: 50 },
  { o: 50, h: 55, l: 47, c: 53 }, { o: 53, h: 61, l: 52, c: 59 },
  { o: 59, h: 64, l: 57, c: 62 }, { o: 62, h: 66, l: 58, c: 60 },
  { o: 60, h: 63, l: 55, c: 57 }, { o: 57, h: 62, l: 54, c: 61 },
  { o: 61, h: 69, l: 60, c: 67 }, { o: 67, h: 72, l: 64, c: 66 },
  { o: 66, h: 70, l: 61, c: 63 }, { o: 63, h: 68, l: 60, c: 66 },
  { o: 66, h: 74, l: 65, c: 72 }, { o: 72, h: 77, l: 69, c: 71 },
  { o: 71, h: 75, l: 66, c: 68 }, { o: 68, h: 73, l: 64, c: 70 },
  { o: 70, h: 78, l: 69, c: 76 }, { o: 76, h: 82, l: 74, c: 79 }
];

const BARRIER_Y = 30; // percent from top — the illustrative No Touch barrier

const PreviewChart: React.FC = () => {
  const min = Math.min(...CANDLES.map((c) => c.l));
  const max = Math.max(...CANDLES.map((c) => c.h));
  const toY = (price: number) => 100 - ((price - min) / (max - min)) * 100;

  return (
    <div className="relative h-[190px] w-full overflow-hidden rounded-[10px] border border-[var(--ws-hairline)] bg-app sm:h-[220px]">
      <div className="surface-grid absolute inset-0 opacity-[0.25]" />

      {/* Barrier — dashed line the wick must not reach */}
      <div
        className="absolute inset-x-0 border-t border-dashed border-accent-cyan/50"
        style={{ top: `${BARRIER_Y}%` }}
      />
      <span className="absolute right-2.5 -translate-y-1/2 rounded border border-accent-cyan/30 bg-accent-cyan/10 px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide text-tint-sky" style={{ top: `${BARRIER_Y}%` }}>
        BARRIER
      </span>

      <div className="absolute inset-0 flex items-end gap-[3px] px-3 pb-4 pt-6 sm:gap-1">
        {CANDLES.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? 'var(--success)' : 'var(--danger)';
          const top = toY(Math.max(c.o, c.c));
          const bottom = toY(Math.min(c.o, c.c));
          const bodyH = Math.max(bottom - top, 1.4);
          const wickTop = toY(c.h);
          const wickBottom = toY(c.l);
          return (
            <div key={i} className="relative flex-1" style={{ height: '100%' }}>
              <span
                className="absolute left-1/2 w-px -translate-x-1/2"
                style={{ top: `${wickTop}%`, height: `${wickBottom - wickTop}%`, backgroundColor: color, opacity: 0.55 }}
              />
              <span
                className="absolute left-0 right-0 rounded-[1.5px]"
                style={{ top: `${top}%`, height: `${bodyH}%`, backgroundColor: color, opacity: up ? 0.85 : 0.75 }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

const PreviewKpi: React.FC<{ label: string; value: string; tone: string }> = ({
  label,
  value,
  tone
}) => (
  <div className="rounded-[10px] border border-[var(--ws-hairline)] bg-surface-deepest p-2.5 sm:p-3">
    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-5">{label}</div>
    <div className="tabular mt-1 text-[16px] font-bold sm:text-[19px]" style={{ color: tone }}>
      {value}
    </div>
  </div>
);

/**
 * Illustrative preview of the scanner workspace. Deliberately labelled as a
 * sample so it is never mistaken for live market output.
 */
export const ScannerPreview: React.FC = () => (
  <div className="relative rounded-[16px] border border-[var(--ws-hairline)] bg-surface p-1.5 shadow-[var(--shadow-modal)]">
    <div className="pointer-events-none absolute -inset-x-6 -top-6 h-24 rounded-full bg-accent/10 blur-3xl" />

    <div className="relative rounded-[12px] border border-[var(--ws-hairline)] bg-surface-deep p-3 sm:p-4">
      {/* Window chrome */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ws-hairline)] pb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-gradient-to-br from-accent to-accent-cyan">
            <Activity className="h-4 w-4 text-on-accent" />
          </span>
          <span className="text-[12.5px] font-bold tracking-tight text-fg-1">Live Scanner</span>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-accent-soft">
          Illustrative preview
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-2.5">
        <PreviewKpi label="Markets" value="47" tone="var(--tint-sky)" />
        <PreviewKpi label="Qualified" value="04" tone="var(--success)" />
        <PreviewKpi label="Watchlist" value="07" tone="var(--warning)" />
      </div>

      <div className="mt-2.5">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[12px] font-bold text-fg-2">
            Synthetic Index <span className="font-normal text-fg-5">· 2m primary / 5m confirmation</span>
          </div>
          <div className="hidden text-[11px] text-fg-5 sm:block">No Touch barrier · wick analysis</div>
        </div>
        <PreviewChart />
      </div>

      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        <div className="flex items-center justify-between rounded-[10px] border border-success/25 bg-success/[0.07] px-3 py-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-5">
              Signal evaluation
            </div>
            <div className="mt-0.5 text-[12.5px] font-bold text-tint-teal">Gates passed</div>
          </div>
          <div className="tabular rounded-md border border-success/30 bg-success/10 px-2 py-1 text-[13px] font-bold text-tint-teal">
            92
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-[10px] border border-[var(--ws-hairline)] bg-surface-deepest px-3 py-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-tint-sky" />
          <div className="text-[11.5px] leading-tight text-fg-4">
            Risk filters and structural gates evaluated before a setup is surfaced.
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2 rounded-[10px] border border-[var(--ws-hairline)] bg-surface-deepest px-3 py-2">
        <Crosshair className="h-3.5 w-3.5 shrink-0 text-accent-soft" />
        <div className="text-[11.5px] leading-tight text-fg-4">
          Sample interface for illustration only — figures are not live market data.
        </div>
      </div>
    </div>
  </div>
);
