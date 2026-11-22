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
import { collectUnknownBlocks } from './tree.js';
import { MAX_BOT_FILE_BYTES } from './parser.js';
import { supportedBlockTypes, unsupportedBlockTypes } from './blocks.js';

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

export function createBotsRouter(ctx: SessionContext, store: Store): Router {
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
      executionEnabled: false
    });
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

  return router;
}
