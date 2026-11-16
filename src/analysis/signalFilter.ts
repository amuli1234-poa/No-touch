import type { Candle } from '../types/market';
import type { RankedSetup } from '../types/ranking';
import type {
  FilteredSignal,
  SignalFilterCheck,
  SignalFilterCheckId,
  SignalFilterConfig,
  SignalFilterContext,
  SignalFilterResult,
} from '../types/signalFilter';
import { DEFAULT_SIGNAL_FILTER_CONFIG } from '../types/signalFilter';
import { aiAtr, readAiCondition } from './aiCommon';
import { analyzeMarketStructure } from './structure';
import { assessMomentum } from './momentum';
import { detectSupplyDemandZones } from './supplyDemand';
import { computeAtrSeries, detectSwings } from './swings';
import { confirmedOnly } from './trendlineDetection';

/**
 * CENTRALIZED SIGNAL QUALITY FILTER.
 *
 * This is the single gate every AI strategy submits its candidate setups to before
 * publication. It lives between the strategies and the display layer. It never generates a
 * signal and never rewrites an engine's own score — it only re-reads the live market and
 * decides whether a candidate is worth showing, scoring its quality out of 100 across seven
 * mandatory dimensions:
 *
 *   DATA      live Deriv connection + fresh prices
 *   TREND     directional trend alignment
 *   STRUCTURE market structure / BOS confirmation
 *   ZONE      supply/demand rejection zone in play
 *   TRIGGER   valid entry trigger + momentum (not late / not exhausted)
 *   NOVELTY   not a duplicate or conflicting repeat
 *   ROOM      sufficient room for the projected move (reward:risk)
 *
 * A setup that fails a REQUIRED dimension (or scores below `minQuality`) is rejected with
 * short reasons. Rejected setups are returned for inspection but are never displayed on the
 * chart. The score is a quality/ranking figure — never a win probability.
 */

