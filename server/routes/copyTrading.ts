import { createHash } from 'node:crypto';
import express, { Router, type Response } from 'express';
import type { AuthedRequest, SessionContext } from '../lib/session.js';
import { requireSession } from '../lib/session.js';
import { open, seal } from '../lib/crypto.js';
import { revokeToken } from '../lib/deriv.js';
import { createOpaqueId } from '../lib/pkce.js';
import { validatePatToken, PAT_FAILURE_MESSAGE } from '../copyTrading/pat.js';

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

function followerView(record: ReturnType<SessionContext['store']['listCopyTradingFollowers']>[number]) {
  return {
    id: record.id,
    loginId: record.loginId ?? null,
    authMethod: record.authMethod,
    accounts: record.accounts.map(({ accountId, type, currency }) => ({ accountId, type, currency })),
    tokenExpiresAt: record.tokenExpiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function createCopyTradingRouter(ctx: SessionContext): Router {
  const router = Router();
  router.use(express.json({ limit: '8kb' }));

  router.get('/api/copy-trading/status', requireSession(ctx), (_req, res: Response) => {
    res.json({ patConfigured: Boolean(ctx.cfg.deriv.patAppId) });
  });

  router.get('/api/copy-trading/followers', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ followers: ctx.store.listCopyTradingFollowers(req.user!.id).map(followerView) });
  });

  /** OAuth link option: the invited client authorizes their own Deriv account. */
  router.post('/api/copy-trading/invitations', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const now = Date.now();
    const id = createOpaqueId(18);
    const secret = createOpaqueId(24);
    const tokenHash = createHash('sha256').update(secret).digest('base64url');
    await ctx.store.putCopyTradingInvitation({
      id,
      ownerUserId: req.user!.id,
      tokenHash,
      createdAt: now,
      expiresAt: now + INVITATION_TTL_MS,
      consumedAt: null
    });
    const url = new URL(`/auth/copy-trading/connect/${id}`, ctx.cfg.appOrigin);
    url.searchParams.set('token', secret);
    res.status(201).json({ url: url.toString(), expiresAt: now + INVITATION_TTL_MS });
  });

  /** PAT option: validate the client's demo account before sealing their token. */
  router.post('/api/copy-trading/followers', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const validation = await validatePatToken(ctx.cfg, token);
    if (!validation.ok) {
      res.status(validation.failure.status).json({
        error: validation.failure.error,
        message: PAT_FAILURE_MESSAGE[validation.failure.error]
      });
      return;
    }

    const { demoAccounts, identity } = validation;
    const owner = req.user!;
    if (demoAccounts.some((account) => owner.accounts.some((owned) => owned.accountId === account.accountId))) {
      res.status(422).json({ error: 'manager_account', message: 'That token includes the manager’s own demo account. Use a client account token.' });
      return;
    }
    if (identity.sub === owner.derivSub) {
      res.status(422).json({ error: 'manager_account', message: 'That token belongs to the manager account. Use a client account token.' });
      return;
    }
    const existing =
      ctx.store.findCopyTradingFollowerByIdentity(identity.sub) ??
      ctx.store.findCopyTradingFollowerByAccountIds(demoAccounts.map((account) => account.accountId));
    if (existing && existing.ownerUserId !== owner.id) {
      res.status(409).json({ error: 'already_linked', message: 'This demo account is already connected to another manager.' });
      return;
    }

    const now = Date.now();
    const record = {
      id: existing?.id ?? createOpaqueId(),
      ownerUserId: owner.id,
      derivSub: identity.sub,
      authMethod: 'pat' as const,
      loginId: identity.loginId,
      accounts: demoAccounts.map((account) => ({
        accountId: account.accountId,
        type: 'demo' as const,
        currency: account.currency,
        status: account.status
      })),
      tokenSealed: seal(token, ctx.cfg.session.secret),
      tokenExpiresAt: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: existing?.status ?? 'authorized',
      revision: (existing?.revision ?? 0) + 1
    };
    await ctx.store.putCopyTradingFollower(record);
    res.status(existing ? 200 : 201).json({ follower: followerView(record) });
  });

  router.delete('/api/copy-trading/followers/:id', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const follower = await ctx.store.deleteCopyTradingFollower(req.user!.id, req.params.id);
    if (!follower) {
      res.status(404).json({ error: 'not_found', message: 'Connected account not found.' });
      return;
    }
    // OAuth grants can be revoked by the backend. Deriv PATs must be revoked by
    // the client in their Deriv token settings; deleting here forgets our copy.
    if (follower.authMethod === 'oauth') {
      const token = open(follower.tokenSealed, ctx.cfg.session.secret);
      if (token) await revokeToken(ctx.cfg, token);
    }
    res.json({ removed: true, providerRevoked: follower.authMethod === 'oauth' });
  });

  return router;
}
