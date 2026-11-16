import type {
  EntryDecisionState,
  EntryModelDecision,
  EntryModelEvaluation,
  EntryModelKind,
  EntryModelMarketContext,
  EntryModelOutcomeRecord,
  EntryModelPerformance,
  EntryModelSetupInput,
} from '../types/entryModelAI';
import { ENTRY_MODEL_KIND_LABELS } from '../types/entryModelAI';

/**
 * UNIVERSAL ENTRY MODEL AI.
 *
 * Evaluates every applicable entry model INDEPENDENTLY for each qualified setup submitted
 * by any specialised strategy AI, then selects the single model with the strongest genuine
 * supporting evidence. It never forces one model onto every strategy, never uses every
 * model at once, and never labels an unconfirmed watching zone as a confirmed entry — when
 * no model carries enough confirmation it returns WATCHING/WAITING with no manufactured
 * signal.
 */

const SUPPORT_THRESHOLD = 24;

/** Evidence keywords per model — matched against the setup's own reasons + evidence. */
const MODEL_KEYWORDS: Record<EntryModelKind, readonly string[]> = {
  LIQUIDITY_SWEEP_REVERSAL: ['sweep', 'liquidity', 'stop hunt', 'stop-run', 'raid', 'took out', 'grab'],
  BOS_RETEST: ['bos', 'break of structure', 'structure break', 'retest'],
  CHOCH_MSS: ['choch', 'mss', 'change of character', 'market structure shift', 'structure shift'],
  ORDER_BLOCK_MITIGATION: ['order block', 'orderblock', 'ob retest', 'mitigation', 'ob '],
  FVG_ENTRY: ['fvg', 'fair value gap', 'imbalance', 'gap fill'],
  BREAKER_MITIGATION_BLOCK: ['breaker', 'mitigation block'],
  SUPPLY_DEMAND_REJECTION: ['supply', 'demand', 'zone rejection', 'zone reaction'],
  SUPPORT_RESISTANCE_RETEST: ['support', 'resistance', 's/r', 'role flip', 'role reversal'],
  TRENDLINE_REJECTION_CONTINUATION: ['trendline', 'trend line', 'line rejection', 'line continuation'],
  BREAKOUT_RETEST: ['breakout', 'break and retest', 'break & retest', 'break-retest', 'retest'],
  SWING_HIGH_LOW_REJECTION: ['swing high', 'swing low', 'swing rejection', 'swing point'],
  DISPLACEMENT_REJECTION: ['displacement', 'engulf', 'rejection wick', 'wick rejection', 'strong close', 'body close'],
  PREMIUM_DISCOUNT: ['premium', 'discount', 'dealing range', 'equilibrium', 'ote', 'fib'],
};

/** The originating strategy model label maps to the entry model it already detected. */
const ORIGIN_LABEL_MODELS: readonly { pattern: RegExp; kind: EntryModelKind }[] = [
  { pattern: /liquidity|sweep/i, kind: 'LIQUIDITY_SWEEP_REVERSAL' },
  { pattern: /choch|mss/i, kind: 'CHOCH_MSS' },
  { pattern: /bos|structure.?break/i, kind: 'BOS_RETEST' },
  { pattern: /order.?block|ob_/i, kind: 'ORDER_BLOCK_MITIGATION' },
  { pattern: /breaker|mitigation/i, kind: 'BREAKER_MITIGATION_BLOCK' },
  { pattern: /fvg|imbalance/i, kind: 'FVG_ENTRY' },
  { pattern: /supply|demand|zone|fresh.?rejection|retest.?continuation/i, kind: 'SUPPLY_DEMAND_REJECTION' },
  { pattern: /trendline/i, kind: 'TRENDLINE_REJECTION_CONTINUATION' },
  { pattern: /breakout|break.?retest/i, kind: 'BREAKOUT_RETEST' },
  { pattern: /sr|support|resistance|role.?flip/i, kind: 'SUPPORT_RESISTANCE_RETEST' },
  { pattern: /swing/i, kind: 'SWING_HIGH_LOW_REJECTION' },
  { pattern: /premium|discount/i, kind: 'PREMIUM_DISCOUNT' },
  { pattern: /momentum|displacement|engulf/i, kind: 'DISPLACEMENT_REJECTION' },
];

