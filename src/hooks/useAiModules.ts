import { useMemo, useRef } from 'react';
import { useAiScanner, type AiScannerValue } from './useAiScanner';
import type { AiEngine } from './useAiScanner';
import type { PeerEvidence } from '../analysis/peerValidation';
import type { DerivWebSocketService } from '../services/derivWebSocket';
import type { ConnectionStatus, SyntheticMarket } from '../types/market';
import type { IndexLearningPlan } from '../types/learning';
import { analyzeBosChochInstrument, BOS_CHOCH_PUBLICATION_MIN_SCORE } from '../analysis/bosChochEngine';
import { analyzeTechnicalInstrument, TECHNICAL_PUBLICATION_MIN_SCORE } from '../analysis/technicalEngine';
import { analyzeSmcInstrument, SMC_PUBLICATION_MIN_SCORE } from '../analysis/smcEngine';
import { analyzeLiquidityInstrument, LIQUIDITY_PUBLICATION_MIN_SCORE } from '../analysis/liquidityEngine';
import { analyzeFvgInstrument, FVG_PUBLICATION_MIN_SCORE } from '../analysis/fvgEngine';
import { analyzeOrderBlockInstrument, ORDER_BLOCK_PUBLICATION_MIN_SCORE } from '../analysis/orderBlockEngine';
import { analyzeMomentumInstrument, MOMENTUM_PUBLICATION_MIN_SCORE } from '../analysis/momentumEngine';
import { analyzeMarketRegimeInstrument, REGIME_PUBLICATION_MIN_SCORE } from '../analysis/marketRegimeEngine';
import { analyzeConfluenceInstrument, CONFLUENCE_PUBLICATION_MIN_SCORE } from '../analysis/confluenceEngine';
import { analyzeLiveInstrument, LIVE_SCANNER_PUBLICATION_MIN_SCORE } from '../analysis/liveScannerEngine';
import {
  analyzeTimeframeAlignmentInstrument,
  TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE,
} from '../analysis/timeframeAlignmentEngine';
import {
  analyzeConsolidationInstrument,
  CONSOLIDATION_PUBLICATION_MIN_SCORE,
} from '../analysis/consolidationEngine';

/**
 * Central registry for the independent AI strategy modules. Every entry owns its OWN
 * engine (independent decisions) and is driven by the shared scanner orchestrator. Adding
 * a future module is a one-line addition here — no other module is touched.
 */
export interface AiModuleDefinition {
  id: string;
  label: string;
  engine: AiEngine;
  publicationGate: number;
  defaultMinScore: number;
  progressLabel: string;
  /** True for decision engines that consume peer evidence from sibling modules. */
  consumesPeers?: boolean;
  /** True for modules that consume the Timeframe Learner's verified per-index plan. */
  consumesLearner?: boolean;
}

