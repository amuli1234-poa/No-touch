import type { Timeframe } from '../../types/scanner';
import type { DrawingDirection, DrawingRecord } from './types';

/**
 * Drawing store: the single owner of drawing *metadata*.
 *
 * Deliberately independent of the chart. It holds coordinates in the same
 * units the chart uses (candle epoch seconds for time, instrument price for
 * price), so a drawing survives resizes, timeframe switches and re-renders
 * without the renderer ever having to re-derive or "correct" a price.
 *
 * Anti-fabrication guarantees enforced here:
 *  - a drawing can only be created from a validated analysis zone, identified
 *    by a non-empty `sourceAnalysisId` (no analysis -> no drawing);
 *  - coordinates must be finite, with `upperPrice > lowerPrice` and
 *    `startEpoch < endEpoch` — invalid input is rejected outright rather than
 *    coerced, so a drawing is never silently moved to the wrong price.
 */

const STORAGE_KEY = 'wicksentinel_drawings_v1';

export interface DrawingState {
  records: readonly DrawingRecord[];
  /** Master visibility switch for the whole drawing layer. */
  visible: boolean;
}

export interface CreateDrawingInput {
  symbol: string;
  direction: DrawingDirection;
  timeframe: Timeframe;
  startEpoch: number;
  endEpoch: number;
  upperPrice: number;
  lowerPrice: number;
  sourceAnalysisId: string;
  reason?: string;
  source?: DrawingRecord['source'];
  /** Injectable clock/id for deterministic tests. */
  id?: string;
  now?: number;
}

const VALID_TIMEFRAMES: readonly Timeframe[] = ['1m', '2m', '5m', '15m', '1h', '4h'];

function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** A drawing record is only valid if every coordinate is real and ordered. */
export function isValidDrawingRecord(r: DrawingRecord): boolean {
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.symbol === 'string' &&
    r.symbol.length > 0 &&
    (r.direction === 'RISE' || r.direction === 'FALL') &&
    VALID_TIMEFRAMES.includes(r.timeframe) &&
    isFinitePositive(r.startEpoch) &&
    isFinitePositive(r.endEpoch) &&
    r.endEpoch > r.startEpoch &&
    Number.isFinite(r.upperPrice) &&
    Number.isFinite(r.lowerPrice) &&
    r.upperPrice > r.lowerPrice &&
    typeof r.sourceAnalysisId === 'string' &&
    r.sourceAnalysisId.length > 0 &&
    Number.isFinite(r.createdAt)
  );
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `drw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class DrawingStore {
  private records = new Map<string, DrawingRecord>();
  private visible = true;
  private listeners = new Set<() => void>();
  private snapshot: DrawingState = { records: [], visible: true };
  private readonly persist: boolean;

  constructor(options: { persist?: boolean; initial?: DrawingRecord[] } = {}) {
    this.persist = options.persist ?? true;
    const seeded = options.initial ?? (this.persist ? readPersisted() : []);
    for (const r of seeded) {
      if (isValidDrawingRecord(r)) this.records.set(r.id, r);
    }
    this.rebuildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DrawingState => this.snapshot;

  /**
   * Create a drawing from a validated zone. Returns the new record, or `null`
   * when the input is not a validated zone — in which case nothing is stored.
   */
  addFromZone(input: CreateDrawingInput): DrawingRecord | null {
    const record: DrawingRecord = {
      id: input.id ?? newId(),
      symbol: input.symbol,
      direction: input.direction,
      timeframe: input.timeframe,
      startEpoch: Math.floor(input.startEpoch),
      endEpoch: Math.floor(input.endEpoch),
      upperPrice: input.upperPrice,
      lowerPrice: input.lowerPrice,
      sourceAnalysisId: input.sourceAnalysisId,
      createdAt: input.now ?? Date.now(),
      source: input.source ?? 'ANALYSIS',
      reason: input.reason
    };

    if (!isValidDrawingRecord(record)) return null;
    this.records.set(record.id, record);
    this.commit();
    return record;
  }

  remove(id: string): boolean {
    const existed = this.records.delete(id);
    if (existed) this.commit();
    return existed;
  }

  clear(): void {
    if (this.records.size === 0) return;
    this.records.clear();
    this.commit();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.commit();
  }

  /** Records for one symbol, optionally narrowed to a timeframe. */
  listForSymbol(symbol: string, timeframe?: Timeframe): DrawingRecord[] {
    return this.snapshot.records.filter(
      (r) => r.symbol === symbol && (timeframe === undefined || r.timeframe === timeframe)
    );
  }

  size(): number {
    return this.records.size;
  }

  private rebuildSnapshot(): void {
    this.snapshot = { records: [...this.records.values()], visible: this.visible };
  }

  private commit(): void {
    this.rebuildSnapshot();
    if (this.persist) writePersisted(this.snapshot.records);
    this.listeners.forEach((l) => l());
  }
}

function readPersisted(): DrawingRecord[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DrawingRecord[]) : [];
  } catch {
    return [];
  }
}

function writePersisted(records: readonly DrawingRecord[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Storage can be unavailable (private mode, quota); drawings still work in memory.
  }
}
