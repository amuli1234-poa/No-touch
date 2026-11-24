import { Router, type Request } from 'express';
import type { SessionContext, AuthedRequest } from '../lib/session.js';
import { requireSession } from '../lib/session.js';
import { open } from '../lib/crypto.js';

export interface BotSocketAccount {
  account_id: string;
  account_type: 'demo' | 'real';
  currency?: string;
  status: string;
}

export type BotSocketUrlRequester = (apiBaseUrl: string, accessToken: string, accountId: string) => Promise<string>;

async function requestDerivSocketUrl(apiBaseUrl: string, accessToken: string, accountId: string): Promise<string> {
  const endpoint = `${apiBaseUrl}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
  } catch {
    throw new Error('deriv_connection_unavailable');
  }
  if (!response.ok) throw new Error('deriv_connection_rejected');

  const payload: any = await response.json().catch(() => null);
  const rawUrl = payload?.data?.url;
  if (typeof rawUrl !== 'string') throw new Error('deriv_connection_invalid');

  let socketUrl: URL;
  try {
    socketUrl = new URL(rawUrl);
  } catch {
    throw new Error('deriv_connection_invalid');
  }
  const host = socketUrl.hostname.toLowerCase();
  if (socketUrl.protocol !== 'wss:' || !(host === 'derivws.com' || host.endsWith('.derivws.com'))) {
    throw new Error('deriv_connection_invalid');
  }
  return socketUrl.toString();
}

function isSameOriginRequest(req: Request, appOrigin: string): boolean {
  const origin = req.get('origin');
  return typeof origin === 'string' && origin === appOrigin;
}

/**
 * Creates an authenticated Deriv Bot connection without sending the OAuth
 * access token to the browser. The only credential returned is Deriv's short-
 * lived, account-bound WebSocket URL.
 */
export function createBotSessionRouter(
  ctx: SessionContext,
  requestSocketUrl: BotSocketUrlRequester = requestDerivSocketUrl
): Router {
  const router = Router();

  router.post('/api/bot/session', requireSession(ctx), async (req: AuthedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Vary', 'Cookie, Origin');

    if (!isSameOriginRequest(req, ctx.cfg.appOrigin)) {
      res.status(403).json({ error: 'same_origin_required' });
      return;
    }

    const rawAccountId = req.body?.accountId;
    if (rawAccountId !== undefined && (typeof rawAccountId !== 'string' || rawAccountId.length > 64)) {
      res.status(400).json({ error: 'invalid_account' });
      return;
    }

    const session = req.session!;
    if (session.derivTokenExpiresAt <= Date.now()) {
      res.status(401).json({ error: 'deriv_authorization_expired' });
      return;
    }
    const accessToken = open(session.derivTokenSealed, ctx.cfg.session.secret);
    if (!accessToken) {
      res.status(401).json({ error: 'deriv_authorization_unavailable' });
      return;
    }

    const accounts = (req.user!.accounts ?? []).filter(
      account => account.accountId && (account.type === 'demo' || account.type === 'real') && account.status !== 'disabled'
    );
    if (accounts.length === 0) {
      res.status(403).json({ error: 'no_authorized_accounts' });
      return;
    }

    const requestedAccountId = typeof rawAccountId === 'string' ? rawAccountId.trim() : '';
    const selected = requestedAccountId
      ? accounts.find(account => account.accountId === requestedAccountId)
      : accounts.find(account => account.type === 'demo') ?? accounts[0];
    if (!selected) {
      res.status(403).json({ error: 'account_not_authorized' });
      return;
    }

    try {
      const socketUrl = await requestSocketUrl(ctx.cfg.deriv.apiBaseUrl, accessToken, selected.accountId);
      res.status(200).json({
        account: {
          account_id: selected.accountId,
          account_type: selected.type,
          currency: selected.currency,
          status: 'active'
        },
        accounts: accounts.map(account => ({
          account_id: account.accountId,
          account_type: account.type,
          currency: account.currency,
          status: 'active'
        } satisfies BotSocketAccount)),
        websocket_url: socketUrl
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'deriv_connection_failed';
      const allowed = new Set([
        'deriv_connection_unavailable',
        'deriv_connection_rejected',
        'deriv_connection_invalid'
      ]);
      res.status(502).json({ error: allowed.has(code) ? code : 'deriv_connection_failed' });
    }
  });

  return router;
}
