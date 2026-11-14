import { Router, type Response } from 'express';
import type { SessionContext, AuthedRequest } from '../lib/session.js';
import { requireSession } from '../lib/session.js';
import { RateLimiter } from '../services/admin/rateLimit.js';
import { ingestEvents, recordHeartbeat, MAX_EVENTS_PER_REQUEST } from '../activity/service.js';
import type { RawEventInput } from '../activity/service.js';

/**
 * Client telemetry ingest.
 *
 *   POST /api/telemetry/events     -> report a batch of activity events
 *   POST /api/telemetry/heartbeat  -> report/refresh a running scanner session
 *
 * The scanner runs in the browser, so these are the only channel by which the
 * server learns what the engines are doing. Both routes require a live session:
 * the scanner is behind login, so every event is attributable, and `userId` is
 * taken from the verified session — never from the body, which would let one
 * user forge another's activity.
 *
 * The client is untrusted, so the routes are deliberately paranoid:
 *  - a per-user rate limiter caps how much a single account can write;
 *  - the body is size-limited by the JSON parser and the batch is count-capped;
 *  - the service validates every field and stores only bounded primitives.
 *
 * Telemetry is best-effort: a rejection is reported but never blocks the
 * scanner, so a telemetry outage cannot break trading.
 */

export function createTelemetryRouter(ctx: SessionContext): Router {
  const { store } = ctx;
  const router = Router();
  // 600 events/minute per user is far above real scanner output (signals are
  // rare), yet caps a runaway or hostile client.
  const eventsLimiter = new RateLimiter(600, 60_000);
  const heartbeatLimiter = new RateLimiter(60, 60_000);

  router.post('/api/telemetry/events', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const gate = eventsLimiter.hit(`events:${userId}`);
    if (!gate.allowed) {
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
      return;
    }

    const body = req.body as { events?: unknown } | undefined;
    if (!body || !Array.isArray(body.events)) {
      res.status(400).json({ error: 'invalid_body', detail: 'expected { events: [...] }' });
      return;
    }
    if (body.events.length > MAX_EVENTS_PER_REQUEST) {
      res.status(413).json({ error: 'batch_too_large', max: MAX_EVENTS_PER_REQUEST });
      return;
    }

    const result = await ingestEvents(store, userId, body.events as RawEventInput[]);
    res.status(202).json(result);
  });

  router.post('/api/telemetry/heartbeat', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const gate = heartbeatLimiter.hit(`heartbeat:${userId}`);
    if (!gate.allowed) {
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.sessionId !== 'string') {
      res.status(400).json({ error: 'invalid_body', detail: 'expected { sessionId, symbols?, timeframes? }' });
      return;
    }

    const session = await recordHeartbeat(store, userId, {
      sessionId: body.sessionId,
      symbols: body.symbols,
      timeframes: body.timeframes,
      clientVersion: body.clientVersion
    });
    if (!session) {
      res.status(400).json({ error: 'invalid_session_id' });
      return;
    }
    res.status(202).json({ ok: true, sessionId: session.id, signalCount: session.signalCount });
  });

  return router;
}