const REQUIRED_CONFIRMATION: Record<EntryModelKind, string> = {
  LIQUIDITY_SWEEP_REVERSAL: 'A liquidity sweep beyond the level followed by a decisive close back inside (reversal confirmation).',
  BOS_RETEST: 'A confirmed break of structure, then price retesting the broken level and holding.',
  CHOCH_MSS: 'A change of character / market-structure shift confirmed by a body close through the prior swing.',
  ORDER_BLOCK_MITIGATION: 'Price returning into the order block and printing a rejection or displacement away from it.',
  FVG_ENTRY: 'Price tapping the fair value gap and closing back out of it (imbalance mitigation).',
  BREAKER_MITIGATION_BLOCK: 'Price retesting the breaker block and holding with a rejection close.',
  SUPPLY_DEMAND_REJECTION: 'A rejection wick plus body close away from the supply/demand zone.',
  SUPPORT_RESISTANCE_RETEST: 'Price retesting the level and holding with a confirmed rejection close.',
  TRENDLINE_REJECTION_CONTINUATION: 'A rejection off the trendline that continues the prevailing direction.',
  BREAKOUT_RETEST: 'A breakout, then a successful retest of the breakout level holding as new support/resistance.',
  SWING_HIGH_LOW_REJECTION: 'A rejection from the swing high/low with a displacement close in the trade direction.',
  DISPLACEMENT_REJECTION: 'A displacement candle / engulfing close confirming rejection at the entry area.',
  PREMIUM_DISCOUNT: 'Price entering the premium (for FALL) or discount (for RISE) of the dealing range and reacting.',
};

function textOf(setup: EntryModelSetupInput): string {
  return [setup.originatingModelLabel, ...setup.reasons, ...setup.evidence]
    .join(' | ')
    .toLowerCase();
}

function originatingKind(setup: EntryModelSetupInput): EntryModelKind | null {
  for (const { pattern, kind } of ORIGIN_LABEL_MODELS) {
    if (pattern.test(setup.originatingModelLabel)) return kind;
  }
  return null;
}

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Evaluates ONE model independently against the setup's own evidence. */
function evaluateModel(
  kind: EntryModelKind,
  setup: EntryModelSetupInput,
  text: string,
  originKind: EntryModelKind | null,
  historicalBonus: Partial<Record<EntryModelKind, number>>
): EntryModelEvaluation {
  const matched: string[] = [];
  for (const kw of MODEL_KEYWORDS[kind]) {
    if (text.includes(kw)) matched.push(kw.trim());
  }
  let supportScore = matched.length * 12;
  if (originKind === kind) supportScore += 22; // preserve the strategy's own detection logic
  supportScore += historicalBonus[kind] ?? 0;
  supportScore = clamp(supportScore);

  const supported = supportScore >= SUPPORT_THRESHOLD;
  const reason = supported
    ? `Matched ${matched.length} evidence signal(s): ${matched.slice(0, 3).join(', ') || setup.originatingModelLabel}.`
    : 'Insufficient supporting evidence for this entry model.';
  return { kind, label: ENTRY_MODEL_KIND_LABELS[kind], supported, supportScore, matchedEvidence: matched, reason };
}

function buildEntryGeometry(
  setup: EntryModelSetupInput,
  atr: number
): { low: number | null; high: number | null } {
  if (setup.entryZoneLow !== null && setup.entryZoneHigh !== null) {
    return { low: Math.min(setup.entryZoneLow, setup.entryZoneHigh), high: Math.max(setup.entryZoneLow, setup.entryZoneHigh) };
  }
  if (setup.entryPrice !== null) {
    const pad = atr > 0 ? atr * 0.2 : Math.abs(setup.entryPrice) * 0.0005;
    return { low: setup.entryPrice - pad, high: setup.entryPrice + pad };
  }
  return { low: null, high: null };
}

