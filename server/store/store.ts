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
import type {
  ActivityEventRecord,
  ScannerSessionRecord
} from '../activity/types.js';
import type {
  ExecutionPreferencesRecord,
  RiskProfileRecord,
  SignalRecord,
  TradeIntentRecord,
  ExecutionAttemptRecord,
  ContractRecord,
  LedgerEntryRecord,
  NotificationRecord,
  ExecutionAuditRecord
} from '../execution/types.js';
import type { ImportedBotRecord } from '../bots/types.js';
import type { BotRunRecord } from '../bots/runTypes.js';
import type {
  CopyTradingFollowerRecord,
  CopyTradingInvitationRecord,
  CopyTradingConsentRecord,
  CopyTradingControlRecord
} from '../copyTrading/types.js';
import type { CommissionEntryRecord } from '../copyTrading/finance.js';
import type { ContractAdjustmentRecord } from '../copyTrading/adjustments.js';
import { JsonBackend } from './json_backend.js';
import { SqliteBackend, sqliteFileExists } from './sqlite_backend.js';
import { PostgresBackend } from './postgres_backend.js';
import type { StorageBackend, StoredRecord } from './backend.js';

/**
 * Durable store for users, sessions, OAuth transactions and the admin domain.
 *
 * Reads are served from an in-memory cache so the public API stays synchronous
 * (callers depend on that). Writes update the cache and are written through to
 * a pluggable backend, which owns durability and atomicity:
 *   - `JsonBackend`   — the original single-file engine, kept for rollback;
 *   - `SqliteBackend` — transactional storage for multi-user execution.
 *
 * Exactly one process may open a data directory at a time; the backend takes an
 * exclusive lock to enforce that.
 */

export interface DerivAccountRef {
  accountId: string;
  type: 'demo' | 'real';
  currency?: string;
  status?: string;
}

/** Persistence engines the store can run on. `auto` prefers SQLite when present. */
export type StorageEngine = 'json' | 'sqlite' | 'postgres' | 'auto';

export interface StoreOptions {
  /**
   * Skips the exclusive data-directory lock. For tests and read-only tooling
   * only — it re-enables the cross-process clobbering the lock exists to stop,
   * so no production path may set it.
   */
  unsafeDisableLock?: boolean;
  /** Which backend to open. Defaults to `auto`. */
  engine?: StorageEngine;
  /** Postgres connection string. Required when engine is 'postgres'. */
  connectionString?: string;
  /** Enable SSL for Postgres. Defaults to true in production or for Supabase. */
  ssl?: boolean;
  /** Overrides backend selection entirely (used by the migration tooling). */
  backend?: StorageBackend;
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
  /**
   * Same-origin path to return to after sign-in (e.g. `/bot/`). Validated as a
   * relative path when the transaction is created, so it can never become an
   * open redirect.
   */
  returnTo?: string;
  flow?: 'copy_trading_follower';
  ownerUserId?: string;
  invitationId?: string;
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
  activityEvents: ActivityEventRecord[];
  scannerSessions: Record<string, ScannerSessionRecord>;
  platformConfig: PlatformConfigRecord;
  /* --------------------- additive: trading domain ----------------------- */
  executionPreferences: Record<string, ExecutionPreferencesRecord>;
  riskProfiles: Record<string, RiskProfileRecord>;
  signals: Record<string, SignalRecord>;
  tradeIntents: Record<string, TradeIntentRecord>;
  executionAttempts: Record<string, ExecutionAttemptRecord>;
  contracts: Record<string, ContractRecord>;
  ledgerEntries: Record<string, LedgerEntryRecord>;
  notifications: Record<string, NotificationRecord>;
  executionAudit: ExecutionAuditRecord[];
  /* ------------------------ imported bots (Phase 2) --------------------- */
  importedBots: Record<string, ImportedBotRecord>;
  /* ---------------------- bot runtimes (Phase 3) ------------------------ */
  botRuns: Record<string, BotRunRecord>;
  copyTradingFollowers: Record<string, CopyTradingFollowerRecord>;
  copyTradingInvitations: Record<string, CopyTradingInvitationRecord>;
  copyTradingConsents: Record<string, CopyTradingConsentRecord>;
  copyTradingControls: Record<string, CopyTradingControlRecord>;
  commissionEntries: Record<string, CommissionEntryRecord>;
  contractAdjustments: Record<string, ContractAdjustmentRecord>;
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
  activityEvents: [],
  scannerSessions: {},
  platformConfig: { maintenanceMode: false, registrationOpen: true, supportEmail: null, updatedBy: null, updatedAt: 0 },
  executionPreferences: {},
  riskProfiles: {},
  signals: {},
  tradeIntents: {},
  executionAttempts: {},
  contracts: {},
  ledgerEntries: {},
  notifications: {},
  executionAudit: [],
  importedBots: {},
  botRuns: {},
  copyTradingFollowers: {},
  copyTradingInvitations: {},
  copyTradingConsents: {},
  copyTradingControls: {},
  commissionEntries: {},
  contractAdjustments: {}
};

/**
 * Chooses a backend. `auto` uses SQLite when a database file is present and
 * falls back to JSON otherwise, so an un-migrated deployment keeps working and
 * a migrated one switches over without an environment change.
 */
