import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKUP_ALPHA,
  MARKUP_COLORS,
  MARKUP_DASH,
  MARKUP_FONT,
  MARKUP_LINE,
  MARKUP_TAG,
  hexToRgba,
  shortZoneLabel,
} from './markupStyle';

/**
 * Guardrail for the minimalist markup style. The chart must stay thin, subtle and
 * low-noise — these bounds keep a future edit from re-introducing heavy lines, opaque
 * fills or verbose labels.
 */
test('every markup line width is thin (never heavier than 1.5px)', () => {
  for (const width of Object.values(MARKUP_LINE)) {
    assert.ok(width > 0 && width <= 1.5, `line width ${width} is not thin`);
  }
});

test('zone fills stay transparent and subtle', () => {
  for (const alpha of [MARKUP_ALPHA.fill, MARKUP_ALPHA.fillActive, MARKUP_ALPHA.ribbon]) {
    assert.ok(alpha > 0 && alpha <= 0.1, `fill alpha ${alpha} is not subtle`);
  }
  for (const alpha of [MARKUP_ALPHA.edgeSoft, MARKUP_ALPHA.edge, MARKUP_ALPHA.edgeStrong]) {
    assert.ok(alpha <= 0.9, `edge alpha ${alpha} is too strong`);
  }
});

test('labels are small and tags are compact', () => {
  for (const font of Object.values(MARKUP_FONT)) {
    const match = /(\d+(?:\.\d+)?)px/.exec(font);
    assert.ok(match, `font "${font}" has no pixel size`);
    assert.ok(Number(match![1]) <= 10, `font "${font}" is too large`);
  }
  assert.ok(MARKUP_TAG.height <= 16);
  assert.ok(MARKUP_TAG.padX <= 6);
});

test('dash patterns are non-negative integers', () => {
  for (const pattern of Object.values(MARKUP_DASH)) {
    for (const n of pattern) {
      assert.ok(Number.isInteger(n) && n > 0, `dash segment ${n} is invalid`);
    }
  }
});

test('shortZoneLabel maps verbose engine labels onto short chart tokens', () => {
  assert.equal(shortZoneLabel('DEMAND'), 'DZ');
  assert.equal(shortZoneLabel('SUPPLY'), 'SZ');
  assert.equal(shortZoneLabel('BULLISH OB'), 'ZONE');
  assert.equal(shortZoneLabel('BOS'), 'BOS');
  assert.equal(shortZoneLabel('CHOCH'), 'CHoCH');
  assert.equal(shortZoneLabel('FVG'), 'FVG');
  assert.equal(shortZoneLabel('SUPPORT'), 'S');
  assert.equal(shortZoneLabel('RESISTANCE'), 'R');
  assert.equal(shortZoneLabel('WATCH RISE'), 'WATCH');
  assert.equal(shortZoneLabel(null), 'ZONE');
});

test('hexToRgba converts a hex colour with the requested alpha', () => {
  assert.equal(hexToRgba('#15803D', 0.5), 'rgba(21, 128, 61, 0.5)');
  assert.equal(hexToRgba('FFFFFF', 1), 'rgba(255, 255, 255, 1)');
});

test('the palette is muted (no pure primary brightness) and distinguishable', () => {
  const hexes = Object.values(MARKUP_COLORS).filter((c) => c.startsWith('#'));
  assert.ok(hexes.length >= 10);
  for (const hex of hexes) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // No channel may be at full intensity — keeps colours from glaring.
    assert.ok(Math.max(r, g, b) <= 200, `${hex} is too bright`);
  }
  // Direction colours must remain distinct from one another.
  assert.notEqual(MARKUP_COLORS.rise, MARKUP_COLORS.fall);
  assert.notEqual(MARKUP_COLORS.support, MARKUP_COLORS.resistance);
});
