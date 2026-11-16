import { useEffect, useRef, useState } from 'react';
import { ScanSearch } from 'lucide-react';

const STEPS = [
  { id: 'logo', label: 'DERIV AI SCANNER' },
  { id: 'scanning', label: 'ANALYSING THE MARKETS' },
] as const;

interface OpeningAnimationProps {
  onComplete: () => void;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Lightweight, short opening sequence. It never simulates prices or signals.
 * Respects prefers-reduced-motion by completing almost immediately.
 */
export function OpeningAnimation({ onComplete }: OpeningAnimationProps) {
  const [step, setStep] = useState(0);
  const [fadingOut, setFadingOut] = useState(false);
  // Keep the latest callback without re-running the timeline: the parent re-renders
  // continuously on live ticks, so depending on onComplete would restart it forever.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const reduced = prefersReducedMotion();
    if (reduced) {
      const t = setTimeout(() => onCompleteRef.current(), 450);
      return () => clearTimeout(t);
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setStep(1), 900));
    timers.push(setTimeout(() => setFadingOut(true), 2100));
    timers.push(setTimeout(() => onCompleteRef.current(), 2500));
    return () => timers.forEach(clearTimeout);
  }, []);

  const current = STEPS[step];

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-app transition-opacity duration-400 ${
        fadingOut ? 'opacity-0' : 'opacity-100'
      }`}
      role="status"
      aria-live="polite"
      aria-label="Deriv AI Scanner is starting"
    >
      <div className="relative flex flex-col items-center gap-6 px-6">
        <div className="relative">
          <div className="absolute inset-0 rounded-2xl bg-accent/20 animate-radar-pulse" aria-hidden="true" />
          <div className="relative w-16 h-16 rounded-2xl bg-accent/12 border border-accent/30 text-accent flex items-center justify-center">
            <ScanSearch className="w-8 h-8" />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-ink">
            DERIV AI SCANNER
          </h1>
          <p className="text-[12px] sm:text-xs font-semibold uppercase tracking-[0.3em] text-accent">
            {current.label}
          </p>
        </div>

        <div className="relative w-56 h-0.5 rounded-full bg-line overflow-hidden" aria-hidden="true">
          <div className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-accent to-transparent animate-radar-sweep" />
        </div>
      </div>

      <p className="absolute bottom-8 text-[11px] text-faint">
        Live Deriv market data · Not financial advice
      </p>
    </div>
  );
}
