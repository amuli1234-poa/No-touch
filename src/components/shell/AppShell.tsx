import React from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { MobileNav } from './MobileNav';
import { NAV_ITEMS, Route, navItemFor } from './navigation';

interface AppShellProps {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  onNavigateOverview: () => void;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  lastScanTimestamp: number;
  isScanning: boolean;
  onScanAll: () => void;
  scanDisabled?: boolean;
  mobileNavOpen: boolean;
  onOpenMobileNav: () => void;
  onCloseMobileNav: () => void;
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({
  activeRoute,
  onNavigate,
  onNavigateOverview,
  connectionState,
  lastScanTimestamp,
  isScanning,
  onScanAll,
  scanDisabled,
  mobileNavOpen,
  onOpenMobileNav,
  onCloseMobileNav,
  children
}) => {
  const item = navItemFor(activeRoute);

  return (
    <div className="flex min-h-screen bg-[#080D18]">
      {/* Desktop sidebar */}
      <aside
        className="sticky top-0 hidden h-screen shrink-0 border-r border-[#1E293B] lg:block"
        style={{ width: 'var(--nav-width)' }}
      >
        <Sidebar
          activeRoute={activeRoute}
          onNavigate={onNavigate}
          onNavigateOverview={onNavigateOverview}
        />
      </aside>

      <MobileNav
        open={mobileNavOpen}
        activeRoute={activeRoute}
        onClose={onCloseMobileNav}
        onNavigate={onNavigate}
        onNavigateOverview={onNavigateOverview}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          title={item.label}
          description={item.description}
          connectionState={connectionState}
          lastScanTimestamp={lastScanTimestamp}
          isScanning={isScanning}
          onScanAll={onScanAll}
          onOpenMobileNav={onOpenMobileNav}
          scanDisabled={scanDisabled}
        />

        <main className="min-w-0 flex-1 px-3 pb-24 pt-4 sm:px-5 sm:pt-5 lg:pb-8">
          <div className="mx-auto w-full max-w-[1680px]">{children}</div>
        </main>

        {/* Mobile bottom tab bar */}
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-[#1E293B] bg-[#0B1120]/95 backdrop-blur-xl lg:hidden">
          <div className="grid grid-cols-4">
            {NAV_ITEMS.map((nav) => {
              const Icon = nav.icon;
              const active = nav.route === activeRoute;
              return (
                <button
                  key={nav.route}
                  onClick={() => onNavigate(nav.route)}
                  className={`flex flex-col items-center gap-1 py-2.5 text-[10px] font-semibold transition-colors ${
                    active ? 'text-[#A5A0FF]' : 'text-slate-500'
                  }`}
                >
                  <Icon className="h-[18px] w-[18px]" />
                  {nav.shortLabel}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
};
