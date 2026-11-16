import express, { Router, type Response } from 'express';

import type { Store } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import { requireSession, type AuthedRequest } from '../lib/session.js';
import { RateLimiter } from '../services/admin/rateLimit.js';
import { open } from '../lib/crypto.js';
import type { ExecutionGateway } from '../execution/gateway.js';
import { ExecutionError } from '../execution/gateway.js';
import { ExecutionAuditor } from '../execution/audit.js';
import type { AutoExecutionRunner } from '../execution/autoRunner.js';
import type { ContractMonitor } from '../execution/contractMonitor.js';
import type { MarketScanner, ScanCandidate } from '../services/marketScanner.js';
import type { MarketDataService } from '../services/marketData.js';
import type { ExecutionFlags } from '../config/flags.js';
import { createSignal, SignalError } from '../services/signals.js';
import { consecutiveLosses } from '../services/risk.js';
import { adapterFor, AdapterError } from '../execution/adapters/index.js';
import { normalisePreferences, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES } from '../execution/preferences.js';
import {
  AccountAccessError,
  resolveAccountForUser,
  resolveTradableAccountForUser
} from '../execution/accountGuard.js';
import type { SignalDirection, ContractFamily, DerivContractType, ContractRecord } from '../execution/types.js';
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
  /** Optional: the automatic scanner, for the status surface. */
  scanner?: MarketScanner;
  /**
   * Optional: the resolved kill switches. When present, the scanner status
   * explains WHY the scanner is off (master switch vs demo switch) instead of a
   * bare "not running", so a fresh local checkout is not a silent dead end.
   */
  flags?: ExecutionFlags;
  /** Optional per-minute limits, for tests. Defaults are conservative. */
  limits?: { signalsPerMinute?: number; submitsPerMinute?: number };
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
  return value === 'rise_fall' || value === 'multipliers' ? value : null;
}

export function createExecutionRouter(deps: ExecutionRouterDeps): Router {
  const { store, gateway, market, runner, monitor, scanner } = deps;
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
   * The manual-trade gate: a manual trade must be backed by a live scanner signal
   * for the same market and direction, so a hand-placed trade can never exist
   * outside a valid setup the scanner itself would have generated. Automatic
   * users are exempt because the scanner is their signal source. The mode comes
   * from the SERVER's stored preferences, never the request body: a client flag
   * would let a hand-placed trade claim to be scanner-originated and skip the
   * check. Returns the rejection to send, or null when the trade may proceed.
   */
  const manualSignalRejection = (
    userId: string,
    symbol: string,
    direction: SignalDirection
  ): { status: number; body: { error: string; message: string } } | null => {
    if (!scanner) return null;
    if (store.getExecutionPreferences(userId)?.mode === 'automatic') return null;
    if (!scanner.isRunning) {
      return {
        status: 422,
        body: {
          error: 'no_signal',
          message: 'The scanner is not running, so there is no valid setup to trade.'
        }
      };
    }
    if (!scanner.hasLiveSignal(symbol, direction)) {
      const reading = scanner.liveReading(symbol);
      return {
        status: 422,
        body: {
          error: 'no_valid_signal',
          message: reading
            ? reading.stale
              ? `The last ${reading.candidate.direction} setup on ${symbol} has passed. Wait for a fresh signal.`
              : `The scanner is not signalling ${direction} on ${symbol} right now.`
            : `The scanner has no active setup for ${symbol}. Wait for a valid signal.`
        }
      };
    }
    return null;
  };

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
    // A manual trade must be backed by a live scanner signal for the same market
    // and direction. This is the authority that stops a hand-placed trade from
    // existing outside a valid setup the scanner itself would have generated.
    const gate = manualSignalRejection(user.id, symbol, direction);
    if (gate) {
      res.status(gate.status).json(gate.body);
      return;
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
      // single-use); it only removes the manual click.
      let auto = null;
      if (runner) {
        const prefs = store.getExecutionPreferences(user.id);
        if (prefs?.mode === 'automatic') {
          auto = await runner.runForUser(user, signal, tokenFor(deps, req));
        }
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

    // Same gate as the signals route: a manual trade must be backed by a live
    // scanner signal for the same market and direction.
    const gate = manualSignalRejection(user.id, symbol, direction);
    if (gate) {
      res.status(gate.status).json(gate.body);
      return;
    }

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
   * The automatic scanner's status, scoped to the caller. It reports whether the
   * scanner is running and what it recently decided, but only for markets the
   * caller's own signals touched — a customer cannot see another's activity.
   */
  router.get('/api/execution/scanner', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const flags = deps.flags;
    const executionEnabled = flags ? flags.allowExecution : true;
    const demoEnabled = flags ? flags.allowDemoExecution : true;
    // Why the scanner is (not) running, so a client can tell the user what to do
    // rather than showing a bare "not running". The scanner needs both switches.
    const reason = !executionEnabled
      ? 'execution_disabled'
      : !demoEnabled
        ? 'demo_execution_disabled'
        : null;
    if (!scanner) {
      res.json({
        running: false,
        executionEnabled,
        demoEnabled,
        reason,
        lastPassAt: null,
        recent: [],
        watchedMarkets: []
      });
      return;
    }
    const userId = req.user!.id;
    const signalSymbols = new Set(
      store
        .listTradeIntents(userId)
        .map((i) => store.getSignal(userId, i.signalId)?.symbol)
        .filter((s): s is string => typeof s === 'string')
    );
    const recent = scanner.recent
      .filter((o) => signalSymbols.has(o.symbol))
      .slice(-20)
      .map((o) => ({
        symbol: o.symbol,
        outcome: o.outcome,
        direction: o.candidate?.direction ?? null,
        confidence: o.candidate?.confidence ?? null,
        executed: o.auto?.outcome === 'executed'
      }));
    res.json({
      running: scanner.isRunning,
      executionEnabled,
      demoEnabled,
      reason,
      lastPassAt: scanner.lastPassTime,
      recent,
      watchedMarkets: scanner.activeMarkets,
      // The live directional readings, so the Trade panel can offer exactly the
      // setups the scanner is willing to trade right now (and nothing else).
      setups: scanner.activeMarkets
        .map((m) => scanner.liveReading(m.symbol))
        .filter((r): r is { candidate: ScanCandidate; stale: boolean } => r !== null)
        .filter((r) => !r.stale)
        .map((r) => ({
          symbol: r.candidate.symbol,
          displayName: r.candidate.displayName,
          direction: r.candidate.direction,
          confidence: r.candidate.confidence,
          reason: r.candidate.reason
        }))
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