function decideState(
  setup: EntryModelSetupInput,
  geometry: { low: number | null; high: number | null },
  price: number,
  atr: number,
  hasModel: boolean,
  setupInput: EntryModelSetupInput,
  now: number
): EntryDecisionState {
  // Invalidation takes precedence: price already beyond the meaningful stop.
  if (setup.stopLoss !== null) {
    if (setup.direction === 'RISE' && price <= setup.stopLoss) return 'INVALIDATED';
    if (setup.direction === 'FALL' && price >= setup.stopLoss) return 'INVALIDATED';
  }
  // Expiry: a setup whose own timeframe lifetime has elapsed is stale, never actionable.
  if (expiryForTimeframe(setupInput.timeframe, setupInput.confirmedBarTime) <= now) return 'EXPIRED';
  if (geometry.low === null || geometry.high === null) {
    return hasModel ? 'CONFIRMED' : 'WAITING';
  }
  const approachTol = atr > 0 ? atr * 0.5 : Math.abs(price) * 0.001;
  // At the entry area (inside the zone plus a small tolerance).
  if (price >= geometry.low - approachTol && price <= geometry.high + approachTol) {
    return hasModel ? 'CONFIRMED' : 'WAITING';
  }
  // Direction-aware: approaching means price is still on the pre-entry side of the zone;
  // beyond the zone means the entry opportunity has already been missed.
  if (setup.direction === 'RISE') {
    return price < geometry.low ? 'WATCHING' : 'MISSED';
  }
  return price > geometry.high ? 'WATCHING' : 'MISSED';
}

function scoreQuality(
  setup: EntryModelSetupInput,
  best: EntryModelEvaluation | null,
  state: EntryDecisionState,
  htfAligned: boolean
): number {
  let q = setup.score * 0.45;
  if (best) q += best.supportScore * 0.35;
  const rr = setup.riskRewardRatio ?? 0;
  q += rr >= 2 ? 14 : rr >= 1.5 ? 10 : rr >= 1 ? 5 : 0;
  if (state === 'CONFIRMED') q += 12;
  else if (state === 'WAITING') q += 4;
  if (htfAligned) q += 8;
  // A missed or invalidated setup can never carry a high quality score.
  if (state === 'MISSED' || state === 'INVALIDATED') q = Math.min(q, 30);
  return clamp(Math.round(q));
}

/**
 * Evaluates the best entry model for ONE qualified setup. Pure — no side effects.
 *
 * `now` (epoch ms) is used only to derive the candidate's expiry window from the setup's
 * own timeframe; it never invents market data.
 */
