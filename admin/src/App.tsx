import { useEffect, type ReactNode } from 'react';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Empty, LoadingBlock } from './components/UI';
import { useAuth } from './lib/auth';
import { usePath, navigate } from './lib/router';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { CopyTradingClientsPage } from './pages/CopyTradingClientsPage';
import { BotsPage } from './pages/BotsPage';
import { DerivConnectionsPage } from './pages/DerivConnectionsPage';
import { AdministratorsPage } from './pages/AdministratorsPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { RevenuePage } from './pages/RevenuePage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { MonitoringPage } from './pages/MonitoringPage';
import { ScannerOpsPage } from './pages/ScannerOpsPage';
import { AuditPage } from './pages/AuditPage';
import { SupportPage } from './pages/SupportPage';
import { AnnouncementsPage } from './pages/AnnouncementsPage';
import { ConfigurationPage } from './pages/ConfigurationPage';
import { ReportsPage } from './pages/ReportsPage';

/**
 * Routes table. Each route declares the permission it needs; the guard checks
 * it before rendering, so a bookmarked URL cannot reveal a page the
 * administrator is not entitled to. The server enforces the same rule again.
 */
const ROUTES: { path: string; permission: string; render: () => ReactNode }[] = [
  { path: '/', permission: 'dashboard.read', render: () => <DashboardPage /> },
  { path: '/users', permission: 'users.read', render: () => <UsersPage /> },
  { path: '/copy-trading/clients', permission: 'copytrading.read', render: () => <CopyTradingClientsPage /> },
  { path: '/copy-trading/connections', permission: 'copytrading.read', render: () => <DerivConnectionsPage /> },
  { path: '/bots', permission: 'monitoring.read', render: () => <BotsPage /> },
  { path: '/administrators', permission: 'admins.read', render: () => <AdministratorsPage /> },
  { path: '/subscriptions', permission: 'subscriptions.read', render: () => <SubscriptionsPage /> },
  { path: '/revenue', permission: 'revenue.read', render: () => <RevenuePage /> },
  { path: '/analytics', permission: 'analytics.read', render: () => <AnalyticsPage /> },
  { path: '/monitoring', permission: 'monitoring.read', render: () => <MonitoringPage /> },
  { path: '/scanner', permission: 'monitoring.read', render: () => <ScannerOpsPage /> },
  { path: '/audit', permission: 'audit.read', render: () => <AuditPage /> },
  { path: '/support', permission: 'support.read', render: () => <SupportPage /> },
  { path: '/announcements', permission: 'announcements.read', render: () => <AnnouncementsPage /> },
  { path: '/configuration', permission: 'configuration.read', render: () => <ConfigurationPage /> },
  { path: '/reports', permission: 'analytics.read', render: () => <ReportsPage /> }
];

export function App() {
  const { admin, loading, has } = useAuth();
  const path = usePath();

  // If a signed-in administrator lands on a route they cannot use, send them to
  // the first route they can.
  useEffect(() => {
    if (!admin) return;
    const route = ROUTES.find((r) => r.path === path);
    if (route && !has(route.permission)) {
      const fallback = ROUTES.find((r) => has(r.permission));
      if (fallback && fallback.path !== path) navigate(fallback.path);
    }
  }, [admin, path, has]);

  if (loading) {
    return (
      <div className="login-wrap">
        <LoadingBlock label="Restoring session…" />
      </div>
    );
  }

  if (!admin) return <LoginPage />;

  const route = ROUTES.find((r) => r.path === path);

  let content: ReactNode;
  if (!route) {
    content = (
      <Empty title="Page not found">
        The page at <span className="mono">{path}</span> does not exist. Use the navigation on the left.
      </Empty>
    );
  } else if (!has(route.permission)) {
    content = (
      <Empty title="Access denied">
        Your role does not include the <span className="mono">{route.permission}</span> permission.
      </Empty>
    );
  } else {
    content = route.render();
  }

  return (
    <AppShell>
      <ErrorBoundary resetKey={path}>{content}</ErrorBoundary>
    </AppShell>
  );
}
