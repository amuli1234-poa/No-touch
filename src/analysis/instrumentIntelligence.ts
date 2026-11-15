import type { Candle, MarketFamily, SyntheticMarket } from '../types/market';
import type { InstrumentBehaviour, InstrumentKind, InstrumentProfile } from '../types/instrument';
import type { EntryModelId } from '../types/engine';

/**
 * Per-instrument intelligence.
 *
 * Each Deriv index behaves differently: some trend cleanly, some spike, some respect
 * ranges and some produce abnormal, non-stationary movement. This module classifies the
 * instrument (Standard Volatility, Volatility 1s, Step, Jump, Range Break, Drift
 * Switching, DEX, Trek, Skew Step, Multi Step, Daily Reset) and derives the behaviour
 * profile plus the preferred entry models for it.
 *
 * Boom and Crash indices are deliberately EXCLUDED — they are never profiled here.
 *
 * The static profile describes what the instrument IS; {@link adaptBehaviour} refines it
 * from the observed candles (measured ATR% and spike frequency) so the engine adapts to
 * each instrument's ACTUAL current behaviour, not just its nominal label.
 */

const M = {
  TREND: 'MODEL_1_TREND_PULLBACK_CONTINUATION' as EntryModelId,
  BREAKOUT: 'MODEL_2_BREAKOUT_AND_RETEST' as EntryModelId,
  SR: 'MODEL_3_SUPPORT_RESISTANCE_REJECTION' as EntryModelId,
  SD: 'MODEL_4_SUPPLY_DEMAND_REACTION' as EntryModelId,
  SWEEP: 'MODEL_5_LIQUIDITY_SWEEP_CHOCH' as EntryModelId,
  TL: 'MODEL_6_TRENDLINE_BREAK_RETEST' as EntryModelId,
  PATTERN: 'MODEL_7_CHART_PATTERN_BREAKOUT' as EntryModelId,
  BOS: 'MODEL_8_MOMENTUM_BOS' as EntryModelId,
};

const ALL_MODELS: readonly EntryModelId[] = [
  M.TREND,
  M.BREAKOUT,
  M.SR,
  M.SD,
  M.SWEEP,
  M.TL,
  M.PATTERN,
  M.BOS,
];

/** True for Boom / Crash indices, which this system must never trade. */
export function isBoomOrCrash(params: {
  symbol: string;
  submarket?: string;
  displayName: string;
}): boolean {
  const sym = params.symbol.toUpperCase();
  const sub = (params.submarket ?? '').toLowerCase();
  const name = params.displayName.toUpperCase();
  if (sub === 'crash_index' || sub === 'boom_index' || sub === 'crash_boom_index') return true;
  if (sym.startsWith('BOOM') || sym.startsWith('CRASH')) return true;
  if (name.includes('BOOM') || name.includes('CRASH')) return true;
  return false;
}

interface StaticProfile {
  kind: InstrumentKind;
  label: string;
  behaviour: InstrumentBehaviour;
  preferredModels: EntryModelId[];
  discouragedModels: EntryModelId[];
  targetRoomAtr: number;
  requiresStabilisation: boolean;
  notes: string;
}

const BASE_BEHAVIOUR: InstrumentBehaviour = {
  volatilityTier: 3,
  trendTendency: 0.5,
  rangeTendency: 0.5,
  spikeRisk: 0.2,
  breakoutQuality: 0.6,
  abnormalVolatilityCapable: false,
};

