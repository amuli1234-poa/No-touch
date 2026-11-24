export interface CopyFollowerAccount {
  accountId: string;
  type: 'demo' | 'real';
  currency?: string;
}

export interface CopyFollower {
  id: string;
  loginId: string | null;
  authMethod: 'oauth' | 'pat';
  accounts: CopyFollowerAccount[];
  tokenExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CopyTradingStatus {
  patConfigured: boolean;
}

export interface CopyControl {
  enabled: boolean;
  updatedAt: number | null;
  stoppedReason: string | null;
  followers: { total: number; eligible: number };
}

export interface CopyAccountPerformance {
  followerId: string | null;
  loginId: string | null;
  accountId: string;
  accountMode: 'demo' | 'real';
  currency: string;
  trades: number;
  settledTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  realisedPnl: number;
  staked: number;
  openStake: number;
  lastTradeAt: number | null;
}

export interface CopyPerformance {
  generatedAt: number;
  ownerUserId: string;
  enabled: boolean;
  followers: number;
  totals: {
    accounts: number;
    trades: number;
    settledTrades: number;
    openTrades: number;
    wins: number;
    losses: number;
    realisedPnl: number;
    staked: number;
    openStake: number;
    roiPercent: number | null;
  };
  accounts: CopyAccountPerformance[];
  daily: { date: string; realisedPnl: number; trades: number }[];
}

async function readError(res: Response): Promise<Error> {
  try {
    const body = await res.json();
    return new Error(typeof body?.message === 'string' ? body.message : 'The request could not be completed.');
  } catch {
    return new Error('The request could not be completed.');
  }
}

export async function listCopyFollowers(): Promise<CopyFollower[]> {
  const res = await fetch('/api/copy-trading/followers', { credentials: 'same-origin' });
  if (!res.ok) throw await readError(res);
  const body = await res.json();
  return Array.isArray(body?.followers) ? body.followers as CopyFollower[] : [];
}

export async function fetchCopyTradingStatus(): Promise<CopyTradingStatus> {
  const res = await fetch('/api/copy-trading/status', { credentials: 'same-origin' });
  if (!res.ok) throw await readError(res);
  return await res.json() as CopyTradingStatus;
}

export async function createCopyInvitation(): Promise<{ url: string; expiresAt: number }> {
  const res = await fetch('/api/copy-trading/invitations', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (!res.ok) throw await readError(res);
  return await res.json() as { url: string; expiresAt: number };
}

export async function addCopyFollower(token: string): Promise<CopyFollower> {
  const res = await fetch('/api/copy-trading/followers', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()).follower as CopyFollower;
}

export async function disconnectCopyFollower(id: string): Promise<{ providerRevoked: boolean }> {
  const res = await fetch(`/api/copy-trading/followers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin'
  });
  if (!res.ok) throw await readError(res);
  return await res.json() as { providerRevoked: boolean };
}

export async function fetchCopyControl(): Promise<CopyControl> {
  const res = await fetch('/api/copy-trading/control', { credentials: 'same-origin' });
  if (!res.ok) throw await readError(res);
  return (await res.json()).control as CopyControl;
}

export async function setCopyControl(enabled: boolean): Promise<{ control: CopyControl; note: string }> {
  const res = await fetch('/api/copy-trading/control', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  });
  if (!res.ok) throw await readError(res);
  return await res.json() as { control: CopyControl; note: string };
}

export async function fetchCopyPerformance(days = 30): Promise<CopyPerformance> {
  const res = await fetch(`/api/copy-trading/performance?days=${days}`, { credentials: 'same-origin' });
  if (!res.ok) throw await readError(res);
  return await res.json() as CopyPerformance;
}
