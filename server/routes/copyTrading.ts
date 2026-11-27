import { createHash, randomUUID } from 'node:crypto';
import express, { Router, type Response } from 'express';
import type { AuthedRequest, SessionContext } from '../lib/session.js';
import { requireSession } from '../lib/session.js';
import { open, seal } from '../lib/crypto.js';
import { revokeToken } from '../lib/deriv.js';
import { createOpaqueId } from '../lib/pkce.js';
import { validatePatToken, PAT_FAILURE_MESSAGE } from '../copyTrading/pat.js';
import { buildCopyPerformance, followerPrincipalId } from '../copyTrading/performance.js';
import { buildClientSummary } from '../copyTrading/reporting.js';
import { applyFollowerCommissions } from '../copyTrading/finance.js';
import type { CopyExecutionEngine } from '../copyTrading/engine.js';
import type { BrokerAdapter, ContractUpdate } from '../execution/broker/types.js';
import type { ContractFamily, DerivContractType, SignalDirection, SignalRecord } from '../execution/types.js';
import type { BalanceService } from '../services/balance.js';

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Dependencies the copy-on-buy route needs beyond the store/config. */
export interface CopyRouteDeps {
  engine: CopyExecutionEngine;
  broker: Pick<BrokerAdapter, 'getContract'>;
}

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

