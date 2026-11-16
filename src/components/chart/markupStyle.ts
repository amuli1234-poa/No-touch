/**
 * MINIMALIST CHART MARKUP — the single source of truth for how every drawing on the
 * candlestick canvas is styled.
 *
 * The candles and the live price are the main focus; markups only support the read. Every
 * primitive (analysis, AI modules, demand & supply, trendline, structure, signal
 * annotation) and the price-line layer draw with these tokens so the whole chart shares
 * one thin, precise, low-noise look:
 *
 *  - thin boundaries (never heavier than 1.5px),
 *  - lightly shaded, transparent zone fills,
 *  - very small labels with a short token (S, R, SZ, DZ, BOS, CHoCH, FVG, WATCH),
 *  - consistent, muted colours that stay distinguishable without glare.
 *
 * Nothing here is derived from a signal, so styling can never imply a trade.
 */

const FONT_STACK = '"Plus Jakarta Sans", system-ui, sans-serif';
const MONO_STACK = '"JetBrains Mono", ui-monospace, monospace';

/** Line widths. Everything is thin; `active` is the heaviest a drawing may get. */
export const MARKUP_LINE = {
  /** Hairline boundary for subtle zone edges and tag borders. */
  hair: 0.75,
  /** Default stroke for every level, boundary and trendline. */
  thin: 1,
  /** A boundary that carries the current read (nearest/approaching zone). */
  edge: 1.15,
  /** Absolute maximum — reserved for the single most important active drawing. */
  active: 1.35,
} as const;

/** Fill / stroke alphas. Zone fills stay barely-there so candles always read first. */
export const MARKUP_ALPHA = {
  /** Zone body fill. */
  fill: 0.05,
  /** Fill for the zone that is closest to price / in play. */
  fillActive: 0.08,
  /** Fill for a signal entry area or risk ribbon. */
  ribbon: 0.04,
  /** Boundary stroke for a distant / watch drawing. */
  edgeSoft: 0.45,
  /** Boundary stroke for an in-play drawing. */
  edge: 0.7,
  /** Boundary stroke for the primary active drawing. */
  edgeStrong: 0.85,
  /** Dotted invalidation / guard line. */
  guard: 0.35,
  /** Tag border. */
  tagBorder: 0.5,
} as const;

export const MARKUP_FONT = {
  label: `600 9px ${FONT_STACK}`,
  labelBold: `700 9px ${FONT_STACK}`,
  micro: `600 8px ${FONT_STACK}`,
  microBold: `700 8px ${FONT_STACK}`,
  /** Single glyph inside a tiny directional marker (R / F). */
  glyph: `700 7px ${FONT_STACK}`,
  price: `600 9px ${MONO_STACK}`,
} as const;

/** Small label tag geometry. */
export const MARKUP_TAG = {
  height: 13,
  padX: 4,
  radius: 2,
  bg: 'rgba(255, 255, 255, 0.86)',
} as const;

/** Dash patterns, from solid to a faint dotted guard. */
export const MARKUP_DASH: Record<'solid' | 'dashed' | 'subtle' | 'dotted', number[]> = {
  solid: [],
  dashed: [5, 4],
  subtle: [4, 3],
  dotted: [2, 3],
};

/** Muted, consistent, distinguishable palette (no excessive brightness). */
export const MARKUP_COLORS = {
  rise: '#15803D',
  fall: '#B91C1C',
  support: '#0369A1',
  resistance: '#B45309',
  zone: '#1E40AF',
  bos: '#475569',
  choch: '#6B21A8',
  fvg: '#0E7490',
  watch: '#0F766E',
  neutral: '#64748B',
  entry: '#1E40AF',
  stop: '#B91C1C',
  target: '#15803D',
  ink: 'rgba(226, 232, 240, 0.9)',
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

export interface TagOptions {
  /** Left edge (or right/centre edge, per `align`) in media coordinates. */
  x: number;
  /** Vertical centre in media coordinates. */
  y: number;
  text: string;
  color: string;
  align?: 'left' | 'right' | 'center';
  bg?: string;
  bold?: boolean;
}

/**
 * Draws one small, low-noise label tag. Used for every label on the chart so the markup
 * reads as a single consistent layer rather than a patchwork of boxes.
 */
export function drawTag(ctx: CanvasRenderingContext2D, o: TagOptions): void {
  ctx.save();
  ctx.font = o.bold === false ? MARKUP_FONT.label : MARKUP_FONT.labelBold;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const textW = ctx.measureText(o.text).width;
  const h = MARKUP_TAG.height;
  const w = textW + MARKUP_TAG.padX * 2;
  let x = o.x;
  if (o.align === 'right') x -= w;
  else if (o.align === 'center') x -= w / 2;
  const y = o.y - h / 2;

  ctx.fillStyle = o.bg ?? MARKUP_TAG.bg;
  roundRect(ctx, x, y, w, h, MARKUP_TAG.radius);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(o.color, MARKUP_ALPHA.tagBorder);
  ctx.lineWidth = MARKUP_LINE.hair;
  roundRect(ctx, x, y, w, h, MARKUP_TAG.radius);
  ctx.stroke();

  ctx.fillStyle = o.color;
  ctx.fillText(o.text, x + MARKUP_TAG.padX, o.y);
  ctx.restore();
}

/**
 * Maps a verbose zone label from an engine onto a short chart token. Keeps the canvas
 * legible: only S, R, SZ, DZ, BOS, CHoCH, FVG and WATCH ever reach the chart.
 */
export function shortZoneLabel(raw: string | null | undefined): string {
  const t = (raw ?? '').toUpperCase();
  if (t.includes('CHOCH')) return 'CHoCH';
  if (t.includes('DEALING RANGE') || t.includes('RANGE')) return 'RANGE';
  if (t.includes('ENTRY ZONE') || t.includes('ENTRY')) return 'ENTRY';
  if (t.includes('BOS') || t.includes('BREAK OF STRUCTURE')) return 'BOS';
  if (t.includes('DEMAND') || t.includes('DZ')) return 'DZ';
  if (t.includes('SUPPLY') || t.includes('SZ')) return 'SZ';
  if (t.includes('FVG') || t.includes('IMBALANCE')) return 'FVG';
  if (t.includes('RESIST')) return 'R';
  if (t.includes('SUPPORT')) return 'S';
  if (t.includes('WATCH')) return 'WATCH';
  return 'ZONE';
}
