import type { ReactNode } from 'react';
import {
  Activity,
  Award,
  BellRing,
  Bot,
  Boxes,
  Braces,
  BrainCircuit,
  CandlestickChart,
  Crosshair,
  FlaskConical,
  Gauge,
  GitBranch,
  GraduationCap,
  HeartPulse,
  Layers,
  LayoutDashboard,
  LineChart,
  Radar,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
  Waves,
} from 'lucide-react';

/**
 * Every reachable section. These are NOT all main tabs — the app exposes seven
 * main modules (see `MAIN_TABS`); the remaining sections are sub-views inside a hub
 * module. Keeping the full union means every existing deep link, hash and `navigate()`
 * call keeps working after the redesign.
 */
export type AppSection =
  | 'dashboard'
  | 'trade'
  | 'chart'
  | 'chartanalysis'
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
  | 'timeframealignment'
  | 'consolidation'
  | 'confluence'
  | 'live'
  | 'entrymodel'
  | 'performance'
  | 'risk'
  | 'alerts'
  | 'strategylab'
  | 'health'
  | 'training'
  | 'history'
  | 'settings'
  /* ------------------- visual strategy workspace (Phase 1) ------------------- */
  | 'freebots'
  | 'premiumbots'
  | 'copytrading'
  | 'aiintelligence';

export interface SectionMeta {
  key: AppSection;
  label: string;
  shortLabel: string;
  icon: ReactNode;
}

export interface MainTab {
  key: string;
  label: string;
  shortLabel: string;
  icon: ReactNode;
  /** Section shown when the tab is opened with no explicit sub-section. */
  defaultSection: AppSection;
  /** Every section reachable inside this main tab, in display order. */
  sections: readonly SectionMeta[];
}

const ICON = 'w-[18px] h-[18px]';

/**
 * The primary navigation modules. Each hub module contains its sub-views so no
 * individual strategy or tool ever becomes a top-level tab of its own. Trade History,
 * Risk Management and AI Training keep their components and routes but live inside a
 * hub module; Settings is reached from the TopBar gear and is deliberately absent here.
 */
export const MAIN_TABS: readonly MainTab[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    shortLabel: 'Dashboard',
    icon: <LayoutDashboard className={ICON} />,
    defaultSection: 'dashboard',
    sections: [
      { key: 'dashboard', label: 'Workspace', shortLabel: 'Workspace', icon: <LayoutDashboard className={ICON} /> },
      { key: 'trade', label: 'Trade', shortLabel: 'Trade', icon: <Wallet className={ICON} /> },
    ],
  },
  {
    key: 'proscanner',
    label: 'Pro Scanner',
    shortLabel: 'Scanner',
    icon: <Sparkles className={ICON} />,
    defaultSection: 'scanner',
    sections: [
      { key: 'scanner', label: 'Market Scanner', shortLabel: 'Scanner', icon: <Sparkles className={ICON} /> },
      { key: 'live', label: 'Live Market Scanner', shortLabel: 'Live', icon: <Radar className={ICON} /> },
      { key: 'trendlines', label: 'Trendline AI', shortLabel: 'Trendlines', icon: <TrendingUp className={ICON} /> },
      { key: 'demandsupply', label: 'Demand & Supply AI', shortLabel: 'D&S', icon: <Boxes className={ICON} /> },
      { key: 'boschoch', label: 'BOS & CHOCH AI', shortLabel: 'BOS', icon: <TrendingUp className={ICON} /> },
      { key: 'smc', label: 'SMC, ICT & Price Action AI', shortLabel: 'SMC', icon: <Crosshair className={ICON} /> },
      { key: 'liquidity', label: 'Liquidity AI', shortLabel: 'Liquidity', icon: <Waves className={ICON} /> },
      { key: 'fvg', label: 'FVG & Imbalance AI', shortLabel: 'FVG', icon: <Braces className={ICON} /> },
      { key: 'orderblock', label: 'Order Block & Breaker Block AI', shortLabel: 'OB', icon: <Boxes className={ICON} /> },
      { key: 'technical', label: 'Technical AI', shortLabel: 'Technical', icon: <Activity className={ICON} /> },
      { key: 'momentum', label: 'Momentum & Volatility AI', shortLabel: 'Momentum', icon: <Gauge className={ICON} /> },
      { key: 'regime', label: 'Market Regime & Consolidation AI', shortLabel: 'Regime', icon: <Layers className={ICON} /> },
      { key: 'timeframealignment', label: 'Timeframe Alignment AI', shortLabel: 'Alignment', icon: <GitBranch className={ICON} /> },
      { key: 'consolidation', label: 'Consolidation & Momentum AI', shortLabel: 'Consolidation', icon: <Gauge className={ICON} /> },
      { key: 'confluence', label: 'Confluence & Trade Validation AI', shortLabel: 'Confluence', icon: <ShieldCheck className={ICON} /> },
    ],
  },
  {
    key: 'freebots',
    label: 'Free Bots',
    shortLabel: 'Free Bots',
    icon: <Bot className={ICON} />,
    defaultSection: 'freebots',
    sections: [
      { key: 'freebots', label: 'Free Bots', shortLabel: 'Bots', icon: <Bot className={ICON} /> },
    ],
  },
  {
    key: 'premiumbots',
    label: 'Premium Bots',
    shortLabel: 'Premium',
    icon: <Bot className={ICON} />,
    defaultSection: 'premiumbots',
    sections: [
      { key: 'premiumbots', label: 'Premium Bots', shortLabel: 'Premium', icon: <Bot className={ICON} /> },
    ],
  },
  {
    key: 'copytrading',
    label: 'Copy Trading',
    shortLabel: 'Copy',
    icon: <Activity className={ICON} />,
    defaultSection: 'copytrading',
    sections: [
      { key: 'copytrading', label: 'Copy Trading', shortLabel: 'Copy Trading', icon: <Activity className={ICON} /> },
    ],
  },
  {
    key: 'marketanalysis',
    label: 'Market Analysis',
    shortLabel: 'Analysis',
    icon: <CandlestickChart className={ICON} />,
    defaultSection: 'chart',
    sections: [
      { key: 'chart', label: 'Chart Only', shortLabel: 'Chart Only', icon: <CandlestickChart className={ICON} /> },
      { key: 'chartanalysis', label: 'Chart Analysis', shortLabel: 'Analysis', icon: <Crosshair className={ICON} /> },
      { key: 'analyser', label: 'Chart Analyser', shortLabel: 'Analyser', icon: <ScanSearch className={ICON} /> },
      { key: 'performance', label: 'Trade Performance', shortLabel: 'Performance', icon: <Award className={ICON} /> },
      { key: 'history', label: 'Trade History', shortLabel: 'History', icon: <LineChart className={ICON} /> },
      { key: 'training', label: 'AI Training', shortLabel: 'Training', icon: <GraduationCap className={ICON} /> },
    ],
  },
  {
    key: 'aiintelligence',
    label: 'AI Intelligence',
    shortLabel: 'AI',
    icon: <BrainCircuit className={ICON} />,
    defaultSection: 'aiintelligence',
    sections: [
      { key: 'aiintelligence', label: 'Intelligence Overview', shortLabel: 'Overview', icon: <BrainCircuit className={ICON} /> },
      { key: 'entrymodel', label: 'Entry Model AI', shortLabel: 'Entry Model', icon: <Crosshair className={ICON} /> },
      { key: 'alerts', label: 'AI Alerts & Notification Manager', shortLabel: 'Alerts', icon: <BellRing className={ICON} /> },
      { key: 'risk', label: 'Risk & Execution AI', shortLabel: 'Risk', icon: <ShieldCheck className={ICON} /> },
      { key: 'strategylab', label: 'Strategy Optimization AI', shortLabel: 'Strategy Lab', icon: <FlaskConical className={ICON} /> },
      { key: 'health', label: 'System Health & Diagnostics', shortLabel: 'Health', icon: <HeartPulse className={ICON} /> },
    ],
  },
] as const;

