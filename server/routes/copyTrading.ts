import { createHash } from 'node:crypto';
import express, { Router, type Response } from 'express';
import type { AuthedRequest, SessionContext } from '../lib/session.js';
import { requireSession } from '../lib/session.js';
import { open, seal } from '../lib/crypto.js';
import { revokeToken } from '../lib/deriv.js';
import { createOpaqueId } from '../lib/pkce.js';
import { validatePatToken, PAT_FAILURE_MESSAGE } from '../copyTrading/pat.js';
import { buildCopyPerformance } from '../copyTrading/performance.js';

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

/** The manager's view of their own copy switch. */
function traderControlView(store: SessionContext['store'], ownerUserId: string) {
  const record = store.getCopyTradingControl(ownerUserId);
  const followers = store.listCopyTradingFollowers(ownerUserId);
  const eligible = followers.filter((f) => {
    const status = f.status ?? 'authorized';
    return status === 'authorized' || status === 'active';
  });
  return {
    enabled: Boolean(record?.enabled),
    updatedAt: record?.updatedAt ?? null,
    stoppedReason: record?.stoppedReason ?? null,
    followers: { total: followers.length, eligible: eligible.length }
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

  /**
   * Profit and loss for the signed-in manager and every client they manage.
   *
   * Scoped to `req.user.id` as the owner, so a manager can only ever read the
   * performance of followers they connected. Copied contracts are owned by the
   * follower's synthetic principal, which is why this cannot reuse the
   * owner-scoped contract listing on its own.
   */
  router.get('/api/copy-trading/performance', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const days = Number.parseInt(String(req.query.days ?? '30'), 10);
    res.json(buildCopyPerformance(ctx.store, req.user!.id, { days: Number.isFinite(days) ? days : 30 }));
  });

  /**
   * The manager's own Start/Stop switch.
   *
   * A manager may start copying for the clients they connected; the engine
   * re-reads this switch on every master trade, so stopping takes effect on the
   * next trade and never cancels a contract already open at the broker.
   */
  router.get('/api/copy-trading/control', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ control: traderControlView(ctx.store, req.user!.id) });
  });

  router.post('/api/copy-trading/control', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled_required', message: 'Say whether copying should start or stop.' });
      return;
    }
    const ownerUserId = req.user!.id;
    if (body.enabled && ctx.store.listCopyTradingFollowers(ownerUserId).length === 0) {
      res.status(409).json({
        error: 'no_followers',
        message: 'Connect at least one client account before starting copy trading.'
      });
      return;
    }
    await ctx.store.putCopyTradingControl({
      ownerUserId,
      enabled: body.enabled,
      updatedBy: ownerUserId,
      updatedByEmail: req.user!.loginId ?? null,
      updatedAt: Date.now(),
      stoppedReason: null
    });
    res.json({
      control: traderControlView(ctx.store, ownerUserId),
      note: body.enabled
        ? 'Copy trading started. Your accepted DEMO trades are mirrored onto each connected client account.'
        : 'Copy trading stopped. New trades are no longer copied; contracts already open are unaffected.'
    });
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
