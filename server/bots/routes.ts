/**
 * Bot importer routes.
 *
 *   POST /api/bots/preview      -> analyze an upload without storing it
 *   POST /api/bots              -> analyze and store an upload
 *   GET  /api/bots              -> list the caller's imported bots
 *   GET  /api/bots/:id          -> one bot
 *   GET  /api/bots/:id/source   -> the original XML, as a download
 *   PATCH /api/bots/:id         -> status transition (pause / resume / archive)
 *   POST /api/bots/:id/duplicate-> copy a bot
 *   DELETE /api/bots/:id        -> remove a bot
 *
 * Every route requires a session and is scoped to the caller's own `userId` by
 * the store accessors. Nothing here can execute a bot: there is no purchase,
 * no gateway call and no flag that would authorise one.
 *
 * Uploads arrive as JSON with the file already read as text. That keeps the
 * body limit explicit and avoids a multipart parser; the limit is set slightly
 * above the parser's own ceiling so the service can return a precise 413
 * rather than the body parser silently truncating.
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';

import type { SessionContext, AuthedRequest } from '../lib/session.js';
import { requireSession } from '../lib/session.js';
import type { Store } from '../store/store.js';
import { open } from '../lib/crypto.js';
import { loadBotMarkets, loadSymbolContracts, BotMarketError } from './markets.js';
import { evaluateCompatibility } from './compatibility.js';
import { planStrategy } from './evaluator.js';
import type { ExecutionGateway } from '../execution/gateway.js';
import type { AutoExecutionRunner } from '../execution/autoRunner.js';
import type { ContractMonitor } from '../execution/contractMonitor.js';
import type { ExecutionAuditor } from '../execution/audit.js';
import type { MarketDataService } from '../services/marketData.js';
import type { ExecutionFlags } from '../config/flags.js';
import {
  ImportError,
  archiveBot,
  deleteBot,
  duplicateBot,
  importBot,
  loadBotTree,
  previewUpload,
  saveBotTree,
  setBotStatus,
  toView
} from './service.js';
import {
  BotRunError,
  RUN_IDLE_TIMEOUT_MS,
  startBotRun,
  stopBotRun,
  tickBotRun,
  toRunView,
  type BotRunDeps
} from './runService.js';
import { collectUnknownBlocks } from './tree.js';
import { MAX_BOT_FILE_BYTES } from './parser.js';
import { supportedBlockTypes, unsupportedBlockTypes } from './blocks.js';

/** What the bot runtime needs. Absent in builds that only import strategies. */
export interface BotRuntimeDeps {
  gateway: ExecutionGateway;
  runner: AutoExecutionRunner;
  monitor: ContractMonitor;
  auditor: ExecutionAuditor;
  market: MarketDataService;
  flags: ExecutionFlags;
}

/** JSON bodies are the raw XML text, so allow the parser ceiling plus overhead. */
const BODY_LIMIT = `${Math.ceil((MAX_BOT_FILE_BYTES * 1.4) / 1024)}kb`;

function fail(res: Response, e: unknown): void {
  if (e instanceof ImportError) {
    res.status(e.status).json({
      error: e.code,
      message: e.message,
      ...(e.existingBotId ? { existingBotId: e.existingBotId } : {})
    });
    return;
  }
  res.status(500).json({ error: 'internal_error', message: 'The import could not be completed.' });
}

