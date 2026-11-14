import { buildMarketSnapshot } from './snapshot';
import {
  checkPrerequisites,
  type AnalysisResult,
  type AnalysisStage,
  type AnalysisStageId,
  type EngineRunRecord,
  type RunAnalysisInput
} from './types';
import type { EngineOutput, EngineZone } from './engines/types';

/**
 * Analysis orchestration.
 *
 * Runs the workflow the product promises, in order, and is honest at every
 * step:
 *   1. verify the snapshot (connection, symbol, timeframe, completeness, freshness);
 *   2. run the deterministic technical pipeline;
 *   3. dispatch to whichever AI engines are actually available;
 *   4. compare engine outputs;
 *   5. validate and produce a result — or WAIT when engines disagree or the
 *      evidence is insufficient.
 *
 * Guarantees:
 *   - a directional result is only produced when the deterministic engine
 *     validated a zone and no *available* engine contradicts it;
 *   - an unavailable engine is reported UNAVAILABLE and never asked for output;
 *   - a failed engine is reported FAILED and never silently counted as agreeing;
 *   - nothing is fabricated — a `zone` is null unless a real one was produced.
 */

const STAGE_LABELS: Record<AnalysisStageId, string> = {
  'market-data': 'Market data verification',
  technical: 'Technical analysis',
  'ai-engines': 'Specialized AI engine execution',
  comparison: 'Cross-engine comparison',
  validation: 'Final validation'
};

const STAGE_ORDER: AnalysisStageId[] = [
  'market-data',
  'technical',
  'ai-engines',
  'comparison',
  'validation'
];

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ana_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Runs one engine with its own timeout, so one slow engine cannot hang the run. */
async function runEngine(
  engine: import('./engines/types').AnalysisEngine,
  snapshot: import('./engines/types').MarketSnapshot,
  parentSignal: AbortSignal,
  timeoutMs: number
): Promise<{ record: EngineRunRecord; output: EngineOutput | null }> {
  const availability = engine.checkAvailability();
  if (!availability.available) {
    return {
      record: {
        engineId: engine.id,
        engineName: engine.name,
        status: 'UNAVAILABLE',
        reason: availability.reason
      },
      output: null
    };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parentSignal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const output = await engine.analyze(snapshot, controller.signal);
    return {
      record: {
        engineId: engine.id,
        engineName: engine.name,
        status: 'COMPLETED',
        completedAtMs: output.completedAtMs,
        direction: output.direction,
        score: output.score,
        summary: output.summary,
        zoneCount: output.zones.length
      },
      output
    };
  } catch (err) {
    const aborted = parentSignal.aborted;
    return {
      record: {
        engineId: engine.id,
        engineName: engine.name,
        status: 'FAILED',
        reason: aborted
          ? 'Cancelled'
          : err instanceof Error
            ? err.message
            : 'Engine failed'
      },
      output: null
    };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onAbort);
  }
}

