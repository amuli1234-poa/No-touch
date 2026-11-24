import type { DerivAccountRef } from '../store/store.js';

/** A follower's Deriv authorization is always sealed at rest. */
export interface CopyTradingFollowerRecord {
  id: string;
  ownerUserId: string;
  derivSub: string;
  authMethod: 'oauth' | 'pat';
  loginId?: string;
  accounts: DerivAccountRef[];
  tokenSealed: string;
  tokenExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CopyTradingInvitationRecord {
  id: string;
  ownerUserId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}
