/**
 * Bot import service.
 *
 * Owns the rules that sit between an uploaded file and a stored record:
 * extension and size checks, parsing, duplicate detection and the small
 * lifecycle transitions the manager exposes.
 *
 * This service has no execution capability and imports no execution module.
 * An imported bot is inert data; nothing here can place a trade, and the
 * records it writes are never read by the execution gateway.
 */

import { randomUUID } from 'node:crypto';

import type { Store } from '../store/store.js';
import { analyzeDbotXml, MAX_BOT_FILE_BYTES } from './parser.js';
import { isKnownBlock } from './blocks.js';
import { annotateUnknown, treeToXml, xmlToTree, type BlockTree } from './tree.js';
import type { BotAnalysis, BotWarning, ImportedBotRecord } from './types.js';

/** The only extension accepted in this phase. */
export const ACCEPTED_EXTENSION = '.xml';

export type ImportErrorCode =
  | 'empty_body'
  | 'missing_filename'
  | 'wrong_extension'
  | 'file_too_large'
  | 'not_text'
  | 'parse_failed'
  | 'duplicate'
  | 'not_found'
  | 'invalid_transition';

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly status: number;
  /** Present when the failure is a duplicate, so the UI can link to the bot. */
  readonly existingBotId?: string;
  constructor(code: ImportErrorCode, message: string, status = 400, existingBotId?: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.status = status;
    this.existingBotId = existingBotId;
  }
}

/** Structural validation of the upload, before any XML is parsed. */
export function validateUpload(filename: unknown, content: unknown): { filename: string; content: string } {
  if (typeof filename !== 'string' || filename.trim().length === 0) {
    throw new ImportError('missing_filename', 'A filename is required.', 400);
  }
  const trimmedName = filename.trim();
  if (!trimmedName.toLowerCase().endsWith(ACCEPTED_EXTENSION)) {
    throw new ImportError(
      'wrong_extension',
      `Only ${ACCEPTED_EXTENSION} files exported from Deriv DBot can be imported.`,
      415
    );
  }
  if (typeof content !== 'string') {
    throw new ImportError('not_text', 'The uploaded file could not be read as text.', 400);
  }
  if (content.length === 0) {
    throw new ImportError('empty_body', 'The selected file is empty.', 400);
  }
  // Measure bytes, not characters: a multi-byte file must be judged by its
  // real size against the same limit the parser enforces.
  if (Buffer.byteLength(content, 'utf8') > MAX_BOT_FILE_BYTES) {
    throw new ImportError(
      'file_too_large',
      `The file exceeds the ${MAX_BOT_FILE_BYTES / 1024} KB import limit.`,
      413
    );
  }
  return { filename: trimmedName, content };
}

export interface ImportResult {
  record: ImportedBotRecord;
  /** True when an identical bot already existed and this call did not store it. */
  duplicate: boolean;
  analysis: BotAnalysis;
}

/**
 * Analyzes an upload without storing anything. Used by the preview step so the
 * user can inspect compatibility before confirming.
 */
export function previewUpload(filename: unknown, content: unknown): BotAnalysis {
  const upload = validateUpload(filename, content);
  return analyzeDbotXml(upload.content, { filename: upload.filename });
}

/**
 * Stores a previously analyzed upload.
 *
 * Duplicate detection is by content hash within the same tenant: re-importing
 * a file the user already has returns the existing bot rather than creating a
 * second copy.
 */