export async function runAnalysis(
  input: RunAnalysisInput,
  signal: AbortSignal
): Promise<AnalysisResult> {
  const now = input.now ?? (() => Date.now());
  const startedAtMs = now();
  const id = input.id ?? newId();
  const timeoutMs = input.timeoutMs ?? 20000;

  const stages: AnalysisStage[] = STAGE_ORDER.map((sid) => ({
    id: sid,
    label: STAGE_LABELS[sid],
    status: 'PENDING'
  }));
  const emit = () => input.onProgress?.(stages.map((s) => ({ ...s })));
  const setStage = (sid: AnalysisStageId, status: AnalysisStage['status'], detail?: string) => {
    const s = stages.find((x) => x.id === sid);
    if (s) {
      s.status = status;
      if (detail !== undefined) s.detail = detail;
    }
    emit();
  };

  const base = {
    id,
    symbol: input.symbol,
    displayName: input.displayName,
    timeframe: input.timeframe,
    startedAtMs,
    completedAtMs: 0
  };

  const snapshot = buildMarketSnapshot({
    symbol: input.symbol,
    displayName: input.displayName,
    timeframe: input.timeframe,
    candles: input.candles,
    capturedAtMs: startedAtMs
  });

  // Stage 1 — market data verification.
  setStage('market-data', 'RUNNING');
  const prereq = checkPrerequisites({
    connectionState: input.connectionState,
    hasSymbol: input.symbol.length > 0,
    hasTimeframe: Boolean(input.timeframe),
    candleCount: input.candles.length,
    minCandles: 20,
    isStale: input.isStale
  });
  if (!prereq.ok) {
    setStage('market-data', 'FAILED', prereq.reason);
    for (const sid of STAGE_ORDER.slice(1)) setStage(sid, 'SKIPPED');
    return {
      ...base,
      status: 'FAILED',
      direction: 'WAIT',
      snapshot,
      engines: [],
      zone: null,
      notes: [prereq.reason ?? 'Prerequisites not met.'],
      completedAtMs: now(),
      error: prereq.reason
    };
  }
  if (!snapshot.complete) {
    setStage('market-data', 'FAILED', snapshot.incompleteReason);
    for (const sid of STAGE_ORDER.slice(1)) setStage(sid, 'SKIPPED');
    return {
      ...base,
      status: 'FAILED',
      direction: 'WAIT',
      snapshot,
      engines: [],
      zone: null,
      notes: [snapshot.incompleteReason ?? 'Snapshot incomplete.'],
      completedAtMs: now(),
      error: snapshot.incompleteReason
    };
  }
  setStage(
    'market-data',
    'COMPLETED',
    `${snapshot.candleCount} ${snapshot.timeframe.toUpperCase()} candles · ${Math.round(snapshot.freshnessMs / 1000)}s old`
  );

  // Stage 2 — technical analysis + stage 3 — AI engines, dispatched together.
  setStage('technical', 'RUNNING');
  setStage('ai-engines', 'RUNNING');

  const results = await Promise.all(
    input.engines.map((e) => runEngine(e, snapshot, signal, timeoutMs))
  );

  const records = results.map((r) => r.record);
  const outputs = results.map((r) => r.output).filter((o): o is EngineOutput => o !== null);

  const technical = records.find((r) => r.engineId === 'deterministic-price-action');
  if (technical?.status === 'COMPLETED') {
    setStage('technical', 'COMPLETED');
  } else {
    setStage('technical', technical?.status === 'FAILED' ? 'FAILED' : 'SKIPPED', technical?.reason);
  }

  const aiRecords = records.filter((r) => r.engineId !== 'deterministic-price-action');
  const aiCompleted = aiRecords.filter((r) => r.status === 'COMPLETED').length;
  const aiUnavailable = aiRecords.filter((r) => r.status === 'UNAVAILABLE').length;
  setStage(
    'ai-engines',
    'COMPLETED',
    aiCompleted > 0
      ? `${aiCompleted} engine(s) returned output`
      : `${aiUnavailable} engine(s) unavailable — no AI output produced`
  );

  if (signal.aborted) {
    setStage('comparison', 'SKIPPED');
    setStage('validation', 'SKIPPED');
    return {
      ...base,
      status: 'FAILED',
      direction: 'WAIT',
      snapshot,
      engines: records,
      zone: null,
      notes: ['Analysis cancelled.'],
      completedAtMs: now(),
      error: 'cancelled'
    };
  }

  // Stage 4 — cross-engine comparison.
  setStage('comparison', 'RUNNING');
  const notes: string[] = [];
  const directions = new Set(outputs.map((o) => o.direction).filter((d) => d !== 'WAIT'));
  const deterministicOutput = outputs.find((o) => o.engineId === 'deterministic-price-action');
  let disagree = directions.size > 1;

  if (aiCompleted === 0) {
    notes.push(
      aiUnavailable > 0
        ? `No AI engine is available (${aiUnavailable} unavailable); result rests on the price-action engine alone.`
        : 'No AI engine produced output.'
    );
  }
  if (disagree) notes.push('Available engines disagree on direction; withholding a directional call.');
  if (aiRecords.some((r) => r.status === 'FAILED')) {
    notes.push('One or more engines failed; their output is excluded from validation.');
  }
  setStage(
    'comparison',
    'COMPLETED',
    disagree ? 'Engines disagree' : `${directions.size || 0} direction(s) among available engines`
  );

  // Stage 5 — final validation.
  setStage('validation', 'RUNNING');

  const zone: EngineZone | null = deterministicOutput?.zones[0] ?? null;
  let status: AnalysisResult['status'] = 'WAIT';
  let direction: AnalysisResult['direction'] = 'WAIT';

  if (!deterministicOutput) {
    notes.push('Price-action engine produced no output; no result can be validated.');
  } else if (deterministicOutput.direction === 'WAIT') {
    notes.push('Price-action engine returned WAIT — no validated directional setup.');
  } else if (disagree) {
    notes.push('Directional call withheld because engines disagree.');
  } else if (!zone) {
    notes.push('No validated zone was produced, so no directional result or drawing.');
  } else {
    status = 'COMPLETED';
    direction = deterministicOutput.direction;
    notes.push(
      zone.confidence !== undefined
        ? 'Validated against available engines.'
        : 'Validated against available engines (deterministic only).'
    );
  }
  setStage('validation', status === 'COMPLETED' ? 'COMPLETED' : 'COMPLETED', status === 'COMPLETED' ? 'Validated' : 'Withheld');

  return {
    ...base,
    status,
    direction,
    snapshot,
    engines: records,
    zone,
    notes,
    completedAtMs: now()
  };
}
