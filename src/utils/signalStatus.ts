import type { FullAnalysisReport } from '../types/analysis';
import type { DirectionPreference } from '../hooks/useAppSettings';
import type { QualityTier } from '../types/engine';

export type SignalLifecycleStatus =
  | 'WAITING'
  | 'DEVELOPING'
  | 'CONFIRMED'
  | 'INVALIDATED';

export interface SignalLifecycle {
  status: SignalLifecycleStatus;
  label: string;
  description: string;
  /** Only CONFIRMED setups are actionable signals. */
  isActionable: boolean;
  /** Set when a confirmed setup is suppressed by a user filter. */
  filterSuppressed?: boolean;
}

export interface SignalLifecycleOptions {
  minQuality?: 'ANY' | 'MODERATE' | 'HIGH';
  directionPreference?: DirectionPreference;
}

const QUALITY_RANK: Record<QualityTier, number> = {
  REJECTED: 0,
  DEVELOPING: 1,
  HIGH_QUALITY: 2,
  EXCEPTIONAL: 3,
};

/**
 * Derives the four-state signal lifecycle from the existing engine report.
 * CONFIRMED / INVALIDATED come straight from the engine decision; DEVELOPING and
 * WAITING are inferred from the strict-filter evidence so the UI never invents a
 * signal the engine did not produce. User quality/direction filters can only
 * demote a CONFIRMED setup, never promote anything.
 */
export function deriveSignalLifecycle(
  report: FullAnalysisReport | null,
  options: SignalLifecycleOptions = {}
): SignalLifecycle | null {
  if (!report) return null;

  const { minQuality = 'ANY', directionPreference = 'BOTH' } = options;

  if (report.signalStatus === 'CONFIRMED' && report.overlays.signal) {
    const signal = report.overlays.signal;
    const minRank = minQuality === 'HIGH' ? 2 : minQuality === 'MODERATE' ? 1 : 0;
    const qualityRank = QUALITY_RANK[signal.quality.tier] ?? 0;
    const directionBlocked =
      directionPreference !== 'BOTH' && signal.direction !== directionPreference;

    if (qualityRank < minRank || directionBlocked) {
      return {
        status: 'DEVELOPING',
        label: 'FILTERED',
        description: directionBlocked
          ? `A confirmed ${signal.direction} setup was generated but is suppressed by your ${directionPreference}-only direction preference.`
          : `A confirmed ${signal.quality.tier} setup was generated but is below your minimum quality filter (${minQuality}).`,
        isActionable: false,
        filterSuppressed: true,
      };
    }

    return {
      status: 'CONFIRMED',
      label: 'CONFIRMED',
      description:
        'A fully developed setup passed every confirmation rule and is actionable.',
      isActionable: true,
    };
  }

  if (
    report.signalStatus === 'INVALIDATED' ||
    report.runState === 'SETUP INVALIDATED'
  ) {
    return {
      status: 'INVALIDATED',
      label: 'INVALIDATED',
      description:
        'The previous setup lost validity when live price broke its technical invalidation level.',
      isActionable: false,
    };
  }

  if (report.runState === 'WAITING FOR CONFIRMATION') {
    return {
      status: 'DEVELOPING',
      label: 'DEVELOPING',
      description:
        'A potential setup is forming but has not yet met the required confirmation rules.',
      isActionable: false,
    };
  }

  if (
    report.runState === 'NO VALID SETUP' ||
    report.setupQuality === 'INVALID SETUP'
  ) {
    return {
      status: 'WAITING',
      label: 'WAITING',
      description:
        'No valid setup. The scanner is waiting for a fully confirmed price-action setup.',
      isActionable: false,
    };
  }

  const isDeveloping =
    report.setupQuality === 'DEVELOPING' ||
    report.confluenceScore >= 3 ||
    report.recommendedDirection !== 'WAIT';

  if (isDeveloping) {
    return {
      status: 'DEVELOPING',
      label: 'DEVELOPING',
      description:
        'Partial confluence is present, but confirmation is still incomplete. Not actionable.',
      isActionable: false,
    };
  }

  return {
    status: 'WAITING',
    label: 'WAITING',
    description:
      'No valid setup. The scanner is waiting for a fully confirmed price-action setup.',
    isActionable: false,
  };
}

export interface StatusStyle {
  text: string;
  bg: string;
  border: string;
  dot: string;
  accent: string;
}

export const SIGNAL_STATUS_STYLE: Record<SignalLifecycleStatus, StatusStyle> = {
  WAITING: {
    text: 'text-muted',
    bg: 'bg-panel',
    border: 'border-line',
    dot: 'bg-faint',
    accent: '#64748b',
  },
  DEVELOPING: {
    text: 'text-warn',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    dot: 'bg-amber-400',
    accent: '#d97706',
  },
  CONFIRMED: {
    text: 'text-emerald-400',
    bg: 'bg-emerald-500/12',
    border: 'border-emerald-500/30',
    dot: 'bg-emerald-400',
    accent: '#16a34a',
  },
  INVALIDATED: {
    text: 'text-bear',
    bg: 'bg-red-500/12',
    border: 'border-red-500/30',
    dot: 'bg-red-500',
    accent: '#dc2626',
  },
};
