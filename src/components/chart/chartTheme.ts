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
  levelInvalidation: '#dc2626'
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
    levelInvalidation: readVar(styles, '--chart-down', FALLBACK.levelInvalidation)
  };
}
