/**
 * Chart colour bridge.
 *
 * Lightweight Charts takes concrete colour strings, so it cannot use the
 * Tailwind classes the rest of the UI relies on. The palette is mirrored in
 * `index.css` as `--chart-*` variables (once per theme); this module reads
 * them at runtime so the chart follows the active theme exactly like every
 * other surface. Never hardcode a hex here — add a token instead.
 */

export interface ChartColors {
  background: string;
  grid: string;
  border: string;
  text: string;
  crosshair: string;
  crosshairLabel: string;
  up: string;
  down: string;
  line: string;
  area: string;
  levelEntry: string;
  levelTarget: string;
  levelInvalidation: string;
  zoneSupport: string;
  zoneResistance: string;
  zoneSupportFill: string;
  zoneResistanceFill: string;
  flipSupport: string;
  flipResistance: string;
  flipSupportFill: string;
  flipResistanceFill: string;
  trendBull: string;
  trendBear: string;
  trendNeutral: string;
  protectedHigh: string;
  protectedLow: string;
  patternNeckline: string;
  patternBoundary: string;
  patternPole: string;
  breakout: string;
}

/** Fallbacks are only used if a token is missing (e.g. in a non-DOM test). */
const FALLBACK: ChartColors = {
  background: '#060b16',
  grid: '#101828',
  border: '#162133',
  text: '#94a3b8',
  crosshair: '#38bdf8',
  crosshairLabel: '#075985',
  up: '#16a34a',
  down: '#dc2626',
  line: '#38bdf8',
  area: 'rgba(56, 189, 248, 0.18)',
  levelEntry: '#38bdf8',
  levelTarget: '#16a34a',
  levelInvalidation: '#dc2626',
  zoneSupport: '#15803d',
  zoneResistance: '#dc2626',
  zoneSupportFill: 'rgba(21, 128, 61, 0.11)',
  zoneResistanceFill: 'rgba(220, 38, 38, 0.11)',
  flipSupport: '#2dd4bf',
  flipResistance: '#fb7185',
  flipSupportFill: 'rgba(20, 184, 166, 0.14)',
  flipResistanceFill: 'rgba(244, 63, 94, 0.14)',
  trendBull: 'rgba(45, 212, 191, 0.82)',
  trendBear: 'rgba(251, 146, 60, 0.82)',
  trendNeutral: 'rgba(148, 163, 184, 0.72)',
  protectedHigh: '#f59e0b',
  protectedLow: '#38bdf8',
  patternNeckline: 'rgba(244, 114, 182, 0.85)',
  patternBoundary: 'rgba(192, 132, 252, 0.82)',
  patternPole: 'rgba(56, 189, 248, 0.72)',
  breakout: '#38bdf8'
};

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Reads the chart palette from the document's computed styles. `theme` is
 * accepted so callers can re-read on theme change and so the dependency is
 * explicit in the calling effect.
 */
export function readChartColors(theme: string): ChartColors {
  if (typeof window === 'undefined' || typeof document === 'undefined') return FALLBACK;
  void theme;
  const styles = getComputedStyle(document.documentElement);
  return {
    background: readVar(styles, '--chart-bg', FALLBACK.background),
    grid: readVar(styles, '--chart-grid', FALLBACK.grid),
    border: readVar(styles, '--chart-border', FALLBACK.border),
    text: readVar(styles, '--chart-text', FALLBACK.text),
    crosshair: readVar(styles, '--chart-crosshair', FALLBACK.crosshair),
    crosshairLabel: readVar(styles, '--chart-crosshair-label', FALLBACK.crosshairLabel),
    up: readVar(styles, '--chart-up', FALLBACK.up),
    down: readVar(styles, '--chart-down', FALLBACK.down),
    line: readVar(styles, '--chart-spot', FALLBACK.line),
    area: 'rgba(56, 189, 248, 0.18)',
    levelEntry: readVar(styles, '--chart-crosshair', FALLBACK.levelEntry),
    levelTarget: readVar(styles, '--chart-up', FALLBACK.levelTarget),
    levelInvalidation: readVar(styles, '--chart-down', FALLBACK.levelInvalidation),
    zoneSupport: readVar(styles, '--chart-zone-support', FALLBACK.zoneSupport),
    zoneResistance: readVar(styles, '--chart-zone-resistance', FALLBACK.zoneResistance),
    zoneSupportFill: readVar(styles, '--chart-zone-support-fill', FALLBACK.zoneSupportFill),
    zoneResistanceFill: readVar(styles, '--chart-zone-resistance-fill', FALLBACK.zoneResistanceFill),
    flipSupport: readVar(styles, '--chart-flip-support', FALLBACK.flipSupport),
    flipResistance: readVar(styles, '--chart-flip-resistance', FALLBACK.flipResistance),
    flipSupportFill: readVar(styles, '--chart-flip-support-fill', FALLBACK.flipSupportFill),
    flipResistanceFill: readVar(styles, '--chart-flip-resistance-fill', FALLBACK.flipResistanceFill),
    trendBull: readVar(styles, '--chart-trend-bull', FALLBACK.trendBull),
    trendBear: readVar(styles, '--chart-trend-bear', FALLBACK.trendBear),
    trendNeutral: readVar(styles, '--chart-trend-neutral', FALLBACK.trendNeutral),
    protectedHigh: readVar(styles, '--chart-protected-high', FALLBACK.protectedHigh),
    protectedLow: readVar(styles, '--chart-protected-low', FALLBACK.protectedLow),
    patternNeckline: readVar(styles, '--chart-pattern-neckline', FALLBACK.patternNeckline),
    patternBoundary: readVar(styles, '--chart-pattern-boundary', FALLBACK.patternBoundary),
    patternPole: readVar(styles, '--chart-pattern-pole', FALLBACK.patternPole),
    breakout: readVar(styles, '--chart-breakout', FALLBACK.breakout)
  };
}
