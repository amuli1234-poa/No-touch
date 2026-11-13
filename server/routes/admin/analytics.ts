import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';

/**
 * Analytics (`/api/admin/v1/analytics/*`).
 *
 * Only metrics the platform can actually compute from real records are
 * returned. Retention, churn and conversion require subscription history that
 * does not exist here, so they are reported as unavailable rather than
 * estimated.
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
    // DAU/MAU require a login-activity event stream. We can only report users
    // with a live session right now (a real, if narrow, signal).
    const withSession = store.listUsers().filter((u) => store.countActiveSessionsForUser(u.id) > 0).length;
    return res.json({
      withLiveSession: withSession,
      dau: null,
      mau: null,
      unavailable: 'Daily/monthly active user counts require a login-event history that is not retained.'
    });
  });

  router.get('/feature-usage', requireAdmin(ctx, 'analytics.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({
      items: [],
      unavailable: 'Scanner feature usage is not reported to the server; the scanner runs client-side.'
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
