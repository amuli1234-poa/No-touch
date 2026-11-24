import express, { Router, type Response } from 'express';

import type { Store, UserRecord } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import { requireSession, type AuthedRequest } from '../lib/session.js';
import { RateLimiter } from '../services/admin/rateLimit.js';
import { open } from '../lib/crypto.js';
import type { ExecutionGateway, ExecutionResult } from '../execution/gateway.js';
import { ExecutionError } from '../execution/gateway.js';
import { ExecutionAuditor } from '../execution/audit.js';
import type { AutoExecutionRunner } from '../execution/autoRunner.js';
import type { ContractMonitor } from '../execution/contractMonitor.js';
import type { SystemSignalService } from '../services/systemSignals.js';
import type { CopyExecutionEngine } from '../copyTrading/engine.js';
import type { MarketDataService } from '../services/marketData.js';
import type { ExecutionFlags } from '../config/flags.js';
import { createSignal, SignalError } from '../services/signals.js';
import { consecutiveLosses } from '../services/risk.js';
import { adapterFor, AdapterError } from '../execution/adapters/index.js';
import { normalisePreferences, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES, MULTIPLIERS_ENABLED } from '../execution/preferences.js';
import {
  AccountAccessError,
  resolveAccountForUser,
  resolveTradableAccountForUser
} from '../execution/accountGuard.js';
import type { SignalDirection, ContractFamily, DerivContractType, ContractRecord, ExecutionPreferencesRecord } from '../execution/types.js';
import { CONTRACT_FAMILY_TYPES } from '../execution/types.js';

/**
 * Execution routes.
 *
 *   POST /api/execution/signals              -> validate and record a signal
 *   POST /api/execution/place                -> signal + intent + submit in one call
 *   POST /api/execution/intents              -> create a trade intent (no purchase)
 *   POST /api/execution/intents/:id/submit   -> submit the intent (the one purchase path)
 *   GET  /api/execution/intents              -> the user's intents
 *   GET  /api/execution/contracts            -> the user's contracts
 *
 * Every route is session-guarded. The account is resolved from the session
 * user's own records inside the gateway; the request body may name an account id
 * but can never widen access. The Deriv access token is unsealed from the signed
 * session here and passed only to the gateway — it is never returned or logged.
 *
 * A purchase is only ever reached through `submit`, which applies the kill
 * switches, ownership, risk and idempotency checks. Creating an intent does not
 * buy anything.
 *
 * Manual trading is the customer's own call: any market, any direction, any
 * time, bounded only by the risk engine and the kill switches. The live-setup
 * requirement is a property of AUTOMATIC mode alone — automatic entries must be
 * the current best signal the dashboard published — and is never imposed on a
 * hand-placed trade.
 */

export interface ExecutionRouterDeps {
  cfg: ServerConfig;
  store: Store;
  gateway: ExecutionGateway;
  market: MarketDataService;
  /** Optional: when present, an automatic user's signal is executed on creation. */
  runner?: AutoExecutionRunner;
  /** Optional: when present, a stuck intent can be reconciled on demand. */
  monitor?: ContractMonitor;
  /**
   * Optional: the bridge the dashboard's best signal is published to. When
   * present, a published best signal is executed for users in automatic mode.
   */
  systemSignals?: SystemSignalService;
  /**
   * Optional: the resolved kill switches. When present, the scanner status
   * explains WHY the scanner is off (master switch vs demo switch) instead of a
   * bare "not running", so a fresh local checkout is not a silent dead end.
   */
  flags?: ExecutionFlags;
  /**
   * Optional: when present, an accepted DEMO trade is mirrored onto the
   * manager's connected followers. Absent in tests that do not exercise copying.
   */
  copyEngine?: CopyExecutionEngine;
  /** Optional per-minute limits, for tests. Defaults are conservative. */
  limits?: { signalsPerMinute?: number; submitsPerMinute?: number };
}

/**
 * Minimum normalised (0–1) strength a published signal must reach before the
 * server will auto-trade it, per the customer's Signal Quality Filter.
 *
 * The dashboard publishes every confirmed signal, but it only marks a signal
 * for automatic entry when it clears the customer's own quality filter, and the
 * gate here follows the same setting. So the setups the automatic trader acts on
 * are exactly the setups the customer is shown — nothing weaker slips through.
 * An absent or unrecognised filter falls back to the strictest tier.
 */
const MIN_QUALITY_THRESHOLD: Record<string, number> = {
  ANY: 0,
  MODERATE: 0.75, // DEVELOPING and above
  HIGH: 0.85 // HIGH_QUALITY and above
};

