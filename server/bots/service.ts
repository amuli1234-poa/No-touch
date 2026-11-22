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
    bot: record.bot
  };
}
