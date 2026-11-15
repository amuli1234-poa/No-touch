/**
 * Lightweight signal chimes generated with the Web Audio API — no binary assets.
 * Audio is created lazily and only after a user gesture has unlocked the context,
 * so nothing plays (or errors) on first load.
 */

export type SignalChime = 'validated' | 'scanner' | 'analyser' | 'invalidated';

let ctx: AudioContext | null = null;
let enabled = true;
let volume = 0.7;
let lastPlayedAt = 0;

const MIN_GAP_MS = 1200; // avoid chime spam during rapid scans

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function isSoundSupported(): boolean {
  return audioContextCtor() !== null;
}

export function setSoundEnabled(next: boolean): void {
  enabled = next;
}

export function isSoundEnabled(): boolean {
  return enabled;
}

/** Sets the chime volume, 0–1. Values are clamped. */
export function setSoundVolume(next: number): void {
  volume = Math.max(0, Math.min(1, next));
}

export function getSoundVolume(): number {
  return volume;
}

/** Call from a user-gesture handler so later chimes are allowed by autoplay policy. */
export function primeAudio(): void {
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === 'suspended') void ctx.resume();
}

interface Note {
  freq: number;
  start: number;
  duration: number;
}

const RECIPES: Record<SignalChime, Note[]> = {
  // Two-note rising major third — a calm confirmation.
  validated: [
    { freq: 587.33, start: 0, duration: 0.16 }, // D5
    { freq: 880.0, start: 0.14, duration: 0.24 }, // A5
  ],
  // Single mid chime for the scanner surfacing a setup.
  scanner: [{ freq: 659.25, start: 0, duration: 0.2 }], // E5
  // Single softer chime for the analyser confirming on the chart.
  analyser: [{ freq: 523.25, start: 0, duration: 0.2 }], // C5
  // Falling minor second — a gentle warning.
  invalidated: [
    { freq: 392.0, start: 0, duration: 0.16 }, // G4
    { freq: 311.13, start: 0.15, duration: 0.28 }, // Eb4
  ],
};

export function playSignalChime(kind: SignalChime): void {
  if (!enabled) return;
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;

  try {
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    lastPlayedAt = now;

    const recipe = RECIPES[kind];
    const peak = 0.16 * (volume / 0.7);
    for (const note of recipe) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      const t0 = ctx.currentTime + note.start;
      const t1 = t0 + note.duration;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
  } catch {
    // Audio is a non-essential enhancement; never surface failures.
  }
}
