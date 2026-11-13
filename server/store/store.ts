import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

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
}

const EMPTY: Database = { users: {}, sessions: {}, oauthTransactions: {} };

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
      this.db = {
        users: parsed.users ?? {},
        sessions: parsed.sessions ?? {},
        oauthTransactions: parsed.oauthTransactions ?? {}
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
}