export async function importBot(
  store: Store,
  userId: string,
  filename: unknown,
  content: unknown
): Promise<ImportResult> {
  const upload = validateUpload(filename, content);
  const analysis = analyzeDbotXml(upload.content, { filename: upload.filename });

  if (analysis.compatibility === 'invalid' || !analysis.bot) {
    throw new ImportError(
      'parse_failed',
      analysis.compatibilityReason || 'The file is not a valid Deriv DBot strategy.',
      422
    );
  }

  const existing = store.findImportedBotByHash(userId, analysis.sourceHash);
  if (existing) {
    return { record: existing, duplicate: true, analysis };
  }

  const now = Date.now();
  const record: ImportedBotRecord = {
    id: randomUUID(),
    userId,
    name: analysis.bot.name,
    sourceFormat: 'deriv-dbot-xml',
    originalFilename: upload.filename,
    sourceHash: analysis.sourceHash,
    sourceXml: upload.content,
    compatibility: analysis.compatibility,
    compatibilityReason: analysis.compatibilityReason,
    status: 'imported',
    createdAt: now,
    updatedAt: now,
    bot: analysis.bot,
    warnings: [...analysis.errors, ...analysis.bot.warnings],
    executionNote:
      'Imported for reference only. This bot has not been authorised to execute, and REAL execution is disabled.'
  };

  await store.putImportedBot(record);
  return { record, duplicate: false, analysis };
}

/**
 * Loads a bot's editable block tree.
 *
 * The tree is built from `workingXml` when the user has saved edits, and from
 * the imported file otherwise. Parsing lives here, on the server, so the
 * browser never has to agree with a second XML implementation.
 */
export function loadBotTree(record: ImportedBotRecord): {
  tree: BlockTree;
  xml: string;
  edited: boolean;
  revision: number;
} {
  const xml = record.workingXml ?? record.sourceXml;
  const tree = annotateUnknown(xmlToTree(xml), isKnownBlock);
  return {
    tree,
    xml,
    edited: typeof record.workingXml === 'string',
    revision: record.revision ?? 0
  };
}

/**
 * Compatibility for a stored bot, re-derived from its current XML.
 *
 * `ImportedBotRecord.compatibility` is a snapshot taken when the bot was
 * imported or last saved. The set of blocks this build interprets grows between
 * releases, so a snapshot can say `partial` for a block that has since gained an
 * interpreter — while the live execution plan for the same XML says `runnable`.
 * Deriving it on read keeps the two verdicts consistent. Unreadable XML yields
 * `invalid` from the analyser itself, so there is no stale value to fall back to.
 */
export function botCompatibility(record: ImportedBotRecord): {
  compatibility: ImportedBotRecord['compatibility'];
  reason: string;
} {
  const xml = record.workingXml ?? record.sourceXml;
  const analysis = analyzeDbotXml(xml, { filename: record.originalFilename });
  return { compatibility: analysis.compatibility, reason: analysis.compatibilityReason };
}

export interface SaveBotTreeResult {
  record: ImportedBotRecord;
  changed: boolean;
  revision: number;
}

/**
 * Saves an edited strategy.
 *
 * The XML is re-parsed before it is stored: whatever the browser sent, the
 * record only ever holds XML the server has itself validated. Saving the
 * strategy the bot already had is a no-op rather than a new revision, so a
 * stray change event cannot inflate the revision count.
 */
export async function saveBotTree(
  store: Store,
  userId: string,
  id: string,
  xml: unknown
): Promise<SaveBotTreeResult> {
  const record = store.getImportedBot(userId, id);
  if (!record) {
    throw new ImportError('not_found', 'Bot not found.', 404);
  }
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new ImportError('empty_body', 'The strategy is empty.', 400);
  }
  if (Buffer.byteLength(xml, 'utf8') > MAX_BOT_FILE_BYTES) {
    throw new ImportError('file_too_large', 'The strategy is too large to save.', 413);
  }

  // Authoritative validation: the stored XML must parse and must still be a
  // strategy. An edit that breaks the structure is rejected, not stored.
  let tree: BlockTree;
  try {
    tree = xmlToTree(xml);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The strategy could not be read.';
    throw new ImportError('parse_failed', message, 422);
  }
  if (tree.blocks.length === 0) {
    throw new ImportError('parse_failed', 'The strategy contains no blocks.', 422);
  }

  const canonical = treeToXml(tree);
  const current = record.workingXml ?? record.sourceXml;
  if (canonical === treeToXml(xmlToTree(current))) {
    return { record, changed: false, revision: record.revision ?? 0 };
  }

  // Re-run the normal analysis so compatibility, warnings and the normalised
  // summary describe the edited strategy rather than the imported one.
  const analysis = analyzeDbotXml(canonical, { filename: record.originalFilename });
  const now = Date.now();
  const updated: ImportedBotRecord = {
    ...record,
    workingXml: canonical,
    revision: (record.revision ?? 0) + 1,
    editedAt: now,
    updatedAt: now,
    ...(analysis.bot
      ? {
          bot: analysis.bot,
          compatibility: analysis.compatibility,
          compatibilityReason: analysis.compatibilityReason,
          warnings: [...analysis.errors, ...analysis.bot.warnings]
        }
      : {})
  };
  await store.putImportedBot(updated);
  return { record: updated, changed: true, revision: updated.revision ?? 0 };
}