const CHECK_META: Record<SignalFilterCheckId, { label: string; max: number }> = {
  DATA: { label: 'Live data & freshness', max: 20 },
  TREND: { label: 'Trend alignment', max: 20 },
  STRUCTURE: { label: 'Structure / BOS', max: 15 },
  ZONE: { label: 'Supply/demand zone', max: 15 },
  TRIGGER: { label: 'Entry trigger & momentum', max: 15 },
  NOVELTY: { label: 'Uniqueness', max: 10 },
  ROOM: { label: 'Room for move', max: 5 },
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function pass(id: SignalFilterCheckId, score: number, detail: string): SignalFilterCheck {
  const meta = CHECK_META[id];
  return { id, label: meta.label, passed: true, score: clamp(score, 0, meta.max), max: meta.max, detail };
}

function fail(id: SignalFilterCheckId, detail: string, score = 0): SignalFilterCheck {
  const meta = CHECK_META[id];
  return { id, label: meta.label, passed: false, score: clamp(score, 0, meta.max), max: meta.max, detail };
}

/** Freshness window for the newest confirmed candle, scaled to the setup timeframe. */
function freshnessWindowSec(timeframe: import('../types/market').TimeframeKey): number {
  switch (timeframe) {
    case 'M1':
      return 300;
    case 'M3':
      return 540;
    case 'M5':
      return 900;
    case 'M7':
      return 1260;
    case 'M15':
      return 2700;
    default:
      return 3600;
  }
}

/**
 * Applies the centralized filter to a set of candidate setups. Deterministic and pure:
 * identical inputs always produce identical verdicts, so it is fully unit-testable.
 */
export function applySignalQualityFilter(
  setups: readonly RankedSetup[],
  context: SignalFilterContext,
  config: SignalFilterConfig = DEFAULT_SIGNAL_FILTER_CONFIG
): SignalFilterResult {
  const now = context.now ?? Date.now();
  const nowSec = Math.floor(now / 1000);
  // Freshness scales to the timeframe the candles were actually fetched on.
  const freshnessWindow = freshnessWindowSec(context.dataTimeframe ?? 'M5');
  const accepted: FilteredSignal[] = [];
  const rejected: FilteredSignal[] = [];

  // Direction winners per symbol drive conflict rejection (strongest engine score wins).
  const winners = new Map<string, RankedSetup>();
  for (const s of setups) {
    const existing = winners.get(s.symbol);
    if (!existing || s.score > existing.score) winners.set(s.symbol, s);
  }
  // Novelty: one setup per (symbol, direction, model) — a re-scan must not inflate the list.
  const seenKeys = new Set<string>();

  for (const setup of setups) {
    const checks: SignalFilterCheck[] = [];
    const candles = context.candlesBySymbol.get(setup.symbol) ?? [];
    const confirmed = confirmedOnly(candles);
    const last = confirmed.length > 0 ? confirmed[confirmed.length - 1] : null;
    const atr = confirmed.length > 0 ? aiAtr(confirmed) : 0;

    // 1. DATA — live connection + fresh prices.
    if (context.connectionStatus !== 'connected') {
      checks.push(
        fail('DATA', `Deriv feed is ${context.connectionStatus} — publication withheld.`)
      );
    } else if (!last || atr <= 0) {
      checks.push(fail('DATA', 'No confirmed candles available for this instrument.'));
    } else {
      const ageSec = nowSec - last.time;
      const window = freshnessWindow;
      if (ageSec > window) {
        checks.push(
          fail('DATA', `Newest confirmed candle is ${ageSec}s old (limit ${window}s) — data stale.`)
        );
      } else {
        // Fresher data scores higher.
        const freshness = clamp(1 - ageSec / window, 0, 1);
        checks.push(
          pass('DATA', 10 + 10 * freshness, `Live feed; newest candle ${ageSec}s old.`)
        );
      }
    }

    // 2. TREND — directional trend alignment.
    let trendAligned = true;
    if (!last || confirmed.length < 30) {
      trendAligned = false;
      checks.push(fail('TREND', 'Not enough confirmed candles to read trend alignment.'));
    } else {
      const condition = readAiCondition(confirmed, atr);
      const wantsBull = setup.direction === 'RISE';
      const biasBull = condition.bias === 'bullish';
      const biasBear = condition.bias === 'bearish';
      const aligned = condition.bias === 'neutral' ? true : wantsBull ? biasBull : biasBear;
      trendAligned = aligned;
      if (!aligned) {
        checks.push(
          fail(
            'TREND',
            `Trend reads ${condition.bias} but setup is ${setup.direction} — misaligned.`
          )
        );
      } else {
        const neutralPenalty = condition.bias === 'neutral' ? 0.5 : 0;
        checks.push(
          pass(
            'TREND',
            20 * clamp(0.4 + 0.6 * condition.strength - neutralPenalty, 0, 1),
            `${condition.detail}${condition.bias === 'neutral' ? ' (neutral — weak alignment)' : ''}`
          )
        );
      }
    }

    // 3. STRUCTURE — market structure / BOS confirmation.
    let structureOk = true;
    let structureDetail = 'Structure tracked on confirmed candles.';
    let structureScore = 8;
    if (confirmed.length < 20) {
      structureOk = false;
      checks.push(fail('STRUCTURE', 'Too few confirmed candles for a structure read.'));
    } else {
      const swings = detectSwings(confirmed, 3, 3);
      const structure = analyzeMarketStructure(confirmed, swings, computeAtrSeries(confirmed), setup.precision);
      const wantsBull = setup.direction === 'RISE';
      const breakAligned =
        structure.latestBreak &&
        ((wantsBull && structure.latestBreak.direction === 'bullish') ||
          (!wantsBull && structure.latestBreak.direction === 'bearish'));
      const dirAligned =
        structure.direction === 'NEUTRAL' ||
        (wantsBull ? structure.direction === 'BULLISH' : structure.direction === 'BEARISH');
      structureOk = dirAligned || Boolean(breakAligned);
      if (!structureOk) {
        checks.push(
          fail(
            'STRUCTURE',
            `Structure reads ${structure.direction} — no ${wantsBull ? 'bullish' : 'bearish'} BOS confirmation.`
          )
        );
      } else {
        structureScore = 8;
        if (dirAligned) structureScore += 3;
        if (breakAligned) {
          structureScore += 4;
          structureDetail = `Aligned ${structure.latestBreak!.kind} (${structure.latestBreak!.direction}) — ${structure.structureLabel}.`;
        } else {
          structureDetail = `${structure.structureLabel} — no fresh BOS, structure still aligned.`;
        }
        checks.push(pass('STRUCTURE', structureScore, structureDetail));
      }
    }

    // 4. ZONE — supply/demand rejection zone in play.
    let zoneOk = true;
    let zoneScore = 6;
    let zoneDetail = 'No supply/demand zone required in play.';
    if (confirmed.length < 25) {
      checks.push(pass('ZONE', 6, 'Zone check deferred — limited history.'));
    } else {
      const zones = detectSupplyDemandZones(confirmed, computeAtrSeries(confirmed), setup.precision);
      const wantsDemand = setup.direction === 'RISE';
      const nearPrice = last ? last.close : 0;
      const relevant = zones.filter((z) => (wantsDemand ? z.type === 'demand' : z.type === 'supply'));
      const priceNear = relevant.find(
        (z) =>
          nearPrice >= z.lowerPrice - atr * 1.5 && nearPrice <= z.upperPrice + atr * 1.5
      );
      const freshZone = priceNear?.status === 'fresh';
      if (relevant.length === 0) {
        // Not mandatory by default; note the absence honestly.
        zoneOk = !config.requireZone;
        zoneDetail = config.requireZone
          ? 'No relevant supply/demand zone found.'
          : 'No relevant supply/demand zone in play — not required.';
        checks.push(
          config.requireZone
            ? fail('ZONE', zoneDetail)
            : pass('ZONE', 6, zoneDetail)
        );
      } else if (priceNear) {
        zoneScore = freshZone ? 15 : 11;
        zoneDetail = `Price reacting at a ${priceNear.type} zone${freshZone ? ' (fresh)' : ''} — ${priceNear.reason}`;
        checks.push(pass('ZONE', zoneScore, zoneDetail));
      } else {
        zoneOk = !config.requireZone;
        zoneScore = 8;
        zoneDetail = `${relevant.length} ${wantsDemand ? 'demand' : 'supply'} zone(s) tracked; price not at the zone yet.`;
        checks.push(
          config.requireZone ? fail('ZONE', zoneDetail, zoneScore) : pass('ZONE', zoneScore, zoneDetail)
        );
      }
    }

    // 5. TRIGGER — valid entry trigger + momentum (reject late / exhausted).
    let triggerOk = true;
    let triggerScore = 8;
    let triggerDetail = 'Entry trigger present.';
    if (confirmed.length < 15) {
      triggerOk = false;
      checks.push(fail('TRIGGER', 'Too few confirmed candles to confirm the entry trigger.'));
    } else {
      const momentum = assessMomentum({
        candles: confirmed,
        atr,
        breakoutLevel: null,
        candidateDirection: setup.direction,
        supportResistance: [],
        supplyDemand: [],
      });
      const wantsBull = setup.direction === 'RISE';
      const withTrade =
        momentum.state === 'NEUTRAL' ||
        (wantsBull ? momentum.state === 'STRONG_BULLISH' : momentum.state === 'STRONG_BEARISH');
      // Lateness: momentum exhaustion/overextension, or price already ran well past the
      // setup's intended entry (chasing an entry that no longer exists).
      const entry = setup.entryPrice;
      const extensionAtr =
        entry !== null && atr > 0 && last
          ? (wantsBull ? last.close - entry : entry - last.close) / atr
          : 0;
      const lateByEntry = extensionAtr > 1.2;
      const late = momentum.isOverextended || momentum.isExhausted || lateByEntry;
      triggerOk = withTrade && !late;
      if (!withTrade) {
        checks.push(
          fail('TRIGGER', `Momentum reads ${momentum.state} against a ${setup.direction} setup — no trigger.`)
        );
      } else if (lateByEntry) {
        checks.push(
          fail(
            'TRIGGER',
            `Entry is late — price is already ${extensionAtr.toFixed(1)}× ATR beyond the intended entry.`
          )
        );
      } else if (late) {
        checks.push(
          fail('TRIGGER', `Setup is late — ${momentum.isExhausted ? 'momentum exhausted' : 'price overextended'}.`)
        );
      } else {
        triggerScore = 8 + (momentum.displacementCandle ? 4 : 0) + (momentum.consecutiveDirectional >= 2 ? 3 : 0);
        triggerDetail = momentum.summary;
        checks.push(pass('TRIGGER', triggerScore, triggerDetail));
      }
    }

    // 6. NOVELTY — duplicate / conflicting repeat.
    let noveltyOk = true;
    const dupKey = `${setup.symbol}:${setup.direction}:${setup.modelLabel}`;
    if (config.rejectDuplicates && seenKeys.has(dupKey)) {
      noveltyOk = false;
      checks.push(fail('NOVELTY', 'Duplicate of an identical setup already submitted this pass.'));
    } else if (config.rejectConflicts && winners.get(setup.symbol) !== setup) {
      noveltyOk = false;
      checks.push(
        fail(
          'NOVELTY',
          `Conflicts with a stronger ${winners.get(setup.symbol)!.direction} setup on the same instrument.`
        )
      );
    } else {
      seenKeys.add(dupKey);
      checks.push(pass('NOVELTY', 10, 'Unique setup for this instrument and direction.'));
    }

    // 7. ROOM — sufficient room for the projected move.
    let roomOk = true;
    const rr = setup.riskRewardRatio;
    if (rr === null || !Number.isFinite(rr)) {
      roomOk = false;
      checks.push(fail('ROOM', 'Projected reward:risk could not be computed.'));
    } else if (rr < config.minRoomR) {
      roomOk = false;
      checks.push(
        fail('ROOM', `Only ${rr.toFixed(2)}R to the first target (need ≥ ${config.minRoomR}R).`)
      );
    } else {
      checks.push(pass('ROOM', clamp((rr / 2) * 5, 0, 5), `${rr.toFixed(2)}R to the first target.`));
    }

    const score = Math.round(checks.reduce((sum, c) => sum + c.score, 0));
    const reasons: string[] = [];
    if (!checks.find((c) => c.id === 'DATA')!.passed) reasons.push('Feed not live / data stale.');
    if (config.requireTrendAlignment && !trendAligned) reasons.push('Trend not aligned.');
    if (config.requireStructure && !structureOk) reasons.push('No structure/BOS confirmation.');
    if (config.requireZone && !zoneOk) reasons.push('No supply/demand zone in play.');
    if (config.requireTrigger && !triggerOk) reasons.push('No valid entry trigger / momentum.');
    if ((config.rejectDuplicates || config.rejectConflicts) && !noveltyOk)
      reasons.push('Duplicate or conflicting setup.');
    if (!roomOk) reasons.push('Insufficient room for the projected move.');
    if (score < config.minQuality) reasons.push(`Quality ${score}/100 is below the ${config.minQuality} gate.`);

    const requiredFail =
      !checks.find((c) => c.id === 'DATA')!.passed ||
      (config.requireTrendAlignment && !trendAligned) ||
      (config.requireStructure && !structureOk) ||
      (config.requireZone && !zoneOk) ||
      (config.requireTrigger && !triggerOk) ||
      ((config.rejectDuplicates || config.rejectConflicts) && !noveltyOk) ||
      !roomOk;

    const acceptedFlag = !requiredFail && score >= config.minQuality;
    const filtered: FilteredSignal = {
      key: setup.key,
      source: setup.source,
      sourceLabel: setup.sourceLabel,
      symbol: setup.symbol,
      displayName: setup.displayName,
      direction: setup.direction,
      modelLabel: setup.modelLabel,
      score,
      engineScore: setup.score,
      riskRewardRatio: rr,
      verdict: acceptedFlag ? 'ACCEPTED' : 'FILTERED',
      checks,
      reasons,
      setup,
    };
    if (acceptedFlag) accepted.push(filtered);
    else rejected.push(filtered);
  }

  accepted.sort((a, b) => b.score - a.score);
  rejected.sort((a, b) => b.score - a.score);
  return {
    accepted,
    rejected,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    config,
  };
}
