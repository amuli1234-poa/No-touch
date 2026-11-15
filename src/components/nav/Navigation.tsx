import type { ReactNode } from 'react';
import {
  Activity,
  Award,
  BarChart3,
  BellRing,
  Boxes,
  Braces,
  Crosshair,
  FlaskConical,
  Gauge,
  GraduationCap,
  HeartPulse,
  Layers,
  LineChart,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  ScanSearch,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Waves,
} from 'lucide-react';
import { CONNECTION_STATUS_DOT } from '../ConnectionBadge';
import type { ConnectionStatus } from '../../types/market';

export type AppSection =
  | 'dashboard'
  | 'analyser'
  | 'scanner'
  | 'trendlines'
  | 'demandsupply'
  | 'boschoch'
  | 'technical'
  | 'smc'
  | 'liquidity'
  | 'fvg'
  | 'orderblock'
  | 'momentum'
  | 'regime'
  | 'confluence'
  | 'live'
  | 'performance'
  | 'risk'
  | 'alerts'
  | 'strategylab'
  | 'health'
  | 'training'
  | 'history'
  | 'settings';

export interface SectionMeta {
  key: AppSection;
  label: string;
  shortLabel: string;
  icon: ReactNode;
}

export interface SectionGroup {
  label: string;
  items: SectionMeta[];
}

/**
 * Grouped navigation. Every module stays reachable, but the sidebar is organised so the single
 * shared chart and the primary tools are never buried. Selecting a module opens its panel
 * beside the ONE shared chart.
 */
export const SECTION_GROUPS: readonly SectionGroup[] = [
  {
    label: 'Workspace',
    items: [
      { key: 'dashboard', label: 'Dashboard', shortLabel: 'Home', icon: <BarChart3 className="w-[18px] h-[18px]" /> },
      { key: 'analyser', label: 'Chart Analyser', shortLabel: 'Analyser', icon: <ScanSearch className="w-[18px] h-[18px]" /> },
      { key: 'scanner', label: 'Market Scanner', shortLabel: 'Scanner', icon: <Sparkles className="w-[18px] h-[18px]" /> },
      { key: 'live', label: 'Live Market Scanner', shortLabel: 'Live', icon: <Radar className="w-[18px] h-[18px]" /> },
    ],
  },
  {
    label: 'Structure AI',
    items: [
      { key: 'trendlines', label: 'Trendline AI', shortLabel: 'Trendlines', icon: <TrendingUp className="w-[18px] h-[18px]" /> },
      { key: 'demandsupply', label: 'Demand & Supply AI', shortLabel: 'D&S', icon: <Boxes className="w-[18px] h-[18px]" /> },
      { key: 'boschoch', label: 'BOS & CHOCH AI', shortLabel: 'BOS', icon: <TrendingUp className="w-[18px] h-[18px]" /> },
      { key: 'smc', label: 'SMC, ICT & Price Action AI', shortLabel: 'SMC', icon: <Crosshair className="w-[18px] h-[18px]" /> },
      { key: 'liquidity', label: 'Liquidity AI', shortLabel: 'Liquidity', icon: <Waves className="w-[18px] h-[18px]" /> },
      { key: 'fvg', label: 'FVG & Imbalance AI', shortLabel: 'FVG', icon: <Braces className="w-[18px] h-[18px]" /> },
      { key: 'orderblock', label: 'Order Block & Breaker Block AI', shortLabel: 'OB', icon: <Boxes className="w-[18px] h-[18px]" /> },
    ],
  },
  {
    label: 'Momentum & Regime AI',
    items: [
      { key: 'technical', label: 'Technical AI', shortLabel: 'Technical', icon: <Activity className="w-[18px] h-[18px]" /> },
      { key: 'momentum', label: 'Momentum & Volatility AI', shortLabel: 'Momentum', icon: <Gauge className="w-[18px] h-[18px]" /> },
      { key: 'regime', label: 'Market Regime & Consolidation AI', shortLabel: 'Regime', icon: <Layers className="w-[18px] h-[18px]" /> },
      { key: 'confluence', label: 'Confluence & Trade Validation AI', shortLabel: 'Confluence', icon: <ShieldCheck className="w-[18px] h-[18px]" /> },
      { key: 'risk', label: 'Risk Management & Trade Execution AI', shortLabel: 'Risk', icon: <ShieldCheck className="w-[18px] h-[18px]" /> },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { key: 'performance', label: 'Trade Performance & Learning AI', shortLabel: 'Performance', icon: <Award className="w-[18px] h-[18px]" /> },
      { key: 'strategylab', label: 'Strategy Optimization & Market Intelligence AI', shortLabel: 'Strategy Lab', icon: <FlaskConical className="w-[18px] h-[18px]" /> },
      { key: 'alerts', label: 'AI Alerts & Notification Manager', shortLabel: 'Alerts', icon: <BellRing className="w-[18px] h-[18px]" /> },
    ],
  },
  {
    label: 'System',
    items: [
      { key: 'health', label: 'System Health & Diagnostics', shortLabel: 'Health', icon: <HeartPulse className="w-[18px] h-[18px]" /> },
      { key: 'training', label: 'AI Training', shortLabel: 'Train', icon: <GraduationCap className="w-[18px] h-[18px]" /> },
      { key: 'history', label: 'Trade History', shortLabel: 'History', icon: <LineChart className="w-[18px] h-[18px]" /> },
      { key: 'settings', label: 'Settings', shortLabel: 'Settings', icon: <SettingsIcon className="w-[18px] h-[18px]" /> },
    ],
  },
] as const;

