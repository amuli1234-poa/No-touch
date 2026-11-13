import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';

/**
 * Operations monitoring (`/api/admin/v1/monitoring/*`).
 *
 * Statuses are derived from real, in-process telemetry. Where the platform has
 * no telemetry source the status is reported as UNKNOWN — never a fabricated
 * "healthy". Specifically, scanner-engine health cannot be observed from the
 * server because the engines run in the browser.
 */

export type ServiceStatus = 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';

export function createMonitoringRouter(ctx: AdminRouteContext): Router {
  const { telemetry, store } = ctx;
  const router = Router();

  router.get('/overview', requireAdmin(ctx, 'monitoring.read'), (_req: AdminAuthedRequest, res: Response) => {
    const latency = telemetry.latencySummary();
    const errorRate = telemetry.errorRate;
    const requests = telemetry.requestCount;

    let apiStatus: ServiceStatus = 'HEALTHY';
    if (requests > 20 && errorRate > 0.1) apiStatus = 'DEGRADED';
    if (requests > 20 && errorRate > 0.25) apiStatus = 'OFFLINE';

    return res.json({
      generatedAt: Date.now(),
      services: [
        {
          key: 'api',
          label: 'Admin API',
          status: apiStatus,
          detail: `${requests} requests, ${(errorRate * 100).toFixed(2)}% errors`
        },
        {
          key: 'process',
          label: 'Backend process',
          status: 'HEALTHY' as ServiceStatus,
          detail: `Up ${telemetry.uptimeSeconds()}s`
        },
        {
          key: 'deriv_ws',
          label: 'Deriv WebSocket',
          status: 'UNKNOWN' as ServiceStatus,
          detail: 'Market data streams client-side; no server-side connection to observe.'
        },
        {
          key: 'scanner_engines',
          label: 'Scanner engines',
          status: 'UNKNOWN' as ServiceStatus,
          detail: 'Engines run in the browser; the server receives no engine telemetry.'
        }
      ],
      metrics: {
        uptimeSeconds: telemetry.uptimeSeconds(),
        requests,
        errors: telemetry.errorCount,
        errorRate,
        latency
      },
      notes: [
        'HEALTHY/DEGRADED/OFFLINE reflect real request telemetry for the API process only.',
        'UNKNOWN is shown where no telemetry source exists (client-side scanner, Deriv stream).'
      ]
    });
  });

  router.get('/errors', requireAdmin(ctx, 'monitoring.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({ items: telemetry.errors(20) });
  });

  router.get('/data-freshness', requireAdmin(ctx, 'monitoring.read'), (_req: AdminAuthedRequest, res: Response) => {
    // The only server-side "freshness" we can honestly report is the recency of
    // the last mutation, inferred from admin session/audit timestamps.
    const lastAudit = store.listAudit().at(-1)?.timestamp ?? null;
    return res.json({
      lastAdminActivityAt: lastAudit,
      marketData: null,
      unavailable: 'Market data freshness is a client-side concern and is not reported to the server.'
    });
  });

  return router;
}