/** Allowed manager transitions. Anything else is rejected rather than guessed. */
const TRANSITIONS: Record<ImportedBotRecord['status'], ImportedBotRecord['status'][]> = {
  imported: ['paused', 'archived'],
  paused: ['imported', 'archived'],
  archived: ['imported']
};

export async function setBotStatus(
  store: Store,
  userId: string,
  id: string,
  status: unknown
): Promise<ImportedBotRecord> {
  const bot = store.getImportedBot(userId, id);
  if (!bot) throw new ImportError('not_found', 'Bot not found.', 404);

  if (status !== 'imported' && status !== 'paused' && status !== 'archived') {
    throw new ImportError('invalid_transition', 'Unknown bot status.', 400);
  }
  if (!TRANSITIONS[bot.status].includes(status)) {
    throw new ImportError(
      'invalid_transition',
      `Cannot move a bot from "${bot.status}" to "${status}".`,
      409
    );
  }

  const next: ImportedBotRecord = { ...bot, status, updatedAt: Date.now() };
  await store.putImportedBot(next);
  return next;
}

/** Copies a bot for the same user under a new id, so the original is untouched. */
export async function duplicateBot(
  store: Store,
  userId: string,
  id: string
): Promise<ImportedBotRecord> {
  const bot = store.getImportedBot(userId, id);
  if (!bot) throw new ImportError('not_found', 'Bot not found.', 404);

  const now = Date.now();
  const copy: ImportedBotRecord = {
    ...bot,
    id: randomUUID(),
    name: `${bot.name} (copy)`,
    status: 'imported',
    createdAt: now,
    updatedAt: now,
    // A copy is a distinct record but shares the original's source hash, so
    // duplicate detection is deliberately not applied here.
    bot: { ...bot.bot, name: `${bot.bot.name} (copy)` },
    warnings: bot.warnings
  };
  await store.putImportedBot(copy);
  return copy;
}

export async function archiveBot(store: Store, userId: string, id: string): Promise<ImportedBotRecord> {
  return setBotStatus(store, userId, id, 'archived');
}

export async function deleteBot(store: Store, userId: string, id: string): Promise<void> {
  const ok = await store.deleteImportedBot(userId, id);
  if (!ok) throw new ImportError('not_found', 'Bot not found.', 404);
}

/** A stored bot plus its warnings, shaped for the client. */
export interface BotView {
  id: string;
  name: string;
  originalFilename: string;
  sourceFormat: string;
  compatibility: ImportedBotRecord['compatibility'];
  compatibilityReason: string;
  status: ImportedBotRecord['status'];
  createdAt: number;
  updatedAt: number;
  executionNote: string;
  warnings: BotWarning[];
  bot: ImportedBotRecord['bot'];
  /** True once the user has saved edits in the block editor. */
  edited: boolean;
  /** Revision of the edited strategy; 0 for a never-edited bot. */
  revision: number;
  editedAt?: number;
}

export function toView(record: ImportedBotRecord): BotView {
  return {
    id: record.id,
    name: record.name,
    originalFilename: record.originalFilename,
    sourceFormat: record.sourceFormat,
    compatibility: record.compatibility,
    compatibilityReason: record.compatibilityReason,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    executionNote: record.executionNote,
    warnings: record.warnings,
    bot: record.bot,
    edited: typeof record.workingXml === 'string',
    revision: record.revision ?? 0,
    ...(record.editedAt !== undefined ? { editedAt: record.editedAt } : {})
  };
}
