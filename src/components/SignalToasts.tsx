import { useEffect } from 'react';
import { ArrowUpRight, ShieldCheck, TrendingDown, TrendingUp, X } from 'lucide-react';
import type { SignalFeedItem } from '../types/signals';

export interface SignalToast extends SignalFeedItem {
  toastId: string;
}

/**
 * Transient, dismissible toasts for freshly confirmed signals. Clicking a toast
 * deep-links to the exact chart that produced it; the toast auto-dismisses.
 */
export function SignalToastStack({
  toasts,
  onDismiss,
  onOpen,
  ttlMs = 7000,
}: {
  toasts: SignalToast[];
  onDismiss: (toastId: string) => void;
  onOpen: (symbol: string, timeframe: SignalFeedItem['timeframe']) => void;
  ttlMs?: number;
}) {
  return (
    <div
      className="fixed z-50 bottom-20 lg:bottom-4 right-3 sm:right-4 flex flex-col gap-2 w-[min(92vw,360px)] pointer-events-none"
      role="region"
      aria-label="Signal notifications"
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.toastId}
          toast={toast}
          ttlMs={ttlMs}
          onDismiss={onDismiss}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  ttlMs,
  onDismiss,
  onOpen,
}: {
  toast: SignalToast;
  ttlMs: number;
  onDismiss: (toastId: string) => void;
  onOpen: (symbol: string, timeframe: SignalFeedItem['timeframe']) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.toastId), ttlMs);
    return () => window.clearTimeout(timer);
  }, [toast.toastId, ttlMs, onDismiss]);

  const isRise = toast.direction === 'RISE';
  const validated = toast.source === 'CO-ANALYSIS';

  return (
    <div
      data-testid={`signal-toast-${toast.symbol}`}
      className={`pointer-events-auto rounded-xl border bg-surface/98 backdrop-blur px-3.5 py-3 shadow-lg shadow-black/40 animate-toast-in ${
        validated ? 'border-emerald-500/40' : 'border-line'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-0.5 inline-flex items-center justify-center w-8 h-8 rounded-lg border shrink-0 ${
            isRise
              ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/30'
              : 'bg-red-500/12 text-bear border-red-500/30'
          }`}
        >
          {isRise ? (
            <TrendingUp className="w-4 h-4" aria-hidden="true" />
          ) : (
            <TrendingDown className="w-4 h-4" aria-hidden="true" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-ink truncate">{toast.displayName}</span>
            {validated && (
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
            )}
          </div>
          <div className="text-[11px] font-mono text-faint mt-0.5">
            {toast.direction} · {toast.timeframe} · {toast.confidence}/100
          </div>
          <div className="text-[11px] text-muted truncate mt-0.5">
            {toast.modelLabel ?? 'Confirmed setup'}
          </div>
        </div>

        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.toastId)}
          className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-faint hover:text-ink hover:bg-elevated transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        onClick={() => {
          onOpen(toast.symbol, toast.timeframe);
          onDismiss(toast.toastId);
        }}
        className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 h-8 text-[12px] font-bold text-accent bg-accent/12 border border-accent/30 rounded-md hover:bg-accent/20 transition-colors cursor-pointer"
      >
        OPEN CHART
        <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
