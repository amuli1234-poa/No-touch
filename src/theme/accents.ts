/**
 * The interface shifts its accent hue with the current system status. Each status
 * maps to a hue with dark/light variants; the hook below writes them into CSS
 * custom properties so every `accent`-based utility retints at once.
 */

export type SystemStatus =
  | 'bullish'
  | 'bearish'
  | 'analysis'
  | 'training'
  | 'warning'
  | 'neutral';

export interface AccentHue {
  label: string;
  /** Dark-theme accent. */
  dark: string;
  /** Light-theme accent. */
  light: string;
  /** Soft/secondary variant used for gradients and hover states. */
  softDark: string;
  softLight: string;
}

export const ACCENT_HUES: Record<SystemStatus, AccentHue> = {
  bullish: {
    label: 'Bullish',
    dark: '#22c55e',
    light: '#15803d',
    softDark: '#16a34a',
    softLight: '#166534',
  },
  bearish: {
    label: 'Bearish',
    dark: '#ef4444',
    light: '#dc2626',
    softDark: '#dc2626',
    softLight: '#b91c1c',
  },
  analysis: {
    label: 'AI analysis',
    dark: '#38bdf8',
    light: '#0284c7',
    softDark: '#0ea5e9',
    softLight: '#0369a1',
  },
  training: {
    label: 'AI training',
    dark: '#a78bfa',
    light: '#7c3aed',
    softDark: '#8b5cf6',
    softLight: '#6d28d9',
  },
  warning: {
    label: 'Developing',
    dark: '#f59e0b',
    light: '#b45309',
    softDark: '#d97706',
    softLight: '#92400e',
  },
  neutral: {
    label: 'Neutral',
    dark: '#38bdf8',
    light: '#0284c7',
    softDark: '#0ea5e9',
    softLight: '#0369a1',
  },
};

/** Manual accent overrides offered in Settings. */
export type ManualAccent = 'blue' | 'green' | 'red' | 'purple' | 'orange';

export const MANUAL_ACCENT_TO_STATUS: Record<ManualAccent, SystemStatus> = {
  blue: 'analysis',
  green: 'bullish',
  red: 'bearish',
  purple: 'training',
  orange: 'warning',
};

function hexToRgbTriplet(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export interface AccentCssVars {
  accent: string;
  accentSoft: string;
  accentRgb: string;
  accentSoftRgb: string;
  glow: string;
}

/** Resolves the CSS custom properties for a status + theme combination. */
export function accentCssVars(status: SystemStatus, theme: 'dark' | 'light'): AccentCssVars {
  const hue = ACCENT_HUES[status];
  const accent = theme === 'dark' ? hue.dark : hue.light;
  const accentSoft = theme === 'dark' ? hue.softDark : hue.softLight;
  const rgb = hexToRgbTriplet(accent);
  return {
    accent,
    accentSoft,
    accentRgb: rgb,
    accentSoftRgb: hexToRgbTriplet(accentSoft),
    glow: `rgba(${rgb.replace(/ /g, ', ')}, ${theme === 'dark' ? 0.35 : 0.26})`,
  };
}
