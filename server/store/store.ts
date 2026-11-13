import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  AdminUserRecord,
  AdminSessionRecord,
  AdminInvitationRecord,
  AdminPasswordResetRecord,
  AuditRecord,
  SupportTicketRecord,
  SupportTicketMessageRecord,
  AnnouncementRecord,
  FeatureFlagRecord,
  AdminNoteRecord,
  PlatformConfigRecord
} from '../admin/types.js';

/**
 * Minimal durable store backed by a single JSON file.
 *
 * The existing project had no database, so nothing is replaced here — this is
 * additive. It holds three collections: users (keyed by a stable Deriv
 * identity), server-side sessions, and one-time OAuth transactions. Writes are
 * serialised through a promise chain and flushed atomically (write + rename).
 */

export interface DerivAccountRef {
  accountId: string;
  type: 'demo' | 'real';
  currency?: string;
  status?: string;
}

export interface UserRecord {
  /** Stable internal id. Derived from the Deriv OIDC `sub`, never a display name. */
  id: string;
  /** The verified Deriv identity subject ("sub" claim). */
  derivSub: string;
  /** Optional non-identifying login id for display only. */
  loginId?: string;
  accounts: DerivAccountRef[];
  createdAt: number;
  updatedAt: number;
  /**
   * Administrative suspension. Enforced by the existing session/authorization
   * path (see `requireSession`), not merely by a status label in a UI.
   */
  suspended?: boolean;
  suspendedAt?: number | null;
  suspendedReason?: string | null;
  /** Scanner/preference blob owned by this user; never shared across users. */
  preferences: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  /** True once Deriv authorization has been revoked or a logout has occurred. */
  revoked: boolean;
  /** AES-256-GCM sealed Deriv access token; never sent to the browser. */
  derivTokenSealed: string;
  /** Expiry of the Deriv access token. */
  derivTokenExpiresAt: number;
  /** Verified Deriv identity subject bound to this session. */
  derivSub: string;
}

export interface OAuthTransaction {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  mode: 'login' | 'signup';
  createdAt: number;
  /** Set when the transaction is used, so a duplicate callback cannot replay it. */
  consumedAt: number | null;
}

interface Database {
  users: Record<string, UserRecord>;
  sessions: Record<string, SessionRecord>;
  oauthTransactions: Record<string, OAuthTransaction>;
  /* ----------------------- additive: admin domain ----------------------- */
  adminUsers: Record<string, AdminUserRecord>;
  adminSessions: Record<string, AdminSessionRecord>;
  adminInvitations: Record<string, AdminInvitationRecord>;
  adminPasswordResets: Record<string, AdminPasswordResetRecord>;
  auditLogs: AuditRecord[];
  supportTickets: Record<string, SupportTicketRecord>;
  supportTicketMessages: Record<string, SupportTicketMessageRecord>;
  announcements: Record<string, AnnouncementRecord>;
  featureFlags: Record<string, FeatureFlagRecord>;
  adminNotes: Record<string, AdminNoteRecord>;
  platformConfig: PlatformConfigRecord;
}

const EMPTY: Database = {
  users: {},
  sessions: {},
  oauthTransactions: {},
  adminUsers: {},
  adminSessions: {},
  adminInvitations: {},
  adminPasswordResets: {},
  auditLogs: [],
  supportTickets: {},
  supportTicketMessages: {},
  announcements: {},
  featureFlags: {},
  adminNotes: {},
  platformConfig: { maintenanceMode: false, registrationOpen: true, supportEmail: null, updatedBy: null, updatedAt: 0 }
};

