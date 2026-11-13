import { useEffect, useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { usePath } from '../lib/router';
import { findNav } from '../lib/navigation';

/**
 * Application frame: persistent sidebar + top bar around the routed page.
 * Collapse state and the mobile drawer are local UI concerns.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem('ws_admin_sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const path = usePath();

  useEffect(() => {
    window.localStorage.setItem('ws_admin_sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  const nav = findNav(path);
  const envLabel = import.meta.env.DEV ? 'Development' : 'Production';

  return (
    <div className="admin-shell" data-collapsed={collapsed}>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      {mobileOpen && <div className="scrim mobile-only" onClick={() => setMobileOpen(false)} aria-hidden />}
      <div className="admin-main">
        <Topbar
          title={nav?.label ?? 'WickSentinel Admin'}
          subtitle="Platform administration"
          onOpenMobile={() => setMobileOpen(true)}
          envLabel={envLabel}
        />
        <main className="admin-content">{children}</main>
      </div>
    </div>
  );
}
