import { expireAuth } from './auth';

/**
 * Bot Builder client.
 *
 * Drives the server-side bot runner (`/api/bots/*`), which is the only path that
 * goes through the execution gateway — and therefore the only path that mirrors
 * a manager's entry to connected copy-trading followers. The vendored Deriv Bot
 * app (`/bot`) trades directly on Deriv and never copies; this client exists so
 * the WickSentinel workspace can run a bot *and* have it copy.
 *
 * The browser holds no Deriv token: the session is an HttpOnly cookie.
 */

export type BotCompatibilityLevel = 'full' | 'partial' | 'unsupported' | 'invalid';
export type BotRunRuntimeStatus = 'running' | 'stopped' | 'settling' | 'error';
export type AccountMode = 'demo' | 'real';

export interface ImportedBot {
  id: string;
  name: string;
  status: string;
  compatibility: { level: BotCompatibilityLevel; reason?: string | null };
  symbol: string | null;
  contractType: string | null;
}

export interface BotRunCounters {
  ticks: number;
  signals: number;
  entries: number;
  rejected: number;
  skipped: number;
}

export interface BotRun {
  runId: string;
  botId: string;
  accountId: string;
  accountMode: AccountMode;
  runtimeStatus: BotRunRuntimeStatus;
  counters: BotRunCounters;
  symbol: string | null;
  contractType: string | null;
  startedAt: number;
  stoppedAt: number | null;
  error: string | null;
}

export interface StartRunResult {
  run: BotRun;
  message?: string;
}

export interface TickResult {
  run: BotRun;
  verdict?: string | null;
  reason?: string | null;
  contractId?: number | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) expireAuth();
  if (!res.ok) {
    const message = typeof data?.message === 'string' ? data.message : undefined;
    const error = typeof data?.error === 'string' ? data.error : 'bot_request_failed';
    throw new Error(message ?? error);
  }
  return data as T;
}

export async function listBots(): Promise<ImportedBot[]> {
  const data = await request<{ bots?: ImportedBot[] }>('/api/bots');
  return Array.isArray(data.bots) ? data.bots : [];
}

export async function listBotRuns(): Promise<BotRun[]> {
  const data = await request<{ runs?: BotRun[] }>('/api/bots/runs');
  return Array.isArray(data.runs) ? data.runs : [];
}

export async function startBotRun(
  botId: string,
  accountId: string,
  accountMode: AccountMode
): Promise<StartRunResult> {
  return request<StartRunResult>(`/api/bots/${encodeURIComponent(botId)}/run`, {
    method: 'POST',
    body: JSON.stringify({ accountId, accountMode })
  });
}

export async function tickBotRun(runId: string): Promise<TickResult> {
  return request<TickResult>(`/api/bots/runs/${encodeURIComponent(runId)}/tick`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function stopBotRun(runId: string): Promise<BotRun> {
  const data = await request<{ run?: BotRun }>(`/api/bots/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  if (!data.run) throw new Error('The run could not be stopped.');
  return data.run;
}

/** The saved strategy XML (the original import until edited). */
export async function fetchBotXml(botId: string): Promise<string> {
  const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/export`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/xml' }
  });
  if (res.status === 401) expireAuth();
  if (!res.ok) throw new Error('The strategy XML could not be loaded.');
  return res.text();
}

/** Saves edited strategy XML; the server re-parses before storing. */
export async function saveBotTree(botId: string, xml: string): Promise<{ revision: number }> {
  return request<{ revision: number }>(`/api/bots/${encodeURIComponent(botId)}/tree`, {
    method: 'PUT',
    body: JSON.stringify({ xml })
  });
}

/** Discards saved edits and returns the bot to its imported file. */
export async function revertBot(botId: string): Promise<void> {
  await request(`/api/bots/${encodeURIComponent(botId)}/revert`, { method: 'POST', body: '{}' });
}