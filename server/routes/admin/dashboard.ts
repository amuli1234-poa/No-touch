import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import { summarise } from '../../activity/service.js';

/**
 * Executive dashboard metrics (`/api/admin/v1/dashboard/*`).
 *
 * Every number here is derived from the real JSON store or the live process.
 * Metrics that require a data source the platform does not have (billing,
 * historical retention) are returned as `null` with an `unavailable` reason so
 * the UI can show an honest empty state instead of a fabricated value.
 */

const DAY = 24 * 60 * 60 * 1000;

function startOfDayUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function createDashboardRouter(ctx: AdminRouteContext): Router {
  const { store, telemetry } = ctx;
  const router = Router();

  router.get('/summary', requireAdmin(ctx, 'dashboard.read'), (_req: AdminAuthedRequest, res: Response) => {
    const now = Date.now();
    const users = store.listUsers();
    const todayStart = startOfDayUtc(now);
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);

    const totalUsers = users.length;
    const suspendedUsers = users.filter((u) => u.suspended).length;
    const activeUsers = totalUsers - suspendedUsers;
    const newToday = users.filter((u) => u.createdAt >= todayStart).length;
    const newThisMonth = users.filter((u) => u.createdAt >= monthStart).length;

    // "Active" = has at least one live session right now (real, not estimated).
    const activeSessions = store.listUsers().reduce((acc, u) => acc + (store.countActiveSessionsForUser(u.id) > 0 ? 1 : 0), 0);
    const activity = summarise(store);

    return res.json({
      generatedAt: now,
      users: {
        total: totalUsers,
        active: activeUsers,
        suspended: suspendedUsers,
        newToday,
        newThisMonth,
        withLiveSession: activeSessions
      },
      // No billing system exists — surfaced explicitly rather than faked.
      subscriptions: {
        paid: null,
        free: null,
        conversionRate: null,
        unavailable: 'No billing or subscription records exist in this deployment.'
      },
      revenue: {
        mrr: null,
        currency: null,
        unavailable: 'No payment gateway or billing records are configured.'
      },
      support: {
        open: store.listTickets().filter((t) => t.status === 'open' || t.status === 'in_progress').length
      },
      system: {
        uptimeSeconds: telemetry.uptimeSeconds(),
        requests: telemetry.requestCount,
        errorRate: telemetry.errorRate,
        latency: telemetry.latencySummary()
      },
      scanner: {
        // Now measured from client heartbeats and reported events.
        activeSessions: activity.activeScannerSessions,
        signalsLast24h: activity.signalsLast24h,
        engineErrorsLast24h: activity.engineErrorsLast24h,
        lastEventAt: activity.lastEventAt
      }
    });
  });

  /** Registration counts per UTC day for the last N days. */
  router.get('/registrations', requireAdmin(ctx, 'dashboard.read'), (req: AdminAuthedRequest, res: Response) => {
    const days = Math.min(90, Math.max(7, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const now = Date.now();
    const start = startOfDayUtc(now) - (days - 1) * DAY;
    const buckets = new Map<number, number>();
    for (let i = 0; i < days; i++) buckets.set(start + i * DAY, 0);
    for (const u of store.listUsers()) {
      const day = startOfDayUtc(u.createdAt);
      if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }
    return res.json({
      days,
      series: [...buckets.entries()].map(([day, count]) => ({ date: new Date(day).toISOString().slice(0, 10), count }))
    });
  });

  /** Recent administrator activity, straight from the append-only audit log. */
  router.get('/recent-admin-activity', requireAdmin(ctx, 'dashboard.read'), (_req: AdminAuthedRequest, res: Response) => {
    const logs = store.listAudit().slice(-20).reverse();
    return res.json({
      items: logs.map((l) => ({
        id: l.id,
        timestamp: l.timestamp,
        actorEmail: l.actorEmail,
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId
      }))
    });
  });

  /** Recent user activity (newest registrations), from real records. */
  router.get('/recent-user-activity', requireAdmin(ctx, 'dashboard.read'), (_req: AdminAuthedRequest, res: Response) => {
    const users = [...store.listUsers()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
    return res.json({
      items: users.map((u) => ({
        id: u.id,
        loginId: u.loginId ?? null,
        createdAt: u.createdAt,
        accounts: u.accounts.length,
        suspended: Boolean(u.suspended)
      }))
    });
  });

  /** Operational alerts derived from live signals only. */
  router.get('/alerts', requireAdmin(ctx, 'dashboard.read'), (_req: AdminAuthedRequest, res: Response) => {
    const alerts: { level: 'info' | 'warning' | 'critical'; message: string; at: number }[] = [];
    const now = Date.now();
    if (telemetry.errorRate > 0.05 && telemetry.requestCount > 20) {
      alerts.push({ level: 'warning', message: `Elevated API error rate: ${(telemetry.errorRate * 100).toFixed(1)}%`, at: now });
    }
    const suspended = store.listUsers().filter((u) => u.suspended).length;
    if (suspended > 0) alerts.push({ level: 'info', message: `${suspended} suspended user account(s)`, at: now });
    const config = store.getPlatformConfig();
    if (config.maintenanceMode) alerts.push({ level: 'critical', message: 'Platform is in maintenance mode', at: now });
    return res.json({ items: alerts });
  });

  return router;
}