function staticProfile(kind: InstrumentKind): StaticProfile {
  const b = (over: Partial<InstrumentBehaviour>): InstrumentBehaviour => ({ ...BASE_BEHAVIOUR, ...over });
  switch (kind) {
    case 'VOLATILITY_1S':
      return {
        kind,
        label: 'Volatility 1s',
        behaviour: b({
          volatilityTier: 4,
          trendTendency: 0.62,
          rangeTendency: 0.5,
          spikeRisk: 0.25,
          breakoutQuality: 0.68,
          abnormalVolatilityCapable: false,
        }),
        // High-frequency: momentum BOS and breakouts resolve quickly.
        preferredModels: [M.BOS, M.BREAKOUT, M.TREND, M.TL, M.SWEEP, M.SR, M.SD, M.PATTERN],
        discouragedModels: [],
        targetRoomAtr: 0.9,
        requiresStabilisation: false,
        notes: 'One-second ticks — fast momentum; structure resolves quickly, keep targets tight.',
      };
    case 'STEP':
      return {
        kind,
        label: 'Step',
        behaviour: b({
          volatilityTier: 3,
          trendTendency: 0.7,
          rangeTendency: 0.3,
          spikeRisk: 0.15,
          breakoutQuality: 0.72,
          abnormalVolatilityCapable: false,
        }),
        // Steps trend in fixed increments — continuation and trendline breaks dominate.
        preferredModels: [M.TREND, M.TL, M.BOS, M.SD, M.BREAKOUT, M.SR, M.SWEEP, M.PATTERN],
        discouragedModels: [],
        targetRoomAtr: 1.0,
        requiresStabilisation: false,
        notes: 'Moves in fixed step increments — trend continuation and trendline breaks.',
      };
    case 'JUMP':
      return {
        kind,
        label: 'Jump',
        behaviour: b({
          volatilityTier: 5,
          trendTendency: 0.45,
          rangeTendency: 0.35,
          spikeRisk: 0.85,
          breakoutQuality: 0.4,
          abnormalVolatilityCapable: true,
        }),
        // Abnormal spikes break levels without follow-through — wait for stabilisation.
        preferredModels: [M.SD, M.SWEEP, M.SR, M.TREND, M.TL, M.BOS, M.BREAKOUT, M.PATTERN],
        discouragedModels: [M.BREAKOUT, M.PATTERN],
        targetRoomAtr: 1.6,
        requiresStabilisation: true,
        notes: 'Abnormal jumps — wait for post-volatility stabilisation; avoid breakout traps.',
      };
    case 'RANGE_BREAK':
      return {
        kind,
        label: 'Range Break',
        behaviour: b({
          volatilityTier: 4,
          trendTendency: 0.4,
          rangeTendency: 0.7,
          spikeRisk: 0.4,
          breakoutQuality: 0.7,
          abnormalVolatilityCapable: true,
        }),
        // Designed to break ranges — range rejection at extremes + confirmed breakout.
        preferredModels: [M.SR, M.BREAKOUT, M.SWEEP, M.BOS, M.TL, M.TREND, M.SD, M.PATTERN],
        discouragedModels: [],
        targetRoomAtr: 1.2,
        requiresStabilisation: false,
        notes: 'Built to break ranges — range-extreme rejection and confirmed breakouts.',
      };
    case 'DRIFT_SWITCHING':
      return {
        kind,
        label: 'Drift Switching',
        behaviour: b({
          volatilityTier: 3,
          trendTendency: 0.55,
          rangeTendency: 0.45,
          spikeRisk: 0.5,
          breakoutQuality: 0.5,
          abnormalVolatilityCapable: true,
        }),
        // Drift regime can switch — favour reaction/sweep models over blind breakouts.
        preferredModels: [M.SWEEP, M.SR, M.SD, M.TREND, M.TL, M.BOS, M.BREAKOUT, M.PATTERN],
        discouragedModels: [M.PATTERN],
        targetRoomAtr: 1.2,
        requiresStabilisation: true,
        notes: 'Drift can switch regime — reaction and sweep models over blind breakouts.',
      };
    case 'DEX':
      return {
        kind,
        label: 'DEX',
        behaviour: b({
          volatilityTier: 5,
          trendTendency: 0.5,
          rangeTendency: 0.35,
          spikeRisk: 0.7,
          breakoutQuality: 0.45,
          abnormalVolatilityCapable: true,
        }),
        preferredModels: [M.SD, M.SWEEP, M.SR, M.TREND, M.BOS, M.TL, M.BREAKOUT, M.PATTERN],
        discouragedModels: [M.BREAKOUT, M.PATTERN],
        targetRoomAtr: 1.5,
        requiresStabilisation: true,
        notes: 'High, non-stationary volatility — post-volatility stabilisation required.',
      };
    case 'TREK':
      return {
        kind,
        label: 'Trek',
        behaviour: b({
          volatilityTier: 3,
          trendTendency: 0.65,
          rangeTendency: 0.4,
          spikeRisk: 0.3,
          breakoutQuality: 0.62,
          abnormalVolatilityCapable: false,
        }),
        preferredModels: [M.TREND, M.SWEEP, M.SD, M.TL, M.BOS, M.BREAKOUT, M.SR, M.PATTERN],
        discouragedModels: [],
        targetRoomAtr: 1.1,
        requiresStabilisation: false,
        notes: 'Trend-oriented synthetic — continuation and pullback into fresh zones.',
      };
    case 'SKEW_STEP':
      return {
        kind,
        label: 'Skew Step',
        behaviour: b({
          volatilityTier: 4,
          trendTendency: 0.55,
          rangeTendency: 0.4,
          spikeRisk: 0.6,
          breakoutQuality: 0.55,
          abnormalVolatilityCapable: true,
        }),
        preferredModels: [M.SR, M.SD, M.SWEEP, M.TREND, M.TL, M.BOS, M.BREAKOUT, M.PATTERN],
        discouragedModels: [M.PATTERN],
        targetRoomAtr: 1.3,
        requiresStabilisation: true,
        notes: 'Skewed step distribution — asymmetric spikes; favour reaction models.',
      };
    case 'MULTI_STEP':
      return {
        kind,
        label: 'Multi Step',
        behaviour: b({
          volatilityTier: 4,
          trendTendency: 0.6,
          rangeTendency: 0.45,
          spikeRisk: 0.5,
          breakoutQuality: 0.6,
          abnormalVolatilityCapable: false,
        }),
        preferredModels: [M.TREND, M.BREAKOUT, M.TL, M.BOS, M.SD, M.SR, M.SWEEP, M.PATTERN],
        discouragedModels: [],
        targetRoomAtr: 1.2,
        requiresStabilisation: false,
        notes: 'Multiple step sizes — trend continuation with stepped displacement.',
      };
    case 'DAILY_RESET':
      return {
        kind,
        label: 'Daily Reset',
        behaviour: b({
          volatilityTier: 3,
          trendTendency: 0.5,
          rangeTendency: 0.55,
          spikeRisk: 0.35,
          breakoutQuality: 0.58,
          abnormalVolatilityCapable: true,
        }),
        preferredModels: [M.SR, M.TREND, M.SWEEP, M.SD, M.BREAKOUT, M.TL, M.BOS, M.PATTERN],
        discouragedModels: [],
        targetRoomAtr: 1.1,
        requiresStabilisation: true,
        notes: 'Resets at the daily boundary — avoid trading straight into the reset.',
      };
    case 'STANDARD_VOLATILITY':
    case 'OTHER':
    default:
      return {
        kind: 'STANDARD_VOLATILITY',
        label: 'Standard Volatility',
        behaviour: b({}),
        preferredModels: [...ALL_MODELS],
        discouragedModels: [],
        targetRoomAtr: 1.0,
        requiresStabilisation: false,
        notes: 'Standard tick volatility — balanced across all models.',
      };
  }
}

