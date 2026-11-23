import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BotRunRecord as ServerBotRunRecord,
  JsonValue,
  PendingDeferral as ServerPendingDeferral
} from '../../server/bots/runTypes';

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
  /** True once the user has saved edits in the block editor. */
  edited: boolean;
  /** Revision of the edited strategy; 0 for a never-edited bot. */
  revision: number;
  editedAt?: number;
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
  if (code !== 'request_failed') message = `${message} (${code}, HTTP ${res.status})`;
  else if (res.status) message = `${message} (HTTP ${res.status})`;
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

/** Downloads the saved strategy: the edited XML when present, else the original. */
export function exportUrl(id: string): string {
  return `/api/bots/${encodeURIComponent(id)}/export`;
}

/* -------------------------------------------------------------------------- */
/*  Markets and compatibility                                                  */
/* -------------------------------------------------------------------------- */

export interface BotMarketCategory {
  key: string;
  label: string;
}

export interface BotMarketSymbol {
  symbol: string;
  displayName: string;
  category: string;
  categoryLabel: string;
  submarket: string;
  pipSize: number;
  available: boolean;
  unavailableReason: string | null;
}

export interface BotMarketCatalog {
  categories: BotMarketCategory[];
  symbols: BotMarketSymbol[];
  fetchedAt: number;
}

/**
 * Verdict vocabulary of the live availability check.
 *
 * Distinct from `CompatibilityLevel`, which describes how much of an imported
 * file this build understands. This one answers a narrower question: can this
 * strategy trade this symbol right now.
 */
export type BotCompatibilityState =
  | 'compatible'
  | 'incompatible'
  | 'unsupported'
  | 'unavailable'
  | 'invalid';

export interface BotCompatibility {
  botId: string;
  symbol: string;
  contractType?: string;
  contractFamily?: string;
  digit?: number | null;
  barrier?: string | null;
  state?: BotCompatibilityState;
  reason?: string;
  details?: string[];
  availableContracts?: string[];
  [key: string]: unknown;
}

/** The Synthetic catalogue Deriv currently publishes, discovered live. */
export async function fetchBotMarkets(): Promise<BotMarketCatalog> {
  const res = await fetch('/api/bots/markets', { credentials: 'same-origin' });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BotMarketCatalog;
}

/**
 * Whether a stored bot can run on a symbol. Omitting `symbol` asks about the
 * symbol the strategy itself names.
 */
