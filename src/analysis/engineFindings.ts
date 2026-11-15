import type { MomentumAssessment, SupportResistanceLevel, SupplyDemandZone } from '../types/analysis';
import type { IndicatorSnapshot } from '../types/engine';
import type { MarketIntelligence } from '../types/intelligence';
import type { EngineFinding, EngineFindings } from '../types/intelligence';
import type { StructureOverlayData } from '../types/structure';
import { formatPrice } from '../utils/derivParser';

interface FindingsParams {
  direction: 'RISE' | 'FALL';
  precision: number;
  intelligence: MarketIntelligence;
  structure: StructureOverlayData | null;
  momentum: MomentumAssessment;
  indicators: IndicatorSnapshot;
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
}

/**
 * Reports what each of the four analysis lenses currently sees for the considered
 * direction. SMC and ICT liquidity readings are price-based hypotheses derived from
 * confirmed candles — they are never presented as proof of institutional activity.
 */
export function buildEngineFindings(params: FindingsParams): EngineFindings {
  const {
    direction,
    precision,
    intelligence,
    structure,
    momentum,
    indicators,
    supportResistance,
    supplyDemand,
  } = params;

  return {
    smc: buildSmcFindings({ direction, precision, intelligence, structure }),
    ict: buildIctFindings({ direction, precision, intelligence }),
    priceAction: buildPriceActionFindings({ direction, momentum, supportResistance, supplyDemand, precision }),
    technical: buildTechnicalFindings({ direction, indicators }),
  };
}

function buildSmcFindings(params: {
  direction: 'RISE' | 'FALL';
  precision: number;
  intelligence: MarketIntelligence;
  structure: StructureOverlayData | null;
}): EngineFinding[] {
  const { direction, precision, intelligence, structure } = params;
  const isRise = direction === 'RISE';
  const findings: EngineFinding[] = [];

  const swingSeq = intelligence.majorSwings
    .map((s) => s.label)
    .filter((l): l is 'HH' | 'HL' | 'LH' | 'LL' => Boolean(l))
    .slice(-4);
  if (swingSeq.length > 0) {
    const aligned = isRise
      ? swingSeq.includes('HH') && swingSeq.includes('HL')
      : swingSeq.includes('LH') && swingSeq.includes('LL');
    findings.push({
      label: `Swing sequence ${swingSeq.join(' → ')}`,
      supports: aligned,
      detail: aligned
        ? 'Higher highs and higher lows (or lower highs and lower lows) confirm the directional structure.'
        : 'Swing sequence does not fully confirm the considered direction.',
    });
  }

  const breaks = structure?.breaks ?? intelligence.breaks;
  const matchingBreaks = breaks.filter((b) =>
    isRise ? b.direction === 'bullish' : b.direction === 'bearish'
  );
  if (matchingBreaks.length > 0) {
    const last = matchingBreaks[matchingBreaks.length - 1];
    findings.push({
      label: `${last.kind} ${isRise ? 'above' : 'below'} ${formatPrice(last.brokenLevel, precision)}`,
      supports: true,
      detail: `Body close at ${formatPrice(last.closePrice, precision)} with ${last.displacementAtr.toFixed(1)}× ATR displacement. ${last.reason}`,
    });
  } else {
    findings.push({
      label: 'No confirmed BOS/CHoCH in this direction',
      supports: false,
      detail: 'Structure has not produced a body-confirmed break supporting this direction (wick-only breaks are not counted).',
    });
  }

  const freshOb = (structure?.watchZones ?? []).filter(
    (z) => z.direction === direction && z.freshness === 'FRESH'
  );
  if (freshOb.length > 0) {
    findings.push({
      label: `Fresh ${isRise ? 'demand' : 'supply'} zone`,
      supports: true,
      detail: `${formatPrice(freshOb[0].lowerPrice, precision)} – ${formatPrice(freshOb[0].upperPrice, precision)} (${freshOb[0].distanceAtr.toFixed(1)}× ATR away), untested.`,
    });
  }

  const fvg = intelligence.fvg.filter((g) => g.reaction === direction && g.freshness === 'FRESH');
  if (fvg.length > 0) {
    findings.push({
      label: `Unmitigated ${isRise ? 'bullish' : 'bearish'} FVG`,
      supports: true,
      detail: `${formatPrice(fvg[0].lowerPrice, precision)} – ${formatPrice(fvg[0].upperPrice, precision)}, ${fvg[0].sizeAtr.toFixed(1)}× ATR imbalance.`,
    });
  }

  const strongSide = isRise ? intelligence.strongLows : intelligence.strongHighs;
  if (strongSide.length > 0) {
    findings.push({
      label: `${isRise ? 'Strong low' : 'Strong high'} protected at ${formatPrice(strongSide[strongSide.length - 1], precision)}`,
      supports: true,
      detail: 'Structural level that must hold for this direction to stay valid.',
    });
  }

  return findings;
}

