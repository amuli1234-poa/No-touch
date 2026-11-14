import React from 'react';
import { TopNav } from './TopNav';
import { Route, TAB_LABELS, navItemFor, sectionForRoute } from './navigation';

interface AppShellProps {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  isScanning: boolean;
  onScanAll: () => void;
  scanDisabled?: boolean;
  signalBadge?: number;
  lastTickAt?: number | null;
  children: React.ReactNode;
}

/**
 * The workspace frame: one compact navigation bar, then the content.
 *
 * There is deliberately no sidebar and no second navigation bar - the product
 * keeps a single horizontal nav, and any sub-views within a section are reached
 * through a slim in-page tab strip. That keeps the chart as the dominant
 * element instead of competing with chrome.
 */
export const AppShell: React.FC<AppShellProps> = ({
  activeRoute,
  onNavigate,
  connectionState,
  isScanning,
  onScanAll,
  scanDisabled,
  signalBadge,
  lastTickAt,
  children
}) => {
  const section = sectionForRoute(activeRoute);
  const showTabs = !!section && section.routes.length > 1;

  return (
    <div className="flex min-h-screen flex-col bg-app">
      <TopNav
        activeRoute={activeRoute}
        onNavigate={onNavigate}
        connectionState={connectionState}
        lastTickAt={lastTickAt}
        isScanning={isScanning}
        onScanAll={onScanAll}
        scanDisabled={scanDisabled}
        signalBadge={signalBadge}
      />

      <main className="mx-auto w-full max-w-[1680px] flex-1 px-3 pb-8 pt-3 sm:px-4 sm:pt-4">
        {showTabs && (
          <nav
            className="mb-3 flex items-center gap-0.5 border-b border-line-soft"
            aria-label="Section views"
          >
            {section!.routes.map((r) => {
              const active = r === activeRoute;
              return (
                <button
                  key={r}
                  onClick={() => onNavigate(r)}
                  aria-current={active ? 'page' : undefined}
                  className={`-mb-px border-b-2 px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                    active
                      ? 'border-accent text-fg-1'
                      : 'border-transparent text-fg-5 hover:text-fg-2'
                  }`}
                >
                  {TAB_LABELS[r] ?? navItemFor(r).label}
                </button>
              );
            })}
          </nav>
        )}

        {children}
      </main>
    </div>
  );
};