export const AI_MODULE_DEFINITIONS: readonly AiModuleDefinition[] = [
  {
    id: 'boschoch',
    label: 'BOS & CHOCH AI',
    engine: analyzeBosChochInstrument,
    publicationGate: BOS_CHOCH_PUBLICATION_MIN_SCORE,
    defaultMinScore: BOS_CHOCH_PUBLICATION_MIN_SCORE,
    progressLabel: 'M15 structure · M7 trend · M5 setup · M3 confirmation · M1 entry',
  },
  {
    id: 'technical',
    label: 'Technical AI',
    engine: analyzeTechnicalInstrument,
    publicationGate: TECHNICAL_PUBLICATION_MIN_SCORE,
    defaultMinScore: TECHNICAL_PUBLICATION_MIN_SCORE,
    progressLabel: 'condition-first indicator confluence',
  },
  {
    id: 'smc',
    label: 'SMC, ICT & Price Action AI',
    engine: analyzeSmcInstrument,
    publicationGate: SMC_PUBLICATION_MIN_SCORE,
    defaultMinScore: SMC_PUBLICATION_MIN_SCORE,
    progressLabel: 'liquidity → displacement → structure sequence',
  },
  {
    id: 'liquidity',
    label: 'Liquidity AI',
    engine: analyzeLiquidityInstrument,
    publicationGate: LIQUIDITY_PUBLICATION_MIN_SCORE,
    defaultMinScore: LIQUIDITY_PUBLICATION_MIN_SCORE,
    progressLabel: 'pools · sweeps · draw-on-liquidity',
  },
  {
    id: 'fvg',
    label: 'FVG & Imbalance AI',
    engine: analyzeFvgInstrument,
    publicationGate: FVG_PUBLICATION_MIN_SCORE,
    defaultMinScore: FVG_PUBLICATION_MIN_SCORE,
    progressLabel: 'displacement imbalances + lifecycle',
  },
  {
    id: 'orderblock',
    label: 'Order Block & Breaker Block AI',
    engine: analyzeOrderBlockInstrument,
    publicationGate: ORDER_BLOCK_PUBLICATION_MIN_SCORE,
    defaultMinScore: ORDER_BLOCK_PUBLICATION_MIN_SCORE,
    progressLabel: 'institutional zones + breakers',
  },
  {
    id: 'momentum',
    label: 'Momentum & Volatility AI',
    engine: analyzeMomentumInstrument,
    publicationGate: MOMENTUM_PUBLICATION_MIN_SCORE,
    defaultMinScore: MOMENTUM_PUBLICATION_MIN_SCORE,
    progressLabel: 'momentum + volatility regime',
  },
  {
    id: 'regime',
    label: 'Market Regime & Consolidation AI',
    engine: analyzeMarketRegimeInstrument,
    publicationGate: REGIME_PUBLICATION_MIN_SCORE,
    defaultMinScore: REGIME_PUBLICATION_MIN_SCORE,
    progressLabel: 'trend vs range classification',
  },
  {
    id: 'confluence',
    label: 'Confluence & Trade Validation AI',
    engine: (params) => analyzeConfluenceInstrument({ ...params, peers: params.peers ?? [] }),
    publicationGate: CONFLUENCE_PUBLICATION_MIN_SCORE,
    defaultMinScore: CONFLUENCE_PUBLICATION_MIN_SCORE,
    progressLabel: 'independent multi-module validation',
    consumesPeers: true,
  },
  {
    id: 'live',
    label: 'Live Market Scanner',
    engine: analyzeLiveInstrument,
    publicationGate: LIVE_SCANNER_PUBLICATION_MIN_SCORE,
    defaultMinScore: LIVE_SCANNER_PUBLICATION_MIN_SCORE,
    progressLabel: 'multi-market opportunity ranking',
  },
  {
    id: 'timeframealignment',
    label: 'Timeframe Alignment AI',
    engine: analyzeTimeframeAlignmentInstrument,
    publicationGate: TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE,
    defaultMinScore: TIMEFRAME_ALIGNMENT_PUBLICATION_MIN_SCORE,
    progressLabel: 'M30 bias → M15/M10 structure → M7/M5 setup → M3/M1 entry',
    consumesLearner: true,
  },
  {
    id: 'consolidation',
    label: 'Consolidation & Momentum AI',
    engine: analyzeConsolidationInstrument,
    publicationGate: CONSOLIDATION_PUBLICATION_MIN_SCORE,
    defaultMinScore: CONSOLIDATION_PUBLICATION_MIN_SCORE,
    progressLabel: 'consolidation · compression · momentum · breakout confirmation',
  },
];

export interface AiModulesHookProps {
  derivService: DerivWebSocketService;
  markets: SyntheticMarket[];
  /** Live connection status — gates the automatic background sweep. */
  connectionStatus?: ConnectionStatus;
  /** When false no module auto-scans (default: true). */
  autoStart?: boolean;
  /** The Learning AI's learned per-index timeframe plans (consumed by the Alignment AI). */
  learnerPlans?: ReadonlyMap<string, IndexLearningPlan>;
}

export type AiModuleScanners = Record<string, AiScannerValue>;

/** Stagger sibling modules so ten sweeps never hit the socket at once. */
const MODULE_START_STAGGER_MS = 5_000;
const MODULE_REFRESH_MS = 180_000;