export function evaluateEntryModel(
  setup: EntryModelSetupInput,
  context: EntryModelMarketContext,
  now = Date.now()
): EntryModelDecision {
  const text = textOf(setup);
  const originKind = originatingKind(setup);
  const historicalBonus = context.historicalBonus ?? {};

  const evaluations = (Object.keys(ENTRY_MODEL_KIND_LABELS) as EntryModelKind[]).map((kind) =>
    evaluateModel(kind, setup, text, originKind, historicalBonus)
  );

  const supported = evaluations
    .filter((e) => e.supported)
    .sort((a, b) => b.supportScore - a.supportScore);
  const best = supported[0] ?? null;

  // Combine only compatible models that genuinely reinforce the selection (never all).
  const combinedWith = best
    ? supported
        .slice(1)
        .filter((e) => e.supportScore >= Math.max(SUPPORT_THRESHOLD, best.supportScore * 0.75))
        .slice(0, 2)
        .map((e) => e.kind)
    : [];

  const geometry = buildEntryGeometry(setup, context.atr);
  const state = decideState(setup, geometry, context.price, context.atr, best !== null, setup, now);
  const htfAligned = context.htfDirection === setup.direction;
  const qualityScore = scoreQuality(setup, best, state, htfAligned);

  const model = best?.kind ?? null;
  const dataTimestamp = context.dataTimestamp ?? setup.confirmedBarTime;
  const expiresAt = expiryForTimeframe(setup.timeframe, setup.confirmedBarTime);

  const explanation = buildExplanation(setup, best, combinedWith, state, htfAligned, context);

  return {
    key: setup.key,
    originatingStrategy: setup.sourceLabel,
    marketName: setup.displayName,
    symbol: setup.symbol,
    marketFamily: setup.marketFamily,
    timeframe: setup.timeframe,
    direction: setup.direction,
    state,
    model,
    modelLabel: model ? ENTRY_MODEL_KIND_LABELS[model] : 'No model — awaiting confirmation',
    combinedWith,
    htfDirection: context.htfDirection,
    watchingZone: geometry.low !== null && geometry.high !== null ? { low: geometry.low, high: geometry.high } : null,
    entryPrice: setup.entryPrice,
    entryRange: geometry.low !== null && geometry.high !== null ? { low: geometry.low, high: geometry.high } : null,
    requiredConfirmation: model ? REQUIRED_CONFIRMATION[model] : 'Wait for a model with clear confirmation — no entry is manufactured without one.',
    stopLoss: setup.stopLoss,
    invalidation: {
      level: setup.stopLoss,
      condition:
        setup.stopLoss !== null
          ? `A close beyond ${setup.stopLoss} invalidates the setup.`
          : 'No meaningful invalidation level — setup rejected.',
    },
    targets: { tp1: setup.takeProfit1, tp2: setup.takeProfit2, tp3: setup.takeProfit3 },
    riskRewardRatio: setup.riskRewardRatio,
    qualityScore,
    confirmedBarTime: setup.confirmedBarTime,
    dataTimestamp,
    expiresAt,
    indexValidatedModel: context.indexProfile?.model ?? null,
    indexValidatedModelLabel: context.indexProfile?.label ?? null,
    explanation,
    evaluations,
  };
}

/** Setup lifetime (ms) by timeframe — a candidate older than this is stale, not actionable. */
export function expiryForTimeframe(timeframe: import('../types/market').TimeframeKey, confirmedBarTime: number): number {
  const seconds: Record<string, number> = {
    M1: 60 * 20,
    M3: 180 * 20,
    M5: 300 * 20,
    M7: 420 * 20,
    M15: 900 * 20,
    H1: 3600 * 12,
    H4: 3600 * 24,
  };
  const span = seconds[timeframe] ?? 300 * 20;
  return (confirmedBarTime + span) * 1000;
}

function buildExplanation(
  setup: EntryModelSetupInput,
  best: EntryModelEvaluation | null,
  combined: readonly EntryModelKind[],
  state: EntryDecisionState,
  htfAligned: boolean,
  context: EntryModelMarketContext
): string {
  if (!best) {
    return `No entry model carries sufficient confirmation for this ${setup.sourceLabel} setup — standing aside rather than manufacturing a signal.`;
  }
  const parts: string[] = [];
  parts.push(`Selected ${best.label} — ${best.reason}`);
  if (combined.length > 0) {
    parts.push(`Reinforced by ${combined.map((k) => ENTRY_MODEL_KIND_LABELS[k]).join(' and ')}.`);
  }
  if (context.htfDirection) {
    parts.push(
      htfAligned
        ? `M15 direction agrees (${context.htfDirection}).`
        : `M15 direction (${context.htfDirection}) does not align — lower conviction.`
    );
  }
  const stateText: Record<EntryDecisionState, string> = {
    WATCHING: 'Price is still approaching the entry area.',
    WAITING: 'Price has reached the area but the model confirmation is missing.',
    CONFIRMED: 'Entry conditions are satisfied.',
    INVALIDATED: 'The setup no longer qualifies.',
    MISSED: 'Price has already moved beyond the acceptable entry area.',
    EXPIRED: 'The setup has aged past its actionable window.',
  };
  parts.push(stateText[state]);
  if (context.indexProfile?.model) {
    parts.push(
      context.indexProfile.retained
        ? `This index's validated model (${context.indexProfile.label}) was retained from its own recorded outcomes.`
        : `This index's learned model is ${context.indexProfile.label}.`
    );
  }
  return parts.join(' ');
}

