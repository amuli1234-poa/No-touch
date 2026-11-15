import type { ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Boxes,
  Braces,
  Crosshair,
  Gauge,
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
import { ConfluenceView } from './ConfluenceView';
import { LiveScannerView } from './LiveScannerView';
import { PerformanceView } from './PerformanceView';
import type { AiJournalHookValue } from '../../hooks/useAiJournal';

interface ModuleMetaConfig {
  title: string;
  subtitle: string;
  icon: ReactNode;
  settingsSubtitle: string;
}

const ICON_CLASS = 'w-4 h-4';

const META: Record<string, ModuleMetaConfig> = {
  boschoch: {
    title: 'BOS & CHOCH AI',
    subtitle: 'Break-of-structure & change-of-character intelligence',
    icon: <TrendingUp className={ICON_CLASS} aria-hidden="true" />,
    settingsSubtitle: 'Structure breaks are read on M15, refined on M5 and confirmed on M1.',
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