/** Every section in display order, for lookups. */
export const SECTIONS: readonly SectionMeta[] = MAIN_TABS.flatMap((t) => t.sections);

/**
 * Sections that intentionally live outside the primary navigation. Settings is opened
 * from the TopBar gear; it keeps its own component, state and persistence.
 */
export const OFF_NAV_SECTIONS: readonly AppSection[] = ['settings'];

/**
 * The main tab that owns a section, or `null` when the section is deliberately not in
 * the primary navigation (Settings). Callers must handle `null` — it means "no tab is
 * active", not "fall back to the first tab".
 */
export function mainTabForSection(section: AppSection): MainTab | null {
  return MAIN_TABS.find((t) => t.sections.some((s) => s.key === section)) ?? null;
}

export type SectionBadges = Partial<Record<AppSection, number>>;

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-white text-[11px] font-bold">
      {count > 99 ? '99+' : count}
    </span>
  );
}

interface SidebarProps {
  active: AppSection;
  onSelect: (section: AppSection) => void;
  statusBadge?: ReactNode;
  badges?: SectionBadges;
  /** Hide entirely (the Chart tab is full-screen and renders no chrome). */
  hidden?: boolean;
}

/**
 * Desktop sidebar — the main tabs. The active hub tab expands to reveal its sub-views so
 * every module stays one tap away without becoming a main tab of its own.
 */
