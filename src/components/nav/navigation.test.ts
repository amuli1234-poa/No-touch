import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIN_TABS, SECTIONS, mainTabForSection, type AppSection } from './Navigation';

/**
 * ARCHITECTURE GUARD — the master spec organises navigation into Overview, Scanner, Signals,
 * Chart and Performance (plus Settings), one workspace per family (never one main tab per
 * strategy), and every legacy section still reachable. This test fails the moment a duplicate
 * or extra main tab is introduced.
 */

const EXPECTED_TAB_LABELS = [
  'Overview',
  'Scanner',
  'Signals',
  'Chart',
  'Performance',
  'Settings',
];

test('navigation: exactly six main tabs in the required order', () => {
  assert.equal(MAIN_TABS.length, 6, 'the app must expose exactly 6 main tabs');
  assert.deepEqual(
    MAIN_TABS.map((t) => t.label),
    EXPECTED_TAB_LABELS
  );
});

test('navigation: tab keys are unique', () => {
  const keys = MAIN_TABS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('navigation: every strategy module lives inside the ONE Scanner tab', () => {
  const strategies = mainTabForSection('trendlines');
  assert.equal(strategies.key, 'scanner');
  const strategyKeys = strategies.sections.map((s) => s.key);
  for (const key of [
    'trendlines',
    'demandsupply',
    'boschoch',
    'smc',
    'liquidity',
    'fvg',
    'orderblock',
    'technical',
    'momentum',
    'regime',
    'confluence',
  ] as AppSection[]) {
    assert.ok(strategyKeys.includes(key), `${key} must be a sub-view of the Scanner tab`);
  }
});

test('navigation: entry model AI lives inside the Signals tab', () => {
  const tab = mainTabForSection('entrymodel');
  assert.equal(tab.key, 'signals');
  assert.deepEqual(tab.sections.map((s) => s.key), ['entrymodel', 'alerts']);
});

test('navigation: the dedicated full-screen chart is the Chart tab default', () => {
  const tab = mainTabForSection('chart');
  assert.equal(tab.key, 'chart');
  assert.equal(tab.defaultSection, 'chart');
});

test('navigation: no section appears in more than one tab (zero duplication)', () => {
  const seen = new Set<string>();
  for (const tab of MAIN_TABS) {
    for (const s of tab.sections) {
      assert.ok(!seen.has(s.key), `${s.key} is duplicated across tabs`);
      seen.add(s.key);
    }
  }
});

test('navigation: every default section belongs to its own tab', () => {
  for (const tab of MAIN_TABS) {
    assert.ok(
      tab.sections.some((s) => s.key === tab.defaultSection),
      `${tab.label} default section ${tab.defaultSection} must be inside the tab`
    );
  }
});

test('navigation: every legacy section stays reachable (no module lost)', () => {
  const all = new Set(SECTIONS.map((s) => s.key));
  for (const key of [
    'dashboard',
    'scanner',
    'live',
    'trendlines',
    'demandsupply',
    'boschoch',
    'technical',
    'smc',
    'liquidity',
    'fvg',
    'orderblock',
    'momentum',
    'regime',
    'confluence',
    'entrymodel',
    'chartanalysis',
    'analyser',
    'performance',
    'risk',
    'alerts',
    'strategylab',
    'health',
    'training',
    'history',
    'settings',
  ] as AppSection[]) {
    assert.ok(all.has(key), `${key} must remain reachable`);
  }
});

test('navigation: no strategy module is a top-level main tab', () => {
  const tabKeys = new Set(MAIN_TABS.map((t) => t.key));
  for (const key of ['trendlines', 'demandsupply', 'boschoch', 'smc', 'liquidity', 'fvg', 'orderblock']) {
    assert.ok(!tabKeys.has(key), `${key} must not be its own main tab`);
  }
});
