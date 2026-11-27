import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Link2,
  CreditCard,
  FileClock,
  Gauge,
  Headphones,
  Repeat,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
  Wallet
} from 'lucide-react';

/**
 * Sidebar navigation. `permission` gates the item: an administrator only sees
 * routes they can actually open. The server enforces the same permissions.
 */
export interface NavItem {
  key: string;
  path: string;
  label: string;
  icon: LucideIcon;
  permission: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { key: 'dashboard', path: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard.read' },
      { key: 'analytics', path: '/analytics', label: 'Analytics', icon: BarChart3, permission: 'analytics.read' }
    ]
  },
  {
    label: 'Customers',
    items: [
      { key: 'users', path: '/users', label: 'Users', icon: Users, permission: 'users.read' },
      {
        key: 'copy-clients',
        path: '/copy-trading/clients',
        label: 'Copy Trading',
        icon: Repeat,
        permission: 'copytrading.read'
      },
      {
        key: 'deriv-connections',
        path: '/copy-trading/connections',
        label: 'Deriv Connections',
        icon: Link2,
        permission: 'copytrading.read'
      },
      { key: 'subscriptions', path: '/subscriptions', label: 'Subscriptions', icon: CreditCard, permission: 'subscriptions.read' },
      { key: 'revenue', path: '/revenue', label: 'Revenue', icon: Wallet, permission: 'revenue.read' },
      { key: 'support', path: '/support', label: 'Support', icon: Headphones, permission: 'support.read' }
    ]
  },
  {
    label: 'Copy Trading',
    items: [
      { key: 'copy-overview', path: '/copy-trading/overview', label: 'Overview', icon: Gauge, permission: 'copytrading.read' },
      { key: 'copy-client-detail', path: '/copy-trading/client', label: 'Client Details', icon: Users, permission: 'copytrading.read' },
      { key: 'copy-strategies', path: '/copy-trading/strategies', label: 'Strategies', icon: Bot, permission: 'copytrading.read' },
      { key: 'copy-executions', path: '/copy-trading/executions', label: 'Live Executions', icon: Activity, permission: 'copytrading.read' },
      { key: 'copy-risk', path: '/copy-trading/risk', label: 'Risk Management', icon: ShieldCheck, permission: 'copytrading.read' },
      { key: 'copy-revenue', path: '/copy-trading/revenue', label: 'Revenue & Commissions', icon: Wallet, permission: 'copytrading.read' },
      { key: 'copy-reports', path: '/copy-trading/reports', label: 'Reports & Audit', icon: FileClock, permission: 'copytrading.read' }
    ]
  },
  {
    label: 'Operations',
    items: [
      { key: 'scanner', path: '/scanner', label: 'Scanner Ops', icon: Gauge, permission: 'monitoring.read' },
      { key: 'bots', path: '/bots', label: 'Bot Builder', icon: Bot, permission: 'monitoring.read' },
      { key: 'monitoring', path: '/monitoring', label: 'System Health', icon: Activity, permission: 'monitoring.read' }
    ]
  },
  {
    label: 'Governance',
    items: [
      { key: 'administrators', path: '/administrators', label: 'Administrators', icon: ShieldCheck, permission: 'admins.read' },
      { key: 'announcements', path: '/announcements', label: 'Announcements', icon: Bell, permission: 'announcements.read' },
      { key: 'audit', path: '/audit', label: 'Audit Log', icon: ScrollText, permission: 'audit.read' },
      { key: 'configuration', path: '/configuration', label: 'Configuration', icon: Settings, permission: 'configuration.read' },
      { key: 'reports', path: '/reports', label: 'Reports', icon: FileClock, permission: 'analytics.read' }
    ]
  }
];

export function findNav(path: string): NavItem | null {
  for (const group of NAV) {
    for (const item of group.items) {
      if (item.path === path) return item;
    }
  }
  return null;
}
