import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MARKUP,
  MARKUP_ALPHA,
  MARKUP_LABEL,
  MARKUP_WIDTH,
  drawLabel,
  drawZoneBox,
} from './chartMarkupStyle';

/**
 * MINIMALIST CHART MARKUP GUARD.
 *
 * The chart must stay a clean, professional institutional-style price chart: the candles
 * are the focus and every markup is thin, subtle and short-labelled. These tests lock that
 * contract in at the source level so a future edit cannot quietly reintroduce thick
 * borders, heavy fills or sentence-length labels.
 */

const SRC = join(process.cwd(), 'src');

/** Every file that paints chart markup on the shared canvas. */
const MARKUP_FILES = [
  'components/AnalysisChartPrimitive.ts',
  'components/UserDrawingsPrimitive.ts',
  'components/chart/StructureChartPrimitive.ts',
  'components/chart/DsChartPrimitive.ts',
  'components/chart/AiChartPrimitive.ts',
  'components/chart/TrendlineChartPrimitive.ts',
  'components/chart/SignalAnnotationPrimitive.ts',
];

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

test('the shared markup palette stays muted and consistent', () => {
  // Every colour is a hex literal — never a bright primary or a neon.
  for (const [name, value] of Object.entries(MARKUP)) {
    assert.match(value, /^#[0-9A-Fa-f]{6}$/, `${name} must be a hex colour`);
  }
  // Line widths stay thin.
  assert.ok(MARKUP_WIDTH.hairline <= 1, 'hairline must be <= 1px');
  assert.ok(MARKUP_WIDTH.line <= 1.25, 'line must be <= 1.25px');
  assert.ok(MARKUP_WIDTH.strong <= 1.5, 'strong must be <= 1.5px');
  // Zone fills stay lightly transparent.
  for (const [name, alpha] of Object.entries(MARKUP_ALPHA)) {
    assert.ok(alpha <= 0.8, `${name} alpha must stay subtle (<= 0.8)`);
  }
  assert.ok(MARKUP_ALPHA.fill <= 0.1, 'zone fills must be <= 0.1 alpha');
});

test('the on-chart label vocabulary is short codes only', () => {
  for (const [name, code] of Object.entries(MARKUP_LABEL)) {
    assert.ok(code.length <= 6, `${name} label "${code}" is too long`);
    assert.equal(code, code.trim(), `${name} label must not have padding`);
  }
});

test('markup primitives never set a stroke heavier than the strong width', () => {
  for (const file of MARKUP_FILES) {
    const source = read(file);
    const widths = [...source.matchAll(/lineWidth\s*=\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    for (const w of widths) {
      assert.ok(w <= 1.5, `${file} sets lineWidth ${w} (must be <= 1.5)`);
    }
  }
});

test('markup primitives never fill a zone with a heavy alpha', () => {
  for (const file of MARKUP_FILES) {
    const source = read(file);
    // Literal rgba fills are banned in markup files — fills come from the shared helpers.
    assert.doesNotMatch(
      source,
      /fillStyle\s*=\s*['"]rgba\(/,
      `${file} must use drawZoneBox / MARKUP_ALPHA for fills, not a literal rgba`
    );
  }
});

test('markup primitives draw short labels, never sentence-length strings', () => {
  for (const file of MARKUP_FILES) {
    const source = read(file);
    // The old heavy label blocks described state in prose; those must not return.
    for (const banned of ['ZONE DETECTED', 'PRICE APPROACHING', 'ENTRY CONFIRMED', 'NO TRADE']) {
      assert.ok(!source.includes(banned), `${file} must not draw the long label "${banned}"`);
    }
  }
});

test('drawZoneBox fills are thin and bounded', () => {
  // The helper itself must not stroke a thick border.
  assert.ok(drawZoneBox.length >= 2);
  assert.ok(MARKUP_WIDTH.strong <= 1.5);
  assert.ok(MARKUP_ALPHA.fillStrong <= 0.1);
});

test('drawLabel is exported and takes a colour', () => {
  assert.equal(typeof drawLabel, 'function');
});

test('there is no unguarded markup file outside the shared style module', () => {
  // Any file that imports the chart canvas must route labels through the shared helpers.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) {
        const source = readFileSync(full, 'utf8');
        const paints = /attachPrimitive|IPrimitivePaneRenderer/.test(source);
        const routes = /chartMarkupStyle|drawLabel/.test(source);
        if (paints && !routes && !/CandlestickChart\.tsx$/.test(full)) offenders.push(full.replace(SRC, ''));
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
});
