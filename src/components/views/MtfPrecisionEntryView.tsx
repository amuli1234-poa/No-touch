import React, { useState, useMemo } from 'react';
import { ActiveSymbol, OpportunitySignal, Timeframe, MomentumClassification } from '../../types/scanner';
import { DerivWebSocketManager } from '../../services/DerivWebSocketManager';
import { MarketStructureEngine } from '../../engines/MarketStructureEngine';
import { SupportResistanceEngine } from '../../engines/SupportResistanceEngine';
import { 
  Compass, 
  Layers, 
  ArrowUpRight, 
  ArrowDownRight, 
  CheckCircle2, 
  Clock, 
  AlertTriangle, 
  ShieldAlert,
  Zap,
  TrendingUp,
  TrendingDown
} from 'lucide-react';

interface MtfPrecisionEntryViewProps {
  symbols: ActiveSymbol[];
  opportunities: Map<string, OpportunitySignal>;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string, targetTab?: 'LIVE_CHART' | 'ANALYSIS') => void;
  wsManager: DerivWebSocketManager;
}

type MtfState =
  | 'ANALYZING_HTF'
  | 'BIAS_ESTABLISHED'
  | 'IDENTIFYING_ZONE'
  | 'WAITING_FOR_RETEST'
  | 'ZONE_TOUCHED'
  | 'WAITING_FOR_REJECTION'
  | 'WAITING_FOR_MICRO_BOS'
  | 'CONFIRMING_MOMENTUM'
  | 'ENTER_SIGNAL'
  | 'SETUP_INVALIDATED';

interface MtfAnalysisResult {
  symbol: string;
  displayName: string;
  currentPrice: number;
  htfBias: 'BULLISH BIAS' | 'BEARISH BIAS' | 'NEUTRAL / NO TRADE';
  patternName: string;
  zoneRange: [number, number];
  zoneType: 'DEMAND' | 'SUPPLY' | 'SUPPORT' | 'RESISTANCE' | 'NONE';
  state: MtfState;
  stateDescription: string;
  retestConfirmed: boolean;
  rejectionConfirmed: boolean;
  microBosConfirmed: boolean;
  momentumStatus: MomentumClassification;
  signalAction: 'ENTER RISE' | 'ENTER FALL' | 'WAIT' | 'NO TRADE';
  entryPrice?: number;
  invalidationLevel?: number;
  takeProfit?: number;
  contractDuration: string;
  qualityRating: 'HIGH CONFLUENCE' | 'MODERATE CONFLUENCE' | 'NO TRADE';
  steps: { name: string; completed: boolean; current: boolean; detail: string }[];
}

