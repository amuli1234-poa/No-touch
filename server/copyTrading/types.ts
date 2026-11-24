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
  /* -------------------- administrative lifecycle -------------------- */
  /**
   * Operational status of the connection. `paused` and `suspended` are
   * administrative holds: they are persisted here and are what a copy engine
   * must consult before submitting for this follower. They never cancel
   * contracts that are already open at the broker.
   */
  status?: CopyFollowerStatus;
  pausedAt?: number | null;
  pausedBy?: string | null;
  suspendedAt?: number | null;
  suspendedReason?: string | null;
  /** Optimistic-concurrency guard for administrative transitions. */
  revision?: number;
}

export type CopyFollowerStatus = 'authorized' | 'active' | 'paused' | 'suspended';

/**
 * Explicit client consent to share a Deriv credential with the platform.
 *
 * Recorded when an administrator submits a client-provided API token. The token
 * itself is never stored here — only the fact, time and channel of consent, so
 * the audit trail can prove authorization without holding a secret.
 */
export interface CopyTradingConsentRecord {
  /** The follower connection this consent covers. */
  followerId: string;
  /** WickSentinel user who owns the connection (the master/manager). */
  ownerUserId: string;
  /** How the client's credential reached the platform. */
  method: 'oauth' | 'pat';
  /** Administrator who recorded the consent, when submitted by staff. */
  recordedByAdminId: string | null;
  /** Attribution for who attested the consent (never a token). */
  attestedBy: string;
  consentedAt: number;
  /** Free-form note from the administrator. Redacted before audit storage. */
  note: string | null;
}

export interface CopyTradingInvitationRecord {
  id: string;
  ownerUserId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  /* -------------------- onboarding attribution ---------------------- */
  /** Email the invitation was addressed to, when created for a new client. */
  invitedEmail?: string | null;
  invitedName?: string | null;
  invitedPhone?: string | null;
  note?: string | null;
  /** Administrator who issued the invitation, when created from the console. */
  createdByAdminId?: string | null;
  /** Set once the invited client's Deriv identity is known. */
  acceptedByUserId?: string | null;
  revokedAt?: number | null;
}
