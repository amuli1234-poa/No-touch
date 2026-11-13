import React from 'react';
import { NAV_GROUPS, NAV_ITEMS, Route } from './navigation';
import { ThemeToggle } from '../ui/ThemeToggle';

interface SidebarProps {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  onNavigateOverview?: () => void;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeRoute,
  onNavigate,
  onNavigateOverview,
  className = ''
}) => (
  <div className={`flex h-full flex-col bg-surface-deep ${className}`}>
    {/* Brand */}
    <div className="flex items-center gap-3 border-b border-line-soft px-4 py-4">
      <button
        onClick={onNavigateOverview}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-accent to-accent-cyan shadow-[var(--shadow-accent)]"
        aria-label="Open overview"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-on-accent" fill="none">
          <path
            d="M3 15.5l4.5-5 3.5 3 4-6 6 7.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="20" cy="5" r="1.8" fill="currentColor" />
        </svg>
      </button>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-extrabold tracking-tight text-fg-1">
            WICKSENTINEL
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[10.5px] font-semibold tracking-[0.14em] text-fg-5">
            SIGNAL ENGINE
          </span>
          <span className="rounded border border-accent/40 bg-accent/15 px-1 py-px text-[9px] font-bold text-accent-soft">
            PRO
          </span>
        </div>
      </div>
    </div>

    {/* Navigation */}
    <nav className="flex-1 space-y-3 overflow-y-auto p-2.5">
      {NAV_GROUPS.map((group) => {
        const items = NAV_ITEMS.filter((item) => item.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-6">
              {group}
            </div>
            <div className="space-y-0.5">
              {items.map((item) => {
                const Icon = item.icon;
                const active = item.route === activeRoute;
                return (
                  <button
                    key={item.route}
                    onClick={() => onNavigate(item.route)}
                    aria-current={active ? 'page' : undefined}
                    title={item.description}
                    className={`group relative flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors ${
                      active
                        ? 'bg-surface-raised text-fg-1'
                        : 'text-fg-4 hover:bg-surface-raised hover:text-fg-1'
                    }`}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent" />
                    )}
                    <Icon
                      className={`h-4 w-4 shrink-0 ${active ? 'text-accent-strong' : 'text-fg-5 group-hover:text-fg-3'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold tracking-tight">
                        {item.label}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>

    {/* Footer */}
    <div className="border-t border-line-soft p-3">
      <div className="mb-2 flex items-center justify-between rounded-[10px] border border-line-soft bg-surface px-3 py-2">
        <span className="text-[11px] font-semibold text-fg-3">Appearance</span>
        <ThemeToggle variant="switch" />
      </div>
      <div className="rounded-[10px] border border-line-soft bg-surface px-3 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-6">
          Engine
        </div>
        <div className="mt-1 text-[11px] leading-relaxed text-fg-5">
          Top-down H4 → H1 → M15 → M5 → M1 price-action model
        </div>
      </div>
    </div>
  </div>
);
