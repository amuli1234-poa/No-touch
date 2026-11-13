import {
  Activity,
  Award,
  BarChart3,
  Bell,
  Compass,
  Layers,
  LineChart,
  Sliders,
  Sparkles,
  Zap,
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

export type NavGroup = 'Discovery' | 'Markets' | 'Intelligence' | 'System';

export interface NavItem {
  route: Route;
  label: string;
  shortLabel: string;
  description: string;
  icon: LucideIcon;
  group: NavGroup;
}

export const NAV_ITEMS: NavItem[] = [
  {
    route: 'BEST_MARKET',
    label: 'Best Market',
    shortLabel: 'Best',
    description: 'Highest-confluence opportunity ranked across the watchlist',
    icon: Sparkles,
    group: 'Discovery'
  },
  {
    route: 'STRATEGY_SCANNER',
    label: 'Strategy Scanner',
    shortLabel: 'Strategy',
    description: 'Six adaptive price-action strategies ranked by confluence',
    icon: Compass,
    group: 'Discovery'
  },
  {
    route: 'MTF_ENTRY',
    label: 'MTF Precision Entry',
    shortLabel: 'MTF',
    description: 'Top-down H4 → M1 entry, stop and target precision levels',
    icon: Layers,
    group: 'Discovery'
  },
  {
    route: 'PLAIN_INDICES',
    label: 'Plain Indices',
    shortLabel: 'Plain',
    description: 'Standard Deriv volatility indices',
    icon: BarChart3,
    group: 'Markets'
  },
  {
    route: 'VOLATILITY_1S',
    label: 'Volatility 1s',
    shortLabel: '1s',
    description: 'High-frequency one-second volatility indices',
    icon: Zap,
    group: 'Markets'
  },
  {
    route: 'LIVE_CHART',
    label: 'Live Chart',
    shortLabel: 'Chart',
    description: 'Interactive candlestick terminal with signal overlays',
    icon: LineChart,
    group: 'Markets'
  },
  {
    route: 'ANALYSIS',
    label: 'Analysis',
    shortLabel: 'Analysis',
    description: 'Full multi-timeframe breakdown for the selected instrument',
    icon: Layers,
    group: 'Intelligence'
  },
  {
    route: 'SIGNALS',
    label: 'Signals',
    shortLabel: 'Signals',
    description: 'Confirmed setups and alert dispatch log',
    icon: Bell,
    group: 'Intelligence'
  },
  {
    route: 'HISTORY',
    label: 'History',
    shortLabel: 'History',
    description: 'Logged signal outcomes and strategy performance',
    icon: Award,
    group: 'Intelligence'
  },
  {
    route: 'SETTINGS',
    label: 'Settings',
    shortLabel: 'Settings',
    description: 'Scanner, scoring, alert and display configuration',
    icon: Sliders,
    group: 'System'
  }
];

export const NAV_GROUPS: NavGroup[] = ['Discovery', 'Markets', 'Intelligence', 'System'];

/** Mobile bottom bar shows a compact subset to keep tap targets usable. */
export const MOBILE_ROUTES: Route[] = [
  'BEST_MARKET',
  'STRATEGY_SCANNER',
  'LIVE_CHART',
  'SIGNALS',
  'SETTINGS'
];

export function navItemFor(route: Route): NavItem {
  return NAV_ITEMS.find((item) => item.route === route) ?? NAV_ITEMS[0];
}

export { Activity };