export function resolveBackend(dataDir: string, options: StoreOptions): StorageBackend {
  if (options.backend) return options.backend;

  const engine = options.engine ?? 'auto';
  const disable = { unsafeDisableLock: options.unsafeDisableLock };

  if (engine === 'json') return new JsonBackend(dataDir, disable);
  if (engine === 'sqlite') return new SqliteBackend(dataDir, disable);
  if (engine === 'postgres') {
    const connStr = options.connectionString ?? process.env.DATABASE_URL;
    if (!connStr) throw new Error('DATABASE_URL is required for postgres engine');
    const ssl = options.ssl ?? (process.env.NODE_ENV === 'production' || connStr.includes('supabase'));
    return new PostgresBackend(connStr, ssl);
  }


  return sqliteFileExists(dataDir) ? new SqliteBackend(dataDir, disable) : new JsonBackend(dataDir, disable);
}

/**
 * Storage options derived from the loaded server config.
 *
 * Every entry point that opens a store must go through this: the bootstrap CLI
 * and the HTTP server then cannot resolve to different backends, which is how
 * an administrator could be written to a JSON file the server never reads.
 */
export function storeOptionsFromConfig(cfg: {
  storageEngine: StorageEngine;
  database?: { url: string | null; ssl: boolean };
}): StoreOptions {
  return {
    engine: cfg.storageEngine,
    connectionString: cfg.database?.url ?? undefined,
    ssl: cfg.database?.ssl
  };
}

export class Store {
  private db: Database = structuredClone(EMPTY);
  private readonly backend: StorageBackend;
  private loaded = false;

  constructor(dataDir: string, options: StoreOptions = {}) {
    this.backend = resolveBackend(path.resolve(dataDir), options);
  }

  /** The active backend — exposed for the migration tooling and diagnostics. */
  get storage(): StorageBackend {
    return this.backend;
  }

  async load(): Promise<void> {
    await this.backend.open();

    try {
      this.db = {
        ...structuredClone(EMPTY),
        users: (await this.backend.loadKeyed('users')) as unknown as Database['users'],
        sessions: (await this.backend.loadKeyed('sessions')) as unknown as Database['sessions'],
        oauthTransactions: (await this.backend.loadKeyed('oauthTransactions')) as unknown as Database['oauthTransactions'],
        adminUsers: (await this.backend.loadKeyed('adminUsers')) as unknown as Database['adminUsers'],
        adminSessions: (await this.backend.loadKeyed('adminSessions')) as unknown as Database['adminSessions'],
        adminInvitations: (await this.backend.loadKeyed('adminInvitations')) as unknown as Database['adminInvitations'],
        adminPasswordResets: (await this.backend.loadKeyed('adminPasswordResets')) as unknown as Database['adminPasswordResets'],
        auditLogs: (await this.backend.loadAppend('auditLogs')) as unknown as Database['auditLogs'],
        supportTickets: (await this.backend.loadKeyed('supportTickets')) as unknown as Database['supportTickets'],
        supportTicketMessages: (await this.backend.loadKeyed('supportTicketMessages')) as unknown as Database['supportTicketMessages'],
        announcements: (await this.backend.loadKeyed('announcements')) as unknown as Database['announcements'],
        featureFlags: (await this.backend.loadKeyed('featureFlags')) as unknown as Database['featureFlags'],
        adminNotes: (await this.backend.loadKeyed('adminNotes')) as unknown as Database['adminNotes'],
        activityEvents: (await this.backend.loadAppend('activityEvents')) as unknown as Database['activityEvents'],
        scannerSessions: (await this.backend.loadKeyed('scannerSessions')) as unknown as Database['scannerSessions'],
        executionPreferences: (await this.backend.loadKeyed('executionPreferences')) as unknown as Database['executionPreferences'],
        riskProfiles: (await this.backend.loadKeyed('riskProfiles')) as unknown as Database['riskProfiles'],
        signals: (await this.backend.loadKeyed('signals')) as unknown as Database['signals'],
        tradeIntents: (await this.backend.loadKeyed('tradeIntents')) as unknown as Database['tradeIntents'],
        executionAttempts: (await this.backend.loadKeyed('executionAttempts')) as unknown as Database['executionAttempts'],
        contracts: (await this.backend.loadKeyed('contracts')) as unknown as Database['contracts'],
        ledgerEntries: (await this.backend.loadKeyed('ledgerEntries')) as unknown as Database['ledgerEntries'],
        notifications: (await this.backend.loadKeyed('notifications')) as unknown as Database['notifications'],
        executionAudit: (await this.backend.loadAppend('executionAudit')) as unknown as Database['executionAudit'],
        importedBots: (await this.backend.loadKeyed('importedBots')) as unknown as Database['importedBots'],
        botRuns: (await this.backend.loadKeyed('botRuns')) as unknown as Database['botRuns'],
        copyTradingFollowers: (await this.backend.loadKeyed('copyTradingFollowers')) as unknown as Database['copyTradingFollowers'],
        copyTradingInvitations: (await this.backend.loadKeyed('copyTradingInvitations')) as unknown as Database['copyTradingInvitations'],
        copyTradingConsents: (await this.backend.loadKeyed('copyTradingConsents')) as unknown as Database['copyTradingConsents'],
        copyTradingControls: (await this.backend.loadKeyed('copyTradingControls')) as unknown as Database['copyTradingControls'],
        commissionEntries: (await this.backend.loadKeyed('commissionEntries')) as unknown as Database['commissionEntries'],
        contractAdjustments: (await this.backend.loadKeyed('contractAdjustments')) as unknown as Database['contractAdjustments']
      };
      const platformConfig = await this.backend.loadSingleton('platformConfig');
      this.db.platformConfig = { ...EMPTY.platformConfig, ...((platformConfig ?? {}) as Partial<PlatformConfigRecord>) };
    } catch (err) {
      await this.backend.close();
      throw err;
    }

    this.loaded = true;
  }

