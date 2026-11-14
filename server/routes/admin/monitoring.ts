import { Router, type Response } from 'express';
import type { AdminRouteContext } from './helpers.js';
import { requireAdmin } from '../../middleware/adminAuth.js';
import type { AdminAuthedRequest } from '../../lib/adminSession.js';
import { summarise } from '../../activity/service.js';
import { SCANNER_ACTIVE_WINDOW_MS } from '../../activity/types.js';

/**
 * Operations monitoring (`/api/admin/v1/monitoring/*`).
 *
 * Statuses are derived from real, in-process telemetry plus the activity log
 * the client now reports into. Scanner-engine health is inferred from reported
 * engine errors: with a live heartbeat we can tell DEGRADED from HEALTHY. Where
 * there is genuinely no source (the Deriv stream is client-side) the status
 * stays UNKNOWN — never a fabricated "healthy".
 */

export type ServiceStatus = 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';

export function createMonitoringRouter(ctx: AdminRouteContext): Router {
  const { telemetry, store } = ctx;
  const router = Router();

  router.get('/overview', requireAdmin(ctx, 'monitoring.read'), (_req: AdminAuthedRequest, res: Response) => {
    const latency = telemetry.latencySummary();
    const errorRate = telemetry.errorRate;
    const requests = telemetry.requestCount;
    const summary = summarise(store);

    let apiStatus: ServiceStatus = 'HEALTHY';
    if (requests > 20 && errorRate > 0.1) apiStatus = 'DEGRADED';
    if (requests > 20 && errorRate > 0.25) apiStatus = 'OFFLINE';

    // Scanner health is inferred from the client heartbeat + reported errors:
    //   no live sessions        -> UNKNOWN (nothing to judge)
    //   sessions but no errors  -> HEALTHY
    //   sessions with errors    -> DEGRADED
    let scannerStatus: ServiceStatus = 'UNKNOWN';
    let scannerDetail = 'No scanner heartbeat received; engines run in the browser.';
    if (summary.activeScannerSessions > 0) {
      if (summary.engineErrorsLast24h > 0) {
        scannerStatus = 'DEGRADED';
        scannerDetail = `${summary.activeScannerSessions} active, ${summary.engineErrorsLast24h} engine errors in 24h`;
      } else {
        scannerStatus = 'HEALTHY';
        scannerDetail = `${summary.activeScannerSessions} active, no engine errors in 24h`;
      }
    }

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
          status: scannerStatus,
          detail: scannerDetail
        }
      ],
      metrics: {
        uptimeSeconds: telemetry.uptimeSeconds(),
        requests,
        errors: telemetry.errorCount,
        errorRate,
        latency,
        activeScannerSessions: summary.activeScannerSessions,
        signalsLast24h: summary.signalsLast24h,
        engineErrorsLast24h: summary.engineErrorsLast24h
      },
      notes: [
        'HEALTHY/DEGRADED/OFFLINE reflect real request telemetry for the API process only.',
        'Scanner status is inferred from client heartbeats and reported engine errors.',
        'UNKNOWN is shown where no telemetry source exists (the client-side Deriv stream).'
      ]
    });
  });

  router.get('/errors', requireAdmin(ctx, 'monitoring.read'), (_req: AdminAuthedRequest, res: Response) => {
    return res.json({ items: telemetry.errors(20) });
  });

  router.get('/scanner-sessions', requireAdmin(ctx, 'monitoring.read'), (_req: AdminAuthedRequest, res: Response) => {
    const now = Date.now();
    const summary = summarise(store, now);
    const sessions = store
      .listScannerSessions()
      .map((s) => ({
        id: s.id,
        userId: s.userId,
        symbols: s.symbols,
        timeframes: s.timeframes,
        startedAt: s.startedAt,
        lastSeenAt: s.lastSeenAt,
        signalCount: s.signalCount,
        errorCount: s.errorCount,
        clientVersion: s.clientVersion,
        active: now - s.lastSeenAt <= SCANNER_ACTIVE_WINDOW_MS
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

    return res.json({
      generatedAt: now,
      active: summary.activeScannerSessions,
      total: sessions.length,
      signalsLast24h: summary.signalsLast24h,
      engineErrorsLast24h: summary.engineErrorsLast24h,
      items: sessions
    });
  });

  router.get('/data-freshness', requireAdmin(ctx, 'monitoring.read'), (_req: AdminAuthedRequest, res: Response) => {
    // Server-side freshness: the most recent admin action (audit log) and the
    // most recent client activity event. Market-data freshness stays a
    // client-side concern and is reported as unavailable.
    const lastAudit = store.listAudit().at(-1)?.timestamp ?? null;
    const lastEventAt = store.listActivityEvents().at(-1)?.timestamp ?? null;
    return res.json({
      lastAdminActivityAt: lastAudit,
      lastClientActivityAt: lastEventAt,
      marketData: null,
      unavailable: 'Market data freshness is a client-side concern and is not reported to the server.'
    });
  });

  return router;
}