export async function fetchBotCompatibility(
  id: string,
  symbol?: string
): Promise<BotCompatibility> {
  const query = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/compatibility${query}`, {
    credentials: 'same-origin'
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BotCompatibility;
}

/* -------------------------------------------------------------------------- */
/*  Block editor                                                               */
/* -------------------------------------------------------------------------- */

export interface BotTreeField {
  name: string;
  value: string;
}

export interface BotTreeInput {
  name: string;
  kind: 'value' | 'statement';
  block: BotTreeNode | null;
  shadow?: { type: string; fields: BotTreeField[] };
}

export interface BotTreeNode {
  type: string;
  id?: string;
  shadow?: boolean;
  unknown?: boolean;
  attrs?: Record<string, string>;
  fields: BotTreeField[];
  inputs: BotTreeInput[];
  shadows: { name: string; type: string; fields: BotTreeField[] }[];
  mutation?: Record<string, string>;
  next: BotTreeNode | null;
}

export interface BotTree {
  attrs: Record<string, string>;
  variables: { id: string; name: string; type?: string }[];
  blocks: BotTreeNode[];
}

export interface BotEditorPayload {
  botId: string;
  name: string;
  edited: boolean;
  revision: number;
  /** The XML to render. Blockly reads this directly. */
  xml: string;
  tree: BotTree;
  /** Block types this build cannot interpret, for placeholder definitions. */
  unknownBlocks: {
    type: string;
    shape: 'stack' | 'value';
    fields: { name: string }[];
    inputs: { name: string; kind: 'value' | 'statement' }[];
  }[];
  executionEligibility?: {
    runnable: boolean;
    reasons: string[];
    unsupported: string[];
  };
  compatibility: CompatibilityLevel;
  compatibilityReason: string;
  status: BotRecord['status'];
}

export async function fetchBotTree(id: string): Promise<BotEditorPayload> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/tree`, {
    credentials: 'same-origin'
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as BotEditorPayload;
}

export async function saveBotTree(
  id: string,
  xml: string
): Promise<{ bot: BotRecord; changed: boolean; revision: number }> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/tree`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml })
  });
  if (!res.ok) throw await parseError(res);
  const data = await res.json();
  return {
    bot: data.bot as BotRecord,
    changed: Boolean(data.changed),
    revision: Number(data.revision ?? 0)
  };
}

/** Discards saved edits and restores the bot's imported strategy. */
export async function revertBot(id: string): Promise<BotRecord> {
  const res = await fetch(`/api/bots/${encodeURIComponent(id)}/revert`, {
    method: 'POST',
    credentials: 'same-origin'
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()).bot as BotRecord;
}

/* ------------------------------- execution -------------------------------- */

export type BotRunStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface BotRunEvent {
  at: number;
  kind: string;
  detail: string;
  signalId?: string;
  intentId?: string;
  contractId?: number;
}

export interface BotRunCounters {
  ticks: number;
  signals: number;
  entries: number;
  rejected: number;
  skipped: number;
}

/** Work a `timeout` block deferred, waiting for its delay to elapse. */
export type BotPendingDeferral = ServerPendingDeferral;

export interface BotRun {
  runId: string;
  botId: string;
  userId: string;
  accountId: string;
  accountMode: 'demo';
  runtimeStatus: BotRunStatus;
  startedAt: number;
  stoppedAt: number | null;
  lastEvaluationAt: number | null;
  lastExecutionId: string | null;
  lastContractId: number | null;
  error: string | null;
  counters: BotRunCounters;
  events: BotRunEvent[];
  maxEntries: number;
  strategyRevision: number;
  symbol: string;
  timeframe: string;
  /**
   * Interpreter variables for this run, keyed by Blockly variable id (or name
   * when the export omits ids). The server sends this on every run view; it is
   * declared here so the Variables panel can show real state rather than a
   * placeholder.
   */
  variables: Record<string, JsonValue>;
  /** Work a `timeout` deferred, or null when nothing is waiting. */
  pendingDeferral: BotPendingDeferral | null;
  /** Contract whose `after_purchase` stack has already run. */
  afterPurchaseFor: number | null;
  /** Contract Deriv has refused to sell, and why. */
  sellRefusedFor: number | null;
  sellRefusedReason: string | null;
  /** Idempotency key and timestamp of the most recent accepted tick. */
  lastTickKey: string | null;
  lastTickAt: number | null;
}

/**
 * Compile-time guard: the client view must stay assignable from the server
 * record. `src/lib/bots.ts` used to declare a subset of what
 * `server/bots/runTypes.ts` sends, so panels showing interpreter state had no
 * declared field to read. If the server adds a field the client needs, this
 * fails to compile rather than silently dropping it at runtime.
 */
type _BotRunMatchesServer = BotRun extends ServerBotRunRecord ? true : never;
const _botRunShape: _BotRunMatchesServer = true;
void _botRunShape;

export type BotRunVerdict = 'entry' | 'no_entry' | 'insufficient' | 'ineligible' | 'skipped' | 'stopped';

export interface StartRunResult {
  run: BotRun;
  /** True while ticking is driven by this browser tab. */
  sessionDependent: boolean;
  idleTimeoutMs: number;
}

export async function startBotRun(
  botId: string,
  accountId: string,
  maxEntries?: number
): Promise<StartRunResult> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/run`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, maxEntries })
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as StartRunResult;
}

