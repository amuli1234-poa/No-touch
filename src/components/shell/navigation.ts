import {
  Activity,
  LineChart,
  Gauge,
  Settings as SettingsIcon,
  type LucideIcon
} from 'lucide-react';

export type Route = 'SCANNER' | 'ANALYSIS' | 'PERFORMANCE' | 'SETTINGS';

export interface NavItem {
  route: Route;
  label: string;
  shortLabel: string;
  description: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  {
    route: 'SCANNER',
    label: 'Live Scanner',
    shortLabel: 'Scanner',
    description: 'Real-time market qualification across synthetic indices',
    icon: Activity
  },
  {
    route: 'ANALYSIS',
    label: 'Market Analysis',
    shortLabel: 'Analysis',
    description: 'Multi-timeframe structure, liquidity and imbalance review',
    icon: LineChart
  },
  {
    route: 'PERFORMANCE',
    label: 'Performance & Calibration',
    shortLabel: 'Performance',
    description: 'Settled outcomes and probability calibration tracking',
    icon: Gauge
  },
  {
    route: 'SETTINGS',
    label: 'Settings',
    shortLabel: 'Settings',
    description: 'Scanner, expiry, scoring and display configuration',
    icon: SettingsIcon
  }
];

export function navItemFor(route: Route): NavItem {
  return NAV_ITEMS.find((item) => item.route === route) ?? NAV_ITEMS[0];
}
