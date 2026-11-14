import express, { Router, type Response } from 'express';

import type { Store } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import { requireSession, type AuthedRequest } from '../lib/session.js';
import { open } from '../lib/crypto.js';
import type { ExecutionGateway } from '../execution/gateway.js';
import { ExecutionError } from '../execution/gateway.js';
import type { AutoExecutionRunner } from '../execution/autoRunner.js';
import type { ContractMonitor } from '../execution/contractMonitor.js';
import type { MarketDataService } from '../services/marketData.js';
import { createSignal, SignalError } from '../services/signals.js';
import { adapterFor, AdapterError } from '../execution/adapters/index.js';
import { AccountAccessError } from '../execution/accountGuard.js';
import type { SignalDirection, ContractFamily, DerivContractType } from '../execution/types.js';
import { CONTRACT_FAMILY_TYPES } from '../execution/types.js';

/**
 * Execution routes.
 *
 *   POST /api/execution/signals              -> validate and record a signal
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
  const { store, gateway, market, runner, monitor } = deps;
  const ctx = { cfg: deps.cfg, store };
  const router = Router();
  const json = express.json({ limit: '32kb' });

  router.post('/api/execution/signals', requireSession(ctx), json, async (req: AuthedRequest, res: Response) => {
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

  router.get('/api/execution/intents', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ intents: store.listTradeIntents(req.user!.id) });
  });

  router.get('/api/execution/contracts', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ contracts: store.listContracts(req.user!.id) });
  });

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