export function createBotsRouter(ctx: SessionContext, store: Store, runtime?: BotRuntimeDeps): Router {
  const router = Router();
  router.use(express.json({ limit: BODY_LIMIT }));

  // What this build can interpret. Published so the UI never claims more than
  // the parser actually supports.
  router.get('/api/bots/formats', (_req: Request, res: Response) => {
    res.json({
      formats: [
        {
          id: 'deriv-dbot-xml',
          label: 'Deriv DBot XML export',
          extension: '.xml',
          maxBytes: MAX_BOT_FILE_BYTES
        }
      ],
      supportedBlocks: supportedBlockTypes(),
      unsupportedBlocks: unsupportedBlockTypes(),
      executionEnabled: runtime !== undefined
    });
  });

  /**
   * The Synthetic market catalogue, discovered live from Deriv.
   *
   * This is the Bots module's own catalogue, not WickSentinel's. It lists every
   * Synthetic family Deriv publishes — including Boom/Crash and Range Break,
   * which the scanner refuses — because an imported bot may legitimately trade
   * them and hiding them would look like an incompatibility.
   */
  router.get('/api/bots/markets', requireSession(ctx), async (_req: AuthedRequest, res: Response) => {
    if (!runtime) {
      res.status(503).json({ error: 'market_data_unavailable', message: 'Market data is not enabled in this build.' });
      return;
    }
    try {
      const catalog = await loadBotMarkets(runtime.market);
      res.json(catalog);
    } catch (e) {
      if (e instanceof BotMarketError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      res.status(503).json({ error: 'market_data_unavailable', message: 'Could not load the market catalogue.' });
    }
  });

  /** Contract types Deriv currently offers for one Synthetic symbol. */
  router.get(
    '/api/bots/markets/:symbol/contracts',
    requireSession(ctx),
    async (req: AuthedRequest, res: Response) => {
      if (!runtime) {
        res.status(503).json({ error: 'market_data_unavailable', message: 'Market data is not enabled in this build.' });
        return;
      }
      try {
        const result = await loadSymbolContracts(runtime.market, req.params.symbol);
        res.json(result);
      } catch (e) {
        if (e instanceof BotMarketError) {
          res.status(e.status).json({ error: e.code, message: e.message });
          return;
        }
        res.status(503).json({ error: 'market_data_unavailable', message: 'Could not load contract availability.' });
      }
    }
  );

  /**
   * Compatibility of a stored bot against its own symbol and against a caller-
   * supplied symbol, so the UI can explain both "does this run at all" and
   * "would it run here".
   */
  router.get('/api/bots/:id/compatibility', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    if (!runtime) {
      res.status(503).json({ error: 'market_data_unavailable', message: 'Market data is not enabled in this build.' });
      return;
    }
    const bot = store.getImportedBot(req.user!.id, req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'not_found', message: 'Bot not found.' });
      return;
    }
    const { tree } = loadBotTree(bot);
    const plan = planStrategy(tree);
    if (!plan.ok || !plan.plan) {
      res.json({
        botId: bot.id,
        plan: null,
        state: 'invalid' as const,
        reason: plan.reasons[0] ?? 'The strategy cannot be interpreted.',
        details: plan.reasons
      });
      return;
    }
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol ? req.query.symbol : plan.plan.symbol;
    try {
      const { contracts } = await loadSymbolContracts(runtime.market, symbol);
      const verdict = evaluateCompatibility(plan.plan, symbol, contracts);
      res.json({
        botId: bot.id,
        symbol,
        contractType: plan.plan.contractType,
        contractFamily: plan.plan.contractFamily,
        digit: plan.plan.digit,
        barrier: plan.plan.barrier,
        ...verdict,
        availableContracts: contracts.map((c) => c.contractType)
      });
    } catch (e) {
      if (e instanceof BotMarketError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      res.status(503).json({ error: 'market_data_unavailable', message: 'Could not check compatibility.' });
    }
  });

  router.post('/api/bots/preview', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    try {
      const { filename, content } = (req.body ?? {}) as { filename?: unknown; content?: unknown };
      const analysis = previewUpload(filename, content);
      res.json({
        compatibility: analysis.compatibility,
        compatibilityReason: analysis.compatibilityReason,
        errors: analysis.errors,
        sourceBytes: analysis.sourceBytes,
        sourceHash: analysis.sourceHash,
        bot: analysis.bot
      });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/bots', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    try {
      const { filename, content } = (req.body ?? {}) as { filename?: unknown; content?: unknown };
      const result = await importBot(store, req.user!.id, filename, content);
      res.status(result.duplicate ? 200 : 201).json({
        duplicate: result.duplicate,
        bot: toView(result.record),
        compatibility: result.analysis.compatibility,
        compatibilityReason: result.analysis.compatibilityReason
      });
    } catch (e) {
      fail(res, e);
    }
  });

  router.get('/api/bots', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const bots = store.listImportedBots(req.user!.id).map(toView);
    res.json({ bots });
  });

  // Registered before `/api/bots/:id` so the literal "runs" is not captured as a
  // bot id. Both are tenant-scoped by the store accessors.
  router.get('/api/bots/runs', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    res.json({ runs: store.listBotRuns(req.user!.id).map(toRunView) });
  });

  router.get('/api/bots/:id/run', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const run = store.findActiveBotRun(req.user!.id, req.params.id);
    res.json({ run: run ? toRunView(run) : null });
  });

  router.get('/api/bots/:id', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const bot = store.getImportedBot(req.user!.id, req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'not_found', message: 'Bot not found.' });
      return;
    }
    res.json({ bot: toView(bot) });
  });

  router.get('/api/bots/:id/source', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const bot = store.getImportedBot(req.user!.id, req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'not_found', message: 'Bot not found.' });
      return;
    }
    // The original file is preserved verbatim so it can always be re-downloaded,
    // even when translation failed.
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${bot.originalFilename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bot.sourceXml);
  });

  /**
   * The bot's editable block tree.
   *
   * Parsing happens here so the browser never has to agree with a second XML
   * implementation. `unknownBlocks` lists the types this build cannot
   * interpret, so the editor can register read-only placeholders for them
   * before Blockly reads the XML — otherwise Blockly would skip those blocks
   * and a save would silently delete them.
   */
  router.get('/api/bots/:id/tree', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const bot = store.getImportedBot(req.user!.id, req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'not_found', message: 'Bot not found.' });
      return;
    }
    try {
      const loaded = loadBotTree(bot);
      const unknownBlocks = collectUnknownBlocks(loaded.tree);
      res.json({
        botId: bot.id,
        name: bot.name,
        edited: loaded.edited,
        revision: loaded.revision,
        xml: loaded.xml,
        tree: loaded.tree,
        unknownBlocks,
        compatibility: bot.compatibility,
        compatibilityReason: bot.compatibilityReason,
        status: bot.status
      });
    } catch (e) {
      res.status(422).json({
        error: 'unreadable',
        message: e instanceof Error ? e.message : 'The strategy could not be read.'
      });
    }
  });

  /** Saves an edited strategy. The server re-parses before storing. */
  router.put('/api/bots/:id/tree', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    try {
      const { xml } = (req.body ?? {}) as { xml?: unknown };
      const result = await saveBotTree(store, req.user!.id, req.params.id, xml);
      res.json({
        bot: toView(result.record),
        changed: result.changed,
        revision: result.revision
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /** Discards saved edits and returns the bot to its imported file. */
  router.post('/api/bots/:id/revert', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const bot = store.getImportedBot(req.user!.id, req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'not_found', message: 'Bot not found.' });
      return;
    }
    const { workingXml: _drop, revision: _r, editedAt: _e, ...rest } = bot;
    const reverted: typeof bot = { ...rest, updatedAt: Date.now() };
    await store.putImportedBot(reverted);
    res.json({ bot: toView(reverted) });
  });

  /** Downloads the saved strategy, which is the original when never edited. */
  router.get('/api/bots/:id/export', requireSession(ctx), (req: AuthedRequest, res: Response) => {
    const bot = store.getImportedBot(req.user!.id, req.params.id);
    if (!bot) {
      res.status(404).json({ error: 'not_found', message: 'Bot not found.' });
      return;
    }
    const xml = bot.workingXml ?? bot.sourceXml;
    const base = bot.originalFilename.replace(/\.xml$/i, '');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xml"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(xml);
  });

  router.patch('/api/bots/:id', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    try {
      const { status } = (req.body ?? {}) as { status?: unknown };
      const updated = await setBotStatus(store, req.user!.id, req.params.id, status);
      res.json({ bot: toView(updated) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/bots/:id/duplicate', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    try {
      const copy = await duplicateBot(store, req.user!.id, req.params.id);
      res.status(201).json({ bot: toView(copy) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.post('/api/bots/:id/archive', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    try {
      const archived = await archiveBot(store, req.user!.id, req.params.id);
      res.json({ bot: toView(archived) });
    } catch (e) {
      fail(res, e);
    }
  });

  router.delete('/api/bots/:id', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    try {
      await deleteBot(store, req.user!.id, req.params.id);
      res.status(204).end();
    } catch (e) {
      fail(res, e);
    }
  });

  /* ======================================================================= */
  /*  Run / stop. These are the only bot routes that can reach a purchase.   */
  /*  Every one is session-guarded, tenant-scoped and DEMO-only; the actual   */
  /*  buy still happens inside ExecutionGateway.submit and nowhere else.     */
  /* ======================================================================= */

  const runDeps = (): BotRunDeps | null =>
    runtime
      ? {
          store,
          market: runtime.market,
          gateway: runtime.gateway,
          runner: runtime.runner,
          monitor: runtime.monitor,
          auditor: runtime.auditor,
          flags: runtime.flags
        }
      : null;

  function runFail(res: Response, e: unknown): void {
    if (e instanceof BotRunError) {
      res.status(e.status).json({
        error: e.code,
        message: e.message,
        ...(e.reasons.length > 0 ? { reasons: e.reasons } : {})
      });
      return;
    }
    res.status(500).json({ error: 'internal_error', message: 'The run could not be completed.' });
  }

  /** The session's sealed Deriv token, or null when absent or expired. */
  function tokenFor(req: AuthedRequest): string | null {
    const session = req.session;
    if (!session || !session.derivTokenSealed) return null;
    if (session.derivTokenExpiresAt <= Date.now()) return null;
    try {
      return open(session.derivTokenSealed, ctx.cfg.session.secret);
    } catch {
      return null;
    }
  }

  /**
   * Starts a run. The account must be the caller's own demo account with a live
   * Deriv authorisation; the strategy must be interpretable and the market must
   * be fresh. Each refusal names its reason so the UI can say something true.
   */
  router.post('/api/bots/:id/run', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const deps = runDeps();
    if (!deps) {
      res.status(503).json({ error: 'execution_unavailable', message: 'Bot execution is not enabled.' });
      return;
    }
    try {
      const body = (req.body ?? {}) as { accountId?: unknown; accountMode?: unknown; maxEntries?: unknown };
      const run = await startBotRun(
        deps,
        req.user!,
        req.params.id,
        {
          accountId: String(body.accountId ?? ''),
          accountMode: body.accountMode === undefined ? undefined : String(body.accountMode),
          maxEntries: typeof body.maxEntries === 'number' ? body.maxEntries : undefined
        },
        tokenFor(req)
      );
      res.status(201).json({
        run: toRunView(run),
        // Stated plainly so the client can show it: ticking is browser-driven.
        sessionDependent: true,
        idleTimeoutMs: RUN_IDLE_TIMEOUT_MS
      });
    } catch (e) {
      runFail(res, e);
    }
  });

  /**
   * One evaluation tick.
   *
   * Re-proves ownership and activity every time, so a stale or stolen run id
   * cannot act. Returns 200 with the run so the client can render the counters
   * even when nothing was bought.
   */
  router.post('/api/bots/runs/:runId/tick', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const deps = runDeps();
    if (!deps) {
      res.status(503).json({ error: 'execution_unavailable', message: 'Bot execution is not enabled.' });
      return;
    }
    try {
      const body = (req.body ?? {}) as { tickKey?: unknown };
      const tickKey = typeof body.tickKey === 'string' && body.tickKey ? body.tickKey : undefined;
      const result = await tickBotRun(deps, req.user!, req.params.runId, tokenFor(req), tickKey);
      res.json({
        run: toRunView(result.run),
        verdict: result.verdict,
        reason: result.reason,
        contractId: result.contractId
      });
    } catch (e) {
      runFail(res, e);
    }
  });

  /**
   * Stops a run. Idempotent: stopping an already-stopped run returns it rather
   * than failing, so a double-click or a retried request is harmless.
   */
  router.post('/api/bots/runs/:runId/stop', requireSession(ctx), async (req: AuthedRequest, res: Response) => {
    const deps = runDeps();
    if (!deps) {
      res.status(503).json({ error: 'execution_unavailable', message: 'Bot execution is not enabled.' });
      return;
    }
    try {
      const run = await stopBotRun(deps, req.user!, req.params.runId, tokenFor(req));
      res.json({ run: toRunView(run) });
    } catch (e) {
      runFail(res, e);
    }
  });

  return router;
}
