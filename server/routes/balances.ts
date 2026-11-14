import { Router, type Response } from 'express';
import type { SessionContext, AuthedRequest } from '../lib/session.js';
import { requireSession } from '../lib/session.js';
import { open } from '../lib/crypto.js';
import { BalanceService, BalanceAccessError, type AccountBalance } from '../services/balance.js';

/**
 * Account balance routes.
 *
 *   GET /api/balances                -> every account the user owns (DEMO + REAL, separate)
 *   GET /api/balances/:accountId     -> one account; optional ?mode= asserts the mode
 *
 * Both are session-guarded. Ownership and mode are validated in the service
 * against the user's own stored account list — the client cannot widen its view
 * by naming another account id. `?refresh=1` forces a re-read (used on
 * reconnect and on account switch). No Deriv token or credential is ever placed
 * in a response body.
 */

function tokenFor(ctx: SessionContext, req: AuthedRequest): string | null {
  const session = req.session!;
  // An expired Deriv token cannot be refreshed here (Deriv issues no refresh
  // tokens); report it as disconnected rather than attempting a doomed call.
  if (session.derivTokenExpiresAt <= Date.now()) return null;
  return open(session.derivTokenSealed, ctx.cfg.session.secret);
}

function parseMode(value: unknown): 'demo' | 'real' | undefined {
  return value === 'demo' || value === 'real' ? value : undefined;
}

export function createBalancesRouter(ctx: SessionContext, balances: BalanceService): Router {
  const router = Router();

  const respond = (res: Response, status: number, body: unknown) => res.status(status).json(body);

  router.get('/api/balances', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const token = tokenFor(ctx, req);
    const force = req.query.refresh === '1';
    const accounts: AccountBalance[] = await balances.readAll(req.user!, token, { force });
    respond(res, 200, {
      accounts,
      tokenExpiresAt: req.session!.derivTokenExpiresAt,
      fetchedAt: Date.now()
    });
  });

  router.get('/api/balances/:accountId', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const rawMode = req.query.mode;
    const expectedMode = parseMode(rawMode);
    if (rawMode !== undefined && expectedMode === undefined) {
      respond(res, 400, { error: 'invalid_mode' });
      return;
    }
    const token = tokenFor(ctx, req);
    const force = req.query.refresh === '1';
    try {
      const account = await balances.read(req.user!, req.params.accountId, token, { expectedMode, force });
      respond(res, 200, {
        account,
        tokenExpiresAt: req.session!.derivTokenExpiresAt,
        fetchedAt: Date.now()
      });
    } catch (err) {
      if (err instanceof BalanceAccessError) {
        respond(res, 403, { error: err.code });
        return;
      }
      respond(res, 500, { error: 'balance_read_failed' });
    }
  });

  return router;
}
