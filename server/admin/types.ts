import type { Role } from './permissions.js';

/** Administrative user account. Passwords are never stored in plaintext. */
export interface AdminUserRecord {
  id: string;
  email: string;
  displayName: string;
  /** scrypt hash, encoded as `scrypt$N$r$p$salt$hash` (base64url). */
  passwordHash: string;
  role: Role;
  /** Explicit extra permission grants on top of the role bundle. */
  extraPermissions: string[];
  status: 'active' | 'suspended' | 'invited';
  /** TOTP enrolment. `secret` is sealed; only present once enrolled. */
  mfa: {
    enrolled: boolean;
    secretSealed: string | null;
    enrolledAt: number | null;
    /** One-time recovery codes (hashed). */
    recoveryCodeHashes: string[];
  };
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  createdBy: string | null;
}

/** Server-side admin session. Distinct cookie + signing context from trader sessions. */
export interface AdminSessionRecord {
  id: string;
  adminId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revoked: boolean;
  /** True between password success and MFA verification. */
  mfaPending: boolean;
  /** Double-submit CSRF token for state-changing admin requests. */
  csrfToken: string;
  ip: string | null;
  userAgent: string | null;
}

export interface AdminInvitationRecord {
  id: string;
  email: string;
  role: Role;
  extraPermissions: string[];
  /** SHA-256 of the one-time activation token; the token itself is never stored. */
  tokenHash: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface AdminPasswordResetRecord {
  id: string;
  adminId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

/** Append-only administrative audit record. Never updated or deleted by the app. */
export interface AuditRecord {
  id: string;
  /** UTC epoch milliseconds. */
  timestamp: number;
  actorAdminId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  previousState: unknown;
  newState: unknown;
  reason: string | null;
  correlationId: string;
  sourceIp: string | null;
  metadata: Record<string, unknown>;
}

export interface SupportTicketRecord {
  id: string;
  subject: string;
  description: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'waiting_for_user' | 'resolved' | 'closed';
  /** Trader user id (u_...) when the ticket is tied to a user. */
  userId: string | null;
  requesterRef: string | null;
  assignedAdminId: string | null;
  createdAt: number;
  updatedAt: number;
  createdByAdminId: string | null;
}

export interface SupportTicketMessageRecord {
  id: string;
  ticketId: string;
  /** Internal notes are never returned through user-facing APIs. */
  internal: boolean;
  body: string;
  authorAdminId: string | null;
  authorKind: 'admin' | 'user' | 'system';
  createdAt: number;
}

export interface AnnouncementRecord {
  id: string;
  title: string;
  body: string;
  kind: 'platform' | 'maintenance' | 'feature' | 'subscription';
  audience: 'all' | 'subscribers' | 'free';
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  publishAt: number | null;
  publishedAt: number | null;
  publishedBy: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface FeatureFlagRecord {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  /** Ordinary product config only — never a trading risk control. */
  updatedBy: string | null;
  updatedAt: number;
}

export interface AdminNoteRecord {
  id: string;
  userId: string;
  body: string;
  authorAdminId: string;
  createdAt: number;
}

/** Platform configuration. Separate namespace from trading risk controls. */
export interface PlatformConfigRecord {
  maintenanceMode: boolean;
  registrationOpen: boolean;
  supportEmail: string | null;
  updatedBy: string | null;
  updatedAt: number;
}
