/**
 * Storage backend abstraction.
 *
 * The store's public API is a set of ~60 methods over 16 record types. Rather
 * than let each persistence engine grow its own copy of that logic, the store
 * delegates every collection read/write to a backend that implements this
 * narrow contract. Swapping JSON for SQLite (and later PostgreSQL) therefore
 * touches only a backend, never the domain logic or its callers.
 *
 * A backend owns durability, atomicity and indexing. It does NOT own record
 * shape validation, timestamps, or business rules — those stay in the store so
 * every backend behaves identically.
 */

/** Every durable collection, in one place so backends cannot silently omit one. */
export const COLLECTIONS = [
  'users',
  'sessions',
  'oauthTransactions',
  'adminUsers',
  'adminSessions',
  'adminInvitations',
  'adminPasswordResets',
  'auditLogs',
  'supportTickets',
  'supportTicketMessages',
  'announcements',
  'featureFlags',
  'adminNotes',
  'activityEvents',
  'scannerSessions',
  /* ---------------------- trading domain (Phase 2) ---------------------- */
  'executionPreferences',
  'riskProfiles',
  'signals',
  'tradeIntents',
  'executionAttempts',
  'contracts',
  'ledgerEntries',
  'notifications',
  'executionAudit'
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

/** A record as held in memory. Keyed collections map id -> record. */
export type StoredRecord = Record<string, unknown>;

/**
 * Collection kinds differ in more than name:
 *  - `keyed`:   a map from a unique key to one record (`users`, `sessions`, ...)
 *  - `append`:  an ordered, append-only list with no key (`auditLogs`)
 *
 * `keyField` names the record property that acts as the unique key for keyed
 * collections. SQLite stores it as a real primary-key column (so lookups and
 * uniqueness are enforced by the database); JSON keeps it as the object key.
 */
export interface CollectionSpec {
  name: CollectionName;
  kind: 'keyed' | 'append';
  keyField?: string;
  /** Columns to index for lookups the store performs by non-key fields. */
  indexFields?: string[];
}

export const COLLECTION_SPECS: readonly CollectionSpec[] = [
  { name: 'users', kind: 'keyed', keyField: 'id', indexFields: ['derivSub'] },
  { name: 'sessions', kind: 'keyed', keyField: 'id', indexFields: ['userId'] },
  { name: 'oauthTransactions', kind: 'keyed', keyField: 'state' },
  { name: 'adminUsers', kind: 'keyed', keyField: 'id', indexFields: ['email'] },
  { name: 'adminSessions', kind: 'keyed', keyField: 'id', indexFields: ['adminId'] },
  { name: 'adminInvitations', kind: 'keyed', keyField: 'id', indexFields: ['tokenHash'] },
  { name: 'adminPasswordResets', kind: 'keyed', keyField: 'id', indexFields: ['tokenHash'] },
  { name: 'auditLogs', kind: 'append' },
  { name: 'supportTickets', kind: 'keyed', keyField: 'id', indexFields: ['userId'] },
  { name: 'supportTicketMessages', kind: 'keyed', keyField: 'id', indexFields: ['ticketId'] },
  { name: 'announcements', kind: 'keyed', keyField: 'id' },
  { name: 'featureFlags', kind: 'keyed', keyField: 'key' },
  { name: 'adminNotes', kind: 'keyed', keyField: 'id', indexFields: ['userId'] },
  // Append-only: every reported event is kept in order for time-series queries.
  { name: 'activityEvents', kind: 'append' },
  // Keyed: one row per running scanner, updated in place by heartbeats.
  { name: 'scannerSessions', kind: 'keyed', keyField: 'id', indexFields: ['userId'] },
  /* ---------------------- trading domain (Phase 2) ---------------------- */
  // One preferences row and one risk profile per user (keyed by userId).
  { name: 'executionPreferences', kind: 'keyed', keyField: 'userId' },
  { name: 'riskProfiles', kind: 'keyed', keyField: 'userId' },
  // Everything else is keyed by its own id and indexed by the owning user, so
  // tenant-scoped lookups never scan another customer's rows.
  { name: 'signals', kind: 'keyed', keyField: 'id', indexFields: ['userId'] },
  { name: 'tradeIntents', kind: 'keyed', keyField: 'id', indexFields: ['userId'] },
  { name: 'executionAttempts', kind: 'keyed', keyField: 'id', indexFields: ['userId', 'intentId'] },
  { name: 'contracts', kind: 'keyed', keyField: 'id', indexFields: ['userId'] },
  { name: 'ledgerEntries', kind: 'keyed', keyField: 'id', indexFields: ['userId', 'dedupeKey'] },
  { name: 'notifications', kind: 'keyed', keyField: 'id', indexFields: ['userId'] },
  // Append-only audit trail; never pruned.
  { name: 'executionAudit', kind: 'append' }
];

export interface StorageBackend {
  /** Human-readable engine name, used in logs and the migration report. */
  readonly kind: 'json' | 'sqlite';

  /** Opens the backend and makes it ready for reads and writes. */
  open(): Promise<void>;

  /** Closes the backend and releases its resources. */
  close(): Promise<void>;

  /** Loads a keyed collection into memory as a key -> record map. */
  loadKeyed(collection: CollectionName): Promise<Record<string, StoredRecord>>;

  /** Loads an append-only collection in insertion order. */
  loadAppend(collection: CollectionName): Promise<StoredRecord[]>;

  /** Inserts or replaces one record in a keyed collection. */
  putKeyed(collection: CollectionName, key: string, record: StoredRecord): Promise<void>;

  /** Deletes one record from a keyed collection. */
  deleteKeyed(collection: CollectionName, key: string): Promise<void>;

  /** Appends one record to an append-only collection. */
  appendRecord(collection: CollectionName, record: StoredRecord): Promise<void>;

  /**
   * Deletes append-only records whose `timestamp` is older than `cutoffMs`.
   * Used for retention on high-volume collections (activity events); the
   * append-only collections that carry audit value are never pruned.
   */
  deleteAppendBefore(collection: CollectionName, cutoffMs: number): Promise<void>;

  /** Reads the singleton platform-config record, if present. */
  loadSingleton(key: string): Promise<StoredRecord | null>;

  /** Writes the singleton platform-config record. */
  putSingleton(key: string, record: StoredRecord): Promise<void>;

  /**
   * Runs `fn` inside a single atomic transaction. Every write performed by `fn`
   * either commits together or is rolled back together. Used by the migration
   * and by any multi-record invariant.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Record counts per collection, for integrity verification. */
  counts(): Promise<Record<string, number>>;
}
