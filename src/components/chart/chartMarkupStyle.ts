/**
 * Shared canvas markup style for every chart primitive.
 *
 * The chart is a clean, professional institutional-style price chart: the candlesticks
 * and current price action are the focus, and every drawing is thin, subtle and short
 * labelled. Routing all markup through this module keeps a zone, a level and a line
 * looking identical wherever they are painted, and keeps the whole chart on one palette.
 *
 * Rules encoded here (enforced by `chartMarkupStyle.test.ts`):
 *   - boundaries are thin (<= 1.5px), never thick rectangles
 *   - zone fills are lightly transparent (<= 0.1 alpha)
 *   - labels are short, small and drawn with a subtle halo instead of heavy boxes
 */

export const MARKUP_FONT = '"Plus Jakarta Sans", system-ui, sans-serif';

/** Directional + structural markup palette. Muted so nothing outshines the candles. */
export const MARKUP = {
  bull: '#16A34A',
  bear: '#DC2626',
  support: '#0EA5E9',
  resistance: '#F59E0B',
  neutral: '#64748B',
  accent: '#2563EB',
  entry: '#2563EB',
  stop: '#DC2626',
  target: '#16A34A',
  bos: '#475569',
  choch: '#7C3AED',
  sweep: '#0EA5E9',
} as const;

/** Fill / edge opacity tiers. Deliberately low so zones never dominate the candles. */
export const MARKUP_ALPHA = {
  fillFaint: 0.05,
  fill: 0.07,
  fillStrong: 0.1,
  edge: 0.45,
  edgeStrong: 0.7,
  line: 0.8,
} as const;

/** Line widths. The chart never uses a stroke heavier than {@link MARKUP_WIDTH.strong}. */
export const MARKUP_WIDTH = {
  hairline: 1,
  line: 1.25,
  strong: 1.5,
} as const;

/**
 * The short label vocabulary. Every on-chart label is one of these codes — never a
 * sentence, a status name or a multi-line description.
 */
export const MARKUP_LABEL = {
  support: 'S',
  resistance: 'R',
  demand: 'DZ',
  supply: 'SZ',
  bos: 'BOS',
  choch: 'CHoCH',
  watch: 'WATCH',
  fvg: 'FVG',
  trendline: 'TL',
  entry: 'E',
  stop: 'SL',
  target: 'TP',
  sweep: 'SWEEP',
} as const;

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export interface LabelOptions {
  size?: number;
  weight?: number;
  align?: CanvasTextAlign;
}

/**
 * Draws a short label in its markup colour with a subtle light halo. The halo keeps the
 * text legible over candles and zones without a heavy filled box, so labels stay small
 * and unobtrusive.
 */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  opts: LabelOptions = {}
): void {
  ctx.save();
  ctx.font = `${opts.weight ?? 600} ${opts.size ?? 9}px ${MARKUP_FONT}`;
  ctx.textAlign = opts.align ?? 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** A thin full-width horizontal line, optionally dashed. */
export function drawHLine(
  ctx: CanvasRenderingContext2D,
  y: number,
  width: number,
  color: string,
  opts: { dash?: number[]; width?: number; alpha?: number; x?: number } = {}
): void {
  ctx.save();
  ctx.strokeStyle = hexToRgba(color, opts.alpha ?? MARKUP_ALPHA.line);
  ctx.lineWidth = opts.width ?? MARKUP_WIDTH.hairline;
  if (opts.dash) ctx.setLineDash(opts.dash);
  ctx.beginPath();
  ctx.moveTo(opts.x ?? 0, y);
  ctx.lineTo(width, y);
  ctx.stroke();
  ctx.restore();
}

export interface ZoneBoxOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  fillAlpha?: number;
  edgeAlpha?: number;
  /** Draw only the top/bottom boundaries (bands) instead of a full rectangle. */
  edgesOnly?: boolean;
  dash?: number[];
  lineWidth?: number;
}

/** A lightly shaded zone with thin boundary lines. No thick borders, no heavy fill. */
export function drawZoneBox(ctx: CanvasRenderingContext2D, opts: ZoneBoxOptions): void {
  const { x, y, w, h, color } = opts;
  if (w <= 0 || h <= 0) return;
  const dash = opts.dash ?? [];
  ctx.save();
  ctx.fillStyle = hexToRgba(color, opts.fillAlpha ?? MARKUP_ALPHA.fill);
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = hexToRgba(color, opts.edgeAlpha ?? MARKUP_ALPHA.edge);
  ctx.lineWidth = opts.lineWidth ?? MARKUP_WIDTH.hairline;
  ctx.setLineDash(dash);
  if (opts.edgesOnly) {
    ctx.beginPath();
    ctx.moveTo(x, y + 0.5);
    ctx.lineTo(x + w, y + 0.5);
    ctx.moveTo(x, y + h - 0.5);
    ctx.lineTo(x + w, y + h - 0.5);
    ctx.stroke();
  } else {
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  ctx.restore();
}

/** A small filled anchor dot used at trendline swings. */
export function drawAnchorDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  radius = 2.2
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