/** Flat list of every section (order preserved) for lookups and legacy helpers. */
export const SECTIONS: readonly SectionMeta[] = SECTION_GROUPS.flatMap((g) => g.items);

export type SectionBadges = Partial<Record<AppSection, number>>;

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-white text-[10px] font-bold">
      {count > 99 ? '99+' : count}
    </span>
  );
}

interface SidebarProps {
  active: AppSection;
  onSelect: (section: AppSection) => void;
  statusBadge?: ReactNode;
  badges?: SectionBadges;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  connectionStatus?: ConnectionStatus;
}

export function Sidebar({
  active,
  onSelect,
  statusBadge,
  badges,
  collapsed = false,
  onToggleCollapsed,
  connectionStatus,
}: SidebarProps) {
  return (
    <nav
      aria-label="Primary"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={`hidden lg:flex flex-col shrink-0 border-r border-line bg-nav transition-[width] duration-200 ${
        collapsed ? 'w-[68px]' : 'w-[236px]'
      }`}
    >
      <div
        className={`h-14 flex items-center border-b border-line shrink-0 ${
          collapsed ? 'px-2 justify-center' : 'px-3 justify-between gap-2'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-accent/12 text-accent border border-accent/25 flex items-center justify-center shrink-0">
            <ScanSearch className="w-4 h-4" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-[13px] font-extrabold tracking-tight text-ink leading-none">
                Wick<span className="text-accent">Sentinel</span>
              </div>
              <div className="text-[9px] font-semibold uppercase tracking-wider text-faint leading-none mt-1">
                Market Intelligence
              </div>
            </div>
          )}
        </div>
        {onToggleCollapsed && !collapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            aria-expanded={true}
            title="Collapse sidebar"
            className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-faint hover:text-ink hover:bg-elevated transition-colors cursor-pointer"
          >
            <PanelLeftClose className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {onToggleCollapsed && collapsed && (
        <div className="shrink-0 px-1.5 py-1.5 border-b border-line-soft flex justify-center">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Expand sidebar"
            aria-expanded={false}
            title="Expand sidebar"
            className="w-full h-7 rounded-lg flex items-center justify-center text-faint hover:text-ink hover:bg-elevated transition-colors cursor-pointer"
          >
            <PanelLeftOpen className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className={`flex-1 min-h-0 overflow-y-auto py-2 space-y-3 ${collapsed ? 'px-1.5' : 'px-2'}`}>
        {SECTION_GROUPS.map((group) => (
          <div key={group.label}>
            {collapsed ? (
              <div className="mx-auto mb-1.5 w-5 border-t border-line-soft" aria-hidden="true" />
            ) : (
              <div className="px-2 pb-1 text-[9px] font-bold uppercase tracking-wider text-faint">
                {group.label}
              </div>
            )}
            <ul className="space-y-0.5">
              {group.items.map((s) => {
                const isActive = s.key === active;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => onSelect(s.key)}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={collapsed ? s.label : undefined}
                      title={collapsed ? s.label : undefined}
                      className={`w-full flex items-center rounded-lg transition-colors duration-150 cursor-pointer border ${
                        collapsed ? 'justify-center px-0 py-2 gap-0' : 'gap-2.5 px-2.5 py-1.5'
                      } ${isActive ? 'bg-accent/10 text-accent border-accent/20' : 'text-muted border-transparent hover:bg-elevated hover:text-ink'}`}
                    >
                      <span className={`relative shrink-0 ${isActive ? 'text-accent' : 'text-faint'}`}>
                        {s.icon}
                        {(badges?.[s.key] ?? 0) > 0 && (
                          <span className="absolute -top-1 -right-1.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-accent text-white text-[8px] font-bold">
                            {(badges?.[s.key] ?? 0) > 9 ? '9+' : badges?.[s.key]}
                          </span>
                        )}
                      </span>
                      {!collapsed && (
                        <>
                          <span className="truncate text-[11px] font-bold tracking-tight">{s.label}</span>
                          <Badge count={badges?.[s.key] ?? 0} />
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {statusBadge && (
        <div className={`border-t border-line shrink-0 ${collapsed ? 'p-2 flex justify-center' : 'p-3'}`}>
          {collapsed ? (
            <span
              className={`block w-2.5 h-2.5 rounded-full shrink-0 ${CONNECTION_STATUS_DOT[connectionStatus ?? 'disconnected']}`}
              data-testid="connection-status"
              title="Deriv Feed · connection status"
              aria-hidden="true"
            />
          ) : (
            statusBadge
          )}
        </div>
      )}
    </nav>
  );
}

const MOBILE_PRIMARY: AppSection[] = ['analyser', 'scanner', 'live', 'strategylab', 'alerts'];

interface MobileNavProps {
  active: AppSection;
  onSelect: (section: AppSection) => void;
  badges?: SectionBadges;
  onOpenMenu: () => void;
}

export function MobileNav({ active, onSelect, badges, onOpenMenu }: MobileNavProps) {
  const items = MOBILE_PRIMARY.map((k) => SECTIONS.find((s) => s.key === k)!).filter(Boolean);
  return (
    <nav
      aria-label="Primary mobile"
      className="lg:hidden shrink-0 border-t border-line bg-nav pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="grid grid-cols-6">
        {items.map((s) => {
          const isActive = s.key === active;
          return (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => onSelect(s.key)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex flex-col items-center justify-center gap-1 py-2 min-h-[54px] transition-colors cursor-pointer ${
                  isActive ? 'text-accent' : 'text-faint'
                }`}
              >
                <span className="relative">
                  {s.icon}
                  {(badges?.[s.key] ?? 0) > 0 && (
                    <span className="absolute -top-1.5 -right-2 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-accent text-white text-[9px] font-bold">
                      {(badges?.[s.key] ?? 0) > 9 ? '9+' : badges?.[s.key]}
                    </span>
                  )}
                </span>
                <span className="text-[9px] font-medium tracking-tight">{s.shortLabel}</span>
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Open all modules"
            className="w-full flex flex-col items-center justify-center gap-1 py-2 min-h-[54px] text-faint cursor-pointer"
          >
            <Layers className="w-[18px] h-[18px]" />
            <span className="text-[9px] font-medium tracking-tight">More</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** Full module list for the mobile "More" sheet. */
export function MobileMenuSheet({
  active,
  onSelect,
  onClose,
}: {
  active: AppSection;
  onSelect: (section: AppSection) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="absolute inset-0 bg-black/40 animate-[fade-in_150ms_ease-out]" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-2xl bg-nav border-t border-line p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] animate-[sheet-up_220ms_cubic-bezier(0.16,1,0.3,1)]">
        <div className="flex items-center justify-between pb-2">
          <span className="text-[13px] font-bold text-ink">All modules</span>
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 bg-elevated border border-line rounded-lg cursor-pointer"
          >
            <span className="text-[11px] font-bold text-muted">Close</span>
          </button>
        </div>
        {SECTION_GROUPS.map((group) => (
          <div key={group.label} className="mb-3">
            <div className="text-[9px] font-bold uppercase tracking-wider text-faint px-1 pb-1">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((s) => {
                const isActive = s.key === active;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(s.key);
                        onClose();
                      }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-[11px] font-bold tracking-tight cursor-pointer border ${
                        isActive ? 'bg-accent/10 text-accent border-accent/20' : 'text-muted border-transparent'
                      }`}
                    >
                      <span className={isActive ? 'text-accent' : 'text-faint'}>{s.icon}</span>
                      <span className="truncate text-[11px] font-bold tracking-tight">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
