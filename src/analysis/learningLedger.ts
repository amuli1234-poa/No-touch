import type { LearningOutcomeRecord } from '../types/learning';

/**
 * ONE LEARNING INTELLIGENCE AI — permanent outcome ledger.
 *
 * Every settled setup is appended here EXACTLY ONCE (deduped by a stable setup id), with
 * full attribution. Records are never mutated and never deleted by normal operation, so the
 * learning history survives an application restart. A recorded outcome is immutable: a later
 * re-scan of the same setup id is ignored rather than overwriting the settled result.
 */

const STORAGE_KEY = 'lucky_learning_ledger_v1';
/** Hard cap so localStorage can never grow without bound (oldest dropped first). */
const MAX_RECORDS = 4000;

export function loadLearningLedger(): LearningOutcomeRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LearningOutcomeRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLearningLedger(records: readonly LearningOutcomeRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
  } catch {
    // Ignore storage write errors — the in-memory ledger stays authoritative for the session.
  }
}

/**
 * Merges new outcome records into the ledger. An id that already exists is NEVER overwritten
 * (immutability), so a re-settled or re-scanned setup can never contaminate history.
 */
export function mergeLearningRecords(
  existing: readonly LearningOutcomeRecord[],
  incoming: readonly LearningOutcomeRecord[]
): LearningOutcomeRecord[] {
  if (incoming.length === 0) return existing as LearningOutcomeRecord[];
  const byId = new Map(existing.map((r) => [r.id, r]));
  let changed = false;
  for (const record of incoming) {
    if (byId.has(record.id)) continue;
    byId.set(record.id, record);
    changed = true;
  }
  if (!changed) return existing as LearningOutcomeRecord[];
  const merged = Array.from(byId.values()).sort((a, b) => a.settledAt - b.settledAt);
  return merged.slice(-MAX_RECORDS);
}
