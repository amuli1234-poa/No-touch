import React from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { MobileNav } from './MobileNav';
import { MOBILE_ROUTES, NAV_ITEMS, Route, navItemFor } from './navigation';

interface AppShellProps {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  onNavigateOverview: () => void;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  lastScanTimestamp: number;
  isScanning: boolean;
  onScanAll: () => void;
  scanDisabled?: boolean;
  latencyMs?: number | null;
  missedTicks?: number;
  signalBadge?: number;
  lastTickAt?: number | null;
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
  latencyMs,
  missedTicks,
  signalBadge,
  lastTickAt,
  mobileNavOpen,
  onOpenMobileNav,
  onCloseMobileNav,
  children
}) => {
  const item = navItemFor(activeRoute);
  const mobileItems = MOBILE_ROUTES.map((r) => navItemFor(r));

  // Collapsing the sidebar is a display preference; persist it so the workspace
  // reopens the way the operator left it.
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem('ws-nav-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem('ws-nav-collapsed', next ? '1' : '0');
      } catch {
        /* storage unavailable — the in-memory state still applies */
      }
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-screen bg-app">
      {/* Desktop sidebar — collapsible rail. */}
      <aside
        className="sticky top-0 hidden h-screen shrink-0 border-r border-line-soft lg:block"
        style={{ width: collapsed ? 'var(--nav-width-collapsed)' : 'var(--nav-width)' }}
      >
        <Sidebar
          activeRoute={activeRoute}
          onNavigate={onNavigate}
          onNavigateOverview={onNavigateOverview}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          connectionState={connectionState}
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
          latencyMs={latencyMs}
          missedTicks={missedTicks}
          signalBadge={signalBadge}
          lastTickAt={lastTickAt}
        />

        <main className="min-w-0 flex-1 px-3 pb-24 pt-4 sm:px-5 sm:pt-5 lg:pb-8">
          <div className="mx-auto w-full max-w-[1680px]">{children}</div>
        </main>

        {/* Mobile bottom tab bar */}
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line-soft bg-surface-deep/95 backdrop-blur-xl lg:hidden">
          <div className="grid grid-cols-5">
            {mobileItems.map((nav) => {
              const Icon = nav.icon;
              const active = nav.route === activeRoute;
              return (
                <button
                  key={nav.route}
                  onClick={() => onNavigate(nav.route)}
                  className={`flex flex-col items-center gap-1 py-2.5 text-[10px] font-semibold transition-colors ${
                    active ? 'text-accent-soft' : 'text-fg-5'
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

export { NAV_ITEMS };
