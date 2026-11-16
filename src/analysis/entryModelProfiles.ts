import type { EntryModelKind, EntryModelPerformance } from '../types/entryModelAI';
import { ENTRY_MODEL_KIND_LABELS } from '../types/entryModelAI';
import type {
  IndexHistoricalBonus,
  IndexModelProfile,
  IndexModelRecord,
  IndexModelStats,
} from '../types/entryModelProfiles';

/**
 * PER-INDEX ENTRY MODEL LEARNING ENGINE.
 *
 * Builds a separate profile for every individual index from its OWN recorded outcomes.
 * Statistics are never mixed between indices. A challenger model is only adopted when:
 *   1. it has a statistically reliable sample,
 *   2. its out-of-sample win rate has not collapsed against its in-sample win rate
 *      (overfitting guard), and
 *   3. it beats the incumbent's expectancy by a margin.
 * Otherwise the previously validated model is RETAINED.
 */

/** Minimum closed (win/loss) trades before any win rate is trusted. */
export const MIN_RELIABLE_SAMPLE = 20;
/** Fraction of the newest records held back as out-of-sample. */
export const OUT_OF_SAMPLE_FRACTION = 0.3;
/** Minimum out-of-sample sample before the overfitting guard can be applied. */
export const MIN_OUT_OF_SAMPLE = 6;
/** An out-of-sample win-rate drop beyond this (points) flags overfitting. */
export const OVERFIT_DROP_POINTS = 25;
/** A challenger must beat the incumbent's expectancy by this margin to be adopted. */
export const CHALLENGER_MARGIN = 0.15;

function isClosed(outcome: IndexModelRecord['outcome']): boolean {
  return outcome === 'TARGET_HIT' || outcome === 'STOP_HIT' || outcome === 'INVALIDATED';
}

function winRate(records: readonly IndexModelRecord[]): number | null {
  const closed = records.filter((r) => isClosed(r.outcome));
  if (closed.length === 0) return null;
  const wins = closed.filter((r) => r.outcome === 'TARGET_HIT').length;
  return Math.round((wins / closed.length) * 100);
}

function expectancyOf(records: readonly IndexModelRecord[]): number | null {
  const closed = records.filter((r) => isClosed(r.outcome));
  if (closed.length === 0) return null;
  let total = 0;
  for (const r of closed) {
    const rr = r.riskRewardRatio ?? 0;
    if (r.outcome === 'TARGET_HIT') total += rr > 0 ? rr : 1;
    else total -= 1;
  }
  return Math.round((total / closed.length) * 100) / 100;
}

/** Builds per-model statistics for ONE index from its own records only. */
function statsForIndex(records: readonly IndexModelRecord[]): IndexModelStats[] {
  const byModel = new Map<EntryModelKind | 'UNKNOWN', IndexModelRecord[]>();
  for (const r of records) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const out: IndexModelStats[] = [];
  for (const [model, list] of byModel) {
    // Records are appended in settlement order, so index order is chronological.
    const ordered = [...list].sort((a, b) => a.settledAt - b.settledAt);
    const splitAt = Math.max(0, Math.floor(ordered.length * (1 - OUT_OF_SAMPLE_FRACTION)));
    const inSample = ordered.slice(0, splitAt);
    const outOfSample = ordered.slice(splitAt);

    const closed = ordered.filter((r) => isClosed(r.outcome));
    const wins = closed.filter((r) => r.outcome === 'TARGET_HIT').length;
    const losses = closed.filter(
      (r) => r.outcome === 'STOP_HIT' || r.outcome === 'INVALIDATED'
    ).length;
    const missed = ordered.filter((r) => r.outcome === 'MISSED').length;
    const rrValues = ordered.map((r) => r.riskRewardRatio).filter((v): v is number => v !== null);

    const inRate = winRate(inSample);
    const outRate = winRate(outOfSample);
    const outClosed = outOfSample.filter((r) => isClosed(r.outcome)).length;
    const overfitRisk =
      outClosed >= MIN_OUT_OF_SAMPLE &&
      inRate !== null &&
      outRate !== null &&
      inRate - outRate > OVERFIT_DROP_POINTS;

    out.push({
      model,
      label: model === 'UNKNOWN' ? 'Unclassified' : ENTRY_MODEL_KIND_LABELS[model],
      sampleSize: ordered.length,
      wins,
      losses,
      missed,
      winRatePercent: closed.length >= MIN_RELIABLE_SAMPLE ? Math.round((wins / closed.length) * 100) : null,
      avgRiskReward:
        rrValues.length > 0
          ? Math.round((rrValues.reduce((a, b) => a + b, 0) / rrValues.length) * 100) / 100
          : null,
      expectancy: expectancyOf(ordered),
      reliable: closed.length >= MIN_RELIABLE_SAMPLE,
      inSampleWinRatePercent: inRate,
      outOfSampleWinRatePercent: outRate,
      overfitRisk,
    });
  }
  return out.sort((a, b) => {
    const ea = a.expectancy ?? -Infinity;
    const eb = b.expectancy ?? -Infinity;
    if (eb !== ea) return eb - ea;
    return b.sampleSize - a.sampleSize;
  });
}