export const MtfPrecisionEntryView: React.FC<MtfPrecisionEntryViewProps> = ({
  symbols,
  opportunities,
  selectedSymbol,
  onSelectSymbol,
  wsManager
}) => {
  const [activeSymbol, setActiveSymbol] = useState<string>(selectedSymbol);

  const symInfo = symbols.find((s) => s.symbol === activeSymbol) || symbols[0];
  const opp = opportunities.get(activeSymbol);

  const symStore = wsManager.candles.get(activeSymbol);
  const c1h = symStore?.get('1h') || [];
  const c15m = symStore?.get('15m') || [];
  const c5m = symStore?.get('5m') || [];
  const c1m = symStore?.get('1m') || [];

  const analysis: MtfAnalysisResult = useMemo(() => {
    if (c1m.length < 15 || c1h.length < 5) {
      return {
        symbol: activeSymbol,
        displayName: symInfo?.displayName || activeSymbol,
        currentPrice: symInfo?.lastQuote || 0,
        htfBias: 'NEUTRAL / NO TRADE',
        patternName: 'Gathering candle history...',
        zoneRange: [0, 0],
        zoneType: 'NONE',
        state: 'ANALYZING_HTF',
        stateDescription: 'Analyzing H1 higher timeframe market structure & directional bias.',
        retestConfirmed: false,
        rejectionConfirmed: false,
        microBosConfirmed: false,
        momentumStatus: 'WEAK',
        signalAction: 'NO TRADE',
        contractDuration: '5 minutes',
        qualityRating: 'NO TRADE',
        steps: []
      };
    }

    const currentPrice = c1m[c1m.length - 1].close;
    const h1Pivots = MarketStructureEngine.findPivots(c1h, 2, 2);
    const h1Bias = MarketStructureEngine.getDirectionalBias(h1Pivots, currentPrice);
    const h1Zones = SupportResistanceEngine.mapZones(c1h, h1Pivots, '1h', 0.0025);

    let htfBias: MtfAnalysisResult['htfBias'] = 'NEUTRAL / NO TRADE';
    if (h1Bias === 'BULLISH') htfBias = 'BULLISH BIAS';
    else if (h1Bias === 'BEARISH') htfBias = 'BEARISH BIAS';

    const relevantZone = h1Zones.find(
      (z) => !z.broken && Math.abs(currentPrice - (z.upperPrice + z.lowerPrice) / 2) / currentPrice <= 0.015
    );

    const zoneType = relevantZone ? relevantZone.type : (h1Bias === 'BULLISH' ? 'DEMAND' : 'SUPPLY');
    const zoneRange: [number, number] = relevantZone
      ? [relevantZone.lowerPrice, relevantZone.upperPrice]
      : [currentPrice * 0.992, currentPrice * 1.008];

    // Evaluate mandatory retest-first rule
    const inZone = relevantZone
      ? currentPrice >= relevantZone.lowerPrice && currentPrice <= relevantZone.upperPrice
      : Math.abs(currentPrice - (zoneRange[0] + zoneRange[1]) / 2) / currentPrice <= 0.005;

    const nearZone = relevantZone
      ? Math.abs(currentPrice - (relevantZone.upperPrice + relevantZone.lowerPrice) / 2) / currentPrice <= 0.012
      : true;

    const m5Pivots = MarketStructureEngine.findPivots(c5m, 2, 2);
    const m5Shifts = MarketStructureEngine.detectStructuralShifts(c5m, m5Pivots);
    const microBos = m5Shifts.length > 0 && m5Shifts[m5Shifts.length - 1].direction === h1Bias;

    const latest1m = c1m[c1m.length - 1];
    const prior1m = c1m.length >= 2 ? c1m[c1m.length - 2] : latest1m;
    const isRejection =
      h1Bias === 'BULLISH'
        ? latest1m.close > prior1m.high || (latest1m.close - latest1m.low) > (latest1m.high - latest1m.close) * 1.5
        : latest1m.close < prior1m.low || (latest1m.high - latest1m.close) > (latest1m.close - latest1m.low) * 1.5;

    let state: MtfState = 'ANALYZING_HTF';
    let stateDesc = 'Analyzing H1 market direction and major chart patterns.';
    let signalAction: MtfAnalysisResult['signalAction'] = 'NO TRADE';
    let qualityRating: MtfAnalysisResult['qualityRating'] = 'NO TRADE';

    if (htfBias === 'NEUTRAL / NO TRADE') {
      state = 'ANALYZING_HTF';
      stateDesc = 'Sideways or conflicting H1 market structure. Displaying NO TRADE.';
    } else if (!relevantZone && !nearZone) {
      state = 'IDENTIFYING_ZONE';
      stateDesc = `Established ${htfBias}. Identifying key ${zoneType} zone for price return.`;
    } else if (nearZone && !inZone) {
      state = 'WAITING_FOR_RETEST';
      stateDesc = `Price approaching identified ${zoneType} zone. Waiting for physical retest touch.`;
    } else if (inZone) {
      state = 'ZONE_TOUCHED';
      stateDesc = `Mandatory Retest-First Rule met: Price touched ${zoneType} zone at ${currentPrice.toFixed(2)}.`;
      if (!isRejection) {
        state = 'WAITING_FOR_REJECTION';
        stateDesc = 'Zone touched. Waiting for lower-timeframe candle rejection response.';
      } else if (!microBos) {
        state = 'WAITING_FOR_MICRO_BOS';
        stateDesc = 'Rejection detected. Waiting for M5 micro break of structure (BOS).';
      } else {
        state = 'CONFIRMING_MOMENTUM';
        stateDesc = 'Micro BOS confirmed. Confirming fresh directional momentum away from zone.';
        signalAction = h1Bias === 'BULLISH' ? 'ENTER RISE' : 'ENTER FALL';
        qualityRating = 'HIGH CONFLUENCE';
      }
    }

    if (opp && opp.setupTier === 'HIGH_QUALITY' && opp.entryAndTp.confirmed) {
      state = 'ENTER_SIGNAL';
      signalAction = opp.direction === 'BULLISH' ? 'ENTER RISE' : 'ENTER FALL';
      qualityRating = 'HIGH CONFLUENCE';
      stateDesc = `Confirmed ${opp.riseFallLabel} precision entry via ${opp.selectedStrategy.label}.`;
    }

    const steps = [
      { name: '1. HTF Direction (H1 / M30)', completed: htfBias !== 'NEUTRAL / NO TRADE', current: state === 'ANALYZING_HTF', detail: htfBias },
      { name: '2. Zone Identification', completed: Boolean(relevantZone), current: state === 'IDENTIFYING_ZONE', detail: `${zoneType} [${zoneRange[0].toFixed(2)} - ${zoneRange[1].toFixed(2)}]` },
      { name: '3. Mandatory Retest-First', completed: inZone || nearZone, current: state === 'WAITING_FOR_RETEST', detail: inZone ? 'Retest complete (touched)' : 'Waiting for touch' },
      { name: '4. Rejection Confirmation', completed: isRejection, current: state === 'WAITING_FOR_REJECTION', detail: isRejection ? 'Rejection candle confirmed' : 'Awaiting rejection' },
      { name: '5. M5 Micro BOS', completed: microBos, current: state === 'WAITING_FOR_MICRO_BOS', detail: microBos ? 'Micro BOS confirmed' : 'Awaiting micro BOS' },
      { name: '6. Momentum & Precision Entry', completed: signalAction === 'ENTER RISE' || signalAction === 'ENTER FALL', current: state === 'ENTER_SIGNAL', detail: signalAction }
    ];

    return {
      symbol: activeSymbol,
      displayName: symInfo?.displayName || activeSymbol,
      currentPrice,
      htfBias,
      patternName: opp?.selectedStrategy.label || (relevantZone?.isFlip ? 'S/R Role Reversal Flip' : 'Trendline Continuation & S&D'),
      zoneRange,
      zoneType,
      state,
      stateDescription: stateDesc,
      retestConfirmed: inZone,
      rejectionConfirmed: isRejection,
      microBosConfirmed: microBos,
      momentumStatus: opp?.momentum.classification || 'MODERATE',
      signalAction,
      entryPrice: opp?.entryAndTp.entryPrice || currentPrice,
      invalidationLevel: opp?.entryAndTp.invalidationLevel || (h1Bias === 'BULLISH' ? currentPrice * 0.992 : currentPrice * 1.008),
      takeProfit: opp?.entryAndTp.takeProfit || (h1Bias === 'BULLISH' ? currentPrice * 1.018 : currentPrice * 0.982),
      contractDuration: opp?.expectedHoldingTime || '5 minutes (M5/M15 swing)',
      qualityRating,
      steps
    };
  }, [activeSymbol, c1m, c1h, c5m, symInfo, opp]);

  return (
    <div className="space-y-6">
      {/* Header & Market Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-surface border border-line/90 shadow-lg">
        <div>
          <h2 className="text-sm font-bold text-fg-1 flex items-center gap-2">
            <Compass className="w-4 h-4 text-accent-soft" />
            <span>MTF Precision Entry Engine (Top-Down Analysis Terminal)</span>
          </h2>
          <p className="text-xs text-fg-4 mt-1 max-w-2xl">
            Enforces the strict Retest-First rule: Higher timeframe directional bias, middle timeframe zone refinement, and lower timeframe entry confirmation.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs font-mono text-fg-4">Select Market:</label>
          <select
            value={activeSymbol}
            onChange={(e) => setActiveSymbol(e.target.value)}
            className="bg-surface-deep border border-line rounded-lg px-3 py-2 text-xs font-mono text-fg-1 focus:border-accent focus:outline-none"
          >
            {symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.displayName} ({s.is1s ? '1s' : 'Plain'})
              </option>
            ))}
          </select>
          <button
            onClick={() => onSelectSymbol(activeSymbol, 'LIVE_CHART')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent hover:bg-accent-strong text-on-accent text-xs font-bold transition"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Open Chart</span>
          </button>
        </div>
      </div>

      {/* Main Grid: State Machine & Execution Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: 10-State Machine Progress Stepper */}
        <div className="lg:col-span-5 rounded-xl border border-line/90 bg-surface p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-line/80">
            <h3 className="text-xs font-bold uppercase tracking-wider text-fg-2 font-mono flex items-center gap-2">
              <Clock className="w-4 h-4 text-accent-soft" />
              <span>Mandatory Retest Sequence</span>
            </h3>
            <span
              className={`px-2.5 py-1 rounded-full text-[10px] font-mono font-bold uppercase ${
                analysis.qualityRating === 'HIGH CONFLUENCE'
                  ? 'bg-success/80 text-success border border-success/60'
                  : 'bg-warning/60 text-warning border border-warning/50'
              }`}
            >
              {analysis.state.replace(/_/g, ' ')}
            </span>
          </div>

          <p className="text-xs text-fg-3 font-sans italic bg-surface-deep/60 p-3 rounded-lg border border-line/80">
            "{analysis.stateDescription}"
          </p>

          <div className="space-y-2.5">
            {analysis.steps.map((st, i) => (
              <div
                key={i}
                className={`p-3 rounded-lg border flex items-center justify-between text-xs font-mono transition ${
                  st.completed
                    ? 'bg-success/20 border-success/40 text-fg-2'
                    : st.current
                    ? 'bg-accent/30 border-accent/50 text-accent-cyan'
                    : 'bg-surface-deep/40 border-line/60 text-fg-5'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {st.completed ? (
                    <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                  ) : st.current ? (
                    <div className="w-4 h-4 rounded-full border-2 border-accent-soft border-t-transparent animate-spin shrink-0" />
                  ) : (
                    <div className="w-4 h-4 rounded-full bg-surface-raised border border-line-strong shrink-0" />
                  )}
                  <span className="font-semibold">{st.name}</span>
                </div>
                <span className="text-[11px] font-semibold text-right">{st.detail}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Final Precision Signal & Execution Panel */}
        <div className="lg:col-span-7 rounded-xl border border-line/90 bg-surface p-5 space-y-5">
          <div className="flex items-center justify-between pb-3 border-b border-line/80">
            <h3 className="text-xs font-bold uppercase tracking-wider text-fg-2 font-mono flex items-center gap-2">
              <Zap className="w-4 h-4 text-success" />
              <span>Precision Entry Signal Panel</span>
            </h3>
            <span className="text-xs font-mono text-fg-4">
              Current: <strong className="text-fg-1">{analysis.currentPrice.toFixed(2)}</strong>
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 font-mono tabular-nums">
            <div className="p-3.5 rounded-lg bg-surface-deep/60 border border-line">
              <span className="text-[10px] text-fg-4 uppercase block">HTF Direction (H1)</span>
              <span
                className={`text-sm font-bold mt-1 block ${
                  analysis.htfBias === 'BULLISH BIAS' ? 'text-success' : analysis.htfBias === 'BEARISH BIAS' ? 'text-danger' : 'text-warning'
                }`}
              >
                {analysis.htfBias}
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-surface-deep/60 border border-line">
              <span className="text-[10px] text-fg-4 uppercase block">Identified Setup</span>
              <span className="text-xs font-bold text-fg-1 mt-1 block truncate" title={analysis.patternName}>
                {analysis.patternName}
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-surface-deep/60 border border-line">
              <span className="text-[10px] text-fg-4 uppercase block">Retest Zone Range</span>
              <span className="text-xs font-bold text-accent-cyan mt-1 block">
                {analysis.zoneRange[0].toFixed(2)} – {analysis.zoneRange[1].toFixed(2)}
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-surface-deep/60 border border-line">
              <span className="text-[10px] text-fg-4 uppercase block">Retest Status</span>
              <span className={`text-xs font-bold mt-1 block ${analysis.retestConfirmed ? 'text-success' : 'text-warning'}`}>
                {analysis.retestConfirmed ? 'Retested & Touched' : 'Waiting for Retest'}
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-surface-deep/60 border border-line">
              <span className="text-[10px] text-fg-4 uppercase block">M5 Micro BOS</span>
              <span className={`text-xs font-bold mt-1 block ${analysis.microBosConfirmed ? 'text-success' : 'text-fg-4'}`}>
                {analysis.microBosConfirmed ? 'Confirmed' : 'Awaiting BOS'}
              </span>
            </div>

            <div className="p-3.5 rounded-lg bg-surface-deep/60 border border-line">
              <span className="text-[10px] text-fg-4 uppercase block">Contract Duration</span>
              <span className="text-xs font-bold text-accent-cyan mt-1 block">{analysis.contractDuration}</span>
            </div>
          </div>

          {/* Action Callout Box */}
          <div
            className={`p-4 rounded-xl border flex flex-wrap items-center justify-between gap-4 font-mono ${
              analysis.signalAction === 'ENTER RISE'
                ? 'bg-success/30 border-success/50 text-success'
                : analysis.signalAction === 'ENTER FALL'
                ? 'bg-danger/30 border-danger/50 text-danger'
                : 'bg-surface-deep border-line text-fg-3'
            }`}
          >
            <div>
              <div className="text-[11px] uppercase tracking-wider text-fg-4">Signal Recommendation</div>
              <div className="text-xl font-extrabold mt-0.5 flex items-center gap-2">
                {analysis.signalAction === 'ENTER RISE' && <ArrowUpRight className="w-6 h-6 text-success" />}
                {analysis.signalAction === 'ENTER FALL' && <ArrowDownRight className="w-6 h-6 text-danger" />}
                <span>{analysis.signalAction}</span>
              </div>
              <div className="text-xs text-fg-3 mt-1 font-sans">
                {analysis.signalAction !== 'NO TRADE' && analysis.signalAction !== 'WAIT'
                  ? `Execute on next available quote after candle close at ${analysis.entryPrice?.toFixed(2)}. Invalidation at ${analysis.invalidationLevel?.toFixed(2)}.`
                  : 'Mandatory Retest-First rule in progress. Standing by until zone touch, rejection and micro BOS complete.'}
              </div>
            </div>

            <div className="text-right">
              <div className="text-[10px] uppercase text-fg-4">Setup Quality</div>
              <div className="text-sm font-bold text-fg-1 mt-0.5">{analysis.qualityRating}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