export async function tickBotRun(
  runId: string,
  tickKey: string
): Promise<{ run: BotRun; verdict: BotRunVerdict; reason: string | null; contractId: number | null }> {
  const res = await fetch(`/api/bots/runs/${encodeURIComponent(runId)}/tick`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickKey })
  });
  if (!res.ok) throw await parseError(res);
  return await res.json();
}

export async function stopBotRun(runId: string): Promise<BotRun> {
  const res = await fetch(`/api/bots/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    credentials: 'same-origin'
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()).run as BotRun;
}

export async function fetchActiveRun(botId: string): Promise<BotRun | null> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/run`, {
    credentials: 'same-origin'
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()).run as BotRun | null;
}

/**
 * Drives a bot run from the browser.
 *
 * Ticking is browser-driven on purpose — it is a disclosed limitation, not an
 * accident. Each tick is a separate authenticated request that re-proves
 * ownership server-side, so the loop is a convenience rather than a source of
 * authority. Closing the tab stops the bot, which is the honest behaviour for a
 * demo tool; the UI says so.
 *
 * The hook never retries a failed tick automatically: a rejected tick usually
 * means the run ended (stopped, failed, kill switch), and retrying would spin.
 */
export function useBotRun(botId: string | null, intervalMs = 4000) {
  const [run, setRun] = useState<BotRun | null>(null);
  const [error, setError] = useState<BotApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastVerdict, setLastVerdict] = useState<BotRunVerdict | null>(null);
  const timer = useRef<number | null>(null);
  const tickCounter = useRef(0);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const tick = useCallback(
    async (runId: string) => {
      tickCounter.current += 1;
      try {
        const result = await tickBotRun(runId, `${runId}:${tickCounter.current}`);
        setRun(result.run);
        setLastVerdict(result.verdict);
        // The server settles the run itself on failure or on reaching its entry
        // ceiling; stop the loop rather than polling a dead run.
        if (result.run.runtimeStatus !== 'running') clear();
      } catch (e) {
        clear();
        setError(e instanceof BotApiError ? e : new BotApiError('tick_failed', 'The bot could not tick.', 0));
      }
    },
    [clear]
  );

  const start = useCallback(
    async (accountId: string, maxEntries?: number) => {
      if (!botId) return;
      setBusy(true);
      setError(null);
      try {
        const started = await startBotRun(botId, accountId, maxEntries);
        setRun(started.run);
        setLastVerdict(null);
        clear();
        tickCounter.current = 0;
        timer.current = window.setInterval(() => {
          void tick(started.run.runId);
        }, intervalMs);
      } catch (e) {
        setError(e instanceof BotApiError ? e : new BotApiError('start_failed', 'The bot could not start.', 0));
      } finally {
        setBusy(false);
      }
    },
    [botId, clear, intervalMs, tick]
  );

  const stop = useCallback(async () => {
    if (!run) return;
    setBusy(true);
    // Stop the local loop first: a tick must not race the stop request.
    clear();
    try {
      const stopped = await stopBotRun(run.runId);
      setRun(stopped);
    } catch (e) {
      setError(e instanceof BotApiError ? e : new BotApiError('stop_failed', 'The bot could not stop.', 0));
    } finally {
      setBusy(false);
    }
  }, [clear, run]);

  // Restore an in-flight run when the editor mounts, so a refresh does not
  // silently abandon a run the customer started.
  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    void (async () => {
      try {
        const active = await fetchActiveRun(botId);
        if (cancelled || !active) return;
        setRun(active);
        if (active.runtimeStatus === 'running') {
          timer.current = window.setInterval(() => {
            void tick(active.runId);
          }, intervalMs);
        }
      } catch {
        // A missing runtime (import-only build) is not an error worth showing.
      }
    })();
    return () => {
      cancelled = true;
      clear();
    };
  }, [botId, clear, intervalMs, tick]);

  return { run, error, busy, lastVerdict, start, stop };
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
