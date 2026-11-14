import React from 'react';
import { ChevronsLeft, ChevronsRight, LogOut, User, Wallet, WifiOff } from 'lucide-react';
import { NAV_GROUPS, NAV_ITEMS, Route } from './navigation';
import { ThemeToggle } from '../ui/ThemeToggle';
import { StatusDot } from '../ui/Badge';
import { useAuth, logout } from '../../lib/auth';
import { navigate } from '../../lib/router';

/**
 * Persistent workspace sidebar.
 *
 * Collapses to an icon rail so the chart can reclaim horizontal space on
 * laptops; the choice is owned by the shell and persisted there. The footer
 * carries what an operator needs at a glance — the Deriv connection, which
 * account mode they are on, the profile and logout.
 *
 * Navigation is driven entirely by `navigation.ts`, so no item here can point
 * at a route the product does not have.
 */

interface SidebarProps {
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  onNavigateOverview?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  connectionState?: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeRoute,
  onNavigate,
  onNavigateOverview,
  collapsed = false,
  onToggleCollapsed,
  connectionState = 'DISCONNECTED',
  className = ''
}) => {
  const auth = useAuth();
  const connected = auth.status === 'authenticated';

  return (
    <div className={`flex h-full flex-col bg-surface-deep ${className}`}>
      {/* Brand */}
      <div
        className={`flex items-center gap-3 border-b border-line-soft py-4 ${
          collapsed ? 'justify-center px-2' : 'px-4'
        }`}
      >
        <button
          onClick={onNavigateOverview}
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-accent to-accent-cyan shadow-[var(--shadow-accent)]"
          aria-label="Open overview"
          title="WickSentinel overview"
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
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-extrabold tracking-tight text-fg-1">
              WICKSENTINEL
            </span>
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[10.5px] font-semibold tracking-[0.14em] text-fg-5">
                SIGNAL ENGINE
              </span>
              <span className="rounded border border-accent/40 bg-accent/15 px-1 py-px text-[9px] font-bold text-accent-soft">
                PRO
              </span>
            </div>
          </div>
        )}
        {onToggleCollapsed && !collapsed && (
          <button
            onClick={onToggleCollapsed}
            aria-label="Collapse navigation"
            title="Collapse navigation"
            className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-fg-5 transition-colors hover:bg-surface-raised hover:text-fg-1 lg:flex"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-3 overflow-y-auto p-2.5">
        {NAV_GROUPS.map((group) => {
          const items = NAV_ITEMS.filter((item) => item.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              {!collapsed && (
                <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-6">
                  {group}
                </div>
              )}
              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = item.route === activeRoute;
                  return (
                    <button
                      key={item.route}
                      onClick={() => onNavigate(item.route)}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? item.label : item.description}
                      className={`group relative flex w-full items-center gap-3 rounded-[10px] py-2 text-left transition-colors ${
                        collapsed ? 'justify-center px-2' : 'px-3'
                      } ${
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
                      {!collapsed && (
                        <span className="block min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-tight">
                          {item.label}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className={`border-t border-line-soft ${collapsed ? 'p-2' : 'p-3'}`}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            {onToggleCollapsed && (
              <button
                onClick={onToggleCollapsed}
                aria-label="Expand navigation"
                title="Expand navigation"
                className="hidden h-8 w-8 items-center justify-center rounded-[9px] text-fg-5 transition-colors hover:bg-surface-raised hover:text-fg-1 lg:flex"
              >
                <ChevronsRight className="h-4 w-4" />
              </button>
            )}
            <ThemeToggle variant="icon" />
            <span
              title={
                connected
                  ? `${auth.user.loginId || 'Deriv account'} · ${auth.user.demoAccounts} demo / ${auth.user.realAccounts} real`
                  : 'Not signed in'
              }
              className="flex h-8 w-8 items-center justify-center rounded-full border border-line-soft bg-surface"
            >
              {connected ? (
                <Wallet className="h-3.5 w-3.5 text-tint-teal" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-fg-5" />
              )}
            </span>
          </div>
        ) : (
          <>
            <AccountCard connectionState={connectionState} />
            <div className="mt-2 flex items-center justify-between rounded-[10px] border border-line-soft bg-surface px-3 py-2">
              <span className="text-[11px] font-semibold text-fg-3">Appearance</span>
              <ThemeToggle variant="switch" />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/** Account, Deriv connection and account-mode card shown when expanded. */
const AccountCard: React.FC<{ connectionState: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' }> = ({
  connectionState
}) => {
  const auth = useAuth();
  const [busy, setBusy] = React.useState(false);

  const handleLogout = async () => {
    setBusy(true);
    await logout();
    setBusy(false);
    navigate('/login');
  };

  const connected = auth.status === 'authenticated';

  return (
    <div className="rounded-[10px] border border-line-soft bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent-soft">
          <User className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] font-semibold text-fg-2">
            {connected ? auth.user.loginId || 'Deriv account' : 'Not signed in'}
          </p>
          <p className="truncate text-[10px] text-fg-5">
            {connected ? 'Authenticated with Deriv' : 'Local preview session'}
          </p>
        </div>
      </div>

      <div className="mt-2.5 space-y-1.5 border-t border-line-soft pt-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-6">
            Account mode
          </span>
          {connected ? (
            <span className="flex items-center gap-1.5 text-[10.5px] text-fg-4">
              <span className="tabular">{auth.user.demoAccounts} demo</span>
              <span className="h-3 w-px bg-line" />
              <span className="tabular">{auth.user.realAccounts} real</span>
            </span>
          ) : (
            <span className="text-[10.5px] text-fg-5">—</span>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-6">
            Market feed
          </span>
          <StatusDot
            tone={
              connectionState === 'CONNECTED'
                ? 'success'
                : connectionState === 'RECONNECTING'
                  ? 'warning'
                  : 'danger'
            }
            pulse={connectionState === 'CONNECTED'}
            label={
              connectionState === 'CONNECTED'
                ? 'Live'
                : connectionState === 'RECONNECTING'
                  ? 'Reconnecting'
                  : 'Offline'
            }
          />
        </div>
      </div>

      {connected && (
        <button
          onClick={handleLogout}
          disabled={busy}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-[8px] border border-line-soft px-2 py-1.5 text-[11px] font-semibold text-fg-3 transition-colors hover:bg-surface-raised hover:text-fg-1 disabled:opacity-60"
        >
          <LogOut className="h-3.5 w-3.5" />
          {busy ? 'Signing out…' : 'Log out'}
        </button>
      )}
    </div>
  );
};