/**
 * Classifies the instrument kind from its symbol, submarket and display name.
 * Order matters: the most specific names are matched first.
 */
export function classifyInstrumentKind(params: {
  symbol: string;
  submarket?: string;
  displayName: string;
}): InstrumentKind {
  const sym = params.symbol.toUpperCase();
  const sub = (params.submarket ?? '').toLowerCase();
  const name = params.displayName.toUpperCase();
  const hay = `${sym} ${sub} ${name}`;
  // Word-boundary match so 'DEX' never matches inside 'INDEX'.
  const hasWord = (token: string) => new RegExp(`(^|[^A-Z])${token}([^A-Z]|$)`).test(name) ||
    sub.includes(token.toLowerCase()) ||
    sym === token;

  if (hay.includes('BOOM') || hay.includes('CRASH')) return 'OTHER';
  if (hasWord('DAILY RESET') || sub.includes('daily')) return 'DAILY_RESET';
  if (hasWord('DRIFT')) return 'DRIFT_SWITCHING';
  if (hasWord('DEX') || sub === 'dex_index' || sub === 'dex') return 'DEX';
  if (hasWord('SKEW STEP') || hasWord('SKEW')) return 'SKEW_STEP';
  if (hasWord('MULTI STEP') || hasWord('MULTISTEP')) return 'MULTI_STEP';
  if (hasWord('TREK')) return 'TREK';
  if (name.includes('JUMP') || sub.includes('jump') || sym.startsWith('JD')) return 'JUMP';
  if (name.includes('RANGE BREAK') || sub.includes('range')) return 'RANGE_BREAK';
  if (hasWord('STEP') || sub.includes('step') || sym.includes('STP')) return 'STEP';
  if (sub.includes('1s') || sym.startsWith('1HZ') || sym.startsWith('1S') || name.includes('(1S)')) {
    return 'VOLATILITY_1S';
  }
  if (sub.includes('random') || sym.startsWith('R_') || name.includes('VOLATILITY')) {
    return 'STANDARD_VOLATILITY';
  }
  return 'OTHER';
}