export function createCopyTradingRouter(ctx: SessionContext, balances?: BalanceService, copy?: CopyRouteDeps): Router {
  const router = Router();
  router.use(express.json({ limit: '8kb' }));

  router.get('/api/copy-trading/status', requireSession(ctx), (_req, res: Response) => {
    res.json({ patConfigured: Boolean(ctx.cfg.deriv.patAppId) });
  });

  router.get('/api/copy-trading/followers', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ followers: ctx.store.listCopyTradingFollowers(req.user!.id).map(followerView) });
  });

  /**
   * Balances for one client the signed-in manager owns.
   *
   * Ownership is proven by reading the follower out of the manager's own list,
   * not by trusting the id in the path. The figure is read live from Deriv over
   * the client's sealed credential and is never stored. DEMO and REAL are
   * reported separately, and a null balance is never presented as zero.
   */
  router.get('/api/copy-trading/followers/:id/balance', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const record = ctx.store
      .listCopyTradingFollowers(req.user!.id)
      .find((f) => f.id === req.params.id);
    if (!record) {
      res.status(404).json({ error: 'follower_not_found' });
      return;
    }

    if (!balances) {
      res.json({
        followerId: record.id,
        accounts: [],
        available: false,
        reason: 'balance_service_unavailable',
        note: 'This build has no balance service wired, so no figure can be shown.'
      });
      return;
    }

    if (record.tokenExpiresAt > 0 && record.tokenExpiresAt <= Date.now()) {
      res.json({
        followerId: record.id,
        accounts: [],
        available: false,
        reason: 'authorization_expired',
        note: 'This client authorization has expired, so Deriv cannot be asked for a balance.'
      });
      return;
    }

    const accessToken = open(record.tokenSealed, ctx.cfg.session.secret);
    if (!accessToken) {
      res.json({
        followerId: record.id,
        accounts: [],
        available: false,
        reason: 'token_unavailable',
        note: 'The stored credential could not be opened, so no balance can be read.'
      });
      return;
    }

    const principal = {
      id: `copy_follower_${record.id}`,
      derivSub: record.derivSub,
      loginId: record.loginId,
      accounts: record.accounts,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      preferences: {}
    };

    // A PAT-authenticated client needs the PAT App ID on the OTP call; an OAuth
    // client does not (its token implies the app). Deriv rejects a PAT without it.
    const appId = record.authMethod === 'pat' ? (ctx.cfg.deriv.patAppId ?? undefined) : undefined;
    const accounts = await balances.readAll(principal, accessToken, {
      force: req.query.refresh === '1',
      appId
    });
    res.json({
      followerId: record.id,
      accounts: accounts.map((a) => ({
        accountId: a.accountId,
        mode: a.mode,
        currency: a.currency,
        balance: a.balance,
        state: a.state,
        lastUpdated: a.lastUpdated,
        ...(a.reason ? { reason: a.reason } : {})
      })),
      available: accounts.some((a) => a.state === 'ok' || a.state === 'stale'),
      fetchedAt: Date.now(),
      note: 'Read live from Deriv with the client credential. DEMO and REAL accounts are listed separately.'
    });
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

  /**
   * Resets the performance dashboard for the signed-in manager. Clears the
   * trading history (contracts, ledger, intents, attempts, signals) for the
   * manager and every connected client's copy principal, so the performance
   * surfaces start fresh. The append-only execution audit is kept as a log.
   */
  router.post('/api/copy-trading/reset', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const user = req.user!;
    const followers = ctx.store.listCopyTradingFollowers(user.id);
    const principals = [user.id, ...followers.map((f) => `copy_follower_${f.id}`)];
    try {
      const cleared = await ctx.store.clearTradingData(principals);
      res.json({ ok: true, cleared });
    } catch {
      res.status(500).json({
        error: 'reset_failed',
        message: 'The performance history could not be reset.'
      });
    }
  });

  /**
   * Copy-on-buy: the bot app reports a trade it just placed on the master's
   * DEMO account so the engine can mirror it to connected followers.
   *
   * The plan (contract type, digit, duration, stake) is known only to the bot
   * that created the trade, so it must be supplied. The server never trusts it
   * blindly: it re-reads the master's open contracts from Deriv and only mirrors
   * a contract that is actually open on the master's own account. The copy
   * switch, kill switches, risk engine and single-use signal all still apply.
   */
  router.post('/api/copy-trading/mirror-on-buy', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    if (!copy) {
      res.status(503).json({ error: 'copy_unavailable', message: 'Copy trading is not wired in this build.' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const accountId = String(b.accountId ?? '');
    const symbol = String(b.symbol ?? '');
    const contractType = String(b.contractType ?? '') as DerivContractType;
    const contractFamily = String(b.contractFamily ?? '') as ContractFamily;
    const direction = (b.direction ?? 'NONE') as SignalDirection;
    const duration = Number(b.duration);
    const durationUnit = String(b.durationUnit ?? 't');
    const stake = Number(b.stake);
    const basis = b.basis === 'payout' ? 'payout' : 'stake';
    const currency = String(b.currency ?? 'USD');
    const masterContractId = Number(b.masterContractId);
    const digit = b.digit === undefined || b.digit === null ? null : Number(b.digit);
    const barrier = b.barrier === undefined || b.barrier === null ? null : String(b.barrier);
    const growthRate = b.growthRate === undefined || b.growthRate === null ? null : Number(b.growthRate);

    if (
      !accountId ||
      !symbol ||
      !contractType ||
      !contractFamily ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !Number.isFinite(stake) ||
      stake <= 0 ||
      !Number.isFinite(masterContractId) ||
      !['s', 'm', 'h', 'd', 't'].includes(durationUnit)
    ) {
      res.status(400).json({ error: 'invalid_plan', message: 'The reported trade plan is incomplete or invalid.' });
      return;
    }

    const master = req.user!;
    const account = master.accounts.find((a) => a.accountId === accountId && a.type === 'demo');
    if (!account) {
      res.status(403).json({ error: 'account_not_authorized', message: 'This is not your demo account.' });
      return;
    }

    const session = req.session!;
    if (session.derivTokenExpiresAt && session.derivTokenExpiresAt <= Date.now()) {
      res.status(401).json({ error: 'token_expired', message: 'Reconnect Deriv to copy this trade.' });
      return;
    }
    const accessToken = open(session.derivTokenSealed, ctx.cfg.session.secret);
    if (!accessToken) {
      res.status(401).json({ error: 'token_unavailable', message: 'Deriv credential is unavailable.' });
      return;
    }

    // Prove the master really holds this contract before mirroring it. Read the
    // single contract by id rather than the open-positions list: a tick-duration
    // contract can settle between the purchase and this round-trip, and a
    // settled contract is still proof the master placed the trade. A missing or
    // unreadable contract fails closed — nothing is copied.
    let observed: ContractUpdate | null = null;
    try {
      observed = await copy.broker.getContract(accountId, 'demo', accessToken, masterContractId);
    } catch {
      observed = null;
    }
    if (!observed) {
      res.status(409).json({
        error: 'contract_not_open',
        message: 'No matching contract was found on your demo account, so nothing was copied.'
      });
      return;
    }

    const now = Date.now();
    const signal: SignalRecord = {
      id: `sig_botbuy_${randomUUID()}`,
      userId: master.id,
      accountId,
      accountMode: 'demo',
      symbol,
      timeframe: `${duration}${durationUnit}`,
      direction,
      contractFamily,
      ...(contractType ? { contractType } : {}),
      analysisId: `botbuy:${masterContractId}`,
      zone: null,
      entryPrice: observed.entrySpot ?? null,
      confidence: 1,
      reason: `botbuy:${masterContractId}`,
      createdAt: now,
      expiresAt: now + 60_000,
      consumedByIntentId: null
    };

    const outcomes = await copy.engine.mirrorMasterTrade({
      master,
      masterAccessToken: accessToken,
      signal,
      masterIntentId: `botbuy:${masterContractId}`,
      stake,
      basis,
      currency,
      parameters: {
        duration,
        durationUnit: durationUnit as 's' | 'm' | 'h' | 'd' | 't',
        multiplier: b.multiplier === undefined || b.multiplier === null ? null : Number(b.multiplier),
        cancellation: b.cancellation === undefined || b.cancellation === null ? null : String(b.cancellation),
        stopLoss: b.stopLoss === undefined || b.stopLoss === null ? null : Number(b.stopLoss),
        takeProfit: b.takeProfit === undefined || b.takeProfit === null ? null : Number(b.takeProfit),
        ...(digit !== null ? { digit } : {}),
        ...(barrier !== null ? { barrier } : {}),
        ...(growthRate !== null ? { growthRate } : {})
      },
      includeMaster: false
    });

    res.json({ outcomes, copied: outcomes.filter((o) => o.outcome === 'copied').length });
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
    // Consent is a separate, explicit record — never implied. The manager is
    // attesting that the client whose token this is has agreed to be copied.
    if (req.body?.consent !== true) {
      res.status(400).json({
        error: 'consent_required',
        message: 'Confirm that the client has consented to their trades being copied.'
      });
      return;
    }
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
    // Record consent alongside the credential. Keyed by follower id, separate
    // from the token, so readiness and the engine see the same eligibility the
    // admin console reports. OAuth onboarding writes this automatically in the
    // callback; the PAT path must write it explicitly here.
    await ctx.store.putCopyTradingConsent({
      followerId: record.id,
      ownerUserId: owner.id,
      method: 'pat',
      recordedByAdminId: null,
      attestedBy: owner.loginId ?? owner.id,
      consentedAt: now,
      note: null
    });
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

  /* ========================= client portal (Phase 3) ====================== */

  /**
   * The signed-in client's own copy-trading summary. Scoped strictly by the
   * session user's Deriv identity, so a client can only ever read the follower
   * records that carry their identity — never another client's.
   */
  router.get('/api/copy-client/summary', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const followers = ctx.store.listAllCopyTradingFollowers().filter((f) => f.derivSub === req.user!.derivSub);
    // Apply any newly settled contracts to the commission ledger first (idempotent),
    // so the client's statement is never stale relative to settled trades.
    for (const ownerId of new Set(followers.map((f) => f.ownerUserId))) {
      await applyFollowerCommissions(ctx.store, ownerId);
    }
    res.json(buildClientSummary(ctx.store, req.user!.derivSub));
  });

  /** The client's own copied contracts, newest first. */
  router.get('/api/copy-client/trades', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const followers = ctx.store.listAllCopyTradingFollowers().filter((f) => f.derivSub === req.user!.derivSub);
    const principals = followers.map((f) => followerPrincipalId(f.id));
    const items = ctx.store
      .listContractsForUsers(principals)
      .sort((a, b) => b.purchaseTime - a.purchaseTime)
      .map((c) => ({
        contractId: c.id,
        accountId: c.accountId,
        symbol: c.symbol,
        contractType: c.contractType,
        stake: c.stake,
        currency: c.currency,
        status: c.status,
        profit: c.profit,
        purchaseTime: c.purchaseTime
      }));
    res.json({ items });
  });

  /** The client's own commission and markup records. */
  router.get('/api/copy-client/earnings', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const followers = ctx.store.listAllCopyTradingFollowers().filter((f) => f.derivSub === req.user!.derivSub);
    for (const ownerId of new Set(followers.map((f) => f.ownerUserId))) {
      await applyFollowerCommissions(ctx.store, ownerId);
    }
    const entries = followers.flatMap((f) =>
      ctx.store.listCommissionEntries(f.ownerUserId).filter((e) => e.followerId === f.id)
    );
    res.json({ items: entries, followers: followers.length });
  });

  return router;
}
