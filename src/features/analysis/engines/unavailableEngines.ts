import type { AnalysisEngine, EngineAvailability, EngineOutput, MarketSnapshot } from './types';

/**
 * Interface-only AI engine slots.
 *
 * The product declares its specialized AI engines here so the analysis panel can
 * show their *real* state. None of them has an inference provider wired up yet,
 * so every one reports `UNAVAILABLE` and is never asked to produce output. This
 * is deliberate: a placeholder that returned a plausible-looking RISE/FALL would
 * be fabricated analysis, which the product must never show.
 *
 * When a provider is actually integrated, implement `analyze` against it and
 * flip `checkAvailability` — nothing else needs to change.
 */
export class UnavailableAnalysisEngine implements AnalysisEngine {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly description: string,
    private readonly unavailableReason: string
  ) {}

  checkAvailability(): EngineAvailability {
    return { available: false, reason: this.unavailableReason };
  }

  async analyze(_snapshot: MarketSnapshot, _signal: AbortSignal): Promise<EngineOutput> {
    // Defensive: the orchestrator must never call this. If it somehow does, fail
    // loudly rather than fabricate a result.
    throw new Error(`${this.name} has no inference provider configured`);
  }
}

const NO_PROVIDER = 'No inference provider configured for this engine.';

/**
 * The declared specialized engines. Order is the order shown in the panel.
 *
 * These are named for the roles the product intends them to play; they carry no
 * results until a provider is integrated.
 */
export function createDeclaredAiEngines(): AnalysisEngine[] {
  return [
    new UnavailableAnalysisEngine(
      'ai-market-context',
      'AI Market Context',
      'Narrative read of regime, catalysts and market context',
      NO_PROVIDER
    ),
    new UnavailableAnalysisEngine(
      'ai-pattern-vision',
      'AI Pattern Vision',
      'Vision model over rendered chart imagery',
      NO_PROVIDER
    ),
    new UnavailableAnalysisEngine(
      'ai-risk-review',
      'AI Risk Review',
      'Independent adversarial review of the deterministic result',
      NO_PROVIDER
    )
  ];
}