export class Store {
  private db: Database = structuredClone(EMPTY);
  private file: string;
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'wicksentinel.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Database>;
      // Additive merge: unknown/absent collections fall back to defaults so an
      // older data file (pre-admin) loads without migration or data loss.
      this.db = {
        ...structuredClone(EMPTY),
        ...parsed,
        users: parsed.users ?? {},
        sessions: parsed.sessions ?? {},
        oauthTransactions: parsed.oauthTransactions ?? {},
        adminUsers: parsed.adminUsers ?? {},
        adminSessions: parsed.adminSessions ?? {},
        adminInvitations: parsed.adminInvitations ?? {},
        adminPasswordResets: parsed.adminPasswordResets ?? {},
        auditLogs: parsed.auditLogs ?? [],
        supportTickets: parsed.supportTickets ?? {},
        supportTicketMessages: parsed.supportTicketMessages ?? {},
        announcements: parsed.announcements ?? {},
        featureFlags: parsed.featureFlags ?? {},
        adminNotes: parsed.adminNotes ?? {},
        platformConfig: { ...EMPTY.platformConfig, ...(parsed.platformConfig ?? {}) }
      };
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      this.db = structuredClone(EMPTY);
    }
    this.loaded = true;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.db, null, 2);
    this.queue = this.queue.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, this.file);
    });
    return this.queue;
  }

  private ensureLoaded(): void {
    if (!this.loaded) throw new Error('Store.load() must be awaited before use.');
  }

  /* ----------------------------- OAuth txns ----------------------------- */

  async createOAuthTransaction(tx: OAuthTransaction): Promise<void> {
    this.ensureLoaded();
    this.pruneOAuthTransactions();
    this.db.oauthTransactions[tx.state] = tx;
    await this.persist();
  }

  getOAuthTransaction(state: string): OAuthTransaction | null {
    this.ensureLoaded();
    return this.db.oauthTransactions[state] ?? null;
  }

  /** Atomically marks a transaction consumed. Returns false if already used. */
  async consumeOAuthTransaction(state: string): Promise<boolean> {
    this.ensureLoaded();
    const tx = this.db.oauthTransactions[state];
    if (!tx || tx.consumedAt !== null) return false;
    tx.consumedAt = Date.now();
    await this.persist();
    return true;
  }

  private pruneOAuthTransactions(): void {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [state, tx] of Object.entries(this.db.oauthTransactions)) {
      if (tx.createdAt < cutoff || tx.consumedAt !== null) delete this.db.oauthTransactions[state];
    }
  }

  /* ------------------------------- Users -------------------------------- */

  getUserById(id: string): UserRecord | null {
    this.ensureLoaded();
    return this.db.users[id] ?? null;
  }

  getUserByDerivSub(sub: string): UserRecord | null {
    this.ensureLoaded();
    return Object.values(this.db.users).find((u) => u.derivSub === sub) ?? null;
  }

  /**
   * Finds a profile that shares any of the given Deriv account ids.
   *
   * When the OIDC subject is unavailable, identity is derived from the account
   * set, which changes when a user opens or closes a Deriv account. Matching on
   * any shared account keeps a returning user on the same profile instead of
   * creating a duplicate.
   */
  findUserByAccountIds(accountIds: string[]): UserRecord | null {
    this.ensureLoaded();
    if (accountIds.length === 0) return null;
    const set = new Set(accountIds);
    return Object.values(this.db.users).find((u) => u.accounts.some((a) => set.has(a.accountId))) ?? null;
  }

  /** Number of stored profiles — used by tests and diagnostics. */
  countUsers(): number {
    this.ensureLoaded();
    return Object.keys(this.db.users).length;
  }

  /** Number of live (non-revoked, unexpired) sessions — used by tests. */
  countActiveSessions(): number {
    this.ensureLoaded();
    const now = Date.now();
    return Object.values(this.db.sessions).filter((s) => !s.revoked && s.expiresAt > now).length;
  }

  async upsertUser(user: UserRecord): Promise<UserRecord> {
    this.ensureLoaded();
    user.updatedAt = Date.now();
    this.db.users[user.id] = user;
    await this.persist();
    return user;
  }

  /* ------------------------------ Sessions ------------------------------ */

  async createSession(session: SessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.sessions[session.id] = session;
    await this.persist();
  }

  getSession(id: string): SessionRecord | null {
    this.ensureLoaded();
    return this.db.sessions[id] ?? null;
  }

  async updateSession(session: SessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.sessions[session.id] = session;
    await this.persist();
  }

  async deleteSession(id: string): Promise<void> {
    this.ensureLoaded();
    delete this.db.sessions[id];
    await this.persist();
  }

  /** Revokes every session belonging to a user (e.g. Deriv authorization revoked). */
  async revokeUserSessions(userId: string): Promise<void> {
    this.ensureLoaded();
    let changed = false;
    for (const s of Object.values(this.db.sessions)) {
      if (s.userId === userId && !s.revoked) {
        s.revoked = true;
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async pruneExpiredSessions(): Promise<void> {
    this.ensureLoaded();
    const now = Date.now();
    let changed = false;
    for (const [id, s] of Object.entries(this.db.sessions)) {
      if (s.expiresAt <= now) {
        delete this.db.sessions[id];
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  /* ====================================================================== */
  /*  Admin domain (additive). Trader collections above are untouched.      */
  /* ====================================================================== */

  /* --------------------------- admin users ------------------------------ */

  getAdminById(id: string): AdminUserRecord | null {
    this.ensureLoaded();
    return this.db.adminUsers[id] ?? null;
  }

  getAdminByEmail(email: string): AdminUserRecord | null {
    this.ensureLoaded();
    const needle = email.trim().toLowerCase();
    return Object.values(this.db.adminUsers).find((a) => a.email.toLowerCase() === needle) ?? null;
  }

  listAdmins(): AdminUserRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.adminUsers).sort((a, b) => a.createdAt - b.createdAt);
  }

  countActiveSuperAdmins(): number {
    this.ensureLoaded();
    return Object.values(this.db.adminUsers).filter((a) => a.role === 'SUPER_ADMIN' && a.status === 'active').length;
  }

  async upsertAdmin(admin: AdminUserRecord): Promise<AdminUserRecord> {
    this.ensureLoaded();
    admin.updatedAt = Date.now();
    this.db.adminUsers[admin.id] = admin;
    await this.persist();
    return admin;
  }

  /* -------------------------- admin sessions ---------------------------- */

  async createAdminSession(session: AdminSessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminSessions[session.id] = session;
    await this.persist();
  }

  getAdminSession(id: string): AdminSessionRecord | null {
    this.ensureLoaded();
    return this.db.adminSessions[id] ?? null;
  }

  async updateAdminSession(session: AdminSessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminSessions[session.id] = session;
    await this.persist();
  }

  async deleteAdminSession(id: string): Promise<void> {
    this.ensureLoaded();
    delete this.db.adminSessions[id];
    await this.persist();
  }

  async revokeAdminSessions(adminId: string): Promise<void> {
    this.ensureLoaded();
    let changed = false;
    for (const s of Object.values(this.db.adminSessions)) {
      if (s.adminId === adminId && !s.revoked) {
        s.revoked = true;
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  /* ----------------------- invitations & resets ------------------------- */

  async createInvitation(inv: AdminInvitationRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminInvitations[inv.id] = inv;
    await this.persist();
  }

  getInvitationByTokenHash(tokenHash: string): AdminInvitationRecord | null {
    this.ensureLoaded();
    return Object.values(this.db.adminInvitations).find((i) => i.tokenHash === tokenHash) ?? null;
  }

  listInvitations(): AdminInvitationRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.adminInvitations).sort((a, b) => b.createdAt - a.createdAt);
  }

  async consumeInvitation(id: string): Promise<void> {
    this.ensureLoaded();
    const inv = this.db.adminInvitations[id];
    if (inv) {
      inv.consumedAt = Date.now();
      await this.persist();
    }
  }

  async createPasswordReset(reset: AdminPasswordResetRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminPasswordResets[reset.id] = reset;
    await this.persist();
  }

  getPasswordResetByTokenHash(tokenHash: string): AdminPasswordResetRecord | null {
    this.ensureLoaded();
    return Object.values(this.db.adminPasswordResets).find((r) => r.tokenHash === tokenHash) ?? null;
  }

  async consumePasswordReset(id: string): Promise<void> {
    this.ensureLoaded();
    const r = this.db.adminPasswordResets[id];
    if (r) {
      r.consumedAt = Date.now();
      await this.persist();
    }
  }

  /* ----------------------------- audit log ------------------------------ */

  /** Appends one audit record. Records are never edited or removed. */
  async appendAudit(record: AuditRecord): Promise<void> {
    this.ensureLoaded();
    this.db.auditLogs.push(record);
    await this.persist();
  }

  listAudit(): AuditRecord[] {
    this.ensureLoaded();
    return this.db.auditLogs;
  }

  /* --------------------------- support tickets -------------------------- */

  async createTicket(ticket: SupportTicketRecord): Promise<void> {
    this.ensureLoaded();
    this.db.supportTickets[ticket.id] = ticket;
    await this.persist();
  }

  getTicket(id: string): SupportTicketRecord | null {
    this.ensureLoaded();
    return this.db.supportTickets[id] ?? null;
  }

  listTickets(): SupportTicketRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.supportTickets).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async updateTicket(ticket: SupportTicketRecord): Promise<void> {
    this.ensureLoaded();
    ticket.updatedAt = Date.now();
    this.db.supportTickets[ticket.id] = ticket;
    await this.persist();
  }

  async addTicketMessage(message: SupportTicketMessageRecord): Promise<void> {
    this.ensureLoaded();
    this.db.supportTicketMessages[message.id] = message;
    await this.persist();
  }

  listTicketMessages(ticketId: string): SupportTicketMessageRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.supportTicketMessages)
      .filter((m) => m.ticketId === ticketId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /* --------------------------- announcements ---------------------------- */

  async upsertAnnouncement(announcement: AnnouncementRecord): Promise<void> {
    this.ensureLoaded();
    announcement.updatedAt = Date.now();
    this.db.announcements[announcement.id] = announcement;
    await this.persist();
  }

  getAnnouncement(id: string): AnnouncementRecord | null {
    this.ensureLoaded();
    return this.db.announcements[id] ?? null;
  }

  listAnnouncements(): AnnouncementRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.announcements).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /* --------------------------- feature flags ---------------------------- */

  async upsertFeatureFlag(flag: FeatureFlagRecord): Promise<void> {
    this.ensureLoaded();
    this.db.featureFlags[flag.key] = flag;
    await this.persist();
  }

  getFeatureFlag(key: string): FeatureFlagRecord | null {
    this.ensureLoaded();
    return this.db.featureFlags[key] ?? null;
  }

  listFeatureFlags(): FeatureFlagRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.featureFlags).sort((a, b) => a.key.localeCompare(b.key));
  }

  /* ---------------------------- admin notes ----------------------------- */

  async addAdminNote(note: AdminNoteRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminNotes[note.id] = note;
    await this.persist();
  }

  listAdminNotes(userId: string): AdminNoteRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.adminNotes)
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /* -------------------------- platform config --------------------------- */

  getPlatformConfig(): PlatformConfigRecord {
    this.ensureLoaded();
    return this.db.platformConfig;
  }

  async setPlatformConfig(config: PlatformConfigRecord): Promise<void> {
    this.ensureLoaded();
    this.db.platformConfig = config;
    await this.persist();
  }

  /* --------------------- trader user admin helpers ---------------------- */

  listUsers(): UserRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.users);
  }

  listSessionsForUser(userId: string): SessionRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.sessions).filter((s) => s.userId === userId);
  }

  countActiveSessionsForUser(userId: string): number {
    this.ensureLoaded();
    const now = Date.now();
    return Object.values(this.db.sessions).filter((s) => s.userId === userId && !s.revoked && s.expiresAt > now).length;
  }

  /** Persists a mutation to an existing user record (admin suspension etc.). */
  async saveUser(user: UserRecord): Promise<void> {
    this.ensureLoaded();
    user.updatedAt = Date.now();
    this.db.users[user.id] = user;
    await this.persist();
  }

  async pruneAdminSessions(): Promise<void> {
    this.ensureLoaded();
    const now = Date.now();
    let changed = false;
    for (const [id, s] of Object.entries(this.db.adminSessions)) {
      if (s.expiresAt <= now) {
        delete this.db.adminSessions[id];
        changed = true;
      }
    }
    if (changed) await this.persist();
  }
}