  /** Releases the backend and its data-directory lock. Called on shutdown. */
  async close(): Promise<void> {
    await this.backend.close();
    this.loaded = false;
  }

  /**
   * Runs `fn` in a single backend transaction. Writes made through this store
   * inside `fn` commit together or roll back together on SQLite. The JSON
   * backend has no transaction, so callers needing atomicity must use SQLite.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureLoaded();
    return this.backend.transaction(fn);
  }

  private ensureLoaded(): void {
    if (!this.loaded) throw new Error('Store.load() must be awaited before use.');
  }

  /* ----------------------------- OAuth txns ----------------------------- */

  async createOAuthTransaction(tx: OAuthTransaction): Promise<void> {
    this.ensureLoaded();
    await this.pruneOAuthTransactions();
    this.db.oauthTransactions[tx.state] = tx;
    await this.backend.putKeyed('oauthTransactions', tx.state, tx as unknown as StoredRecord);
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
    await this.backend.putKeyed('oauthTransactions', state, tx as unknown as StoredRecord);
    return true;
  }

  private async pruneOAuthTransactions(): Promise<void> {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [state, tx] of Object.entries(this.db.oauthTransactions)) {
      if (tx.createdAt < cutoff || tx.consumedAt !== null) {
        delete this.db.oauthTransactions[state];
        await this.backend.deleteKeyed('oauthTransactions', state);
      }
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
    await this.backend.putKeyed('users', user.id, user as unknown as StoredRecord);
    return user;
  }

  /* ------------------------------ Sessions ------------------------------ */

  async createSession(session: SessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.sessions[session.id] = session;
    await this.backend.putKeyed('sessions', session.id, session as unknown as StoredRecord);
  }

  getSession(id: string): SessionRecord | null {
    this.ensureLoaded();
    return this.db.sessions[id] ?? null;
  }

  async updateSession(session: SessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.sessions[session.id] = session;
    await this.backend.putKeyed('sessions', session.id, session as unknown as StoredRecord);
  }

  async deleteSession(id: string): Promise<void> {
    this.ensureLoaded();
    delete this.db.sessions[id];
    await this.backend.deleteKeyed('sessions', id);
  }

  /** Revokes every session belonging to a user (e.g. Deriv authorization revoked). */
  async revokeUserSessions(userId: string): Promise<void> {
    this.ensureLoaded();
    for (const s of Object.values(this.db.sessions)) {
      if (s.userId === userId && !s.revoked) {
        s.revoked = true;
        await this.backend.putKeyed('sessions', s.id, s as unknown as StoredRecord);
      }
    }
  }

  async pruneExpiredSessions(): Promise<void> {
    this.ensureLoaded();
    const now = Date.now();
    for (const [id, s] of Object.entries(this.db.sessions)) {
      if (s.expiresAt <= now) {
        delete this.db.sessions[id];
        await this.backend.deleteKeyed('sessions', id);
      }
    }
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
    await this.backend.putKeyed('adminUsers', admin.id, admin as unknown as StoredRecord);
    return admin;
  }

  /* -------------------------- admin sessions ---------------------------- */

  async createAdminSession(session: AdminSessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminSessions[session.id] = session;
    await this.backend.putKeyed('adminSessions', session.id, session as unknown as StoredRecord);
  }

  getAdminSession(id: string): AdminSessionRecord | null {
    this.ensureLoaded();
    return this.db.adminSessions[id] ?? null;
  }

  async updateAdminSession(session: AdminSessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminSessions[session.id] = session;
    await this.backend.putKeyed('adminSessions', session.id, session as unknown as StoredRecord);
  }

  async deleteAdminSession(id: string): Promise<void> {
    this.ensureLoaded();
    delete this.db.adminSessions[id];
    await this.backend.deleteKeyed('adminSessions', id);
  }

  async revokeAdminSessions(adminId: string): Promise<void> {
    this.ensureLoaded();
    for (const s of Object.values(this.db.adminSessions)) {
      if (s.adminId === adminId && !s.revoked) {
        s.revoked = true;
        await this.backend.putKeyed('adminSessions', s.id, s as unknown as StoredRecord);
      }
    }
  }

  /* ----------------------- invitations & resets ------------------------- */

