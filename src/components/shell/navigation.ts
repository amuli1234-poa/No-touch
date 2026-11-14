import {
  Activity,
  BarChart3,
  Bell,
  Compass,
  LayoutDashboard,
  LineChart,
  Sliders,
  type LucideIcon
} from 'lucide-react';

export type Route =
  | 'BEST_MARKET'
  | 'STRATEGY_SCANNER'
  | 'MTF_ENTRY'
  | 'PLAIN_INDICES'
  | 'VOLATILITY_1S'
  | 'LIVE_CHART'
  | 'ANALYSIS'
  | 'SIGNALS'
  | 'HISTORY'
  | 'SETTINGS';

export interface NavItem {
  route: Route;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  {
    route: 'BEST_MARKET',
    label: 'Best Market',
    description: 'Highest-confluence opportunity ranked across the watchlist',
    icon: LayoutDashboard
  },
  {
    route: 'STRATEGY_SCANNER',
    label: 'Strategy Scanner',
    description: 'Six adaptive price-action strategies ranked by confluence',
    icon: Compass
  },
  {
    route: 'MTF_ENTRY',
    label: 'MTF Entry',
    description: 'Top-down H4 to M1 entry, stop and target precision levels',
    icon: LineChart
  },
  {
    route: 'PLAIN_INDICES',
    label: 'Plain Indices',
    description: 'Standard Deriv volatility indices',
    icon: BarChart3
  },
  {
    route: 'VOLATILITY_1S',
    label: 'Volatility 1s',
    description: 'High-frequency one-second volatility indices',
    icon: Activity
  },
  {
    route: 'LIVE_CHART',
    label: 'Live Chart',
    description: 'Interactive candlestick terminal with signal overlays',
    icon: LineChart
  },
  {
    route: 'ANALYSIS',
    label: 'Analysis',
    description: 'Full multi-timeframe breakdown for the selected instrument',
    icon: LineChart
  },
  {
    route: 'SIGNALS',
    label: 'Signals',
    description: 'Confirmed setups and alert dispatch log',
    icon: Bell
  },
  {
    route: 'HISTORY',
    label: 'History',
    description: 'Logged signal outcomes and strategy performance',
    icon: Activity
  },
  {
    route: 'SETTINGS',
    label: 'Settings',
    description: 'Scanner, scoring, alert and display configuration',
    icon: Sliders
  }
];

export function navItemFor(route: Route): NavItem {
  return NAV_ITEMS.find((item) => item.route === route) ?? NAV_ITEMS[0];
}

/**
 * The five top-level destinations. Each owns one or more sub-routes rendered as
 * compact in-page tabs, so the product keeps a single navigation bar while every
 * existing view stays reachable. `ANALYSIS` is intentionally absent - it is a
 * drill-down from the chart, never a top-level destination.
 */
export interface NavSection {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Route activated when the section is selected. */
  primary: Route;
  /** Sub-routes shown as in-page tabs. A single-entry section shows no tabs. */
  routes: Route[];
}

export const NAV_SECTIONS: NavSection[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, primary: 'LIVE_CHART', routes: ['LIVE_CHART', 'BEST_MARKET'] },
  { id: 'scanner', label: 'Scanner', icon: Compass, primary: 'STRATEGY_SCANNER', routes: ['STRATEGY_SCANNER', 'MTF_ENTRY'] },
  { id: 'markets', label: 'Markets', icon: BarChart3, primary: 'PLAIN_INDICES', routes: ['PLAIN_INDICES', 'VOLATILITY_1S'] },
  { id: 'activity', label: 'Activity', icon: Bell, primary: 'SIGNALS', routes: ['SIGNALS', 'HISTORY'] },
  { id: 'settings', label: 'Settings', icon: Sliders, primary: 'SETTINGS', routes: ['SETTINGS'] }
];

/** Short labels for the in-page sub-route tabs. */
export const TAB_LABELS: Partial<Record<Route, string>> = {
  LIVE_CHART: 'Chart',
  BEST_MARKET: 'Best market',
  STRATEGY_SCANNER: 'Strategies',
  MTF_ENTRY: 'MTF entry',
  PLAIN_INDICES: 'Plain',
  VOLATILITY_1S: '1-second',
  SIGNALS: 'Signals',
  HISTORY: 'History',
  SETTINGS: 'Settings'
};

/** The section a route belongs to, or null for drill-down routes (e.g. Analysis). */
export function sectionForRoute(route: Route): NavSection | null {
  return NAV_SECTIONS.find((s) => s.routes.includes(route)) ?? null;
}

/** The top-level nav item that should read as active for a given route. */
export function activeSectionId(route: Route): string | null {
  const section = sectionForRoute(route);
  if (section) return section.id;
  // Analysis is a drill-down from the chart, so Overview stays highlighted.
  return route === 'ANALYSIS' ? 'overview' : null;
}
