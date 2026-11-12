import React from 'react';
import { NAV_ITEMS, Route } from './navigation';

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
  <div className={`flex h-full flex-col bg-[#0B1120] ${className}`}>
    {/* Brand */}
    <div className="flex items-center gap-3 border-b border-[#1E293B] px-4 py-4">
      <button
        onClick={onNavigateOverview}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-[#635BFF] to-[#38BDF8] shadow-[0_4px_14px_-4px_rgba(99,91,255,0.7)]"
        aria-label="Open overview"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none">
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
          <span className="truncate text-[13px] font-extrabold tracking-tight text-white">
            DERIV NO TOUCH
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[10.5px] font-semibold tracking-[0.14em] text-slate-500">
            SCANNER
          </span>
          <span className="rounded border border-[#635BFF]/40 bg-[#635BFF]/15 px-1 py-px text-[9px] font-bold text-[#A5A0FF]">
            V4.0 PRO
          </span>
        </div>
      </div>
    </div>

    {/* Navigation */}
    <nav className="flex-1 space-y-1 overflow-y-auto p-2.5">
      <div className="px-2 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">
        Workspace
      </div>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.route === activeRoute;
        return (
          <button
            key={item.route}
            onClick={() => onNavigate(item.route)}
            aria-current={active ? 'page' : undefined}
            className={`group relative flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors ${
              active
                ? 'bg-[#172238] text-white'
                : 'text-slate-400 hover:bg-[#141D2F] hover:text-slate-100'
            }`}
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[#635BFF]" />
            )}
            <Icon
              className={`h-4 w-4 shrink-0 ${active ? 'text-[#8B85FF]' : 'text-slate-500 group-hover:text-slate-300'}`}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold tracking-tight">
                {item.label}
              </span>
            </span>
          </button>
        );
      })}
    </nav>

    {/* Footer */}
    <div className="border-t border-[#1E293B] p-3">
      <div className="rounded-[10px] border border-[#1E293B] bg-[#0F1728] px-3 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
          Engine
        </div>
        <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
          2m displacement · 5m alignment imbalance model
        </div>
      </div>
    </div>
  </div>
);
