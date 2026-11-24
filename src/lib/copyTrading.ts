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