/** Evaluates the best entry model for a batch of qualified setups. */
export function evaluateEntryModels(
  setups: readonly EntryModelSetupInput[],
  contexts: ReadonlyMap<string, EntryModelMarketContext>,
  now = Date.now()
): EntryModelDecision[] {
  const out: EntryModelDecision[] = [];
  for (const setup of setups) {
    const context = contexts.get(setup.key);
    if (!context) continue;
    out.push(evaluateEntryModel(setup, context, now));
  }
  return out;
}

/** True only when a decision is fully validated and actionable for the final ranking. */
export function isRankableDecision(decision: EntryModelDecision): boolean {
  return decision.state === 'CONFIRMED' && decision.model !== null;
}

const MIN_RELIABLE_SAMPLE = 20;

/**
 * Aggregates recorded outcomes into per-model, sample-aware performance. Win rates are
 * withheld below a meaningful sample — no fabricated performance is ever reported.
 */
export function aggregateEntryModelPerformance(
  records: readonly EntryModelOutcomeRecord[]
): EntryModelPerformance[] {
  const byModel = new Map<EntryModelKind | 'UNKNOWN', EntryModelOutcomeRecord[]>();
  for (const record of records) {
    const list = byModel.get(record.model) ?? [];
    list.push(record);
    byModel.set(record.model, list);
  }
  const out: EntryModelPerformance[] = [];
  for (const [model, list] of byModel) {
    const wins = list.filter((r) => r.outcome === 'TARGET_HIT').length;
    const losses = list.filter((r) => r.outcome === 'STOP_HIT' || r.outcome === 'INVALIDATED').length;
    const missed = list.filter((r) => r.outcome === 'MISSED').length;
    const rrValues = list.map((r) => r.riskRewardRatio).filter((v): v is number => v !== null);
    const sampleSize = wins + losses;
    out.push({
      model,
      label: model === 'UNKNOWN' ? 'Unclassified' : ENTRY_MODEL_KIND_LABELS[model],
      sampleSize: list.length,
      wins,
      losses,
      missed,
      winRatePercent: sampleSize >= MIN_RELIABLE_SAMPLE ? Math.round((wins / sampleSize) * 100) : null,
      avgRiskReward:
        rrValues.length > 0
          ? Math.round((rrValues.reduce((a, b) => a + b, 0) / rrValues.length) * 100) / 100
          : null,
      reliable: sampleSize >= MIN_RELIABLE_SAMPLE,
    });
  }
  return out.sort((a, b) => b.sampleSize - a.sampleSize);
}

/**
 * Converts recorded outcomes into the historical bonus the selection reads, so models that
 * actually perform better are genuinely preferred. Models without a trustworthy sample get
 * no bonus (never a fabricated one).
 */
export function historicalBonusFromPerformance(
  performance: readonly EntryModelPerformance[]
): Partial<Record<EntryModelKind, number>> {
  const bonus: Partial<Record<EntryModelKind, number>> = {};
  for (const p of performance) {
    if (!p.reliable || p.model === 'UNKNOWN' || p.winRatePercent === null) continue;
    if (p.winRatePercent >= 60) bonus[p.model] = 8;
    else if (p.winRatePercent >= 50) bonus[p.model] = 4;
    else if (p.winRatePercent < 40) bonus[p.model] = -6;
  }
  return bonus;
}