function buildIctFindings(params: {
  direction: 'RISE' | 'FALL';
  precision: number;
  intelligence: MarketIntelligence;
}): EngineFinding[] {
  const { direction, precision, intelligence } = params;
  const isRise = direction === 'RISE';
  const findings: EngineFinding[] = [];

  const relevantSweep = intelligence.liquiditySweeps.find((s) =>
    isRise ? s.direction === 'bullish' : s.direction === 'bearish'
  );
  if (relevantSweep) {
    findings.push({
      label: `Liquidity sweep of ${formatPrice(relevantSweep.sweptLevel, precision)}`,
      supports: true,
      detail: `Price swept the ${isRise ? 'sell-side' : 'buy-side'} level and reclaimed (close ${formatPrice(relevantSweep.reversalClose, precision)}). Treated as a price-based sweep, not institutional proof.`,
    });
  } else {
    findings.push({
      label: 'No clean liquidity sweep',
      supports: null,
      detail: 'No qualifying sweep-and-reclaim preceded this setup.',
    });
  }

  if (intelligence.displacement) {
    const aligned = intelligence.displacement.direction === (isRise ? 'bullish' : 'bearish');
    findings.push({
      label: `${intelligence.displacement.direction} displacement ${intelligence.displacement.atr.toFixed(1)}× ATR`,
      supports: aligned,
      detail: aligned
        ? 'Recent displacement is in the considered direction — momentum supports the idea.'
        : 'Most recent displacement opposes the considered direction.',
    });
  }

  const pools = intelligence.report.liquidityObjectives.filter(
    (p) => !p.swept && ((isRise && p.side === 'above') || (!isRise && p.side === 'below'))
  );
  if (pools.length > 0) {
    findings.push({
      label: `Resting ${isRise ? 'buy-side' : 'sell-side'} liquidity`,
      supports: true,
      detail: `Un-swept pool at ${formatPrice(pools[0].price, precision)} (${pools[0].distanceAtr.toFixed(1)}× ATR) is the natural draw for this direction.`,
    });
  }

  const premiumDiscount = premiumDiscountState(intelligence);
  if (premiumDiscount) {
    const favourable =
      (isRise && premiumDiscount === 'discount') || (!isRise && premiumDiscount === 'premium');
    findings.push({
      label: `Price in ${premiumDiscount}`,
      supports: favourable,
      detail: favourable
        ? 'Price sits in the favourable half of the dealing range for this direction.'
        : 'Price sits in the unfavourable half of the dealing range for this direction.',
    });
  }

  return findings;
}

/** Splits the recent dealing range into premium / discount halves (ICT framing). */
function premiumDiscountState(intelligence: MarketIntelligence): 'premium' | 'discount' | null {
  if (intelligence.strongHighs.length === 0 || intelligence.strongLows.length === 0) return null;
  const hi = Math.max(...intelligence.strongHighs);
  const lo = Math.min(...intelligence.strongLows);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
  const mid = (hi + lo) / 2;
  return intelligence.price >= mid ? 'premium' : 'discount';
}

function buildPriceActionFindings(params: {
  direction: 'RISE' | 'FALL';
  momentum: MomentumAssessment;
  supportResistance: readonly SupportResistanceLevel[];
  supplyDemand: readonly SupplyDemandZone[];
  precision: number;
}): EngineFinding[] {
  const { direction, momentum, supportResistance, supplyDemand, precision } = params;
  const isRise = direction === 'RISE';
  const findings: EngineFinding[] = [];

  const directionalMomentum = isRise
    ? momentum.state === 'STRONG_BULLISH'
    : momentum.state === 'STRONG_BEARISH';
  findings.push({
    label: `Candle strength ${momentum.state.replace(/_/g, ' ').toLowerCase()}`,
    supports: directionalMomentum ? true : momentum.state === 'WEAK' ? false : null,
    detail: momentum.summary,
  });

  if (momentum.displacementCandle) {
    findings.push({
      label: 'Displacement candle',
      supports: true,
      detail: `Body ratio ${(momentum.bodyRatio * 100).toFixed(0)}% with ${momentum.breakoutAtrDistance.toFixed(1)}× ATR expansion.`,
    });
  }

  if (momentum.isOverextended || momentum.isExhausted) {
    findings.push({
      label: 'Move extended',
      supports: false,
      detail: 'Price is overextended / exhausted — a pullback or reversal is more likely than continuation here.',
    });
  }

  const pullback = momentum.pullbackQuality;
  findings.push({
    label: `Pullback quality ${pullback.replace(/_/g, ' ').toLowerCase()}`,
    supports: pullback === 'CLEAN' ? true : pullback === 'AGGRESSIVE_COUNTER' ? false : null,
    detail:
      pullback === 'CLEAN'
        ? 'The retracement is orderly and respects structure — continuation-friendly.'
        : pullback === 'AGGRESSIVE_COUNTER'
          ? 'Counter-move is aggressive — the continuation thesis is weakened.'
          : 'Retracement is choppy; no clean price-action confirmation either way.',
  });

  const nearestBarrier = nearestOpposingBarrier(direction, supportResistance, supplyDemand);
  if (nearestBarrier !== null) {
    findings.push({
      label: `Opposing level ahead at ${formatPrice(nearestBarrier, precision)}`,
      supports: null,
      detail: 'An opposing structure sits in the path — the target must clear it to be realistic.',
    });
  }

  return findings;
}

