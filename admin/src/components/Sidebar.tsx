import { ChevronsLeft, ChevronsRight, LogOut } from 'lucide-react';
import { NAV } from '../lib/navigation';
import { useAuth } from '../lib/auth';
import { navigate, usePath } from '../lib/router';
import { initials, titleCase } from '../lib/format';

/**
 * Primary navigation rail. Items are filtered by the administrator's effective
 * permissions, so a Support Agent never sees a Configuration link they cannot
 * use. Collapsible on desktop; an overlay drawer on mobile.
 */
export function Sidebar({
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const path = usePath();
  const { admin, has } = useAuth();

  return (
    <aside className="sidebar" data-collapsed={collapsed} data-open={mobileOpen} aria-label="Main navigation">
      <div className="sidebar-brand">
        <div className="sidebar-logo" aria-hidden>
          WS
        </div>
        {!collapsed && (
          <div className="grow truncate">
            <div className="sidebar-title">WickSentinel</div>
            <div className="sidebar-subtitle">Admin Console</div>
          </div>
        )}
      </div>

      <nav className="sidebar-nav">
        {NAV.map((group) => {
          const visible = group.items.filter((item) => has(item.permission));
          if (visible.length === 0) return null;
          return (
            <div key={group.label}>
              <div className="sidebar-group-label">{group.label}</div>
              {visible.map((item) => {
                const Icon = item.icon;
                const active = path === item.path;
                return (
                  <button
                    key={item.key}
                    className="sidebar-link"
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                    onClick={() => {
                      navigate(item.path);
                      onCloseMobile();
                    }}
                  >
                    <Icon size={17} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        {admin && (
          <div className="sidebar-user">
            <div className="sidebar-avatar" aria-hidden>
              {initials(admin.displayName || admin.email)}
            </div>
            {!collapsed && (
              <div className="sidebar-user-meta grow truncate">
                <div className="sidebar-user-name">{admin.displayName || admin.email}</div>
                <div className="sidebar-user-role">{titleCase(admin.role)}</div>
              </div>
            )}
          </div>
        )}
        <div className="row gap-sm" style={{ marginTop: 10 }}>
          <button
            className="sidebar-link desktop-only"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{ flex: 1 }}
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            <span>Collapse</span>
          </button>
          <SignOutButton compact={collapsed} />
        </div>
      </div>
    </aside>
  );
}

function SignOutButton({ compact }: { compact: boolean }) {
  const { signOut } = useAuth();
  return (
    <button
      className="sidebar-link"
      onClick={() => void signOut()}
      title={compact ? 'Sign out' : undefined}
      aria-label="Sign out"
      style={compact ? { width: 36 } : undefined}
    >
      <LogOut size={16} />
      <span>Sign out</span>
    </button>
  );
}
