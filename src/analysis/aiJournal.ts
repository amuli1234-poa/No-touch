import type { AiSignal } from '../types/aiModule';
import type { Candle } from '../types/market';

/**
 * TRADE PERFORMANCE & LEARNING AI — durable signal journal.
 *
 * Every published signal from every AI module is recorded here with a stable id, then its
 * outcome is verified INDEPENDENTLY against subsequent real candles. This module never
 * trusts a module's own opinion of its performance, and it never fabricates missing data.
 */

export type AiJournalOutcome =
  | 'PENDING'
  | 'WIN'
  | 'LOSS'
  | 'AMBIGUOUS'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'NO_TRIGGER';

export interface AiJournalRecord {
  id: string;
  symbol: string;
  displayName: string;
  /** Module that produced the signal (never merged across modules). */
  module: string;
  modelId: string;
  modelLabel: string;
  direction: 'RISE' | 'FALL';
  timeframe: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number | null;
  riskRewardRatio: number;
  qualityScore: number;
  condition: string;
  strategyVersion: string;
  createdAt: number;
  confirmedBarTime: number;
  outcome: AiJournalOutcome;
  /** Highest target index reached (0 = none, 1 = TP1 …). */
  highestTargetReached: 0 | 1 | 2 | 3;
  exitPrice: number | null;
  mfePct: number;
  maePct: number;
  settledAt: number | null;
  lastUpdated: number;
}

const STORAGE_KEY = 'lucky_ai_signal_journal_v1';
const MAX_RECORDS = 600;
/** Signals older than this with no resolution are expired. */
const EXPIRY_MS = 1000 * 60 * 60 * 12;

export function loadAiJournal(): AiJournalRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AiJournalRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveAiJournal(records: readonly AiJournalRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
  } catch {
    // Ignore storage write errors.
  }
}

/** Creates a journal record for a published signal (id-keyed, so re-scans never duplicate). */
export function createAiJournalRecord(signal: AiSignal, module: string): AiJournalRecord {
  return {
    id: signal.id,
    symbol: signal.symbol,
    displayName: signal.displayName,
    module,
    modelId: signal.modelId,
    modelLabel: signal.modelLabel,
    direction: signal.direction,
    timeframe: 'M15→M5→M1',
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit1,
    takeProfit2: signal.takeProfit2,
    takeProfit3: signal.takeProfit3,
    riskRewardRatio: signal.riskRewardRatio,
    qualityScore: signal.score,
    condition: signal.condition,
    strategyVersion: 'v1',
    createdAt: signal.createdAt,
    confirmedBarTime: signal.confirmedBarTime,
    outcome: 'PENDING',
    highestTargetReached: 0,
    exitPrice: null,
    mfePct: 0,
    maePct: 0,
    settledAt: null,
    lastUpdated: Date.now(),
  };
}

/**
 * Settles a pending record against real subsequent candles. Within a single candle, if
 * both a target and the stop were touched, the result is AMBIGUOUS — never assumed a win.
 */
export function evaluateAiJournalRecord(
  record: AiJournalRecord,
  candles: readonly Candle[]
): AiJournalRecord {
  if (record.outcome !== 'PENDING' && record.outcome !== 'NO_TRIGGER') return record;
  const fresh = candles.filter((c) => c.time >= record.confirmedBarTime);
  if (fresh.length === 0) return record;

  const rise = record.direction === 'RISE';
  const entry = record.entryPrice;
  let mfe = record.mfePct;
  let mae = record.maePct;
  let highest = record.highestTargetReached;
  const targets = [record.takeProfit1, record.takeProfit2, record.takeProfit3].filter(
    (v): v is number => v !== null
  );

  let outcome: AiJournalOutcome = 'PENDING';
  let exitPrice: number | null = null;

  for (const bar of fresh) {
    const favorablePct = rise ? ((bar.high - entry) / entry) * 100 : ((entry - bar.low) / entry) * 100;
    const adversePct = rise ? ((entry - bar.low) / entry) * 100 : ((bar.high - entry) / entry) * 100;
    if (favorablePct > mfe) mfe = favorablePct;
    if (adversePct > mae) mae = adversePct;

    const stopHit = rise ? bar.low <= record.stopLoss : bar.high >= record.stopLoss;
    const hitTargets = targets.filter((t) => (rise ? bar.high >= t : bar.low <= t));
    const targetHit = hitTargets.length > 0;

    if (stopHit && targetHit) {
      // Both levels inside one candle: the order of events cannot be established.
      outcome = 'AMBIGUOUS';
      exitPrice = bar.close;
      break;
    }
    if (stopHit) {
      outcome = 'LOSS';
      exitPrice = record.stopLoss;
      break;
    }
    if (targetHit) {
      highest = Math.max(highest, hitTargets.length) as 0 | 1 | 2 | 3;
      outcome = 'WIN';
      exitPrice = Math.max(...hitTargets);
      break;
    }
  }

  if (outcome === 'PENDING') {
    const age = Date.now() - record.createdAt;
    if (age > EXPIRY_MS) {
      return {
        ...record,
        outcome: 'EXPIRED',
        highestTargetReached: highest,
        mfePct: Number(mfe.toFixed(3)),
        maePct: Number(mae.toFixed(3)),
        exitPrice: fresh[fresh.length - 1].close,
        settledAt: Date.now(),
        lastUpdated: Date.now(),
      };
    }
    return {
      ...record,
      highestTargetReached: highest,
      mfePct: Number(mfe.toFixed(3)),
      maePct: Number(mae.toFixed(3)),
      lastUpdated: Date.now(),
    };
  }

  return {
    ...record,
    outcome,
    highestTargetReached: highest,
    mfePct: Number(mfe.toFixed(3)),
    maePct: Number(mae.toFixed(3)),
    exitPrice,
    settledAt: Date.now(),
    lastUpdated: Date.now(),
  };
}

/**
 * Merges freshly published signals into the journal. Existing records are preserved (no
 * erasing history when a module is updated) and duplicates are rejected by id.
 */
export function mergeJournalSignals(
  existing: readonly AiJournalRecord[],
  incoming: readonly { module: string; signal: AiSignal }[]
): AiJournalRecord[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const { module, signal } of incoming) {
    if (byId.has(signal.id)) continue;
    byId.set(signal.id, createAiJournalRecord(signal, module));
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS);
}
