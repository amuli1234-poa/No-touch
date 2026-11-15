import { useMemo, useRef } from 'react';
import { useAiScanner, type AiScannerValue } from './useAiScanner';
import type { AiEngine } from './useAiScanner';
import type { PeerEvidence } from '../analysis/peerValidation';
import type { DerivWebSocketService } from '../services/derivWebSocket';
import type { SyntheticMarket } from '../types/market';
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
}

export const AI_MODULE_DEFINITIONS: readonly AiModuleDefinition[] = [
  {
    id: 'boschoch',
    label: 'BOS & CHOCH AI',
    engine: analyzeBosChochInstrument,
    publicationGate: BOS_CHOCH_PUBLICATION_MIN_SCORE,
    defaultMinScore: BOS_CHOCH_PUBLICATION_MIN_SCORE,
    progressLabel: 'M15 structure · M5 setup · M1 entry',
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
];

export interface AiModulesHookProps {
  derivService: DerivWebSocketService;
  markets: SyntheticMarket[];
}

export type AiModuleScanners = Record<string, AiScannerValue>;

function scannerProps(
  def: AiModuleDefinition,
  derivService: DerivWebSocketService,
  markets: SyntheticMarket[],
  getPeers?: (symbol: string) => PeerEvidence[]
) {
  return {
    derivService,
    markets,
    engine: def.engine,
    publicationGate: def.publicationGate,
    defaultMinScore: def.defaultMinScore,
    progressLabel: def.progressLabel,
    getPeers,
  };
}

/**
 * Instantiates ONE independent scanner per module. Each scanner fetches its own candles,
 * runs its own engine and keeps its own settings, history and results. The Confluence
 * module additionally receives peer signals (never decisions) from every sibling scanner.
 */
export function useAiModules({ derivService, markets }: AiModulesHookProps): AiModuleScanners {
  const boschoch = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[0], derivService, markets));
  const technical = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[1], derivService, markets));
  const smc = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[2], derivService, markets));
  const liquidity = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[3], derivService, markets));
  const fvg = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[4], derivService, markets));
  const orderblock = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[5], derivService, markets));
  const momentum = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[6], derivService, markets));
  const regime = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[7], derivService, markets));
  const live = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[9], derivService, markets));

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

  const confluence = useAiScanner(scannerProps(AI_MODULE_DEFINITIONS[8], derivService, markets, getPeers));

  return useMemo(
    () => ({ boschoch, technical, smc, liquidity, fvg, orderblock, momentum, regime, confluence, live }),
    [boschoch, technical, smc, liquidity, fvg, orderblock, momentum, regime, confluence, live]
  );
}