function thresholdForMinQuality(value: unknown): number {
  return typeof value === 'string' && value in MIN_QUALITY_THRESHOLD
    ? MIN_QUALITY_THRESHOLD[value]
    : MIN_QUALITY_THRESHOLD.HIGH;
}

/** Unseals the session's Deriv token, or null when absent/expired. */
function tokenFor(deps: ExecutionRouterDeps, req: AuthedRequest): string | null {
  const session = req.session!;
  if (session.derivTokenExpiresAt <= Date.now()) return null;
  try {
    return open(session.derivTokenSealed, deps.cfg.session.secret);
  } catch {
    return null;
  }
}

function parseDirection(value: unknown): SignalDirection | null {
  return value === 'RISE' || value === 'FALL' || value === 'NONE' ? value : null;
}

function parseFamily(value: unknown): ContractFamily | null {
  if (value !== 'rise_fall' && value !== 'multipliers') return null;
  // Multipliers are disabled; a crafted request cannot select them either.
  if (value === 'multipliers' && !MULTIPLIERS_ENABLED) return null;
  return value;
}

export function createExecutionRouter(deps: ExecutionRouterDeps): Router {
  const { store, gateway, market, runner, monitor, systemSignals } = deps;
  const ctx = { cfg: deps.cfg, store };
  const auditor = new ExecutionAuditor(store);
  // Per-user limits. These blunt a runaway client or a stuck loop; the risk
  // engine's execution-frequency rule remains the real trading throttle.
  const submitLimiter = new RateLimiter(deps.limits?.submitsPerMinute ?? 30, 60_000);
  const signalLimiter = new RateLimiter(deps.limits?.signalsPerMinute ?? 120, 60_000);
  const limit = (limiter: RateLimiter, req: AuthedRequest, res: Response): boolean => {
    const gate = limiter.hit(`${req.user!.id}`);
    if (!gate.allowed) {
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
      return false;
    }
    return true;
  };
  const router = Router();
  const json = express.json({ limit: '32kb' });

  /**
   * The automatic-trade gate: an automatic entry must be backed by the current
   * best signal the dashboard published for the same market and direction.
   * Automatic mode is the system scanner's own domain — the customer has
   * delegated the decision — so an entry that is not the live best signal must
   * never auto-execute. Manual trading is exempt: that is the trader's own call
   * and is bounded only by the risk engine.
   * Returns the rejection to send, or null when the entry may proceed.
   */
  const automaticSignalRejection = (
    userId: string,
    symbol: string,
    direction: SignalDirection
  ): { status: number; body: { error: string; message: string } } | null => {
    if (!systemSignals) return null;
    if (store.getExecutionPreferences(userId)?.mode !== 'automatic') return null;
    const current = systemSignals.current(userId);
    if (!current) {
      return {
        status: 422,
        body: {
          error: 'no_signal',
          message: 'The dashboard has not published a confirmed best signal yet.'
        }
      };
    }
    if (current.symbol !== symbol || current.direction !== direction) {
      return {
        status: 422,
        body: {
          error: 'no_valid_signal',
          message: `The current best signal is ${current.direction} ${current.displayName}, not ${direction} ${symbol}.`
        }
      };
    }
    if (systemSignals.isTraded(userId, current.setupKey)) {
      return {
        status: 422,
        body: {
          error: 'already_traded',
          message: 'This best signal has already been traded. Wait for a fresh one.'
        }
      };
    }
    return null;
  };

  /**
   * Mirrors a trade the automatic runner just executed onto the manager's
   * connected followers. Only a successful DEMO execution is mirrored; the
   * engine re-checks the mode itself, so this cannot widen what is copied.
   *
   * A copy failure never propagates: the manager's own trade is already live and
   * each follower's outcome is audited individually inside the engine.
   */
  const mirrorAutoTrade = async (
    user: UserRecord,
    signal: Parameters<CopyExecutionEngine['mirrorMasterTrade']>[0]['signal'],
    auto: { result: ExecutionResult | null } | null
  ): Promise<void> => {
    if (!deps.copyEngine || !auto?.result) return;
    const intent = auto.result.intent;
    try {
      await deps.copyEngine.mirrorMasterTrade({
        master: user,
        signal,
        masterIntentId: intent.id,
        stake: intent.stake,
        basis: intent.basis,
        currency: intent.currency,
        parameters: intent.parameters
      });
    } catch {
      // Swallowed deliberately: the manager's trade is already accepted.
    }
  };

  /**
   * The dashboard's best signal, published by the client. It is recorded for the
   * signed-in user and, when that user is in automatic mode, entered through the
   * same runner a manual trade uses — kill switches, risk, single-use and one
   * purchase path all still apply. The entry, stop-loss and take-profit are chart
   * markers: they are stored for display and never sent to Deriv.
   */
  router.post('/api/execution/system-signal', requireSession(ctx), json, async (req: AuthedRequest, res: Response) => {
    if (!systemSignals) {
      res.status(503).json({ error: 'system_signals_unavailable' });
      return;
    }
    if (!limit(signalLimiter, req, res)) return;
    const body = req.body ?? {};
    const direction = parseDirection(body.direction);
    const symbol = String(body.symbol ?? '');
    const setupKey = String(body.setupKey ?? '');
    if (!direction || direction === 'NONE' || !symbol || !setupKey) {
      res.status(400).json({ error: 'invalid_signal' });
      return;
    }
    const user = req.user!;
    const published = systemSignals!.publish({
      userId: user.id,
      symbol,
      displayName: String(body.displayName ?? symbol),
      direction,
      timeframe: String(body.timeframe ?? '5m'),
      confidence: typeof body.confidence === 'number' ? body.confidence : 0,
      entryPrice: typeof body.entryPrice === 'number' ? body.entryPrice : null,
      stopLoss: typeof body.stopLoss === 'number' ? body.stopLoss : null,
      takeProfit: typeof body.takeProfit === 'number' ? body.takeProfit : null,
      setupKey,
      source: String(body.source ?? 'SYSTEM')
    });

    const prefs = store.getExecutionPreferences(user.id);
    if (!runner || prefs?.mode !== 'automatic' || prefs.autoStopped) {
      res.status(200).json({ published, auto: null });
      return;
    }
    if (systemSignals!.isTraded(user.id, setupKey)) {
      res.status(200).json({ published, auto: null, reason: 'already_traded' });
      return;
    }
    const account = demoAccountFor(user, prefs);
    if (!account) {
      res.status(200).json({ published, auto: null, reason: 'no_demo_account' });
      return;
    }
    // Only setups that clear the customer's Signal Quality Filter are auto-traded.
    // The dashboard already withholds weaker signals, but the server re-checks
    // here so the gate holds even if a client sends one. The filter travels with
    // the publication; an absent one falls back to the strictest tier.
    const confidence = typeof body.confidence === 'number' ? body.confidence : 0;
    const normalisedConfidence = confidence > 1 ? confidence / 100 : confidence;
    const threshold = thresholdForMinQuality(body.minQuality);
    if (normalisedConfidence < threshold) {
      res.status(200).json({ published, auto: null, reason: 'weak_signal' });
      return;
    }
    const token = tokenFor(deps, req);
    const snapshot = await market.freshSnapshot(symbol);
    if (!snapshot) {
      res.status(422).json({ published, auto: null, error: 'no_price' });
      return;
    }
    try {
      const signal = await createSignal(store, market, {
        userId: user.id,
        accountId: account.accountId,
        accountMode: 'demo',
        symbol,
        timeframe: String(body.timeframe ?? '5m'),
        direction,
        // Multipliers are disabled; the system trader only uses Rise/Fall.
        contractFamily: 'rise_fall',
        analysisId: `system:${setupKey}`,
        confidence: normalisedConfidence,
        reason: String(body.source ?? 'system') + ' best signal'
      });
      const auto = await runner.runForUser(user, signal, token);
      if (auto.outcome === 'executed') {
        systemSignals!.markExecuted(user.id, setupKey, signal.id, 'executed');
        await mirrorAutoTrade(user, signal, auto);
      }
      res.status(201).json({ published, auto });
    } catch (err) {
      if (err instanceof SignalError) {
        res.status(422).json({ published, auto: null, error: err.code });
        return;
      }
      res.status(500).json({ error: 'signal_failed' });
    }
  });

  router.post('/api/execution/signals', requireSession(ctx), json, async (req: AuthedRequest, res: Response) => {
    if (!limit(signalLimiter, req, res)) return;
    const body = req.body ?? {};
    const direction = parseDirection(body.direction);
    const contractFamily = parseFamily(body.contractFamily);
    if (!direction || !contractFamily) {
      res.status(400).json({ error: 'invalid_signal' });
      return;
    }
    const user = req.user!;
    // The account must belong to the user; the guard rejects, never substitutes.
    const account = user.accounts.find((a) => a.accountId === body.accountId);
    if (!account) {
      res.status(403).json({ error: 'account_not_authorized' });
      return;
    }
    const symbol = String(body.symbol ?? '');
    // An automatic entry may only run on the current best signal. Check before
    // the signal is recorded, so a refused auto-entry leaves nothing behind.
    // Manual users skip this entirely — the trader places their own trade.
    const automaticEntry = !!runner && store.getExecutionPreferences(user.id)?.mode === 'automatic';
    if (automaticEntry) {
      const gate = automaticSignalRejection(user.id, symbol, direction);
      if (gate) {
        res.status(gate.status).json(gate.body);
        return;
      }
    }
    // A signal must be built on a fresh price. The backend does not otherwise
    // subscribe to ticks, so its snapshot can be stale or absent; wait briefly
    // for the next tick rather than trusting whatever happens to be cached.
    const snapshot = await market.freshSnapshot(symbol);
    if (!snapshot) {
      res.status(422).json({ error: 'no_price', message: `No live price for ${symbol} yet.` });
      return;
    }
    try {
      const signal = await createSignal(store, market, {
        userId: user.id,
        accountId: account.accountId,
        accountMode: account.type === 'real' ? 'real' : 'demo',
        symbol: String(body.symbol ?? ''),
        timeframe: String(body.timeframe ?? '5m'),
        direction,
        contractFamily,
        analysisId: String(body.analysisId ?? ''),
        zone: body.zone ?? null,
        confidence: typeof body.confidence === 'number' ? body.confidence : null,
        reason: typeof body.reason === 'string' ? body.reason : ''
      });
      // An automatic user has pre-delegated submission: run the loop now. This
      // still passes through every gateway control (kill switches, risk,
      // single-use); it only removes the manual click. The live-setup gate above
      // already ran for automatic users, so only a validated entry reaches here.
      let auto = null;
      if (automaticEntry) {
        auto = await runner!.runForUser(user, signal, tokenFor(deps, req));
        if (auto.outcome === 'executed') await mirrorAutoTrade(user, signal, auto);
      }
      res.status(201).json({ signal, auto });
    } catch (err) {
      if (err instanceof SignalError) {
        res.status(422).json({ error: err.code, message: err.message });
        return;
      }
      res.status(500).json({ error: 'signal_failed' });
    }
  });

  /**
   * Prices a trade without creating an intent or buying anything. Used by the
   * Trade panel to show the real payout before the customer commits. Repeatable
   * by design: it consumes no signal and evaluates no risk.
   */
  router.post('/api/execution/preview', requireSession(ctx), json, async (req: AuthedRequest, res: Response) => {
    const body = req.body ?? {};
    const user = req.user!;
    const contractFamily = parseFamily(body.contractFamily);
    const direction = parseDirection(body.direction);
    if (!contractFamily || !direction || direction === 'NONE') {
      res.status(400).json({ error: 'invalid_preview' });
      return;
    }
    const accountId = String(body.accountId ?? '');
    let account;
    try {
      account = resolveAccountForUser(user, accountId);
    } catch (err) {
      const code = err instanceof AccountAccessError ? err.code : 'account_not_authorized';
      res.status(403).json({ error: code });
      return;
    }
    const contractType = directionContractType(direction, contractFamily);
    try {
      const preview = await gateway.preview({
        account,
        accessToken: tokenFor(deps, req),
        contractFamily,
        contractType,
        symbol: String(body.symbol ?? ''),
        stake: Number(body.stake ?? 0),
        basis: body.basis === 'payout' ? 'payout' : 'stake',
        currency: String(body.currency ?? 'USD'),
        parameters: normaliseParameters(body.parameters ?? {})
      });
      res.json({ preview });
    } catch (err) {
      if (err instanceof AdapterError) {
        res.status(422).json({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof ExecutionError) {
        res.status(409).json({ error: err.code, reasons: err.reasons });
        return;
      }
      res.status(502).json({ error: 'preview_failed' });
    }
  });

  router.post('/api/execution/intents', requireSession(ctx), json, async (req: AuthedRequest, res: Response) => {
    const body = req.body ?? {};
    const user = req.user!;
    const signal = store.getSignal(user.id, String(body.signalId ?? ''));
    if (!signal) {
      res.status(404).json({ error: 'signal_not_found' });
      return;
    }
    const contractFamily = parseFamily(body.contractFamily) ?? signal.contractFamily;
    // The contract type must be the correct one for the signal's direction.
    const contractType = (body.contractType as DerivContractType) ?? directionContractType(signal.direction, contractFamily);
    if (!CONTRACT_FAMILY_TYPES[contractFamily].includes(contractType)) {
      res.status(400).json({ error: 'invalid_contract_type' });
      return;
    }
    try {
      // Validate the parameters against the family before persisting the intent.
      adapterFor(contractFamily).buildProposal({
        directionContractType: contractType,
        amount: Number(body.stake ?? 0),
        basis: body.basis === 'payout' ? 'payout' : 'stake',
        currency: String(body.currency ?? 'USD'),
        symbol: signal.symbol,
        parameters: normaliseParameters(body.parameters ?? {})
      });
    } catch (err) {
      if (err instanceof AdapterError) {
        res.status(422).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
    if (!idempotencyKey) {
      res.status(400).json({ error: 'missing_idempotency_key' });
      return;
    }
    try {
      const intent = await gateway.createIntent({
        user,
        accountId: signal.accountId,
        signal,
        contractType,
        contractFamily,
        stake: Number(body.stake ?? 0),
        basis: body.basis === 'payout' ? 'payout' : 'stake',
        currency: String(body.currency ?? 'USD'),
        parameters: normaliseParameters(body.parameters ?? {}),
        idempotencyKey,
        manualApproval: { approvedAt: Date.now(), expiresAt: Date.now() + 15_000 }
      });
      res.status(201).json({ intent });
    } catch (err) {
      if (err instanceof AccountAccessError) {
        res.status(403).json({ error: err.code });
        return;
      }
      res.status(500).json({ error: 'intent_failed' });
    }
  });

  router.post(
    '/api/execution/intents/:id/submit',
    requireSession(ctx),
    json,
    async (req: AuthedRequest, res: Response) => {
      if (!limit(submitLimiter, req, res)) return;
      const user = req.user!;
      const token = tokenFor(deps, req);
      try {
        const result = await gateway.submit(user, req.params.id, token);
        res.status(200).json({
          intent: result.intent,
          contractId: result.contractId,
          buy: result.buy
            ? {
                contractId: result.buy.contractId,
                buyPrice: result.buy.buyPrice,
                payout: result.buy.payout,
                transactionId: result.buy.transactionId
              }
            : null
        });
      } catch (err) {
        if (err instanceof ExecutionError) {
          res.status(err.code === 'not_found' ? 404 : 409).json({ error: err.code, reasons: err.reasons });
          return;
        }
        res.status(500).json({ error: 'submit_failed' });
      }
    }
  );

  /**
   * Places a manual trade end to end in ONE round-trip.
   *
   * The client used to drive signal -> intent -> submit as three sequential HTTP
   * calls, so a single click paid three network round-trips before Deriv was even
   * asked for a price. This route runs the identical sequence server-side, using
   * the same helpers the individual routes use, so the safety properties are
   * unchanged: the manual-signal gate, a fresh-price signal, single-use, risk and
   * one purchase path all still apply. It only removes the client round-trips.
   */
  router.post('/api/execution/place', requireSession(ctx), json, async (req: AuthedRequest, res: Response) => {
    if (!limit(submitLimiter, req, res)) return;
    const body = req.body ?? {};
    const direction = parseDirection(body.direction);
    const contractFamily = parseFamily(body.contractFamily);
    if (!direction || direction === 'NONE' || !contractFamily) {
      res.status(400).json({ error: 'invalid_signal' });
      return;
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
    if (!idempotencyKey) {
      res.status(400).json({ error: 'missing_idempotency_key' });
      return;
    }
    const user = req.user!;
    // Idempotency before anything else: a repeated key (a double-click or a retry
    // of the same ticket) must not create a second signal or a second purchase.
    // The original result is replayed so the client sees the same trade.
    const existingIntent = store.findTradeIntentByIdempotencyKey(user.id, idempotencyKey);
    if (existingIntent) {
      const contract = existingIntent.contractId
        ? store.getContract(user.id, String(existingIntent.contractId))
        : null;
      res.status(200).json({
        intent: existingIntent,
        contractId: existingIntent.contractId,
        buy: contract
          ? {
              contractId: Number(contract.id),
              buyPrice: contract.buyPrice,
              payout: contract.payout,
              transactionId: contract.buyTransactionId
            }
          : null
      });
      return;
    }
    const account = user.accounts.find((a) => a.accountId === body.accountId);
    if (!account) {
      res.status(403).json({ error: 'account_not_authorized' });
      return;
    }
    const symbol = String(body.symbol ?? '');

    const snapshot = await market.freshSnapshot(symbol);
    if (!snapshot) {
      res.status(422).json({ error: 'no_price', message: `No live price for ${symbol} yet.` });
      return;
    }

    const parameters = normaliseParameters(body.parameters ?? {});
    let signal;
    try {
      signal = await createSignal(store, market, {
        userId: user.id,
        accountId: account.accountId,
        accountMode: account.type === 'real' ? 'real' : 'demo',
        symbol,
        timeframe: String(body.timeframe ?? '5m'),
        direction,
        contractFamily,
        analysisId: String(body.analysisId ?? ''),
        zone: body.zone ?? null,
        confidence: typeof body.confidence === 'number' ? body.confidence : null,
        reason: typeof body.reason === 'string' ? body.reason : ''
      });
    } catch (err) {
      if (err instanceof SignalError) {
        res.status(422).json({ error: err.code, message: err.message });
        return;
      }
      res.status(500).json({ error: 'signal_failed' });
      return;
    }

    const contractType = directionContractType(direction, contractFamily);
    try {
      // Validate the parameters against the family before persisting the intent.
      adapterFor(contractFamily).buildProposal({
        directionContractType: contractType,
        amount: Number(body.stake ?? 0),
        basis: body.basis === 'payout' ? 'payout' : 'stake',
        currency: String(body.currency ?? 'USD'),
        symbol,
        parameters
      });
    } catch (err) {
      if (err instanceof AdapterError) {
        res.status(422).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    try {
      const intent = await gateway.createIntent({
        user,
        accountId: account.accountId,
        signal,
        contractType,
        contractFamily,
        stake: Number(body.stake ?? 0),
        basis: body.basis === 'payout' ? 'payout' : 'stake',
        currency: String(body.currency ?? 'USD'),
        parameters,
        idempotencyKey,
        manualApproval: { approvedAt: Date.now(), expiresAt: Date.now() + 15_000 }
      });
      const result = await gateway.submit(user, intent.id, tokenFor(deps, req));

      // Mirroring happens only after the master's trade was accepted by the
      // broker, so a follower never copies a trade the manager did not get.
      // A copy failure must not fail the manager's own trade, which has already
      // been accepted; it is audited per follower inside the engine.
      if (deps.copyEngine) {
        try {
          await deps.copyEngine.mirrorMasterTrade({
            master: user,
            signal,
            masterIntentId: intent.id,
            stake: Number(body.stake ?? 0),
            basis: body.basis === 'payout' ? 'payout' : 'stake',
            currency: String(body.currency ?? 'USD'),
            parameters
          });
        } catch {
          // Swallowed deliberately: the manager's trade is already live.
        }
      }

      res.status(200).json({
        intent: result.intent,
        contractId: result.contractId,
        buy: result.buy
          ? {
              contractId: result.buy.contractId,
              buyPrice: result.buy.buyPrice,
              payout: result.buy.payout,
              transactionId: result.buy.transactionId
            }
          : null
      });
    } catch (err) {
      if (err instanceof AccountAccessError) {
        res.status(403).json({ error: err.code });
        return;
      }
      if (err instanceof ExecutionError) {
        res.status(err.code === 'not_found' ? 404 : 409).json({ error: err.code, reasons: err.reasons });
        return;
      }
      res.status(500).json({ error: 'submit_failed' });
    }
  });

  router.get('/api/execution/intents', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ intents: store.listTradeIntents(req.user!.id) });
  });

  /**
   * The automatic-trading status, scoped to the caller. It reports whether the
   * server permits automatic trading at all, and the last best signal the
   * dashboard published for this user. The markets themselves are scanned in the
   * dashboard, so there is no server-side watch list to report.
   */
  router.get('/api/execution/scanner', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const flags = deps.flags;
    const executionEnabled = flags ? flags.allowExecution : true;
    const demoEnabled = flags ? flags.allowDemoExecution : true;
    const automaticEnabled = flags ? flags.allowAutomaticTrading : true;
    // Why automatic trading is (not) available, so a client can tell the user
    // what to do rather than showing a bare "off". It needs every switch.
    const reason = !executionEnabled
      ? 'execution_disabled'
      : !demoEnabled
        ? 'demo_execution_disabled'
        : !automaticEnabled
          ? 'automatic_disabled'
          : null;
    const userId = req.user!.id;
    const current = systemSignals?.current(userId) ?? null;
    const recent = (systemSignals?.recent(userId) ?? []).slice(-20).map((s) => ({
      symbol: s.symbol,
      outcome: s.executedAt !== null ? 'executed' : 'proposed',
      direction: s.direction,
      confidence: s.confidence,
      executed: s.executedAt !== null
    }));
    res.json({
      // Automatic trading is "running" only when every switch permits it.
      running: executionEnabled && demoEnabled && automaticEnabled,
      executionEnabled,
      demoEnabled,
      automaticEnabled,
      reason,
      lastPassAt: current?.publishedAt ?? null,
      recent,
      // The dashboard owns the market universe; the server has none.
      watchedMarkets: [],
      // The current best signal, so the Trade panel can show exactly the setup
      // the system trader would act on right now (and nothing else).
      setups: current
        ? [
            {
              symbol: current.symbol,
              displayName: current.displayName,
              direction: current.direction,
              confidence: current.confidence,
              reason: current.source
            }
          ]
        : []
    });
  });

  router.get('/api/execution/contracts', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const user = req.user!;
    const token = tokenFor(deps, req);
    const contracts = store.listContracts(user.id);
    try {
      if (monitor && token) {
        for (const contract of contracts) {
          if (contract.status !== 'open') continue;
          if (hasPendingClose(store, user.id, contract)) {
            await gateway.recoverPendingClose(user, contract.id);
            const current = store.getContract(user.id, contract.id) ?? contract;
            monitor.monitor(user, current, token);
          } else {
            monitor.ensureMonitoring(user, contract, token);
          }
        }
      }
      res.json({
        contracts: store.listContracts(user.id).map((contract) => ({
          ...contract,
          closePending: hasPendingClose(store, user.id, contract)
        }))
      });
    } catch {
      res.status(500).json({ error: 'contracts_unavailable', message: 'Could not load and reconcile account positions.' });
    }
  });

  router.post(
    '/api/execution/contracts/:contractId/close',
    requireSession(ctx),
    json,
    async (req: AuthedRequest, res: Response) => {
      if (!limit(submitLimiter, req, res)) return;
      try {
        const sale = await gateway.closeContract(req.user!, req.params.contractId, tokenFor(deps, req));
        const contract = store.getContract(req.user!.id, String(sale.contractId));
        if (!contract) throw new Error('The confirmed sale has no stored contract.');
        res.json({
          contract: { ...contract, closePending: hasPendingClose(store, req.user!.id, contract) },
          sale
        });
      } catch (err) {
        if (err instanceof ExecutionError) {
          const forbidden =
            err.code === 'account_not_authorized' ||
            err.code === 'account_mode_mismatch' ||
            err.code === 'account_mode_invalid' ||
            err.code === 'account_unavailable';
          res.status(err.code === 'not_found' ? 404 : forbidden ? 403 : 409).json({
            error: err.code,
            message: err.message,
            reasons: err.reasons
          });
          return;
        }
        res.status(500).json({ error: 'close_failed', message: 'Could not close the position.' });
      }
    }
  );

  /**
   * The Trade panel's preferences. A preference expresses intent only — it can
   * never grant authority, and the gateway re-derives every permission on each
   * purchase. `realExecutionAuthorised` and `autoStopped` are carried over, not
   * writable here.
   */
  router.get('/api/execution/preferences', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const existing = store.getExecutionPreferences(req.user!.id);
    const normalised = normalisePreferences({}, existing, req.user!.id);
    res.json({
      preferences: normalised.ok ? normalised.value : existing,
      durationBounds: { minMinutes: MIN_DURATION_MINUTES, maxMinutes: MAX_DURATION_MINUTES }
    });
  });

  router.put(
    '/api/execution/preferences',
    requireSession(ctx),
    json,
    async (req: AuthedRequest, res: Response) => {
      const user = req.user!;
      const existing = store.getExecutionPreferences(user.id);
      const result = normalisePreferences(req.body ?? {}, existing, user.id);
      if (!result.ok) {
        res.status(422).json({ error: result.error.code, message: result.error.message });
        return;
      }
      // Automatic trading is switched off by default. A stored preference for it
      // would only mislead the panel, so refuse to select it while the switch is
      // off. (The gateway refuses an automatic purchase regardless.)
      if (result.value.mode === 'automatic' && deps.flags && !deps.flags.allowAutomaticTrading) {
        res.status(422).json({
          error: 'automatic_disabled',
          message: 'Automatic trading is switched off on this server. Place trades manually.'
        });
        return;
      }
      // A preferred account must be one the user actually owns; the gateway
      // re-checks on submit, but rejecting early gives a clear message.
      for (const mode of ['demo', 'real'] as const) {
        const accountId = result.value.preferredAccountId[mode];
        if (accountId && !user.accounts.some((a) => a.accountId === accountId)) {
          res.status(403).json({
            error: 'account_not_authorized',
            message: 'That account is not linked to your session.'
          });
          return;
        }
      }
      await store.putExecutionPreferences(result.value);
      res.json({ preferences: result.value });
    }
  );

  router.post(
    '/api/execution/risk-session/reset',
    requireSession(ctx),
    json,
    async (req: AuthedRequest, res: Response) => {
      if (!limit(submitLimiter, req, res)) return;
      const user = req.user!;
      const accountId = req.body?.accountId;
      if (typeof accountId !== 'string' || accountId.trim() === '') {
        res.status(400).json({ error: 'invalid_account', message: 'Select a DEMO account to reset.' });
        return;
      }

      try {
        resolveTradableAccountForUser(user, accountId, 'demo');
      } catch (err) {
        if (err instanceof AccountAccessError) {
          res.status(403).json({ error: err.code, message: err.message });
          return;
        }
        res.status(500).json({
          error: 'risk_account_check_failed',
          message: 'Could not verify the DEMO account for this reset.'
        });
        return;
      }

      const preferences = store.getExecutionPreferences(user.id);
      if (!preferences?.autoStopped) {
        res.status(409).json({
          error: 'auto_stop_not_engaged',
          message: 'Automatic execution is not stopped; no risk-session reset was made.'
        });
        return;
      }

      const resetAt = Date.now();
      const priorLossStreak = consecutiveLosses(store.listContracts(user.id), accountId);
      const updated = {
        ...preferences,
        autoStopped: false,
        lossStreakResetAtByAccount: {
          ...preferences.lossStreakResetAtByAccount,
          [accountId]: resetAt
        },
        updatedAt: resetAt
      };

      try {
        await store.transaction(async () => {
          await store.putExecutionPreferences(updated);
          await auditor.record({
            userId: user.id,
            action: 'execution.risk_session_reset',
            outcome: 'allowed',
            accountId,
            detail: { priorLossStreak, resetAt, mode: 'demo' }
          });
        });
        res.json({ preferences: updated, resetAt });
      } catch {
        res.status(500).json({
          error: 'risk_session_reset_failed',
          message: 'Could not save the risk-session reset. Trading remains subject to all risk controls.'
        });
      }
    }
  );

  router.get('/api/execution/ledger', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ entries: store.listLedgerEntries(req.user!.id) });
  });

  // Reconcile an intent left stuck by a lost purchase confirmation. This asks
  // Deriv what actually happened; it never retries the purchase.
  router.post(
    '/api/execution/intents/:id/reconcile',
    requireSession(ctx),
    async (req: AuthedRequest, res: Response) => {
      if (!monitor) {
        res.status(501).json({ error: 'reconciliation_unavailable' });
        return;
      }
      const user = req.user!;
      const token = tokenFor(deps, req);
      if (!token) {
        res.status(409).json({ error: 'token_expired' });
        return;
      }
      const intent = store.getTradeIntent(user.id, req.params.id);
      if (!intent) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      try {
        const reconciled = await monitor.reconcile(user, req.params.id, token);
        res.json({ intent: reconciled });
      } catch (err) {
        res.status(500).json({ error: 'reconcile_failed' });
      }
    }
  );

  return router;
}