/** The best RELIABLE, non-overfit challenger for an index, or null. */
function bestChallenger(models: readonly IndexModelStats[]): IndexModelStats | null {
  const viable = models.filter(
    (m) => m.reliable && !m.overfitRisk && m.model !== 'UNKNOWN' && m.expectancy !== null
  );
  if (viable.length === 0) return null;
  return viable.reduce((best, m) =>
    (m.expectancy ?? -Infinity) > (best.expectancy ?? -Infinity) ? m : best
  );
}

/**
 * Builds one profile per index. `previous` carries the last validated selection per index
 * so a new pass can RETAIN it when no challenger genuinely beats it.
 */
export function buildIndexProfiles(
  records: readonly IndexModelRecord[],
  previous: ReadonlyMap<string, IndexModelProfile> = new Map()
): Map<string, IndexModelProfile> {
  const bySymbol = new Map<string, IndexModelRecord[]>();
  for (const r of records) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }

  const out = new Map<string, IndexModelProfile>();
  for (const [symbol, list] of bySymbol) {
    const models = statsForIndex(list);
    const incumbent = previous.get(symbol)?.selected ?? null;
    const incumbentStats = incumbent ? models.find((m) => m.model === incumbent) ?? null : null;
    const challenger = bestChallenger(models);

    let selected: EntryModelKind | null = incumbent;
    let retained = false;
    let retentionReason: string | null = null;
    let challengerKind: EntryModelKind | null = null;

    if (challenger) {
      challengerKind = challenger.model as EntryModelKind;
      if (incumbent && incumbentStats && incumbent !== challenger.model) {
        const incumbentExp = incumbentStats.expectancy ?? -Infinity;
        const challengerExp = challenger.expectancy ?? -Infinity;
        if (challengerExp > incumbentExp + CHALLENGER_MARGIN) {
          selected = challenger.model as EntryModelKind;
          retentionReason = `Adopted ${challenger.label} — expectancy ${challengerExp.toFixed(2)}R beats the retained ${incumbentStats.label} (${incumbentExp.toFixed(2)}R) by more than ${CHALLENGER_MARGIN}R.`;
        } else {
          retained = true;
          retentionReason = `Retained ${incumbentStats.label} (expectancy ${incumbentExp.toFixed(2)}R) — the challenger ${challenger.label} (${challengerExp.toFixed(2)}R) did not beat it by the ${CHALLENGER_MARGIN}R margin.`;
        }
      } else {
        selected = challenger.model as EntryModelKind;
        retentionReason = `Selected ${challenger.label} — the only reliable, non-overfit model for this index (expectancy ${(challenger.expectancy ?? 0).toFixed(2)}R).`;
      }
    } else if (incumbent) {
      retained = true;
      retentionReason = `Retained ${ENTRY_MODEL_KIND_LABELS[incumbent]} — no reliable challenger has enough out-of-sample evidence yet.`;
    } else {
      retentionReason = 'No reliable entry-model profile for this index yet — collecting outcomes.';
    }

    const selectedStats = selected ? models.find((m) => m.model === selected) ?? null : null;
    const latest = list.reduce((max, r) => Math.max(max, r.settledAt), 0);

    out.set(symbol, {
      symbol,
      displayName: list[0]?.displayName ?? symbol,
      marketFamily: list[0]?.marketFamily ?? 'OTHER',
      totalRecords: list.length,
      models,
      selected,
      selectedLabel: selected ? ENTRY_MODEL_KIND_LABELS[selected] : 'Collecting outcomes',
      selectedExpectancy: selectedStats?.expectancy ?? null,
      challenger: challengerKind,
      challengerLabel: challengerKind ? ENTRY_MODEL_KIND_LABELS[challengerKind] : null,
      retained,
      retentionReason,
      lastUpdated: latest || Date.now(),
    });
  }
  return out;
}

/**
 * Converts the per-index profiles into the historical bonus the Entry Model AI reads for
 * ONE index. Only a reliable, non-overfit model earns a bonus — never a fabricated one.
 */
export function indexHistoricalBonus(profile: IndexModelProfile | undefined): Partial<Record<EntryModelKind, number>> {
  if (!profile) return {};
  const bonus: Partial<Record<EntryModelKind, number>> = {};
  for (const m of profile.models) {
    if (m.model === 'UNKNOWN' || !m.reliable || m.overfitRisk || m.winRatePercent === null) continue;
    const kind = m.model as EntryModelKind;
    if (m.winRatePercent >= 60) bonus[kind] = 8;
    else if (m.winRatePercent >= 50) bonus[kind] = 4;
    else if (m.winRatePercent < 40) bonus[kind] = -6;
  }
  return bonus;
}

/** Builds the symbol → historical-bonus map the Entry Model AI consumes per candidate. */
export function indexHistoricalBonusMap(
  profiles: ReadonlyMap<string, IndexModelProfile>
): IndexHistoricalBonus {
  const out: IndexHistoricalBonus = new Map();
  for (const [symbol, profile] of profiles) out.set(symbol, indexHistoricalBonus(profile));
  return out;
}

/**
 * Per-index performance summary (for the UI). Never blended across indices — the caller
 * passes one index's records.
 */
export function summarizeIndexPerformance(records: readonly IndexModelRecord[]): EntryModelPerformance[] {
  const stats = statsForIndex(records);
  return stats.map((s) => ({
    model: s.model,
    label: s.label,
    sampleSize: s.sampleSize,
    wins: s.wins,
    losses: s.losses,
    missed: s.missed,
    winRatePercent: s.winRatePercent,
    avgRiskReward: s.avgRiskReward,
    reliable: s.reliable,
  }));
}