/** Builds the static per-instrument profile (no candles needed). */
export function buildInstrumentProfile(params: {
  symbol: string;
  submarket?: string;
  displayName: string;
  family: MarketFamily;
}): InstrumentProfile {
  const kind = classifyInstrumentKind(params);
  const stat = staticProfile(kind);
  return {
    kind: stat.kind,
    label: stat.label,
    family: params.family,
    behaviour: stat.behaviour,
    preferredModels: stat.preferredModels,
    discouragedModels: stat.discouragedModels,
    targetRoomAtr: stat.targetRoomAtr,
    requiresStabilisation: stat.requiresStabilisation,
    notes: stat.notes,
  };
}

/** Convenience overload for a full {@link SyntheticMarket}. */
export function profileForMarket(market: {
  symbol: string;
  displayName: string;
  submarket?: string;
  family: MarketFamily;
}): InstrumentProfile {
  return buildInstrumentProfile(market);
}

/**
 * Refines the behaviour profile from the ACTUAL candles: measures realized ATR% and
 * spike frequency and nudges the volatility tier, spike risk and stabilisation flag so
 * the engine adapts to the instrument's current behaviour, not just its label.
 */
export function adaptBehaviour(
  profile: InstrumentProfile,
  candles: readonly Candle[],
  atr: number
): InstrumentProfile {
  if (candles.length < 20 || atr <= 0) return profile;
  const price = candles[candles.length - 1].close;
  if (price <= 0) return profile;

  const normalizedAtrPct = (atr / price) * 100;
  const window = candles.slice(-40);
  const ranges = window.map((c) => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const spikes = ranges.filter((r) => avgRange > 0 && r > avgRange * 2.5).length;
  const spikeFrequency = spikes / window.length;

  const volatilityTier: InstrumentBehaviour['volatilityTier'] =
    normalizedAtrPct >= 1.2
      ? 5
      : normalizedAtrPct >= 0.7
        ? 4
        : normalizedAtrPct >= 0.35
          ? 3
          : normalizedAtrPct >= 0.15
            ? 2
            : 1;

  const spikeRisk = Math.max(profile.behaviour.spikeRisk, Math.min(1, spikeFrequency * 2));
  const abnormalVolatilityCapable =
    profile.behaviour.abnormalVolatilityCapable || spikeFrequency >= 0.15;

  return {
    ...profile,
    behaviour: {
      ...profile.behaviour,
      volatilityTier,
      spikeRisk,
      abnormalVolatilityCapable,
    },
  };
}

/**
 * Orders the candidate models for a given instrument: the instrument's preferred models
 * first (in its own priority), then any remaining eligible models. Discouraged models
 * are dropped unless nothing else is available, so the engine never forces a model the
 * instrument handles badly.
 */
export function orderModelsForInstrument(
  eligible: readonly EntryModelId[],
  profile: InstrumentProfile
): EntryModelId[] {
  const eligibleSet = new Set(eligible);
  const preferred = profile.preferredModels.filter((m) => eligibleSet.has(m));
  const discouraged = new Set(profile.discouragedModels);
  const rest = eligible.filter((m) => !preferred.includes(m) && !discouraged.has(m));
  const fallbackDiscouraged = eligible.filter((m) => discouraged.has(m));

  if (preferred.length === 0 && rest.length === 0) return [...eligible];
  // Keep discouraged models only as a last resort, never ahead of a suitable model.
  return [...preferred, ...rest, ...fallbackDiscouraged];
}
