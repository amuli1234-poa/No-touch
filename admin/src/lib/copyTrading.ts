import { api, qs } from './api';

/**
 * Typed client for the Copy Trading administration endpoints.
 *
 * A Deriv token is passed straight through to the server inside the POST body
 * and is never retained by this module, placed in component state by the caller,
 * or written to storage. `api` sends it over the credentialed same-origin fetch.
 */

export type CopyFollowerStatus = 'authorized' | 'active' | 'paused' | 'suspended';

export interface AdminCopyClient {
  id: string;
  client: { loginId: string | null; derivAccountMasked: string | null; userId: string | null };
  master: { userId: string; loginId: string | null } | null;
  authMethod: 'oauth' | 'pat';
  accountType: 'demo' | 'real';
  currency: string | null;
  accounts: { accountId: string; type: string; currency: string | null; status: string | null }[];
  status: CopyFollowerStatus;
  pausedAt: number | null;
  suspendedAt: number | null;
  suspendedReason: string | null;
  connection: { authorizationExpiresAt: number | null; authorizationExpired: boolean };
  consent: { recordedAt: number; method: string; attestedBy: string } | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface AdminCopyClientPage {
  items: AdminCopyClient[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts?: { total: number; pendingInvitations: number };
}

export interface AdminInvitation {
  id: string;
  invitedEmail: string | null;
  invitedName: string | null;
  invitedPhone: string | null;
  note: string | null;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  master: { userId: string; loginId: string | null } | null;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface AdminMaster {
  userId: string;
  loginId: string | null;
  accountCount: number;
  demoAccounts: number;
  realAccounts: number;
  clients: number;
}

export interface UserSearchRow {
  id: string;
  loginId: string | null;
  createdAt: number;
  suspended: boolean;
  accountCount: number;
  hasFollowerConnection: boolean;
  followerStatus: CopyFollowerStatus | null;
}

export interface ClientProfile {
  user: {
    id: string;
    loginId: string | null;
    createdAt: number;
    suspended: boolean;
    accounts: { accountId: string; type: string; currency: string | null }[];
  };
  connection: AdminCopyClient | null;
  checks: {
    hasConnection: boolean;
    hasDemoAccount: boolean;
    authorizationUsable: boolean;
    consentRecorded: boolean;
    duplicateAssignment: boolean;
    userSuspended: boolean;
  };
}

export interface RiskProfileView {
  ownerUserId: string;
  profile: Record<string, unknown> | null;
  configured: boolean;
  unavailable?: string;
}

/** One client account's live balance, read from Deriv with the client credential. */
export interface ClientBalanceAccount {
  accountId: string;
  mode: 'demo' | 'real';
  currency: string | null;
  /** Null unless state is 'ok' or 'stale'. Never a fabricated 0. */
  balance: number | null;
  state: 'ok' | 'unavailable' | 'stale' | 'disconnected';
  lastUpdated: number | null;
  reason?: string;
}

export interface ClientBalanceView {
  followerId: string;
  accounts: ClientBalanceAccount[];
  available: boolean;
  reason?: string;
  note?: string;
  fetchedAt?: number;
}

export const copyTradingApi = {
  listClients: (query: string) => api.get<AdminCopyClientPage>(`/copy-trading/clients${query}`),
  listInvitations: () => api.get<{ items: AdminInvitation[]; pending: number; total: number }>('/copy-trading/invitations'),
  listMasters: () => api.get<{ items: AdminMaster[] }>('/copy-trading/masters'),
  searchUsers: (query: string) => api.get<{ items: UserSearchRow[]; hint?: string }>(`/copy-trading/clients/search${query}`),
  profile: (userId: string) => api.get<ClientProfile>(`/copy-trading/clients/${encodeURIComponent(userId)}/profile`),

  invite: (body: {
    email: string;
    name?: string;
    phone?: string;
    note?: string;
    masterUserId: string;
  }) => api.post<{ invitation: AdminInvitation; url: string }>('/copy-trading/clients/invitations', body),

  revokeInvitation: (id: string) => api.post<{ invitation: AdminInvitation }>(`/copy-trading/invitations/${encodeURIComponent(id)}/revoke`, {}),

  /** The token is sent once, in the body, and never stored client-side. */
  authorizeToken: (
    userId: string,
    body: { token: string; consent: true; masterUserId: string; attestedBy?: string; consentNote?: string }
  ) =>
    api.post<{ client: AdminCopyClient; ignoredRealAccounts: number }>(
      `/copy-trading/clients/${encodeURIComponent(userId)}/authorize-token`,
      body
    ),

  authorizeOauth: (userId: string, body: { masterUserId: string }) =>
    api.post<{ invitation: AdminInvitation; url: string }>(
      `/copy-trading/clients/${encodeURIComponent(userId)}/authorize-oauth`,
      body
    ),

  setStatus: (id: string, status: 'active' | 'paused' | 'suspended', reason?: string) =>
    api.post<{ client: AdminCopyClient; note: string }>(`/copy-trading/clients/${encodeURIComponent(id)}/status`, { status, reason }),

  remove: (id: string) =>
    api.del<{ removed: boolean; providerRevoked: boolean; note: string }>(`/copy-trading/clients/${encodeURIComponent(id)}`),

  risk: (id: string) => api.get<RiskProfileView>(`/copy-trading/clients/${encodeURIComponent(id)}/risk`),

  balance: (id: string, refresh = false) =>
    api.get<ClientBalanceView>(
      `/copy-trading/clients/${encodeURIComponent(id)}/balance${refresh ? '?refresh=1' : ''}`
    )
};

export interface CopyControlView {
  ownerUserId: string;
  master: { userId: string; loginId: string | null } | null;
  enabled: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  updatedByEmail: string | null;
  stoppedReason: string | null;
  followers: { total: number; eligible: number; held: number };
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

export const copyControlApi = {
  get: (masterUserId: string) =>
    api.get<{ control: CopyControlView }>(`/copy-trading/control${qs({ masterUserId })}`),
  list: () => api.get<{ items: CopyControlView[] }>('/copy-trading/control'),
  set: (body: { masterUserId: string; enabled: boolean; reason?: string }) =>
    api.post<{ control: CopyControlView; note: string }>('/copy-trading/control', body),
  performance: (masterUserId: string, days = 30) =>
    api.get<CopyPerformance>(`/copy-trading/performance${qs({ masterUserId, days })}`)
};
