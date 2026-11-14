import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import { summarise } from '../../activity/service.js';

/**
 * Analytics (`/api/admin/v1/analytics/*`).
 *
 * Activity-derived figures (DAU/MAU, feature usage, scanner activity) are now
 * computed from the real `activityEvents` collection, which the client and the
 * auth path write to. Metrics that still have no source — retention, churn,
 * conversion — need subscription history that does not exist, so they remain
 * reported as unavailable rather than estimated.
 */

const DAY = 24 * 60 * 60 * 1000;

function startOfDayUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function createAnalyticsRouter(ctx: AdminRouteContext): Router {
  const { store } = ctx;
  const router = Router();

  router.get('/users', requireAdmin(ctx, 'analytics.read'), (req: AdminAuthedRequest, res: Response) => {
    const days = Math.min(365, Math.max(7, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const now = Date.now();
    const start = startOfDayUtc(now) - (days - 1) * DAY;
    const buckets = new Map<number, number>();
    for (let i = 0; i < days; i++) buckets.set(start + i * DAY, 0);
    let cumulative = 0;
    const users = store.listUsers();
    // Cumulative prior to window start.
    cumulative = users.filter((u) => u.createdAt < start).length;
    for (const u of users) {
      const day = startOfDayUtc(u.createdAt);
      if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }
    const series = [...buckets.entries()].map(([day, count]) => {
      cumulative += count;
      return { date: new Date(day).toISOString().slice(0, 10), newUsers: count, totalUsers: cumulative };
    });
    return res.json({ days, series, total: users.length });
  });

  router.get('/active-users', requireAdmin(ctx, 'analytics.read'), (_req: AdminAuthedRequest, res: Response) => {
    // DAU/MAU come from the activity event log: a user counts as active on a
    // day when they produced at least one event (sign-in, scan, signal, ...).
    const summary = summarise(store);
    const withSession = store.listUsers().filter((u) => store.countActiveSessionsForUser(u.id) > 0).length;
    return res.json({
      withLiveSession: withSession,
      dau: summary.dau,
      mau: summary.mau,
      activeScannerSessions: summary.activeScannerSessions,
      signalsLast24h: summary.signalsLast24h,
      lastEventAt: summary.lastEventAt
    });
  });

  router.get('/feature-usage', requireAdmin(ctx, 'analytics.read'), (req: AdminAuthedRequest, res: Response) => {
    const days = Math.min(365, Math.max(7, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const now = Date.now();
    const since = startOfDayUtc(now) - (days - 1) * DAY;

    // Count events by kind within the window — real feature-usage signal from
    // what the client actually reported, not an estimate.
    const byKind = new Map<string, number>();
    const bySymbol = new Map<string, number>();
    for (const e of store.listActivityEvents()) {
      if (e.timestamp < since) continue;
      byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
      if (e.kind === 'signal.generated' && e.symbol) {
        bySymbol.set(e.symbol, (bySymbol.get(e.symbol) ?? 0) + 1);
      }
    }

    const items = [...byKind.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count);

    return res.json({
      days,
      items,
      topSymbols: [...bySymbol.entries()].map(([symbol, count]) => ({ symbol, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      total: items.reduce((acc, i) => acc + i.count, 0)
    });
  });

  router.get('/retention', requireAdmin(ctx, 'analytics.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({ cohorts: [], unavailable: 'Retention requires historical activity data that is not retained.' });
  });

  router.get('/conversion', requireAdmin(ctx, 'analytics.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({ rate: null, unavailable: 'Conversion requires subscription records, which do not exist here.' });
  });

  router.get('/churn', requireAdmin(ctx, 'analytics.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({ rate: null, unavailable: 'Churn requires subscription history, which does not exist here.' });
  });

  return router;
}
