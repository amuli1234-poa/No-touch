import type { ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Boxes,
  Braces,
  Crosshair,
  Gauge,
  GitBranch,
  Layers,
  LineChart,
  Radar,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Waves,
} from 'lucide-react';
import type { AiScannerValue } from '../../hooks/useAiScanner';
import { AiModuleView, type AiModuleMeta } from './AiModuleView';
import { BosRetracementPanel } from './BosRetracementPanel';
import { ConfluenceView } from './ConfluenceView';
import { ConsolidationPanel } from './ConsolidationPanel';
import { LiveScannerView } from './LiveScannerView';
import { PerformanceView } from './PerformanceView';
import { TimeframeAlignmentPanel } from './TimeframeAlignmentPanel';
import type { AiJournalHookValue } from '../../hooks/useAiJournal';

interface ModuleMetaConfig {
  title: string;
  subtitle: string;
  icon: ReactNode;
  settingsSubtitle: string;
  /** Optional module-specific panel rendered inside the module view (below the reads). */
  extraPanel?: AiModuleMeta['extraPanel'];
}

const ICON_CLASS = 'w-4 h-4';

const META: Record<string, ModuleMetaConfig> = {
  boschoch: {
    title: 'BOS & CHOCH AI',
    subtitle: 'BOS retracement & rejection — structure break is a setup, not an entry',
    icon: <TrendingUp className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Structure breaks are read on M30 → M15 → M10 → M7 → M6 → M5 → M4 → M3 → M2 → M1.',
    extraPanel: (analysis) => <BosRetracementPanel analysis={analysis} />,
  },
  technical: {
    title: 'Technical AI',
    subtitle: 'Condition-first adaptive indicator intelligence',
    icon: <Activity className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Classifies the market condition, then applies only the matching strategy.',
  },
  smc: {
    title: 'SMC, ICT & Price Action AI',
    subtitle: 'Institutional order-flow sequencing',
    icon: <Crosshair className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Liquidity → displacement → structure shift → point of interest.',
  },
  liquidity: {
    title: 'Liquidity AI',
    subtitle: 'Where liquidity sits, what was swept, what is the next draw',
    icon: <Waves className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Maps buy-side/sell-side pools, sweeps and future liquidity targets.',
  },
  fvg: {
    title: 'FVG & Imbalance AI',
    subtitle: 'Displacement imbalances with lifecycle tracking',
    icon: <Braces className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Validates genuine three-candle imbalances and their mitigation state.',
  },
  orderblock: {
    title: 'Order Block & Breaker Block AI',
    subtitle: 'Institutional zones and role-reversal breakers',
    icon: <Boxes className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Tracks fresh → tested → mitigated → invalidated → role-reversal zones.',
  },
  momentum: {
    title: 'Momentum & Volatility AI',
    subtitle: 'Momentum acceleration and volatility regime',
    icon: <Gauge className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Classifies volatility regime, then selects the fitting momentum model.',
  },
  regime: {
    title: 'Market Regime & Consolidation AI',
    subtitle: 'Trend vs range classification and transitions',
    icon: <Layers className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Classifies the regime and rates trading conditions before any setup.',
  },
  timeframealignment: {
    title: 'Timeframe Alignment AI',
    subtitle: 'Top-down multi-timeframe alignment — pullback vs reversal',
    icon: <GitBranch className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Reads M30 → M15 → M10 → M7 → M5 → M3 → M1 top-down and resolves one bias.',
    extraPanel: (analysis) => <TimeframeAlignmentPanel analysis={analysis} />,
  },
  consolidation: {
    title: 'Consolidation & Momentum AI',
    subtitle: 'Compression detection and breakout / momentum read',
    icon: <Gauge className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Detects consolidation, compression and volatility contraction, then reads expansion.',
    extraPanel: (analysis) => <ConsolidationPanel analysis={analysis} />,
  },
};

export function moduleViewFor(id: string, scanner: AiScannerValue): ReactNode {
  const meta = META[id];
  if (!meta) return null;
  const moduleMeta: AiModuleMeta = meta;
  return <AiModuleView scanner={scanner} meta={moduleMeta} />;
}

interface AiTabsProps {
  scanners: Record<string, AiScannerValue>;
  journal: AiJournalHookValue;
}

/** Resolves a section id to the correct AI tab view (signal modules / decision engines / performance). */
export function AiTabView({ id, scanners, journal }: AiTabsProps & { id: string }): ReactNode {
  if (id === 'confluence') return <ConfluenceView scanner={scanners.confluence} />;
  if (id === 'live') return <LiveScannerView scanner={scanners.live} />;
  if (id === 'performance') return <PerformanceView journal={journal} />;
  return moduleViewFor(id, scanners[id]);
}

export const AI_ICONS = {
  Radar: <Radar className={ICON_CLASS} aria-hidden="true" />,
  ShieldCheck: <ShieldCheck className={ICON_CLASS} aria-hidden="true" />,
  BarChart3: <BarChart3 className={ICON_CLASS} aria-hidden="true" />,
  Sparkles: <Sparkles className={ICON_CLASS} aria-hidden="true" />,
  LineChart: <LineChart className={ICON_CLASS} aria-hidden="true" />,
  ScanSearch: <ScanSearch className={ICON_CLASS} aria-hidden="true" />,
};
