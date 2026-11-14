import { OpportunityScoringEngine } from '../../../engines/OpportunityScoringEngine';
import type { ActiveSymbol, Candle, OpportunitySignal } from '../../../types/scanner';
import type {
  AnalysisEngine,
  EngineAvailability,
  EngineDirection,
  EngineOutput,
  EngineZone,
  MarketSnapshot
} from './types';

/**
 * The deterministic engine wraps WickSentinel's own multi-timeframe price-action
 * pipeline (`OpportunityScoringEngine`). It is real, tested logic — not an AI
 * provider — and it is always available, so the analysis pipeline can produce a
 * trustworthy result even when no AI engine is configured.
 *
 * It only ever reports zones the engine already published: the valid tradeable
 * range and confirmed entry levels. It never invents a level.
 */

export interface DeterministicEngineDeps {
  /** Candle buffers keyed by timeframe, as owned by the market-data service. */
  candlesFor: (symbol: string) => {
    '1m'?: Candle[];
    '5m'?: Candle[];
    '15m'?: Candle[];
    '1h'?: Candle[];
    '4h'?: Candle[];
  };
  /** Symbol metadata (pip size, display name) from the feed. */
  symbolInfoFor: (symbol: string) => ActiveSymbol | undefined;
  minScoreThreshold?: number;
  fvgMinDisplacement?: number;
}

/** Derive the engine's directional lean from its own rise/fall label. */
function directionFromSignal(signal: OpportunitySignal): EngineDirection {
  if (signal.riseFallLabel === 'BUY / RISE') return 'RISE';
  if (signal.riseFallLabel === 'SELL / FALL') return 'FALL';
  return 'WAIT';
}

/**
 * Build a zone from the signal's own published range/entry data. Returns null
 * when the engine did not validate a range or a confirmed entry — in which case
 * no zone exists and the UI must say so.
 */
export function zoneFromSignal(signal: OpportunitySignal): EngineZone | null {
  const range = signal.tradingRange;
  const entry = signal.entryAndTp;

  const direction: 'RISE' | 'FALL' | null =
    entry.confirmed && entry.status === 'CONFIRMED_ENTRY'
      ? entry.direction === 'BULLISH'
        ? 'RISE'
        : entry.direction === 'BEARISH'
          ? 'FALL'
          : null
      : null;

  if (!direction) return null;
  if (!range.isValid) return null;

  const evidence: string[] = [];
  if (range.isValid) {
    evidence.push(
      `Valid ${range.timeframe.toUpperCase()} tradeable range ${range.rangeLow.toFixed(2)}–${range.rangeHigh.toFixed(2)}`
    );
    evidence.push(`Price positioned in the ${range.currentPosition.toLowerCase()} of the range`);
  }
  if (entry.entryRationale) evidence.push(entry.entryRationale);
  if (signal.selectedStrategy?.label) evidence.push(`Strategy: ${signal.selectedStrategy.label}`);

  return {
    direction,
    timeframe: range.timeframe,
    upperPrice: Math.max(range.rangeHigh, range.rangeLow),
    lowerPrice: Math.min(range.rangeHigh, range.rangeLow),
    reason:
      direction === 'RISE'
        ? 'Validated demand-side entry within the tradeable range.'
        : 'Validated supply-side entry within the tradeable range.',
    evidence,
    invalidation: entry.invalidationLevel !== undefined ? `Invalidation at ${entry.invalidationLevel}` : undefined,
    startEpoch: Number.isFinite(range.startEpoch) ? range.startEpoch : undefined,
    endEpoch: Number.isFinite(range.endEpoch) ? range.endEpoch : undefined
    // No confidence figure: the engine publishes a confluence *score*, not a
    // probability. Reporting one here would fabricate a number it never made.
  };
}

export class DeterministicAnalysisEngine implements AnalysisEngine {
  readonly id = 'deterministic-price-action';
  readonly name = 'Price-Action Engine';
  readonly description = 'WickSentinel multi-timeframe structure, range and confirmation pipeline';

  constructor(private readonly deps: DeterministicEngineDeps) {}

  checkAvailability(): EngineAvailability {
    return { available: true };
  }

  async analyze(snapshot: MarketSnapshot, signal: AbortSignal): Promise<EngineOutput> {
    const info = this.deps.symbolInfoFor(snapshot.symbol);
    if (!info) throw new Error('Symbol metadata unavailable');
    if (signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError');

    const candles = this.deps.candlesFor(snapshot.symbol);
    const opportunity = OpportunityScoringEngine.analyzeTopDown({
      symbolInfo: info,
      c4h: candles['4h'] ?? [],
      c1h: candles['1h'] ?? [],
      c15m: candles['15m'] ?? [],
      c5m: candles['5m'] ?? [],
      c1m: candles['1m'] ?? [],
      minScoreThreshold: this.deps.minScoreThreshold ?? 75,
      fvgMinDisplacement: this.deps.fvgMinDisplacement ?? 0.00025
    });

    if (signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError');

    if (!opportunity) {
      return {
        engineId: this.id,
        engineName: this.name,
        direction: 'WAIT',
        zones: [],
        summary: 'Insufficient multi-timeframe history for a validated setup.',
        completedAtMs: Date.now()
      };
    }

    const zone = zoneFromSignal(opportunity);
    return {
      engineId: this.id,
      engineName: this.name,
      direction: directionFromSignal(opportunity),
      score: opportunity.score.total,
      zones: zone ? [zone] : [],
      summary: opportunity.explanation,
      completedAtMs: Date.now()
    };
  }
}
