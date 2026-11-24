import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIN_TABS,
  OFF_NAV_SECTIONS,
  SECTIONS,
  mainTabForSection,
  type AppSection,
} from './Navigation';

/**
 * ARCHITECTURE GUARD — the workspace navigation is organised into seven modules:
 * Dashboard, Free Bots, Premium Bots, Copy Trading, Pro Scanner, Market Analysis and AI Intelligence.
 * Trade History and AI Training live inside Market Analysis; Risk Management lives inside
 * AI Intelligence; Settings is reachable from the TopBar rather than the primary nav.
 * These tests fail the moment a tab is added, renamed, reordered or orphaned.
 */

const EXPECTED_TAB_LABELS = [
  'Dashboard',
  'Pro Scanner',
  'Free Bots',
  'Premium Bots',
  'Copy Trading',
  'Market Analysis',
  'AI Intelligence',
];

test('navigation: exactly seven primary modules in the required order', () => {
  assert.equal(MAIN_TABS.length, 7, 'the app must expose 7 primary modules');
  assert.deepEqual(
    MAIN_TABS.map((t) => t.label),
    EXPECTED_TAB_LABELS
  );
});

test('navigation: tab keys are unique', () => {
  const keys = MAIN_TABS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('navigation: every primary module navigates to the correct default section', () => {
  const expected: Record<string, AppSection> = {
    dashboard: 'dashboard',
    freebots: 'freebots',
    premiumbots: 'premiumbots',
    copytrading: 'copytrading',
    proscanner: 'scanner',
    marketanalysis: 'chart',
    aiintelligence: 'aiintelligence',
  };
  for (const tab of MAIN_TABS) {
    assert.equal(
      tab.defaultSection,
      expected[tab.key],
      `${tab.label} must open on ${expected[tab.key]}`
    );
  }
});

test('navigation: every default section belongs to its own module', () => {
  for (const tab of MAIN_TABS) {
    assert.ok(
      tab.sections.some((s) => s.key === tab.defaultSection),
      `${tab.label} default section ${tab.defaultSection} must be inside the module`
    );
  }
});

test('navigation: Trade History is reachable under Market Analysis', () => {
  const tab = mainTabForSection('history');
  assert.ok(tab, 'history must belong to a primary module');
  assert.equal(tab.label, 'Market Analysis');
});

test('navigation: AI Training is reachable under Market Analysis', () => {
  const tab = mainTabForSection('training');
  assert.ok(tab, 'training must belong to a primary module');
  assert.equal(tab.label, 'Market Analysis');
});

test('navigation: Risk Management is reachable under AI Intelligence', () => {
  const tab = mainTabForSection('risk');
  assert.ok(tab, 'risk must belong to a primary module');
  assert.equal(tab.label, 'AI Intelligence');
});

test('navigation: Settings is not in the primary navigation but is an off-nav section', () => {
  assert.equal(mainTabForSection('settings'), null, 'Settings must not be a primary module');
  const primary = new Set(SECTIONS.map((s) => s.key));
  assert.ok(!primary.has('settings'), 'Settings must not appear in the primary nav tree');
  assert.ok(OFF_NAV_SECTIONS.includes('settings'), 'Settings must stay a reachable section');
});

test('navigation: every strategy module lives inside the ONE Pro Scanner module', () => {
  const strategies = mainTabForSection('trendlines');
  assert.ok(strategies);
  assert.equal(strategies.label, 'Pro Scanner');
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
    assert.ok(strategyKeys.includes(key), `${key} must be a sub-view of the Pro Scanner module`);
  }
});

test('navigation: chart workspaces live inside Market Analysis', () => {
  for (const key of ['chart', 'chartanalysis', 'analyser'] as AppSection[]) {
    const tab = mainTabForSection(key);
    assert.ok(tab, `${key} must belong to a primary module`);
    assert.equal(tab.label, 'Market Analysis', `${key} must sit under Market Analysis`);
  }
});

test('navigation: no section appears in more than one module (zero duplication)', () => {
  const seen = new Set<string>();
  for (const tab of MAIN_TABS) {
    for (const s of tab.sections) {
      assert.ok(!seen.has(s.key), `${s.key} is duplicated across modules`);
      seen.add(s.key);
    }
  }
});

test('navigation: every legacy section stays reachable (no module lost)', () => {
  const all = new Set([...SECTIONS.map((s) => s.key), ...OFF_NAV_SECTIONS]);
  for (const key of [
    'dashboard',
    'trade',
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
    'timeframealignment',
    'consolidation',
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

test('navigation: the bot catalogs, copy trading and AI intelligence sections exist', () => {
  const all = new Set(SECTIONS.map((s) => s.key));
  for (const key of ['freebots', 'premiumbots', 'copytrading', 'aiintelligence'] as AppSection[]) {
    assert.ok(all.has(key), `${key} must be reachable from the primary navigation`);
  }
});

test('navigation: no strategy module is a top-level primary module', () => {
  const tabKeys = new Set(MAIN_TABS.map((t) => t.key));
  for (const key of ['trendlines', 'demandsupply', 'boschoch', 'smc', 'liquidity', 'fvg', 'orderblock']) {
    assert.ok(!tabKeys.has(key), `${key} must not be its own primary module`);
  }
});

test('navigation: legacy hash aliases still resolve to real sections', () => {
  // Mirrors LEGACY_HASH in App.tsx; a hash written by an old build must not dead-end.
  const LEGACY_HASH: Record<string, AppSection> = {
    analysis: 'analyser',
    signal: 'entrymodel',
  };
  const reachable = new Set([...SECTIONS.map((s) => s.key), ...OFF_NAV_SECTIONS]);
  for (const [alias, target] of Object.entries(LEGACY_HASH)) {
    assert.ok(reachable.has(target), `legacy alias ${alias} must resolve to a reachable section`);
  }
});

test('navigation: the bot app stays an external link, not a workspace module', () => {
  // The Deriv bot app is a separate build served under /bot with its own router.
  // It must never be folded into the tab/section model, which would make the
  // shell try to route to it and break navigation.
  const tabKeys = new Set(MAIN_TABS.map((t) => t.key));
  assert.ok(!tabKeys.has('bot'), 'the bot app must not become a primary module');
  assert.ok(
    !SECTIONS.some((s) => String(s.key) === 'bot'),
    'the bot app must not become a workspace section'
  );
});