function nearestOpposingBarrier(
  direction: 'RISE' | 'FALL',
  supportResistance: readonly SupportResistanceLevel[],
  supplyDemand: readonly SupplyDemandZone[]
): number | null {
  const levels = supportResistance
    .filter((l) => l.status === 'active' && (direction === 'RISE' ? l.type === 'resistance' : l.type === 'support'))
    .map((l) => l.price);
  const zones = supplyDemand
    .filter((z) => z.status !== 'invalidated' && (direction === 'RISE' ? z.type === 'supply' : z.type === 'demand'))
    .map((z) => (direction === 'RISE' ? z.lowerPrice : z.upperPrice));
  const all = [...levels, ...zones].filter((p) => Number.isFinite(p));
  if (all.length === 0) return null;
  return direction === 'RISE' ? Math.min(...all) : Math.max(...all);
}

function buildTechnicalFindings(params: {
  direction: 'RISE' | 'FALL';
  indicators: IndicatorSnapshot;
}): EngineFinding[] {
  const { direction, indicators } = params;
  const isRise = direction === 'RISE';
  const findings: EngineFinding[] = [];

  if (indicators.ema20 !== null || indicators.ema50 !== null) {
    const trendOk = indicators.trendConfirm === (isRise ? 'BULLISH' : 'BEARISH');
    findings.push({
      label: `EMA trend ${indicators.trendConfirm.toLowerCase()}`,
      supports: indicators.trendConfirm === 'NEUTRAL' ? null : trendOk,
      detail: `EMA20 ${indicators.ema20 !== null ? formatPrice(indicators.ema20, 4) : '—'} · EMA50 ${indicators.ema50 !== null ? formatPrice(indicators.ema50, 4) : '—'} relationship.`,
    });
  }

  if (indicators.rsi14 !== null) {
    const rsiOk = isRise ? indicators.rsi14 >= 50 : indicators.rsi14 <= 50;
    findings.push({
      label: `RSI ${indicators.rsi14.toFixed(1)}`,
      supports: rsiOk,
      detail: isRise ? 'RSI above 50 supports upside momentum.' : 'RSI below 50 supports downside momentum.',
    });
  }

  if (indicators.macdHistogram !== null) {
    const macdOk = isRise ? indicators.macdHistogram > 0 : indicators.macdHistogram < 0;
    findings.push({
      label: `MACD histogram ${indicators.macdHistogram.toFixed(4)}`,
      supports: macdOk,
      detail: 'MACD momentum is used only as a confirming filter.',
    });
  }

  if (indicators.adx14 !== null) {
    findings.push({
      label: `ADX ${indicators.adx14.toFixed(1)}${indicators.strengthConfirm ? ' (trending)' : ''}`,
      supports: indicators.strengthConfirm ? true : null,
      detail: indicators.strengthConfirm
        ? 'Trend strength confirmed — continuation models are more reliable.'
        : 'Weak trend strength — treat breakout and continuation ideas with caution.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      label: 'Indicators unavailable',
      supports: null,
      detail: 'Not enough history to compute the technical filter set.',
    });
  }

  return findings;
}

/** Counts how many findings in a lens actively support vs. oppose a direction. */
export function summariseFindings(findings: readonly EngineFinding[]): {
  support: number;
  oppose: number;
  neutral: number;
} {
  let support = 0;
  let oppose = 0;
  let neutral = 0;
  for (const f of findings) {
    if (f.supports === true) support++;
    else if (f.supports === false) oppose++;
    else neutral++;
  }
  return { support, oppose, neutral };
}