  async createInvitation(inv: AdminInvitationRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminInvitations[inv.id] = inv;
    await this.backend.putKeyed('adminInvitations', inv.id, inv as unknown as StoredRecord);
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
      await this.backend.putKeyed('adminInvitations', id, inv as unknown as StoredRecord);
    }
  }

  async createPasswordReset(reset: AdminPasswordResetRecord): Promise<void> {
    this.ensureLoaded();
    this.db.adminPasswordResets[reset.id] = reset;
    await this.backend.putKeyed('adminPasswordResets', reset.id, reset as unknown as StoredRecord);
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
      await this.backend.putKeyed('adminPasswordResets', id, r as unknown as StoredRecord);
    }
  }

  /* ----------------------------- audit log ------------------------------ */

  /** Appends one audit record. Records are never edited or removed. */
  async appendAudit(record: AuditRecord): Promise<void> {
    this.ensureLoaded();
    this.db.auditLogs.push(record);
    await this.backend.appendRecord('auditLogs', record as unknown as StoredRecord);
  }

  listAudit(): AuditRecord[] {
    this.ensureLoaded();
    return this.db.auditLogs;
  }

  /* --------------------------- support tickets -------------------------- */

  async createTicket(ticket: SupportTicketRecord): Promise<void> {
    this.ensureLoaded();
    this.db.supportTickets[ticket.id] = ticket;
    await this.backend.putKeyed('supportTickets', ticket.id, ticket as unknown as StoredRecord);
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
    await this.backend.putKeyed('supportTickets', ticket.id, ticket as unknown as StoredRecord);
  }

  async addTicketMessage(message: SupportTicketMessageRecord): Promise<void> {
    this.ensureLoaded();
    this.db.supportTicketMessages[message.id] = message;
    await this.backend.putKeyed('supportTicketMessages', message.id, message as unknown as StoredRecord);
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
    await this.backend.putKeyed('announcements', announcement.id, announcement as unknown as StoredRecord);
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
    await this.backend.putKeyed('featureFlags', flag.key, flag as unknown as StoredRecord);
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
    await this.backend.putKeyed('adminNotes', note.id, note as unknown as StoredRecord);
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
    await this.backend.putSingleton('platformConfig', config as unknown as StoredRecord);
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
    await this.backend.putKeyed('users', user.id, user as unknown as StoredRecord);
  }

  async pruneAdminSessions(): Promise<void> {
    this.ensureLoaded();
    const now = Date.now();
    for (const [id, s] of Object.entries(this.db.adminSessions)) {
      if (s.expiresAt <= now) {
        delete this.db.adminSessions[id];
        await this.backend.deleteKeyed('adminSessions', id);
      }
    }
  }

  /* ====================================================================== */
  /*  Activity & scanner telemetry (additive).                             */
  /* ====================================================================== */

  /** Appends one activity event. Events are never edited or removed by hand. */
  async appendActivityEvent(event: ActivityEventRecord): Promise<void> {
    this.ensureLoaded();
    this.db.activityEvents.push(event);
    await this.backend.appendRecord('activityEvents', event as unknown as StoredRecord);
  }

  /**
   * All activity events, oldest first. Bounded by `retentionDays` pruning, so
   * callers can treat this as a bounded working set.
   */
  listActivityEvents(): ActivityEventRecord[] {
    this.ensureLoaded();
    return this.db.activityEvents;
  }

  /**
   * Drops activity events older than `retentionDays`. Audit records are NOT
   * affected — only the high-volume telemetry collection is pruned.
   */
  async pruneActivityEvents(retentionDays: number): Promise<number> {
    this.ensureLoaded();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const before = this.db.activityEvents.length;
    this.db.activityEvents = this.db.activityEvents.filter((e) => e.timestamp >= cutoff);
    await this.backend.deleteAppendBefore('activityEvents', cutoff);
    return before - this.db.activityEvents.length;
  }

  /* ------------------------- scanner sessions --------------------------- */

  /**
   * Records a scanner heartbeat, creating the session row on first sight.
   * Updates in place so a long-running scanner is one row, not one per beat.
   */
  async upsertScannerSession(session: ScannerSessionRecord): Promise<void> {
    this.ensureLoaded();
    this.db.scannerSessions[session.id] = session;
    await this.backend.putKeyed('scannerSessions', session.id, session as unknown as StoredRecord);
  }

  getScannerSession(id: string): ScannerSessionRecord | null {
    this.ensureLoaded();
    return this.db.scannerSessions[id] ?? null;
  }

  listScannerSessions(): ScannerSessionRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.scannerSessions);
  }

  /** Scanner sessions seen within `windowMs` of `now`. The "active now" count. */
  countActiveScannerSessions(windowMs: number, now = Date.now()): number {
    this.ensureLoaded();
    return Object.values(this.db.scannerSessions).filter((s) => now - s.lastSeenAt <= windowMs).length;
  }

  /** Removes scanner rows not seen within `windowMs`, so the set stays bounded. */
  async pruneScannerSessions(windowMs: number, now = Date.now()): Promise<number> {
    this.ensureLoaded();
    let removed = 0;
    for (const [id, s] of Object.entries(this.db.scannerSessions)) {
      if (now - s.lastSeenAt > windowMs) {
        delete this.db.scannerSessions[id];
        await this.backend.deleteKeyed('scannerSessions', id);
        removed += 1;
      }
    }
    return removed;
  }

  /* ====================================================================== */
  /*  Trading domain (additive). Every accessor is scoped by userId.        */
  /*                                                                        */
  /*  Isolation rule: a record is only ever returned to the user it belongs */
  /*  to. `get*` helpers take the owning userId and return null on a        */
  /*  mismatch, so a caller cannot read another tenant's row by guessing an */
  /*  id. Nothing here executes a trade; these are pure persistence.        */
  /* ====================================================================== */

  /* --------------------- execution preferences -------------------------- */

  async putExecutionPreferences(prefs: ExecutionPreferencesRecord): Promise<void> {
    this.ensureLoaded();
    prefs.updatedAt = Date.now();
    this.db.executionPreferences[prefs.userId] = prefs;
    await this.backend.putKeyed('executionPreferences', prefs.userId, prefs as unknown as StoredRecord);
  }

  getExecutionPreferences(userId: string): ExecutionPreferencesRecord | null {
    this.ensureLoaded();
    return this.db.executionPreferences[userId] ?? null;
  }

  /* --------------------------- risk profiles ---------------------------- */

  async putRiskProfile(profile: RiskProfileRecord): Promise<void> {
    this.ensureLoaded();
    profile.updatedAt = Date.now();
    this.db.riskProfiles[profile.userId] = profile;
    await this.backend.putKeyed('riskProfiles', profile.userId, profile as unknown as StoredRecord);
  }

  getRiskProfile(userId: string): RiskProfileRecord | null {
    this.ensureLoaded();
    return this.db.riskProfiles[userId] ?? null;
  }

  /* ------------------------------ signals ------------------------------- */

  async putSignal(signal: SignalRecord): Promise<void> {
    this.ensureLoaded();
    this.db.signals[signal.id] = signal;
    await this.backend.putKeyed('signals', signal.id, signal as unknown as StoredRecord);
  }

  /** Returns the signal only when it belongs to `userId`. */
  getSignal(userId: string, id: string): SignalRecord | null {
    this.ensureLoaded();
    const s = this.db.signals[id];
    return s && s.userId === userId ? s : null;
  }

  listSignals(userId: string): SignalRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.signals).filter((s) => s.userId === userId);
  }

  /* ---------------------------- trade intents --------------------------- */

  async putTradeIntent(intent: TradeIntentRecord): Promise<void> {
    this.ensureLoaded();
    intent.updatedAt = Date.now();
    this.db.tradeIntents[intent.id] = intent;
    await this.backend.putKeyed('tradeIntents', intent.id, intent as unknown as StoredRecord);
  }

  /** Returns the intent only when it belongs to `userId`. */
  getTradeIntent(userId: string, id: string): TradeIntentRecord | null {
    this.ensureLoaded();
    const i = this.db.tradeIntents[id];
    return i && i.userId === userId ? i : null;
  }

  listTradeIntents(userId: string): TradeIntentRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.tradeIntents).filter((i) => i.userId === userId);
  }

  /** Finds an intent by idempotency key for a user, so a duplicate is a no-op. */
  findTradeIntentByIdempotencyKey(userId: string, key: string): TradeIntentRecord | null {
    this.ensureLoaded();
    return (
      Object.values(this.db.tradeIntents).find((i) => i.userId === userId && i.idempotencyKey === key) ?? null
    );
  }

  /* -------------------------- execution attempts ------------------------ */

  async putExecutionAttempt(attempt: ExecutionAttemptRecord): Promise<void> {
    this.ensureLoaded();
    this.db.executionAttempts[attempt.id] = attempt;
    await this.backend.putKeyed('executionAttempts', attempt.id, attempt as unknown as StoredRecord);
  }

  listExecutionAttempts(userId: string, intentId: string): ExecutionAttemptRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.executionAttempts)
      .filter((a) => a.userId === userId && a.intentId === intentId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  /* ------------------------------ contracts ----------------------------- */

  async putContract(contract: ContractRecord): Promise<void> {
    this.ensureLoaded();
    contract.updatedAt = Date.now();
    this.db.contracts[contract.id] = contract;
    await this.backend.putKeyed('contracts', contract.id, contract as unknown as StoredRecord);
  }

  /** Returns the contract only when it belongs to `userId`. */
  getContract(userId: string, id: string): ContractRecord | null {
    this.ensureLoaded();
    const c = this.db.contracts[id];
    return c && c.userId === userId ? c : null;
  }

  /** Returns a contract by id regardless of owner (adjustment/reconciliation use). */
  findContractById(id: string): ContractRecord | null {
    this.ensureLoaded();
    return this.db.contracts[id] ?? null;
  }

  listContracts(userId: string): ContractRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.contracts).filter((c) => c.userId === userId);
  }

  /** Open contracts for a user on one account, used for exposure limits. */
  listOpenContracts(userId: string, accountId: string): ContractRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.contracts).filter(
      (c) => c.userId === userId && c.accountId === accountId && c.status === 'open'
    );
  }

  /* -------------------------------- ledger ------------------------------ */

  /**
   * Appends a ledger entry, refusing a duplicate by `dedupeKey`. Returns false
   * when the entry already exists, so a replayed settlement cannot double-post.
   */
  async putLedgerEntry(entry: LedgerEntryRecord): Promise<boolean> {
    this.ensureLoaded();
    const existing = Object.values(this.db.ledgerEntries).find(
      (e) => e.userId === entry.userId && e.dedupeKey === entry.dedupeKey
    );
    if (existing) return false;
    this.db.ledgerEntries[entry.id] = entry;
    await this.backend.putKeyed('ledgerEntries', entry.id, entry as unknown as StoredRecord);
    return true;
  }

  listLedgerEntries(userId: string): LedgerEntryRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.ledgerEntries)
      .filter((e) => e.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /* ---------------------------- notifications --------------------------- */

  async putNotification(notification: NotificationRecord): Promise<void> {
    this.ensureLoaded();
    this.db.notifications[notification.id] = notification;
    await this.backend.putKeyed('notifications', notification.id, notification as unknown as StoredRecord);
  }

  listNotifications(userId: string): NotificationRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.notifications)
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Returns the notification only when it belongs to `userId`. */
  getNotification(userId: string, id: string): NotificationRecord | null {
    this.ensureLoaded();
    const n = this.db.notifications[id];
    return n && n.userId === userId ? n : null;
  }

  /* -------------------------- execution audit --------------------------- */

  async appendExecutionAudit(record: ExecutionAuditRecord): Promise<void> {
    this.ensureLoaded();
    this.db.executionAudit.push(record);
    await this.backend.appendRecord('executionAudit', record as unknown as StoredRecord);
  }

  listExecutionAudit(): ExecutionAuditRecord[] {
    this.ensureLoaded();
    return this.db.executionAudit;
  }

  /**
   * Clears the trading history for a set of principals — the manager plus their
   * copy-follower principals — so the performance surfaces start fresh. Deletes
   * contracts, ledger entries, trade intents, execution attempts and signals.
   * The append-only execution audit is deliberately left intact as a security
   * log. Returns the number of records removed per collection.
   */
  async clearTradingData(
    userIds: string[]
  ): Promise<{ contracts: number; ledger: number; intents: number; attempts: number; signals: number }> {
    this.ensureLoaded();
    const counts = { contracts: 0, ledger: 0, intents: 0, attempts: 0, signals: 0 };
    for (const userId of new Set(userIds)) {
      for (const r of Object.values(this.db.contracts).filter((x) => x.userId === userId)) {
        delete this.db.contracts[r.id];
        await this.backend.deleteKeyed('contracts', r.id);
        counts.contracts += 1;
      }
      for (const r of Object.values(this.db.ledgerEntries).filter((x) => x.userId === userId)) {
        delete this.db.ledgerEntries[r.id];
        await this.backend.deleteKeyed('ledgerEntries', r.id);
        counts.ledger += 1;
      }
      for (const r of Object.values(this.db.tradeIntents).filter((x) => x.userId === userId)) {
        delete this.db.tradeIntents[r.id];
        await this.backend.deleteKeyed('tradeIntents', r.id);
        counts.intents += 1;
      }
      for (const r of Object.values(this.db.executionAttempts).filter((x) => x.userId === userId)) {
        delete this.db.executionAttempts[r.id];
        await this.backend.deleteKeyed('executionAttempts', r.id);
        counts.attempts += 1;
      }
      for (const r of Object.values(this.db.signals).filter((x) => x.userId === userId)) {
        delete this.db.signals[r.id];
        await this.backend.deleteKeyed('signals', r.id);
        counts.signals += 1;
      }
    }
    // Commission records belong to the master's book (ownerUserId) or to a
    // follower principal; clear both so a reset also resets the fee ledger.
    for (const r of Object.values(this.db.commissionEntries).filter(
      (x) => userIds.includes(x.ownerUserId) || userIds.includes(x.principal)
    )) {
      delete this.db.commissionEntries[r.id];
      await this.backend.deleteKeyed('commissionEntries', r.id);
    }
    for (const r of Object.values(this.db.contractAdjustments).filter(
      (x) => userIds.includes(x.ownerUserId) || userIds.includes(x.principal)
    )) {
      delete this.db.contractAdjustments[r.id];
      await this.backend.deleteKeyed('contractAdjustments', r.id);
    }
    return counts;
  }

  /* ====================================================================== */
  /*  Imported bots (Phase 2, additive).                                    */
  /*                                                                        */
  /*  Same isolation rule as the trading domain: every read takes the owning */
  /*  userId and returns null on a mismatch, so a caller cannot read or      */
  /*  mutate another tenant's bot by guessing an id. Importing a bot is      */
  /*  never an execution grant — these are inert strategy records.           */
  /* ====================================================================== */

  async putImportedBot(bot: ImportedBotRecord): Promise<void> {
    this.ensureLoaded();
    this.db.importedBots[bot.id] = bot;
    await this.backend.putKeyed('importedBots', bot.id, bot as unknown as StoredRecord);
  }

  /** Returns the bot only when it belongs to `userId`. */
  getImportedBot(userId: string, id: string): ImportedBotRecord | null {
    this.ensureLoaded();
    const bot = this.db.importedBots[id];
    return bot && bot.userId === userId ? bot : null;
  }

  /** Every bot owned by `userId`, newest first. */
  listImportedBots(userId: string): ImportedBotRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.importedBots)
      .filter((b) => b.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Finds an existing bot for this user with the same source hash, so a
   * duplicate upload can be detected before it is stored again.
   */
  findImportedBotByHash(userId: string, sourceHash: string): ImportedBotRecord | null {
    this.ensureLoaded();
    return (
      Object.values(this.db.importedBots).find(
        (b) => b.userId === userId && b.sourceHash === sourceHash
      ) ?? null
    );
  }

  async deleteImportedBot(userId: string, id: string): Promise<boolean> {
    this.ensureLoaded();
    const bot = this.db.importedBots[id];
    if (!bot || bot.userId !== userId) return false;
    delete this.db.importedBots[id];
    await this.backend.deleteKeyed('importedBots', id);
    return true;
  }

  /**
   * Every imported bot across all owners, newest first.
   *
   * Administrative read only — trader paths must keep using `listImportedBots`,
   * which is owner-scoped. Returns the records as stored so the console can
   * report compatibility and warnings without re-parsing.
   */
  listAllImportedBots(): ImportedBotRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.importedBots).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Every bot run across all owners, newest first. Administrative read only. */
  listAllBotRuns(): BotRunRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.botRuns).sort((a, b) => b.startedAt - a.startedAt);
  }

  /* ----------------------- copy trading followers ---------------------- */

  async putCopyTradingFollower(record: CopyTradingFollowerRecord): Promise<void> {
    this.ensureLoaded();
    this.db.copyTradingFollowers[record.id] = record;
    await this.backend.putKeyed('copyTradingFollowers', record.id, record as unknown as StoredRecord);
  }

  getCopyTradingFollower(ownerUserId: string, id: string): CopyTradingFollowerRecord | null {
    this.ensureLoaded();
    const record = this.db.copyTradingFollowers[id];
    return record?.ownerUserId === ownerUserId ? record : null;
  }

  listCopyTradingFollowers(ownerUserId: string): CopyTradingFollowerRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.copyTradingFollowers)
      .filter((record) => record.ownerUserId === ownerUserId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  findCopyTradingFollowerByIdentity(derivSub: string): CopyTradingFollowerRecord | null {
    this.ensureLoaded();
    return Object.values(this.db.copyTradingFollowers).find((record) => record.derivSub === derivSub) ?? null;
  }

  findCopyTradingFollowerByAccountIds(accountIds: string[]): CopyTradingFollowerRecord | null {
    this.ensureLoaded();
    const requested = new Set(accountIds);
    return Object.values(this.db.copyTradingFollowers).find(
      (record) => record.accounts.some((account) => requested.has(account.accountId))
    ) ?? null;
  }

  async deleteCopyTradingFollower(ownerUserId: string, id: string): Promise<CopyTradingFollowerRecord | null> {
    this.ensureLoaded();
    const record = this.db.copyTradingFollowers[id];
    if (!record || record.ownerUserId !== ownerUserId) return null;
    delete this.db.copyTradingFollowers[id];
    await this.backend.deleteKeyed('copyTradingFollowers', id);
    return record;
  }

  async putCopyTradingInvitation(record: CopyTradingInvitationRecord): Promise<void> {
    this.ensureLoaded();
    this.db.copyTradingInvitations[record.id] = record;
    await this.backend.putKeyed('copyTradingInvitations', record.id, record as unknown as StoredRecord);
  }

  getCopyTradingInvitation(id: string): CopyTradingInvitationRecord | null {
    this.ensureLoaded();
    return this.db.copyTradingInvitations[id] ?? null;
  }

  async consumeCopyTradingInvitation(id: string): Promise<CopyTradingInvitationRecord | null> {
    this.ensureLoaded();
    const record = this.db.copyTradingInvitations[id];
    if (!record || record.consumedAt !== null || record.expiresAt <= Date.now()) return null;
    record.consumedAt = Date.now();
    await this.backend.putKeyed('copyTradingInvitations', id, record as unknown as StoredRecord);
    return record;
  }

  async revokeCopyTradingInvitation(id: string): Promise<CopyTradingInvitationRecord | null> {
    this.ensureLoaded();
    const record = this.db.copyTradingInvitations[id];
    if (!record || record.consumedAt !== null) return null;
    record.revokedAt = Date.now();
    await this.backend.putKeyed('copyTradingInvitations', id, record as unknown as StoredRecord);
    return record;
  }

  /**
   * Every follower connection across all owners.
   *
   * Administrative read only. Trader-facing paths must keep using
   * `listCopyTradingFollowers`, which is owner-scoped; this method exists so the
   * console can see the platform-wide picture and is reachable only behind an
   * admin permission check.
   */
  listAllCopyTradingFollowers(): CopyTradingFollowerRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.copyTradingFollowers).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Every invitation, newest first. Administrative read only. */
  listAllCopyTradingInvitations(): CopyTradingInvitationRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.copyTradingInvitations).sort((a, b) => b.createdAt - a.createdAt);
  }

  async putCopyTradingConsent(record: CopyTradingConsentRecord): Promise<void> {
    this.ensureLoaded();
    this.db.copyTradingConsents[record.followerId] = record;
    await this.backend.putKeyed('copyTradingConsents', record.followerId, record as unknown as StoredRecord);
  }

  getCopyTradingConsent(followerId: string): CopyTradingConsentRecord | null {
    this.ensureLoaded();
    return this.db.copyTradingConsents[followerId] ?? null;
  }

  async deleteCopyTradingConsent(followerId: string): Promise<void> {
    this.ensureLoaded();
    if (!this.db.copyTradingConsents[followerId]) return;
    delete this.db.copyTradingConsents[followerId];
    await this.backend.deleteKeyed('copyTradingConsents', followerId);
  }

  /* --------------------------- copy trading control --------------------- */

  async putCopyTradingControl(record: CopyTradingControlRecord): Promise<void> {
    this.ensureLoaded();
    this.db.copyTradingControls[record.ownerUserId] = record;
    await this.backend.putKeyed('copyTradingControls', record.ownerUserId, record as unknown as StoredRecord);
  }

  getCopyTradingControl(ownerUserId: string): CopyTradingControlRecord | null {
    this.ensureLoaded();
    return this.db.copyTradingControls[ownerUserId] ?? null;
  }

  /**
   * Contracts owned by any user whose id is in `userIds`.
   *
   * The copy engine represents each follower as a synthetic principal, so a
   * follower's copied contracts are stored under that synthetic id rather than
   * the manager's. Performance reporting must see both, which the owner-scoped
   * `listContracts` cannot do.
   */
  listContractsForUsers(userIds: readonly string[]): ContractRecord[] {
    this.ensureLoaded();
    const wanted = new Set(userIds);
    return Object.values(this.db.contracts).filter((c) => wanted.has(c.userId));
  }

  /* ------------------------- commission ledger -------------------------- */

  /**
   * Appends one immutable commission record, refusing a duplicate by `dedupeKey`
   * (per user). Returns false when the record already exists, so a re-run of the
   * commission engine can never charge the same performance fee twice.
   */
  async putCommissionEntry(entry: CommissionEntryRecord): Promise<boolean> {
    this.ensureLoaded();
    const existing = Object.values(this.db.commissionEntries).find(
      (e) => e.ownerUserId === entry.ownerUserId && e.dedupeKey === entry.dedupeKey
    );
    if (existing) return false;
    this.db.commissionEntries[entry.id] = entry;
    await this.backend.putKeyed('commissionEntries', entry.id, entry as unknown as StoredRecord);
    return true;
  }

  /** Commission records for one master's book (every follower). */
  listCommissionEntries(ownerUserId: string): CommissionEntryRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.commissionEntries)
      .filter((e) => e.ownerUserId === ownerUserId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Every commission record across all masters (admin/reporting). */
  listAllCommissionEntries(): CommissionEntryRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.commissionEntries).sort((a, b) => a.createdAt - b.createdAt);
  }

  /* ------------------------ settlement adjustments ------------------------ */

  /** Appends an immutable adjustment, refusing a duplicate by `dedupeKey`. */
  async putContractAdjustment(entry: ContractAdjustmentRecord): Promise<boolean> {
    this.ensureLoaded();
    const existing = Object.values(this.db.contractAdjustments).find(
      (e) => e.ownerUserId === entry.ownerUserId && e.dedupeKey === entry.dedupeKey
    );
    if (existing) return false;
    this.db.contractAdjustments[entry.id] = entry;
    await this.backend.putKeyed('contractAdjustments', entry.id, entry as unknown as StoredRecord);
    return true;
  }

  /** Adjustments for one contract, oldest first. */
  listContractAdjustments(contractId: string): ContractAdjustmentRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.contractAdjustments)
      .filter((a) => a.contractId === contractId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /* ====================================================================== */
  /*  Bot runtimes. Same isolation rule as everything else: every read     */
  /*  takes the owning userId and returns null on a mismatch, so a caller   */
  /*  cannot inspect or stop another tenant's run by guessing its id.       */
  /* ====================================================================== */

  async putBotRun(run: BotRunRecord): Promise<void> {
    this.ensureLoaded();
    this.db.botRuns[run.runId] = run;
    await this.backend.putKeyed('botRuns', run.runId, run as unknown as StoredRecord);
  }

  /** Returns the run only when it belongs to `userId`. */
  getBotRun(userId: string, runId: string): BotRunRecord | null {
    this.ensureLoaded();
    const run = this.db.botRuns[runId];
    return run && run.userId === userId ? run : null;
  }

  /** Every run owned by `userId`, newest first. */
  listBotRuns(userId: string): BotRunRecord[] {
    this.ensureLoaded();
    return Object.values(this.db.botRuns)
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** The user's active run for one bot, if any. At most one is ever active. */
  findActiveBotRun(userId: string, botId: string): BotRunRecord | null {
    this.ensureLoaded();
    return (
      Object.values(this.db.botRuns).find(
        (r) => r.userId === userId && r.botId === botId && (r.runtimeStatus === 'running' || r.runtimeStatus === 'stopping')
      ) ?? null
    );
  }
}