export function Sidebar({ active, onSelect, statusBadge, badges, hidden = false }: SidebarProps) {
  // Settings lives outside the primary navigation, so no module is active while it is open.
  const activeTabKey = mainTabForSection(active)?.key ?? null;
  return (
    <nav
      aria-label="Primary"
      className={`${hidden ? 'hidden' : 'hidden lg:flex'} flex-col w-[236px] shrink-0 border-r border-line bg-nav`}
    >
      <div className="h-14 px-4 flex items-center gap-2.5 border-b border-line">
        <div className="w-8 h-8 rounded-lg bg-accent/12 text-accent border border-accent/25 flex items-center justify-center shrink-0">
          <ScanSearch className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-bold tracking-tight text-ink leading-none">Deriv AI</div>
          <div className="text-[12px] font-medium text-muted leading-none mt-0.5">Scanner</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {MAIN_TABS.map((tab) => {
          const isActive = tab.key === activeTabKey;
          const tabBadge = tab.sections.reduce((n, s) => Math.max(n, badges?.[s.key] ?? 0), 0);
          return (
            <div key={tab.key}>
              <button
                type="button"
                onClick={() => onSelect(tab.defaultSection)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-semibold transition-colors duration-150 cursor-pointer border ${
                  isActive
                    ? 'bg-accent/10 text-accent border-accent/20'
                    : 'text-muted border-transparent hover:bg-elevated hover:text-ink'
                }`}
              >
                <span className={isActive ? 'text-accent' : 'text-faint'}>{tab.icon}</span>
                <span className="truncate">{tab.label}</span>
                <Badge count={tabBadge} />
              </button>

              {isActive && tab.sections.length > 1 && (
                <ul className="mt-0.5 mb-1 ml-3 pl-2 border-l border-line space-y-0.5">
                  {tab.sections.map((s) => {
                    const sub = s.key === active;
                    return (
                      <li key={s.key}>
                        <button
                          type="button"
                          onClick={() => onSelect(s.key)}
                          aria-current={sub ? 'page' : undefined}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] font-medium transition-colors cursor-pointer ${
                            sub ? 'bg-elevated text-accent' : 'text-faint hover:text-ink hover:bg-elevated/60'
                          }`}
                        >
                          <span className="truncate">{s.label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}

        {/* The Deriv bot app is a separate build served under /bot with its own
            router, so it is a plain link rather than a section of this shell. */}
        <a
          href={`${import.meta.env.BASE_URL}bot/`}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-semibold text-muted border border-transparent hover:bg-elevated hover:text-ink transition-colors duration-150"
        >
          <span className="text-faint">
            <Bot className={ICON} />
          </span>
          <span className="truncate">Bot Builder</span>
        </a>
      </div>

      {statusBadge && <div className="p-3 border-t border-line">{statusBadge}</div>}
    </nav>
  );
}

/** Mobile bottom bar — primary modules plus a "More" sheet. */
const MOBILE_PRIMARY: AppSection[] = ['dashboard', 'freebots', 'premiumbots', 'copytrading', 'scanner', 'chart', 'aiintelligence'];

interface MobileNavProps {
  active: AppSection;
  onSelect: (section: AppSection) => void;
  badges?: SectionBadges;
  onOpenMenu: () => void;
}

export function MobileNav({ active, onSelect, badges, onOpenMenu }: MobileNavProps) {
  const activeTabKey = mainTabForSection(active)?.key ?? null;
  const items = MOBILE_PRIMARY.map((k) => mainTabForSection(k)).filter(
    (t): t is MainTab => t !== null
  );
  return (
    <nav
      aria-label="Primary mobile"
      className="lg:hidden shrink-0 border-t border-line bg-nav pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="grid grid-cols-8">
        {items.map((tab) => {
          const isActive = tab.key === activeTabKey;
          const tabBadge = tab.sections.reduce((n, s) => Math.max(n, badges?.[s.key] ?? 0), 0);
          return (
            <li key={tab.key}>
              <button
                type="button"
                onClick={() => onSelect(tab.defaultSection)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex flex-col items-center justify-center gap-1 py-2 min-h-[54px] transition-colors cursor-pointer ${
                  isActive ? 'text-accent' : 'text-faint'
                }`}
              >
                <span className="relative">
                  {tab.icon}
                  {tabBadge > 0 && (
                    <span className="absolute -top-1.5 -right-2 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-accent text-white text-[10px] font-bold">
                      {tabBadge > 9 ? '9+' : tabBadge}
                    </span>
                  )}
                </span>
                <span className="text-[10px] font-medium tracking-tight">{tab.shortLabel}</span>
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
            <span className="text-[10px] font-medium tracking-tight">More</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** Full module list for the mobile "More" sheet — the main tabs plus their sub-views. */
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
          <span className="text-[15px] font-semibold text-ink">All modules</span>
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 text-[13px] font-medium text-muted bg-elevated border border-line rounded-lg cursor-pointer"
          >
            Close
          </button>
        </div>
        {MAIN_TABS.map((tab) => (
          <div key={tab.key} className="mb-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-faint px-1 pb-1">
              {tab.label}
            </div>
            <ul className="space-y-0.5">
              {tab.sections.map((s) => {
                const isActive = s.key === active;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(s.key);
                        onClose();
                      }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-[13px] font-medium cursor-pointer border ${
                        isActive ? 'bg-accent/10 text-accent border-accent/20' : 'text-muted border-transparent'
                      }`}
                    >
                      <span className={isActive ? 'text-accent' : 'text-faint'}>{s.icon}</span>
                      <span className="truncate">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <a
          href={`${import.meta.env.BASE_URL}bot/`}
          className="mt-1 w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-[13px] font-semibold text-muted border border-transparent"
        >
          <span className="text-faint">
            <Bot className="w-[18px] h-[18px]" />
          </span>
          <span className="truncate">Bot Builder</span>
        </a>
      </div>
    </div>
  );
}