/**
 * The user's demo account for system trading, preferring the one they selected.
 * Returns null when the user has no demo account, so the caller skips rather
 * than substituting a real one.
 */
function demoAccountFor(
  user: UserRecord,
  prefs: ExecutionPreferencesRecord | null
): UserRecord['accounts'][number] | null {
  const preferred = prefs?.preferredAccountId?.demo;
  const demos = user.accounts.filter((a) => a.type === 'demo');
  return demos.find((a) => a.accountId === preferred) ?? demos[0] ?? null;
}

function hasPendingClose(store: Store, userId: string, contract: ContractRecord): boolean {
  const attempts = store
    .listExecutionAttempts(userId, contract.intentId)
    .filter(
      (attempt) =>
        attempt.phase === 'close' &&
        attempt.requestSummary.contractId === contract.id
    );
  const outcome = attempts[attempts.length - 1]?.outcome;
  return outcome === 'pending' || outcome === 'unknown';
}

function directionContractType(direction: SignalDirection, family: ContractFamily): DerivContractType {
  if (direction === 'NONE') throw new AdapterError('invalid_direction', 'A NONE signal has no contract type.');
  return family === 'multipliers'
    ? direction === 'RISE'
      ? 'MULTUP'
      : 'MULTDOWN'
    : direction === 'RISE'
      ? 'CALL'
      : 'PUT';
}

function normaliseParameters(raw: any) {
  return {
    duration: Number(raw.duration ?? 0),
    durationUnit: typeof raw.durationUnit === 'string' ? raw.durationUnit : 'm',
    multiplier: typeof raw.multiplier === 'number' ? raw.multiplier : null,
    cancellation: typeof raw.cancellation === 'string' ? raw.cancellation : null,
    stopLoss: typeof raw.stopLoss === 'number' ? raw.stopLoss : null,
    takeProfit: typeof raw.takeProfit === 'number' ? raw.takeProfit : null
  };
}
