import { useCallback, useEffect, useState } from 'react';

/**
 * Frontend bot-importer client.
 *
 * The browser reads a local file with the FileReader API and posts its text to
 * the server, which owns all parsing and validation. Nothing is parsed in the
 * browser, so a hostile file never reaches an XML parser inside the app, and
 * no bot state is kept in localStorage — the server store is the only source
 * of truth.
 */

export type CompatibilityLevel = 'full' | 'partial' | 'unsupported' | 'invalid';

export interface BotCondition {
  kind: string;
  description: string;
  supported: boolean;
}

export interface BotIndicator {
  kind: string;
  params: Record<string, number | string>;
  summary: string;
}

export interface NormalizedBot {
  name: string;
  sourceFormat: string;
  market: {
    market: string | null;
    submarket: string | null;
    symbol: string | null;
    candleInterval: string | null;
  };
  contract: {
    tradeTypeCategory: string | null;
    tradeType: string | null;
    contractTypes: string[];
  };
  stake: {
    amount: number | null;
    currency: string | null;
    duration: number | null;
    durationUnit: string | null;
  };
  indicators: BotIndicator[];
  entryConditions: BotCondition[];
  exitConditions: BotCondition[];
  blockInventory: { type: string; count: number }[];
  unsupportedBlocks: { type: string; count: number; reason: string }[];
  unknownBlocks: { type: string; count: number }[];
  warnings: { code: string; message: string }[];
  isDbot: boolean;
}

export interface BotWarning {
  code: string;
  message: string;
}

export interface BotPreview {
  compatibility: CompatibilityLevel;
  compatibilityReason: string;
  errors: BotWarning[];
  sourceBytes: number;
  sourceHash: string;
  bot: NormalizedBot | null;
}

export interface BotRecord {
  id: string;
  name: string;
  originalFilename: string;
  sourceFormat: string;
  compatibility: CompatibilityLevel;
  compatibilityReason: string;
  status: 'imported' | 'paused' | 'archived';
  createdAt: number;
  updatedAt: number;
  executionNote: string;
  warnings: BotWarning[];
  bot: NormalizedBot;
}

export interface BotFormats {
  formats: { id: string; label: string; extension: string; maxBytes: number }[];
  supportedBlocks: string[];
  unsupportedBlocks: { type: string; reason: string }[];
  executionEnabled: boolean;
}

/** Error carrying the server's stable code so the UI can react precisely. */
export class BotApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly existingBotId?: string;
  constructor(code: string, message: string, status: number, existingBotId?: string) {
    super(message);
    this.name = 'BotApiError';
    this.code = code;
    this.status = status;
    this.existingBotId = existingBotId;
  }
}

async function parseError(res: Response): Promise<BotApiError> {
  let code = 'request_failed';
  let message = 'The request could not be completed.';
  let existingBotId: string | undefined;
  try {
    const body = await res.json();
    if (typeof body?.error === 'string') code = body.error;
    if (typeof body?.message === 'string') message = body.message;
    if (typeof body?.existingBotId === 'string') existingBotId = body.existingBotId;
  } catch {
    // A non-JSON error body leaves the defaults in place.
  }
  return new BotApiError(code, message, res.status, existingBotId);
}

export async function fetchBotFormats(): Promise<BotFormats> {
  const res = await fetch('/api/bots/formats', { credentials: 'same-origin' });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BotFormats;
}

export async function previewBot(filename: string, content: string): Promise<BotPreview> {
  const res = await fetch('/api/bots/preview', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content })
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BotPreview;
}

export async function confirmImport(
  filename: string,
  content: string
): Promise<{ bot: BotRecord; duplicate: boolean }> {
  const res = await fetch('/api/bots', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content })
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  return { bot: data.bot as BotRecord, duplicate: Boolean(data.duplicate) };
}

export async function listBots(): Promise<BotRecord[]> {
  const res = await fetch('/api/bots', { credentials: 'same-origin' });
  if (res.status === 401) return [];
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  return Array.isArray(data?.bots) ? (data.bots as BotRecord[]) : [];
}

export async function updateBotStatus(id: string, status: BotRecord['status']): Promise<BotRecord> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()).bot as BotRecord;
}

export async function duplicateBot(id: string): Promise<BotRecord> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    credentials: 'same-origin'
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()).bot as BotRecord;
}

export async function deleteBot(id: string): Promise<void> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin'
  });
  if (!res.ok) throw await parseError(res);
}

/** Downloads the original XML exactly as it was imported. */
export function sourceUrl(id: string): string {
  return `/api/bots/${encodeURIComponent(id)}/source`;
}

/**
 * Bot list hook. Keeps one shared fetch per mount and exposes an explicit
 * refresh so the importer can update the manager after a confirmed import.
 */
export function useBots(): {
  bots: BotRecord[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [bots, setBots] = useState<BotRecord[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus((prev) => (prev === 'ready' ? prev : 'loading'));
    try {
      const next = await listBots();
      setBots(next);
      setStatus('ready');
      setError(null);
    } catch (e) {
      setStatus('error');
      setError(e instanceof BotApiError ? e.message : 'The bot list could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { bots, status, error, refresh };
}

/** Human-readable labels for the compatibility levels. */
export const COMPATIBILITY_LABEL: Record<CompatibilityLevel, string> = {
  full: 'Fully supported',
  partial: 'Partially supported',
  unsupported: 'Unsupported',
  invalid: 'Invalid'
};

export const COMPATIBILITY_STYLE: Record<CompatibilityLevel, string> = {
  full: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  partial: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  unsupported: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  invalid: 'bg-rose-500/10 text-rose-400 border-rose-500/30'
};