function scannerProps(
  def: AiModuleDefinition,
  derivService: DerivWebSocketService,
  markets: SyntheticMarket[],
  index: number,
  connectionStatus: ConnectionStatus,
  autoStart: boolean,
  getPeers?: (symbol: string) => PeerEvidence[],
  getLearnerPlan?: (symbol: string) => IndexLearningPlan | null
) {
  return {
    derivService,
    markets,
    engine: def.engine,
    publicationGate: def.publicationGate,
    defaultMinScore: def.defaultMinScore,
    progressLabel: def.progressLabel,
    getPeers,
    getLearnerPlan,
    connectionStatus,
    autoStart,
    autoStartDelayMs: index * MODULE_START_STAGGER_MS,
    autoRefreshMs: MODULE_REFRESH_MS,
  };
}

/**
 * Instantiates ONE independent scanner per module. Each scanner fetches its own candles,
 * runs its own engine and keeps its own settings, history and results. The Confluence
 * module additionally receives peer signals (never decisions) from every sibling scanner.
 */
export function useAiModules({
  derivService,
  markets,
  connectionStatus = 'connected',
  autoStart = true,
  learnerPlans,
}: AiModulesHookProps): AiModuleScanners {
  const learnerPlansRef = useRef(learnerPlans);
  learnerPlansRef.current = learnerPlans;
  const getLearnerPlan = useMemo(
    () => (symbol: string): IndexLearningPlan | null => learnerPlansRef.current?.get(symbol) ?? null,
    []
  );

  const p = (i: number, getPeers?: (symbol: string) => PeerEvidence[]) =>
    scannerProps(
      AI_MODULE_DEFINITIONS[i],
      derivService,
      markets,
      i,
      connectionStatus,
      autoStart,
      getPeers,
      getLearnerPlan
    );

  const boschoch = useAiScanner(p(0));
  const technical = useAiScanner(p(1));
  const smc = useAiScanner(p(2));
  const liquidity = useAiScanner(p(3));
  const fvg = useAiScanner(p(4));
  const orderblock = useAiScanner(p(5));
  const momentum = useAiScanner(p(6));
  const regime = useAiScanner(p(7));
  const live = useAiScanner(p(9));
  const timeframealignment = useAiScanner(p(10));
  const consolidation = useAiScanner(p(11));

  // Peer evidence is read live from each module's latest published signal (per index only).
  const peerScanners: { module: string; scanner: AiScannerValue }[] = [
    { module: AI_MODULE_DEFINITIONS[0].label, scanner: boschoch },
    { module: AI_MODULE_DEFINITIONS[1].label, scanner: technical },
    { module: AI_MODULE_DEFINITIONS[2].label, scanner: smc },
    { module: AI_MODULE_DEFINITIONS[3].label, scanner: liquidity },
    { module: AI_MODULE_DEFINITIONS[4].label, scanner: fvg },
    { module: AI_MODULE_DEFINITIONS[5].label, scanner: orderblock },
    { module: AI_MODULE_DEFINITIONS[6].label, scanner: momentum },
    { module: AI_MODULE_DEFINITIONS[7].label, scanner: regime },
    { module: AI_MODULE_DEFINITIONS[10].label, scanner: timeframealignment },
    { module: AI_MODULE_DEFINITIONS[11].label, scanner: consolidation },
  ];
  const peersRef = useRef(peerScanners);
  peersRef.current = peerScanners;

  const getPeers = useMemo(
    () =>
      (symbol: string): PeerEvidence[] => {
        const out: PeerEvidence[] = [];
        for (const { module, scanner } of peersRef.current) {
          const analysis = scanner.analyses.find((a) => a.symbol === symbol);
          if (analysis?.signal) out.push({ module, signal: analysis.signal });
        }
        return out;
      },
    []
  );

  const confluence = useAiScanner(p(8, getPeers));

  return useMemo(
    () => ({
      boschoch,
      technical,
      smc,
      liquidity,
      fvg,
      orderblock,
      momentum,
      regime,
      confluence,
      live,
      timeframealignment,
      consolidation,
    }),
    [
      boschoch,
      technical,
      smc,
      liquidity,
      fvg,
      orderblock,
      momentum,
      regime,
      confluence,
      live,
      timeframealignment,
      consolidation,
    ]
  );
}
