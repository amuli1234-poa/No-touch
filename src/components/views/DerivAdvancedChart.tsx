import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  Candle,
  ChartOverlayPreferences,
  ChartPattern,
  MarketCondition,
  MomentumClassification,
  OpportunitySignal,
  PositionDrawing,
  ProtectedSwing,
  SupportResistanceZone,
  Timeframe,
  Trendline
} from '../../types/scanner';
import { MarketStructureEngine } from '../../engines/MarketStructureEngine';
import { SupportResistanceEngine } from '../../engines/SupportResistanceEngine';
import { TrendlineAndRangeEngine } from '../../engines/TrendlineAndRangeEngine';
import { ChartPatternEngine } from '../../engines/ChartPatternEngine';
import { TechnicalIndicatorsEngine } from '../../engines/TechnicalIndicatorsEngine';
import { useTheme } from '../../lib/theme';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  Minimize2,
  Scan,
  SlidersHorizontal,
  Layers,
  Wifi,
  WifiOff,
  TrendingUp,
  TrendingDown,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  Trash2,
  ArrowLeftRight
} from 'lucide-react';

interface DerivAdvancedChartProps {
  candles: Candle[];
  symbol: string;
  displayName: string;
  pipSize: number;
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  opportunity?: OpportunitySignal;
  connectionState?: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING';
  isStale?: boolean;
  missedTicks?: number;
  latencyMs?: number | null;
}

const TIMEFRAMES: { tf: Timeframe; label: string }[] = [
  { tf: '4h', label: 'H4' },
  { tf: '1h', label: 'H1' },
  { tf: '15m', label: 'M15' },
  { tf: '5m', label: 'M5' },
  { tf: '1m', label: 'M1' }
];

// Exact Deriv Advanced Trading Charts dark-theme candlestick colors (body, wick & border)
const DERIV_BULLISH_COLOR = '#4bb4b3';
const DERIV_BEARISH_COLOR = '#ec3f3f';

interface TradeLevelLine {
  key: 'ENTRY' | 'SL' | 'TP';
  label: string;
  price: number;
  lineColor: string;
  badgeBg: string;
}

type ChartTrendLabel = 'Uptrend' | 'Downtrend' | 'Consolidation';

function getTimeframePeriodSeconds(tf: Timeframe): number {
  switch (tf) {
    case '4h':
      return 14400;
    case '1h':
      return 3600;
    case '15m':
      return 900;
    case '5m':
      return 300;
    case '1m':
    default:
      return 60;
  }
}

function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function formatMomentumText(classification: MomentumClassification): string {
  switch (classification) {
    case 'STRONG':
      return 'Strong';
    case 'MODERATE':
      return 'Moderate';
    case 'DEVELOPING':
      return 'Developing';
    case 'WEAK':
    default:
      return 'Weak';
  }
}

export const DerivAdvancedChart: React.FC<DerivAdvancedChartProps> = ({
  candles,
  symbol,
  displayName,
  pipSize,
  timeframe,
  onTimeframeChange,
  opportunity,
  connectionState = 'CONNECTED',
  isStale,
  missedTicks = 0,
  latencyMs
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [size, setSize] = useState({ width: 900, height: 490 });
  const [visibleCount, setVisibleCount] = useState<number>(72);
  const [rightOffset, setRightOffset] = useState<number>(0);
  const [candleWidthRatio, setCandleWidthRatio] = useState<number>(0.68); // Adjustable candle spacing
  const [verticalScale, setVerticalScale] = useState<number>(1.0); // Adjustable chart vertical scaling
  const [pricePanOffset, setPricePanOffset] = useState<number>(0); // Vertical drag pan offset in price units
  const [autoScale, setAutoScale] = useState<boolean>(true);
  const [showScaleControls, setShowScaleControls] = useState<boolean>(false);
  const [showOverlayControls, setShowOverlayControls] = useState<boolean>(false);
  const [overlays, setOverlays] = useState<ChartOverlayPreferences>(() => {
    const defaults: ChartOverlayPreferences = {
      showTrendlines: true,
      showSupportResistance: true,
      showFlippedSR: true,
      showSupplyDemand: true,
      showBreakoutLevels: true,
      showProtectedSwings: true,
      showChartPatterns: true,
      showTradeLevels: true,
      showPositionTool: true
    };
    try {
      const saved = localStorage.getItem('wicksentinel_chart_overlays_v1');
      if (saved) return { ...defaults, ...JSON.parse(saved) };
    } catch {
      // Ignore storage errors
    }
    return defaults;
  });
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const { theme } = useTheme();
  const chartTheme: 'white' | 'dark' = theme === 'light' ? 'white' : 'dark';
  const [nowEpoch, setNowEpoch] = useState<number>(() => Math.floor(Date.now() / 1000));

  // Interactive TradingView-style Long & Short Position Drawing State
  const [manualPositions, setManualPositions] = useState<PositionDrawing[]>(() => {
    try {
      const saved = localStorage.getItem('wicksentinel_manual_positions_v1');
      if (saved) return JSON.parse(saved);
    } catch {
      // Ignore storage errors
    }
    return [];
  });
  const [autoOverrides, setAutoOverrides] = useState<Record<string, PositionDrawing>>(() => {
    try {
      const saved = localStorage.getItem('wicksentinel_auto_pos_overrides_v1');
      if (saved) return JSON.parse(saved);
    } catch {
      // Ignore storage errors
    }
    return {};
  });
  const [dismissedAutoIds, setDismissedAutoIds] = useState<string[]>([]);
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [hoveredPositionId, setHoveredPositionId] = useState<string | null>(null);
  const [placingSide, setPlacingSide] = useState<'LONG' | 'SHORT' | null>(null);
  const [cursorStyle, setCursorStyle] = useState<string>('crosshair');

  useEffect(() => {
    try {
      localStorage.setItem('wicksentinel_chart_overlays_v1', JSON.stringify(overlays));
    } catch {
      // Ignore storage errors
    }
  }, [overlays]);

  useEffect(() => {
    try {
      localStorage.setItem('wicksentinel_manual_positions_v1', JSON.stringify(manualPositions));
    } catch {
      // Ignore storage errors
    }
  }, [manualPositions]);

  useEffect(() => {
    try {
      localStorage.setItem('wicksentinel_auto_pos_overrides_v1', JSON.stringify(autoOverrides));
    } catch {
      // Ignore storage errors
    }
  }, [autoOverrides]);

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverYPrice, setHoverYPrice] = useState<number | null>(null);

  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startOffset: number;
    startPricePan: number;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    startOffset: 0,
    startPricePan: 0
  });

  type PosHandleKind = 'TP' | 'SL' | 'ENTRY' | 'LEFT' | 'RIGHT' | 'BODY';
  const posDragRef = useRef<{
    active: boolean;
    posId: string;
    isAuto: boolean;
    signalId?: string;
    handle: PosHandleKind;
    startX: number;
    startY: number;
    initial: PositionDrawing;
  } | null>(null);

  const pinchRef = useRef<{
    active: boolean;
    startDist: number;
    startVisibleCount: number;
  }>({
    active: false,
    startDist: 0,
    startVisibleCount: 72
  });

  const decimals = pipSize < 0.01 ? 3 : 2;
  const fmtPrice = useCallback((p: number) => p.toFixed(decimals), [decimals]);

  // 1-second timer for live candle countdown
  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNowEpoch(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(timerId);
  }, []);

  // Reset only pan/cursor on instrument or timeframe switch (never reset on live incoming ticks)
  useEffect(() => {
    setRightOffset(0);
    setPricePanOffset(0);
    setVerticalScale(1.0);
    setAutoScale(true);
    setHoverIndex(null);
    setHoverYPrice(null);
    setPlacingSide(null);
    setSelectedPositionId(null);
  }, [symbol, timeframe]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) {
        setIsFullscreen((prev) => (prev ? false : prev));
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const targetHeight = isFullscreen
        ? Math.max(360, window.innerHeight - 130)
        : rect.width < 640
        ? 360
        : 500;
      setSize({ width: Math.max(280, Math.floor(rect.width)), height: targetHeight });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    window.addEventListener('resize', updateSize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [isFullscreen]);

  const toggleFullscreen = async () => {
    const next = !isFullscreen;
    setIsFullscreen(next);
    try {
      if (next && wrapperRef.current?.requestFullscreen) {
        await wrapperRef.current.requestFullscreen();
      } else if (!next && document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // CSS fixed-fullscreen overlay handles fullscreen cleanly inside sandboxed iframes
    }
  };

  const handleResetZoom = () => {
    setVisibleCount(72);
    setRightOffset(0);
    setCandleWidthRatio(0.68);
    setVerticalScale(1.0);
    setPricePanOffset(0);
    setAutoScale(true);
  };

  const handleAutoFit = () => {
    setRightOffset(0);
    setVerticalScale(1.0);
    setPricePanOffset(0);
    setAutoScale(true);
    setVisibleCount((v) => Math.max(24, Math.min(120, v)));
  };

  // Live Market Structure Overlays from genuine Deriv candles on the displayed timeframe:
  // Market Trend & Condition, Protected High/Low, Unbroken/Flip S/R Zones, Trendlines, & Confirmed Chart Patterns.
  const chartStructure = useMemo(() => {
    if (candles.length < 8) {
      return {
        trendLabel: 'Consolidation' as ChartTrendLabel,
        marketCondition: 'UNCLEAR' as MarketCondition,
        protectedHigh: null as ProtectedSwing | null,
        protectedLow: null as ProtectedSwing | null,
        supportZones: [] as SupportResistanceZone[],
        resistanceZones: [] as SupportResistanceZone[],
        trendlines: [] as Trendline[],
        confirmedPattern: null as ChartPattern | null
      };
    }

    const pivots = MarketStructureEngine.findPivots(candles, 2, 2);
    const shifts = MarketStructureEngine.detectAllStructuralShifts(candles, pivots);
    const rawCond = MarketStructureEngine.classifyMarketCondition(candles, pivots, shifts);
    const latestClose = candles[candles.length - 1].close;
    const bias = MarketStructureEngine.getDirectionalBias(pivots, latestClose);

    let trendLabel: ChartTrendLabel = 'Consolidation';
    if (rawCond === 'UPTRENDING') {
      trendLabel = 'Uptrend';
    } else if (rawCond === 'DOWNTRENDING') {
      trendLabel = 'Downtrend';
    } else if (rawCond === 'REVERSING') {
      const lastShift = shifts[shifts.length - 1];
      if (lastShift?.direction === 'BULLISH' || bias === 'BULLISH') trendLabel = 'Uptrend';
      else if (lastShift?.direction === 'BEARISH' || bias === 'BEARISH') trendLabel = 'Downtrend';
    } else if (rawCond === 'UNCLEAR') {
      if (bias === 'BULLISH') trendLabel = 'Uptrend';
      else if (bias === 'BEARISH') trendLabel = 'Downtrend';
    }

    const { protectedHigh, protectedLow } = MarketStructureEngine.identifyProtectedSwings(
      candles,
      pivots,
      shifts
    );

    const allZones = SupportResistanceEngine.mapZones(candles, pivots, timeframe);
    const rankZone = (z: SupportResistanceZone) => {
      const mid = (z.upperPrice + z.lowerPrice) / 2;
      const dist = Math.abs(latestClose - mid);
      const flipBonus = z.isFlip ? 0.55 : 1.0;
      const strengthMultiplier = z.strength.startsWith('STRONG') ? 0.65 : 1.0;
      return dist * strengthMultiplier * flipBonus;
    };

    // Keep clean, significant unbroken Support & Resistance zones + Flipped S/R levels nearest price
    const flipZones = allZones.filter((z) => !z.broken && z.isFlip);
    const supportZones = [
      ...flipZones.filter((z) => z.type === 'SUPPORT'),
      ...allZones
        .filter(
          (z) =>
            !z.broken &&
            !z.isFlip &&
            (z.type === 'DEMAND' || z.type === 'SUPPORT') &&
            z.lowerPrice <= latestClose * 1.008
        )
        .sort((a, b) => rankZone(a) - rankZone(b))
        .slice(0, 2)
    ].slice(0, 3);

    const resistanceZones = [
      ...flipZones.filter((z) => z.type === 'RESISTANCE'),
      ...allZones
        .filter(
          (z) =>
            !z.broken &&
            !z.isFlip &&
            (z.type === 'SUPPLY' || z.type === 'RESISTANCE') &&
            z.upperPrice >= latestClose * 0.992
        )
        .sort((a, b) => rankZone(a) - rankZone(b))
        .slice(0, 2)
    ].slice(0, 3);

    const trendlines = TrendlineAndRangeEngine.detectTrendlines(candles, pivots, timeframe).filter(
      (t) => !t.broken || t.retested
    );

    // Confirm chart patterns strictly on completed (closed) candles for this timeframe
    const tfSec = getTimeframePeriodSeconds(timeframe);
    const currBucket = Math.floor(Date.now() / 1000 / tfSec) * tfSec;
    const closedCandles =
      candles.length > 20 && candles[candles.length - 1].epoch >= currBucket
        ? candles.slice(0, -1)
        : candles;
    const closedPivots =
      closedCandles.length === candles.length
        ? pivots
        : MarketStructureEngine.findPivots(closedCandles, 2, 2);
    const atrSeries = TechnicalIndicatorsEngine.computeAtrSeries(closedCandles, 14);
    const atr = atrSeries[atrSeries.length - 1] ?? 0;
    const confirmedPatterns = ChartPatternEngine.detectConfirmedPatterns(
      closedCandles,
      closedPivots,
      timeframe,
      atr
    );

    return {
      trendLabel,
      marketCondition: rawCond,
      protectedHigh,
      protectedLow,
      supportZones,
      resistanceZones,
      trendlines,
      confirmedPattern: confirmedPatterns[0] || null
    };
  }, [candles, timeframe]);

  // Signal Integration: Entry (Blue), Stop Loss (Red), Take Profit (Green).
  // Momentum no longer independently blocks an otherwise valid confirmed setup.
  const activeTradeLevels = useMemo((): TradeLevelLine[] => {
    if (
      !opportunity ||
      opportunity.setupTier !== 'HIGH_QUALITY' ||
      !opportunity.tradingRange.isValid ||
      !opportunity.entryAndTp.confirmed ||
      opportunity.score.total < 75
    ) {
      return [];
    }

    const { entryPrice, invalidationLevel, takeProfit, takeProfit2 } = opportunity.entryAndTp;
    const levels: TradeLevelLine[] = [];

    if (typeof entryPrice === 'number' && Number.isFinite(entryPrice)) {
      levels.push({
        key: 'ENTRY',
        label: 'ENTRY',
        price: entryPrice,
        lineColor: '#3b82f6',
        badgeBg: '#1d4ed8'
      });
    }

    if (typeof invalidationLevel === 'number' && Number.isFinite(invalidationLevel)) {
      levels.push({
        key: 'SL',
        label: 'SL',
        price: invalidationLevel,
        lineColor: '#ef4444',
        badgeBg: '#b91c1c'
      });
    }

    if (typeof takeProfit === 'number' && Number.isFinite(takeProfit)) {
      levels.push({
        key: 'TP',
        label: 'TP1',
        price: takeProfit,
        lineColor: '#22c55e',
        badgeBg: '#15803d'
      });
    }

    if (typeof takeProfit2 === 'number' && Number.isFinite(takeProfit2)) {
      levels.push({
        key: 'TP',
        label: 'TP2',
        price: takeProfit2,
        lineColor: '#10b981',
        badgeBg: '#047857'
      });
    }

    return levels;
  }, [opportunity]);

  const formingCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
  const periodSeconds = getTimeframePeriodSeconds(timeframe);
  const remainingSeconds = formingCandle
    ? Math.max(0, formingCandle.epoch + periodSeconds - nowEpoch)
    : 0;
  const countdownText = formingCandle ? formatCountdown(remainingSeconds) : '--:--';

  // Automatic Long/Short Position overlay — strictly shown ONLY for confirmed setups (never for WAIT / unconfirmed)
  const autoPosition = useMemo((): PositionDrawing | null => {
    if (
      !opportunity ||
      opportunity.symbol !== symbol ||
      opportunity.setupTier !== 'HIGH_QUALITY' ||
      !opportunity.tradingRange.isValid ||
      !opportunity.entryAndTp.confirmed ||
      opportunity.score.total < 75 ||
      dismissedAutoIds.includes(opportunity.id)
    ) {
      return null;
    }

    const override = autoOverrides[opportunity.id];
    if (override) return override;

    const { entryPrice, invalidationLevel, takeProfit } = opportunity.entryAndTp;
    if (
      typeof entryPrice !== 'number' ||
      typeof invalidationLevel !== 'number' ||
      typeof takeProfit !== 'number'
    ) {
      return null;
    }

    const latestEpoch = formingCandle?.epoch ?? Math.floor(Date.now() / 1000);
    return {
      id: `AUTO_${opportunity.id}`,
      symbol,
      side: opportunity.direction === 'BEARISH' ? 'SHORT' : 'LONG',
      source: 'AUTO',
      signalId: opportunity.id,
      startEpoch: latestEpoch - periodSeconds * 8,
      endEpoch: latestEpoch + periodSeconds * 10,
      entryPrice,
      stopLoss: invalidationLevel,
      takeProfit,
      customized: false
    };
  }, [opportunity, symbol, dismissedAutoIds, autoOverrides, formingCandle?.epoch, periodSeconds]);

  const symbolManualPositions = useMemo(
    () => manualPositions.filter((p) => p.symbol === symbol),
    [manualPositions, symbol]
  );

  const visiblePositions = useMemo((): PositionDrawing[] => {
    if (overlays.showPositionTool === false) return [];
    return [...symbolManualPositions, ...(autoPosition ? [autoPosition] : [])];
  }, [overlays.showPositionTool, symbolManualPositions, autoPosition]);

  const selectedPosition = useMemo(
    () => visiblePositions.find((p) => p.id === selectedPositionId) || null,
    [visiblePositions, selectedPositionId]
  );

  const viewWindow = useMemo(() => {
    const total = candles.length;
    if (total === 0) return { startIdx: 0, endIdx: 0, slice: [] as Candle[] };
    const clampedCount = Math.max(10, Math.min(240, Math.round(visibleCount)));
    const maxOffset = Math.max(0, total - 8);
    const clampedOffset = Math.max(0, Math.min(maxOffset, rightOffset));
    const endIdx = total - clampedOffset;
    const startIdx = Math.max(0, endIdx - clampedCount);
    return {
      startIdx,
      endIdx,
      slice: candles.slice(startIdx, endIdx)
    };
  }, [candles, visibleCount, rightOffset]);

  // Compute current price domain cleanly so mouse hover, vertical pan & scaling stay in sync
  const priceDomain = useMemo(() => {
    const slice = viewWindow.slice;
    if (slice.length === 0) {
      return { minPrice: 0, maxPrice: 1, span: 1 };
    }
    let minP = Infinity;
    let maxP = -Infinity;
    for (const c of slice) {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    }
    for (const lvl of activeTradeLevels) {
      minP = Math.min(minP, lvl.price);
      maxP = Math.max(maxP, lvl.price);
    }
    if (autoPosition && overlays.showPositionTool !== false) {
      minP = Math.min(minP, autoPosition.entryPrice, autoPosition.stopLoss, autoPosition.takeProfit);
      maxP = Math.max(maxP, autoPosition.entryPrice, autoPosition.stopLoss, autoPosition.takeProfit);
    }

    const baseSpan = Math.max(1e-6, maxP - minP);
    const paddedSpan = baseSpan * 1.22;
    const mid = (maxP + minP) / 2 + pricePanOffset;
    const scaledHalf = (paddedSpan / 2) / Math.max(0.35, Math.min(4.0, verticalScale));
    return {
      minPrice: mid - scaledHalf,
      maxPrice: mid + scaledHalf,
      span: Math.max(1e-6, scaledHalf * 2)
    };
  }, [viewWindow.slice, activeTradeLevels, autoPosition, overlays.showPositionTool, pricePanOffset, verticalScale]);

  const getChartGeometry = useCallback(() => {
    const W = size.width;
    const H = size.height;
    const isCompact = W < 540;
    const padLeft = 10;
    const padRight = isCompact ? 68 : 84;
    const padTop = 16;
    const timeAxisH = 26;
    const liveMarginPx = rightOffset === 0 ? (isCompact ? 18 : 28) : 6;
    const chartW = W - padLeft - padRight;
    const plotW = Math.max(40, chartW - liveMarginPx);
    const mainH = H - padTop - timeAxisH;
    const barStep = plotW / Math.max(1, viewWindow.slice.length);
    return {
      W,
      H,
      isCompact,
      padLeft,
      padRight,
      padTop,
      timeAxisH,
      liveMarginPx,
      chartW,
      plotW,
      mainH,
      barStep
    };
  }, [size.width, size.height, rightOffset, viewWindow.slice.length]);

  const updatePositionById = useCallback(
    (posId: string, updater: (prev: PositionDrawing) => PositionDrawing) => {
      if (autoPosition && autoPosition.id === posId && autoPosition.signalId) {
        const sigId = autoPosition.signalId;
        setAutoOverrides((prev) => ({
          ...prev,
          [sigId]: { ...updater(prev[sigId] || autoPosition), customized: true }
        }));
      } else {
        setManualPositions((prev) => prev.map((p) => (p.id === posId ? updater(p) : p)));
      }
    },
    [autoPosition]
  );

  const deletePositionById = useCallback(
    (posId: string) => {
      if (autoPosition && autoPosition.id === posId && autoPosition.signalId) {
        const sigId = autoPosition.signalId;
        setDismissedAutoIds((prev) => (prev.includes(sigId) ? prev : [...prev, sigId]));
      } else {
        setManualPositions((prev) => prev.filter((p) => p.id !== posId));
      }
      setSelectedPositionId((cur) => (cur === posId ? null : cur));
    },
    [autoPosition]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        if (placingSide) setPlacingSide(null);
        else setSelectedPositionId(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPositionId) {
        deletePositionById(selectedPositionId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [placingSide, selectedPositionId, deletePositionById]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    const W = size.width;
    const H = size.height;

    const isWhite = chartTheme === 'white';
    const bgCol = isWhite ? '#FFFFFF' : '#070b12';
    const gridCol = isWhite ? 'rgba(226, 232, 240, 0.9)' : 'rgba(30, 41, 59, 0.45)';
    const textCol = isWhite ? '#334155' : '#94a3b8';
    const bullCol = isWhite ? '#16A36A' : '#4bb4b3';
    const bearCol = isWhite ? '#E34B52' : '#ec3f3f';

    ctx.fillStyle = bgCol;
    ctx.fillRect(0, 0, W, H);

    const slice = viewWindow.slice;
    if (slice.length === 0) {
      ctx.fillStyle = textCol;
      ctx.font = '12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`Waiting for live Deriv ${symbol} (${timeframe.toUpperCase()}) candles...`, W / 2, H / 2);
      return;
    }

    const isCompact = W < 540;
    const padLeft = 10;
    const padRight = isCompact ? 68 : 84;
    const padTop = 16;
    const timeAxisH = 26;
    // Reserve right margin on live edge so forming candle is always spacious & clearly inspectable
    const liveMarginPx = rightOffset === 0 ? (isCompact ? 18 : 28) : 6;
    const chartW = W - padLeft - padRight;
    const plotW = Math.max(40, chartW - liveMarginPx);
    const mainH = H - padTop - timeAxisH;

    const { minPrice, maxPrice, span } = priceDomain;
    const yForPrice = (price: number) => padTop + ((maxPrice - price) / span) * mainH;
    const barStep = plotW / Math.max(1, slice.length);
    const candleW = Math.max(2.5, Math.min(24, barStep * candleWidthRatio));
    const xForLocalIdx = (idx: number) => padLeft + (idx + 0.5) * barStep;

    const xForEpoch = (epoch: number): number => {
      if (slice.length === 0) return padLeft;
      if (epoch <= slice[0].epoch) {
        const barsBefore = (slice[0].epoch - epoch) / Math.max(1, periodSeconds);
        return xForLocalIdx(-barsBefore);
      }
      for (let i = 0; i < slice.length; i++) {
        if (slice[i].epoch === epoch) return xForLocalIdx(i);
        if (slice[i].epoch > epoch && i > 0) {
          const frac = (epoch - slice[i - 1].epoch) / Math.max(1, slice[i].epoch - slice[i - 1].epoch);
          return xForLocalIdx(i - 1 + frac);
        }
      }
      const barsAfter = (epoch - slice[slice.length - 1].epoch) / Math.max(1, periodSeconds);
      return xForLocalIdx(slice.length - 1 + barsAfter);
    };

    // Minimal grid & right-hand price scale
    ctx.strokeStyle = gridCol;
    ctx.lineWidth = 1;
    const gridRows = 5;
    for (let i = 0; i <= gridRows; i++) {
      const y = padTop + (mainH / gridRows) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + chartW, y);
      ctx.stroke();

      const priceVal = maxPrice - (span / gridRows) * i;
      ctx.fillStyle = textCol;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(priceVal), padLeft + chartW + 7, y + 3);
    }

    // Price scale divider
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.5)';
    ctx.beginPath();
    ctx.moveTo(padLeft + chartW, padTop);
    ctx.lineTo(padLeft + chartW, H - timeAxisH);
    ctx.stroke();

    // Candle Timestamps along bottom axis
    const timeTicks = Math.min(isCompact ? 4 : 6, Math.max(3, Math.floor(plotW / 120)));
    for (let t = 0; t < timeTicks; t++) {
      const idx = Math.floor((t / Math.max(1, timeTicks - 1)) * (slice.length - 1));
      const x = xForLocalIdx(idx);
      const d = new Date(slice[idx].epoch * 1000);
      const label =
        timeframe === '4h' || timeframe === '1h'
          ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`
          : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

      ctx.fillStyle = '#64748b';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, H - 8);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, chartW, mainH);
    ctx.clip();

    const usedRightLabelYs: number[] = [];

    // 1. Clean Support & Resistance Levels and Supply & Demand Zones (extending until invalidated)
    const zonesToDraw: { zone: SupportResistanceZone; isSupport: boolean }[] = [
      ...chartStructure.supportZones.map((z) => ({ zone: z, isSupport: true })),
      ...chartStructure.resistanceZones.map((z) => ({ zone: z, isSupport: false }))
    ];

    for (const { zone, isSupport } of zonesToDraw) {
      const isFlipZone = Boolean(zone.isFlip);
      const isSdBand = Boolean(zone.hasBaseFormation || (zone.causedDisplacement && !zone.isFlip));
      if (isFlipZone && overlays.showFlippedSR === false) continue;
      if (!isFlipZone && isSdBand && !overlays.showSupplyDemand) continue;
      if (!isFlipZone && !isSdBand && !overlays.showSupportResistance) continue;

      const yTop = yForPrice(zone.upperPrice);
      const yBot = yForPrice(zone.lowerPrice);
      if (yBot < padTop - 4 || yTop > padTop + mainH + 4) continue;

      const xStart = Math.max(padLeft, xForEpoch(zone.originEpoch));
      const xEnd = padLeft + chartW;
      if (xEnd <= xStart) continue;

      const zoneH = Math.max(3, yBot - yTop);
      if (isFlipZone) {
        ctx.fillStyle = isSupport ? 'rgba(20, 184, 166, 0.14)' : 'rgba(244, 63, 94, 0.14)';
        ctx.fillRect(xStart, yTop, xEnd - xStart, zoneH);
        const yMid = (yTop + yBot) / 2;
        ctx.strokeStyle = isSupport ? 'rgba(45, 212, 191, 0.92)' : 'rgba(251, 113, 133, 0.92)';
        ctx.lineWidth = 1.65;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(xStart, yMid);
        ctx.lineTo(xEnd, yMid);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        if (isSdBand && overlays.showSupplyDemand) {
          ctx.fillStyle = isSupport ? 'rgba(16, 185, 129, 0.11)' : 'rgba(244, 63, 94, 0.11)';
          ctx.fillRect(xStart, yTop, xEnd - xStart, zoneH);
        }

        ctx.strokeStyle = isSupport ? 'rgba(16, 185, 129, 0.48)' : 'rgba(244, 63, 94, 0.48)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xStart, yTop);
        ctx.lineTo(xEnd, yTop);
        if (isSdBand) {
          ctx.moveTo(xStart, yBot);
          ctx.lineTo(xEnd, yBot);
        }
        ctx.stroke();
      }

      // Subtle right-edge S/R, S&D or Flip S/R tag if clear of existing labels
      const tagY = Math.max(padTop + 11, Math.min(padTop + mainH - 5, yTop + 10));
      if (!usedRightLabelYs.some((y) => Math.abs(y - tagY) < 15)) {
        usedRightLabelYs.push(tagY);
        ctx.font = isFlipZone ? 'bold 9.5px "JetBrains Mono", monospace' : '9px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillStyle = isFlipZone
          ? isSupport
            ? '#2dd4bf'
            : '#fda4af'
          : isSupport
          ? 'rgba(110, 231, 183, 0.85)'
          : 'rgba(253, 164, 175, 0.85)';
        const midFlipPrice = (zone.upperPrice + zone.lowerPrice) / 2;
        const label = isFlipZone
          ? `${isSupport ? 'R→S FLIP' : 'S→R FLIP'} ${fmtPrice(midFlipPrice)}`
          : isSdBand
          ? `${zone.fresh ? 'Fresh ' : ''}${isSupport ? 'Demand' : 'Supply'}`
          : `${zone.tier === 'MAJOR' ? 'Major ' : ''}${isSupport ? 'Support' : 'Resistance'}`;
        ctx.fillText(label, padLeft + chartW - 8, tagY);
      }
    }

    // 1.5 Breakout & Retest Level (when M15 breakout/retest is active)
    if (
      overlays.showBreakoutLevels &&
      opportunity?.tradingRange.isValid &&
      opportunity.tradingRange.breakoutState !== 'INSIDE_RANGE'
    ) {
      const isBullBrk = opportunity.tradingRange.breakoutState === 'BULLISH_BREAKOUT_RETEST';
      const brkPrice = isBullBrk
        ? opportunity.tradingRange.rangeHigh
        : opportunity.tradingRange.rangeLow;
      const yBrk = yForPrice(brkPrice);
      if (yBrk >= padTop && yBrk <= padTop + mainH) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
        ctx.lineWidth = 1.25;
        ctx.setLineDash([7, 4]);
        ctx.beginPath();
        ctx.moveTo(padLeft, yBrk);
        ctx.lineTo(padLeft + chartW, yBrk);
        ctx.stroke();
        ctx.setLineDash([]);

        if (!usedRightLabelYs.some((y) => Math.abs(y - (yBrk - 5)) < 14)) {
          usedRightLabelYs.push(yBrk - 5);
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'right';
          ctx.fillStyle = '#38bdf8';
          ctx.fillText(
            `Breakout/Retest ${fmtPrice(brkPrice)}`,
            padLeft + chartW - 8,
            Math.max(padTop + 12, yBrk - 5)
          );
        }
      }
    }

    // 2. Clean Ascending, Descending & Horizontal Trendlines from genuine pivot structure
    if (overlays.showTrendlines) {
      for (const tl of chartStructure.trendlines) {
        const t0 = Math.max(tl.startEpoch, slice[0].epoch);
        const t1 = Math.min(tl.endEpoch, slice[slice.length - 1].epoch);
        if (t1 <= t0) continue;

        const p0 = tl.startPrice + tl.slopePerSecond * (t0 - tl.startEpoch);
        const p1 = tl.startPrice + tl.slopePerSecond * (t1 - tl.startEpoch);

        ctx.strokeStyle =
          tl.direction === 'BULLISH'
            ? 'rgba(45, 212, 191, 0.82)'
            : tl.direction === 'BEARISH'
            ? 'rgba(251, 146, 60, 0.82)'
            : 'rgba(148, 163, 184, 0.72)';
        ctx.lineWidth = tl.event === 'BREAKOUT' || tl.event === 'RETEST' ? 1.5 : 1.2;
        ctx.setLineDash(tl.event === 'BREAKOUT' || tl.event === 'RETEST' ? [3, 3] : [6, 4]);
        ctx.beginPath();
        ctx.moveTo(xForEpoch(t0), yForPrice(p0));
        ctx.lineTo(xForEpoch(t1), yForPrice(p1));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 3. Valid Protected Swing High & Protected Swing Low
    if (overlays.showProtectedSwings) {
      const protectedLevels: { swing: ProtectedSwing; color: string; isHigh: boolean }[] = [];
      if (chartStructure.protectedHigh) {
        protectedLevels.push({ swing: chartStructure.protectedHigh, color: '#f59e0b', isHigh: true });
      }
      if (chartStructure.protectedLow) {
        protectedLevels.push({ swing: chartStructure.protectedLow, color: '#38bdf8', isHigh: false });
      }

      for (const { swing, color, isHigh } of protectedLevels) {
        const y = yForPrice(swing.price);
        if (y < padTop - 6 || y > padTop + mainH + 6) continue;

        const rawOriginX = xForEpoch(swing.epoch);
        const xStart = Math.max(padLeft, rawOriginX);
        const xEnd = padLeft + chartW;

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.15;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(xStart, y);
        ctx.lineTo(xEnd, y);
        ctx.stroke();
        ctx.setLineDash([]);

        if (rawOriginX >= padLeft && rawOriginX <= xEnd) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(rawOriginX, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }

        const rawLabelY = isHigh ? y - 5 : y + 12;
        let labelY = Math.max(padTop + 12, Math.min(padTop + mainH - 5, rawLabelY));
        if (usedRightLabelYs.some((uy) => Math.abs(uy - labelY) < 14)) {
          labelY = isHigh ? Math.max(padTop + 12, labelY - 14) : Math.min(padTop + mainH - 5, labelY + 14);
        }
        usedRightLabelYs.push(labelY);

        ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillStyle = color;
        ctx.fillText(
          `${isHigh ? 'Prot High' : 'Prot Low'} ${fmtPrice(swing.price)}`,
          padLeft + chartW - 8,
          labelY
        );
      }
    }

    // 3.5 Confirmed Chart Pattern (only when structure & breakout/boundary close confirmation exist)
    if (overlays.showChartPatterns && chartStructure.confirmedPattern) {
      const pat = chartStructure.confirmedPattern;
      for (const line of pat.lines) {
        const x0 = xForEpoch(line.startEpoch);
        const y0 = yForPrice(line.startPrice);
        const x1 = xForEpoch(line.endEpoch);
        const y1 = yForPrice(line.endPrice);
        if (Math.max(x0, x1) < padLeft || Math.min(x0, x1) > padLeft + chartW) continue;

        ctx.strokeStyle =
          line.kind === 'NECKLINE'
            ? 'rgba(244, 114, 182, 0.85)'
            : line.kind === 'POLE'
            ? 'rgba(56, 189, 248, 0.72)'
            : 'rgba(192, 132, 252, 0.82)';
        ctx.lineWidth = line.kind === 'NECKLINE' ? 1.5 : 1.35;
        ctx.setLineDash(line.kind === 'NECKLINE' ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const anchorLine = pat.lines[0];
      if (anchorLine) {
        const labelX = Math.max(
          padLeft + 10,
          Math.min(padLeft + chartW - 140, xForEpoch(anchorLine.startEpoch))
        );
        const labelY = Math.max(
          padTop + 34,
          Math.min(padTop + mainH - 12, yForPrice(anchorLine.startPrice) - 6)
        );
        ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#d8b4fe';
        ctx.fillText(`${pat.label} (${pat.direction === 'BULLISH' ? 'Bull' : pat.direction === 'BEARISH' ? 'Bear' : 'Range'})`, labelX, labelY);
      }
    }

    // 4. Candlesticks with exact Deriv Advanced Trading Charts colors (body, wick, border)
    // Visually distinguish active forming candle from closed historical candles
    const formingSliceIdx = viewWindow.endIdx === candles.length ? slice.length - 1 : -1;

    for (let i = 0; i < slice.length; i++) {
      const c = slice[i];
      const x = xForLocalIdx(i);
      const isForming = i === formingSliceIdx;
      const isUp = c.close >= c.open;
      const candleColor = isUp ? DERIV_BULLISH_COLOR : DERIV_BEARISH_COLOR;

      if (isForming) {
        const colW = Math.max(candleW + 6, Math.min(28, barStep * 0.92));
        ctx.fillStyle = 'rgba(148, 163, 184, 0.07)';
        ctx.fillRect(x - colW / 2, padTop, colW, mainH);
      }

      const yHigh = yForPrice(c.high);
      const yLow = yForPrice(c.low);
      const yOpen = yForPrice(c.open);
      const yClose = yForPrice(c.close);

      // Wick
      ctx.strokeStyle = candleColor;
      ctx.lineWidth = Math.max(1.25, Math.min(2, candleW * 0.16));
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      // Body + Border
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(2, Math.abs(yClose - yOpen));
      ctx.fillStyle = candleColor;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
      ctx.strokeStyle = isForming ? 'rgba(248, 250, 252, 0.88)' : candleColor;
      ctx.lineWidth = isForming ? 1.25 : 1;
      ctx.strokeRect(x - candleW / 2, bodyTop, candleW, bodyH);
    }

    // Current live forming price hairline across chart
    const liveCandle = candles[candles.length - 1];
    if (liveCandle) {
      const yLiveLine = yForPrice(liveCandle.close);
      if (yLiveLine >= padTop && yLiveLine <= padTop + mainH) {
        const liveIsUp = liveCandle.close >= liveCandle.open;
        ctx.strokeStyle = liveIsUp ? 'rgba(75, 180, 179, 0.5)' : 'rgba(236, 63, 63, 0.5)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padLeft, yLiveLine);
        ctx.lineTo(padLeft + chartW, yLiveLine);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Confirmed Signal Entry Marker (Large Blue Dot with "BUY" or Large Red Dot with "SELL")
    if (opportunity && opportunity.status === 'QUALIFIED' && opportunity.entryAndTp.confirmed && slice.length > 0) {
      const isBuy = opportunity.direction === 'BULLISH';
      const targetEpoch = opportunity.detectedEpoch || slice[slice.length - 1].epoch;
      let bestIdx = slice.length - 1;
      let minDiff = Infinity;
      for (let i = 0; i < slice.length; i++) {
        const diff = Math.abs(slice[i].epoch - targetEpoch);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = i;
        }
      }
      const markerCandle = slice[bestIdx];
      const mx = xForLocalIdx(bestIdx);
      const my = yForPrice(isBuy ? markerCandle.low : markerCandle.high);
      const dotRadius = 9;

      ctx.save();
      ctx.shadowColor = isBuy ? 'rgba(59, 130, 246, 0.7)' : 'rgba(239, 68, 68, 0.7)';
      ctx.shadowBlur = 14;
      ctx.fillStyle = isBuy ? '#3b82f6' : '#ef4444';
      ctx.beginPath();
      ctx.arc(mx, my + (isBuy ? 16 : -16), dotRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(mx, my + (isBuy ? 16 : -16), dotRadius, 0, Math.PI * 2);
      ctx.stroke();

      const labelText = isBuy ? 'BUY' : 'SELL';
      ctx.font = 'bold 11.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      const textW = ctx.measureText(labelText).width + 14;
      const labelX = mx;
      const labelY = my + (isBuy ? 35 : -32);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      ctx.fillRect(labelX - textW / 2, labelY - 8.5, textW, 19);
      ctx.strokeStyle = isBuy ? '#3b82f6' : '#ef4444';
      ctx.lineWidth = 1.75;
      ctx.strokeRect(labelX - textW / 2, labelY - 8.5, textW, 19);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, labelX, labelY + 4.5);
      ctx.restore();
    }

    // 5. TradingView-Style Long & Short Position Drawing Overlays (Automatic for Confirmed Signals + Manual Drawings)
    if (overlays.showPositionTool !== false && visiblePositions.length > 0) {
      for (const pos of visiblePositions) {
        const rawX1 = xForEpoch(pos.startEpoch);
        const rawX2 = xForEpoch(pos.endEpoch);
        const leftRaw = Math.min(rawX1, rawX2);
        const rightRaw = Math.max(rawX1, rawX2);
        if (rightRaw < padLeft + 8 || leftRaw > padLeft + chartW - 8) continue;

        const boxLeft = Math.max(padLeft + 4, leftRaw);
        const boxRight = Math.min(padLeft + chartW - 4, rightRaw);
        if (boxRight - boxLeft < 14) continue;

        const yEntry = yForPrice(pos.entryPrice);
        const yTp = yForPrice(pos.takeProfit);
        const ySl = yForPrice(pos.stopLoss);

        const profitTop = Math.min(yEntry, yTp);
        const profitH = Math.abs(yTp - yEntry);
        const riskTop = Math.min(yEntry, ySl);
        const riskH = Math.abs(ySl - yEntry);

        const isSelected = pos.id === selectedPositionId;
        const isHovered = pos.id === hoveredPositionId;

        const riskDist = Math.max(1e-9, Math.abs(pos.entryPrice - pos.stopLoss));
        const rewardDist = Math.abs(pos.takeProfit - pos.entryPrice);
        const rr = rewardDist / riskDist;

        // Profit Zone Fill & Border
        ctx.fillStyle = isSelected ? 'rgba(16, 185, 129, 0.25)' : 'rgba(16, 185, 129, 0.16)';
        ctx.fillRect(boxLeft, profitTop, boxRight - boxLeft, Math.max(2, profitH));
        ctx.strokeStyle = isSelected ? '#4ade80' : 'rgba(34, 197, 94, 0.85)';
        ctx.lineWidth = isSelected ? 1.5 : 1.1;
        ctx.strokeRect(boxLeft, profitTop, boxRight - boxLeft, Math.max(2, profitH));

        // Risk Zone Fill & Border
        ctx.fillStyle = isSelected ? 'rgba(239, 68, 68, 0.25)' : 'rgba(239, 68, 68, 0.16)';
        ctx.fillRect(boxLeft, riskTop, boxRight - boxLeft, Math.max(2, riskH));
        ctx.strokeStyle = isSelected ? '#f87171' : 'rgba(239, 68, 68, 0.85)';
        ctx.lineWidth = isSelected ? 1.5 : 1.1;
        ctx.strokeRect(boxLeft, riskTop, boxRight - boxLeft, Math.max(2, riskH));

        // Subtle chart-wide extension lines for Entry / SL / TP when Auto or Selected
        if (pos.source === 'AUTO' || isSelected) {
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(34, 197, 94, 0.5)';
          ctx.beginPath();
          ctx.moveTo(padLeft, yTp);
          ctx.lineTo(padLeft + chartW, yTp);
          ctx.stroke();

          ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
          ctx.beginPath();
          ctx.moveTo(padLeft, ySl);
          ctx.lineTo(padLeft + chartW, ySl);
          ctx.stroke();

          ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
          ctx.beginPath();
          ctx.moveTo(padLeft, yEntry);
          ctx.lineTo(padLeft + chartW, yEntry);
          ctx.stroke();
          ctx.restore();
        }

        // Solid Entry Dividing Line
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(boxLeft, yEntry);
        ctx.lineTo(boxRight, yEntry);
        ctx.stroke();

        const boxMidX = (boxLeft + boxRight) / 2;
        const boxW = boxRight - boxLeft;

        // Profit Tag inside Profit Zone
        ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        if (profitH >= 15 && boxW >= 90) {
          const tpText = `TP ${fmtPrice(pos.takeProfit)} (+${fmtPrice(rewardDist)})`;
          const tpLabelY =
            pos.side === 'LONG'
              ? Math.max(padTop + 11, yTp + 12)
              : Math.min(padTop + mainH - 4, yTp - 5);
          ctx.fillStyle = '#86efac';
          ctx.fillText(tpText, boxMidX, tpLabelY, boxW - 10);
        }

        // Risk Tag inside Risk Zone
        if (riskH >= 15 && boxW >= 90) {
          const slText = `SL ${fmtPrice(pos.stopLoss)} (-${fmtPrice(riskDist)})`;
          const slLabelY =
            pos.side === 'LONG'
              ? Math.min(padTop + mainH - 4, ySl - 5)
              : Math.max(padTop + 11, ySl + 12);
          ctx.fillStyle = '#fca5a5';
          ctx.fillText(slText, boxMidX, slLabelY, boxW - 10);
        }

        // Center Entry + R:R Badge
        const entryBadgeText = `${pos.side} · ${rr.toFixed(2)}R · ${fmtPrice(pos.entryPrice)}`;
        const ebW = Math.min(boxW - 8, ctx.measureText(entryBadgeText).width + 14);
        if (ebW >= 46 && yEntry >= padTop + 8 && yEntry <= padTop + mainH - 8) {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
          ctx.fillRect(boxMidX - ebW / 2, yEntry - 9, ebW, 18);
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 1;
          ctx.strokeRect(boxMidX - ebW / 2, yEntry - 9, ebW, 18);
          ctx.fillStyle = '#e0f2fe';
          ctx.fillText(entryBadgeText, boxMidX, yEntry + 3.5, ebW - 6);
        }

        // Interactive Drag Handles (shown when selected or hovered)
        if (isSelected || isHovered) {
          const drawHandle = (hx: number, hy: number, borderColor: string) => {
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(hx - 4, hy - 4, 8, 8);
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(hx - 4, hy - 4, 8, 8);
          };
          drawHandle(boxMidX, yTp, '#22c55e');
          drawHandle(boxMidX, ySl, '#ef4444');
          drawHandle(boxLeft, yEntry, '#3b82f6');
          const midBodyY = (Math.min(yTp, ySl) + Math.max(yTp, ySl)) / 2;
          drawHandle(boxLeft, midBodyY, '#94a3b8');
          drawHandle(boxRight, midBodyY, '#94a3b8');
        }
      }
    }

    // 5B. Fallback Primary Signal Line Badges when Entry/SL/TP enabled without Position Tool box
    const drawLineBadges =
      overlays.showTradeLevels &&
      activeTradeLevels.length > 0 &&
      (overlays.showPositionTool === false || !autoPosition);

    if (drawLineBadges) {
      for (const lvl of activeTradeLevels) {
        const y = yForPrice(lvl.price);
        ctx.strokeStyle = lvl.lineColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + chartW, y);
        ctx.stroke();
      }

      const badgeHeight = 18;
      const minGap = 22;
      const positioned = activeTradeLevels
        .map((lvl) => ({
          ...lvl,
          lineY: yForPrice(lvl.price),
          labelY: Math.max(
            padTop + badgeHeight / 2 + 24,
            Math.min(padTop + mainH - badgeHeight / 2 - 2, yForPrice(lvl.price))
          )
        }))
        .sort((a, b) => a.labelY - b.labelY);

      for (let i = 1; i < positioned.length; i++) {
        if (positioned[i].labelY - positioned[i - 1].labelY < minGap) {
          positioned[i].labelY = positioned[i - 1].labelY + minGap;
        }
      }
      const maxLabelY = padTop + mainH - badgeHeight / 2 - 2;
      if (positioned.length > 0 && positioned[positioned.length - 1].labelY > maxLabelY) {
        positioned[positioned.length - 1].labelY = maxLabelY;
        for (let i = positioned.length - 2; i >= 0; i--) {
          if (positioned[i + 1].labelY - positioned[i].labelY < minGap) {
            positioned[i].labelY = positioned[i + 1].labelY - minGap;
          }
        }
      }

      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      for (const item of positioned) {
        const text = `${item.label} ${fmtPrice(item.price)}`;
        const textW = ctx.measureText(text).width;
        const boxW = textW + 14;
        const boxX = padLeft + 8;
        const boxY = item.labelY - badgeHeight / 2;

        if (Math.abs(item.labelY - item.lineY) > 3) {
          ctx.strokeStyle = item.lineColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(boxX + 4, item.lineY);
          ctx.lineTo(boxX + 4, item.labelY);
          ctx.stroke();
        }

        ctx.fillStyle = item.badgeBg;
        ctx.fillRect(boxX, boxY, boxW, badgeHeight);
        ctx.strokeStyle = item.lineColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX, boxY, boxW, badgeHeight);

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(text, boxX + 7, item.labelY + 3.5);
      }
    }

    // 6. Top-Left On-Canvas Market Trend & Momentum Overlay Label (compact, uncluttered)
    const trendText = `TREND: ${chartStructure.trendLabel.toUpperCase()}`;
    const momText = opportunity
      ? ` · MOM: ${formatMomentumText(opportunity.momentum.classification).toUpperCase()}`
      : '';
    const hudFull = `${trendText}${momText}`;
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    const hudW = ctx.measureText(hudFull).width + 14;
    ctx.fillStyle = 'rgba(7, 11, 18, 0.84)';
    ctx.fillRect(padLeft + 8, padTop + 4, hudW, 18);
    ctx.strokeStyle =
      chartStructure.trendLabel === 'Uptrend'
        ? 'rgba(16, 185, 129, 0.55)'
        : chartStructure.trendLabel === 'Downtrend'
        ? 'rgba(244, 63, 94, 0.55)'
        : 'rgba(245, 158, 11, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft + 8, padTop + 4, hudW, 18);

    ctx.textAlign = 'left';
    ctx.fillStyle =
      chartStructure.trendLabel === 'Uptrend'
        ? '#34d399'
        : chartStructure.trendLabel === 'Downtrend'
        ? '#fb7185'
        : '#fbbf24';
    ctx.fillText(trendText, padLeft + 15, padTop + 16);

    if (momText) {
      const trendOnlyW = ctx.measureText(trendText).width;
      const cls = opportunity!.momentum.classification;
      ctx.fillStyle =
        cls === 'STRONG'
          ? '#34d399'
          : cls === 'MODERATE'
          ? '#38bdf8'
          : cls === 'DEVELOPING'
          ? '#fbbf24'
          : '#94a3b8';
      ctx.fillText(momText, padLeft + 15 + trendOnlyW, padTop + 16);
    }

    ctx.restore();

    // Right Price Scale: Selected/Auto Position TP/Entry/SL price tags
    const focusPosition = selectedPosition || autoPosition;
    if (overlays.showPositionTool !== false && focusPosition) {
      const axisTags = [
        { price: focusPosition.takeProfit, bg: '#15803d', fg: '#ffffff' },
        { price: focusPosition.entryPrice, bg: '#1d4ed8', fg: '#ffffff' },
        { price: focusPosition.stopLoss, bg: '#b91c1c', fg: '#ffffff' }
      ];
      for (const t of axisTags) {
        const ty = yForPrice(t.price);
        if (ty < padTop + 6 || ty > padTop + mainH - 6) continue;
        ctx.fillStyle = t.bg;
        ctx.fillRect(padLeft + chartW + 2, ty - 8, padRight - 4, 16);
        ctx.fillStyle = t.fg;
        ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(fmtPrice(t.price), padLeft + chartW + 7, ty + 3);
      }
    }

    // Right Price Scale: Live Forming Candle Price Tag + Countdown Timer
    if (liveCandle) {
      const yLive = Math.max(padTop + 9, Math.min(padTop + mainH - 25, yForPrice(liveCandle.close)));
      const liveIsUp = liveCandle.close >= liveCandle.open;
      ctx.fillStyle = liveIsUp ? DERIV_BULLISH_COLOR : DERIV_BEARISH_COLOR;
      ctx.fillRect(padLeft + chartW + 2, yLive - 9, padRight - 4, 18);
      ctx.fillStyle = liveIsUp ? '#042f2e' : '#ffffff';
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(liveCandle.close), padLeft + chartW + 7, yLive + 3.5);

      // Live Candle Countdown Tag attached right beneath live close price
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(padLeft + chartW + 2, yLive + 9, padRight - 4, 15);
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(padLeft + chartW + 2, yLive + 9, padRight - 4, 15);
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.fillText(countdownText, padLeft + chartW + 7, yLive + 20);
    }

    // Crosshair
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < slice.length) {
      const cx = xForLocalIdx(hoverIndex);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, padTop);
      ctx.lineTo(cx, H - timeAxisH);
      ctx.stroke();

      if (hoverYPrice !== null && hoverYPrice >= minPrice && hoverYPrice <= maxPrice) {
        const cy = yForPrice(hoverYPrice);
        ctx.beginPath();
        ctx.moveTo(padLeft, cy);
        ctx.lineTo(padLeft + chartW, cy);
        ctx.stroke();

        ctx.fillStyle = '#334155';
        ctx.fillRect(padLeft + chartW + 2, cy - 9, padRight - 4, 18);
        ctx.fillStyle = '#f8fafc';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(fmtPrice(hoverYPrice), padLeft + chartW + 7, cy + 3.5);
      }
      ctx.setLineDash([]);
    }
  }, [
    size,
    candles,
    viewWindow,
    priceDomain,
    rightOffset,
    candleWidthRatio,
    symbol,
    timeframe,
    periodSeconds,
    countdownText,
    chartStructure,
    opportunity,
    activeTradeLevels,
    visiblePositions,
    selectedPositionId,
    hoveredPositionId,
    selectedPosition,
    autoPosition,
    overlays,
    hoverIndex,
    hoverYPrice,
    fmtPrice,
    chartTheme
  ]);

  const inspectedCandle =
    hoverIndex !== null && hoverIndex >= 0 && hoverIndex < viewWindow.slice.length
      ? viewWindow.slice[hoverIndex]
      : formingCandle;

  const formingIsBull = formingCandle ? formingCandle.close >= formingCandle.open : true;

  const hitTestPosition = useCallback(
    (x: number, y: number): { pos: PositionDrawing; handle: PosHandleKind } | null => {
      const slice = viewWindow.slice;
      if (slice.length === 0 || visiblePositions.length === 0) return null;
      const g = getChartGeometry();
      const { padLeft, padTop, chartW, mainH, barStep } = g;
      const { maxPrice, span } = priceDomain;
      const yForP = (p: number) => padTop + ((maxPrice - p) / span) * mainH;
      const xForIdx = (idx: number) => padLeft + (idx + 0.5) * barStep;
      const xForEp = (epoch: number): number => {
        if (epoch <= slice[0].epoch) return xForIdx(-((slice[0].epoch - epoch) / Math.max(1, periodSeconds)));
        for (let i = 0; i < slice.length; i++) {
          if (slice[i].epoch === epoch) return xForIdx(i);
          if (slice[i].epoch > epoch && i > 0) {
            const frac = (epoch - slice[i - 1].epoch) / Math.max(1, slice[i].epoch - slice[i - 1].epoch);
            return xForIdx(i - 1 + frac);
          }
        }
        return xForIdx(slice.length - 1 + (epoch - slice[slice.length - 1].epoch) / Math.max(1, periodSeconds));
      };

      // Check top-most (last drawn) first
      for (let i = visiblePositions.length - 1; i >= 0; i--) {
        const pos = visiblePositions[i];
        const leftRaw = Math.min(xForEp(pos.startEpoch), xForEp(pos.endEpoch));
        const rightRaw = Math.max(xForEp(pos.startEpoch), xForEp(pos.endEpoch));
        const boxLeft = Math.max(padLeft + 4, leftRaw);
        const boxRight = Math.min(padLeft + chartW - 4, rightRaw);
        if (boxRight - boxLeft < 10) continue;

        const yEntry = yForP(pos.entryPrice);
        const yTp = yForP(pos.takeProfit);
        const ySl = yForP(pos.stopLoss);
        const boxMidX = (boxLeft + boxRight) / 2;
        const midBodyY = (Math.min(yTp, ySl) + Math.max(yTp, ySl)) / 2;

        const hitTol = 9;
        if (Math.abs(x - boxMidX) <= hitTol && Math.abs(y - yTp) <= hitTol) {
          return { pos, handle: 'TP' };
        }
        if (Math.abs(x - boxMidX) <= hitTol && Math.abs(y - ySl) <= hitTol) {
          return { pos, handle: 'SL' };
        }
        if (Math.abs(x - boxLeft) <= hitTol && Math.abs(y - yEntry) <= hitTol) {
          return { pos, handle: 'ENTRY' };
        }
        if (Math.abs(x - boxLeft) <= hitTol && Math.abs(y - midBodyY) <= 16) {
          return { pos, handle: 'LEFT' };
        }
        if (Math.abs(x - boxRight) <= hitTol && Math.abs(y - midBodyY) <= 16) {
          return { pos, handle: 'RIGHT' };
        }

        const topY = Math.min(yTp, ySl, yEntry);
        const botY = Math.max(yTp, ySl, yEntry);
        if (x >= boxLeft && x <= boxRight && y >= topY && y <= botY) {
          if (Math.abs(y - yTp) <= 5) return { pos, handle: 'TP' };
          if (Math.abs(y - ySl) <= 5) return { pos, handle: 'SL' };
          if (Math.abs(y - yEntry) <= 5) return { pos, handle: 'ENTRY' };
          return { pos, handle: 'BODY' };
        }
      }
      return null;
    },
    [viewWindow.slice, visiblePositions, getChartGeometry, priceDomain, periodSeconds]
  );

  const placeManualPositionAt = useCallback(
    (side: 'LONG' | 'SHORT', clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const slice = viewWindow.slice;
      if (!canvas || slice.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const g = getChartGeometry();
      const ratioY = Math.max(0.05, Math.min(0.95, (y - g.padTop) / Math.max(1, g.mainH)));
      const entry = priceDomain.maxPrice - ratioY * priceDomain.span;
      const floatIdx = (x - g.padLeft) / Math.max(1, g.barStep) - 0.5;
      const startEpoch =
        slice[Math.max(0, Math.min(slice.length - 1, Math.round(floatIdx)))].epoch;
      const endEpoch = startEpoch + periodSeconds * 12;

      const defaultRisk = Math.max(pipSize * 4, priceDomain.span * 0.14);
      const stopLoss = side === 'LONG' ? entry - defaultRisk : entry + defaultRisk;
      const takeProfit = side === 'LONG' ? entry + defaultRisk * 2 : entry - defaultRisk * 2;

      const newPos: PositionDrawing = {
        id: `POS_${side}_${Date.now()}`,
        symbol,
        side,
        source: 'MANUAL',
        startEpoch,
        endEpoch,
        entryPrice: entry,
        stopLoss,
        takeProfit
      };
      setManualPositions((prev) => [...prev, newPos]);
      setSelectedPositionId(newPos.id);
      setOverlays((prev) => ({ ...prev, showPositionTool: true }));
      setPlacingSide(null);
    },
    [viewWindow.slice, getChartGeometry, priceDomain, periodSeconds, pipSize, symbol]
  );

  const applyPositionDrag = useCallback(
    (clientX: number, clientY: number) => {
      const pd = posDragRef.current;
      if (!pd || !pd.active) return;
      const g = getChartGeometry();
      const dx = clientX - pd.startX;
      const dy = clientY - pd.startY;
      const priceDelta = -(dy / Math.max(1, g.mainH)) * priceDomain.span;
      const barsDelta = dx / Math.max(2, g.barStep);
      const epochDelta = Math.round(barsDelta * periodSeconds);
      const minStep = Math.max(pipSize, priceDomain.span * 0.015);
      const minSpanSec = periodSeconds * 2;

      updatePositionById(pd.posId, () => {
        const init = pd.initial;
        if (pd.handle === 'TP') {
          const nextTp =
            init.side === 'LONG'
              ? Math.max(init.entryPrice + minStep, init.takeProfit + priceDelta)
              : Math.min(init.entryPrice - minStep, init.takeProfit + priceDelta);
          return { ...init, takeProfit: nextTp };
        }
        if (pd.handle === 'SL') {
          const nextSl =
            init.side === 'LONG'
              ? Math.min(init.entryPrice - minStep, init.stopLoss + priceDelta)
              : Math.max(init.entryPrice + minStep, init.stopLoss + priceDelta);
          return { ...init, stopLoss: nextSl };
        }
        if (pd.handle === 'ENTRY') {
          const nextEntry =
            init.side === 'LONG'
              ? Math.min(init.takeProfit - minStep, Math.max(init.stopLoss + minStep, init.entryPrice + priceDelta))
              : Math.max(init.takeProfit + minStep, Math.min(init.stopLoss - minStep, init.entryPrice + priceDelta));
          return { ...init, entryPrice: nextEntry };
        }
        if (pd.handle === 'LEFT') {
          const nextStart = Math.min(init.endEpoch - minSpanSec, init.startEpoch + epochDelta);
          return { ...init, startEpoch: nextStart };
        }
        if (pd.handle === 'RIGHT') {
          const nextEnd = Math.max(init.startEpoch + minSpanSec, init.endEpoch + epochDelta);
          return { ...init, endEpoch: nextEnd };
        }
        // BODY: translate entire drawing in both time and price
        return {
          ...init,
          startEpoch: init.startEpoch + epochDelta,
          endEpoch: init.endEpoch + epochDelta,
          entryPrice: init.entryPrice + priceDelta,
          stopLoss: init.stopLoss + priceDelta,
          takeProfit: init.takeProfit + priceDelta
        };
      });
    },
    [getChartGeometry, priceDomain.span, periodSeconds, pipSize, updatePositionById]
  );

  const panByClientXY = (clientX: number, clientY: number) => {
    const isCompact = size.width < 540;
    const padRight = isCompact ? 68 : 84;
    const plotW = Math.max(40, size.width - 10 - padRight - (rightOffset === 0 ? (isCompact ? 18 : 28) : 6));
    const barStep = Math.max(3, plotW / Math.max(1, viewWindow.slice.length));
    const dx = clientX - dragRef.current.startX;
    const barsMoved = Math.round(dx / barStep);
    setRightOffset(
      Math.max(0, Math.min(Math.max(0, candles.length - 8), dragRef.current.startOffset + barsMoved))
    );

    // Vertical drag panning across price axis
    if (!autoScale || Math.abs(clientY - dragRef.current.startY) > 6) {
      const mainH = Math.max(80, size.height - 16 - 26);
      const dy = clientY - dragRef.current.startY;
      const pricePerPx = priceDomain.span / mainH;
      if (Math.abs(dy) > 4) setAutoScale(false);
      setPricePanOffset(dragRef.current.startPricePan + dy * pricePerPx);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (posDragRef.current?.active) {
      applyPositionDrag(e.clientX, e.clientY);
      return;
    }

    if (dragRef.current.active) {
      panByClientXY(e.clientX, e.clientY);
      return;
    }

    const hit = hitTestPosition(x, y);
    if (hit) {
      setHoveredPositionId(hit.pos.id);
      setCursorStyle(
        hit.handle === 'TP' || hit.handle === 'SL' || hit.handle === 'ENTRY'
          ? 'ns-resize'
          : hit.handle === 'LEFT' || hit.handle === 'RIGHT'
          ? 'ew-resize'
          : 'grab'
      );
    } else {
      setHoveredPositionId(null);
      setCursorStyle('crosshair');
    }

    const g = getChartGeometry();
    if (x >= g.padLeft && x <= g.padLeft + g.plotW && viewWindow.slice.length > 0) {
      const idx = Math.floor(((x - g.padLeft) / g.plotW) * viewWindow.slice.length);
      setHoverIndex(Math.max(0, Math.min(viewWindow.slice.length - 1, idx)));

      const ratio = (y - g.padTop) / Math.max(1, g.mainH);
      setHoverYPrice(priceDomain.maxPrice - ratio * priceDomain.span);
    } else {
      setHoverIndex(null);
      setHoverYPrice(null);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const step = Math.max(2, Math.round(visibleCount * 0.12));
    const delta = e.deltaY > 0 ? step : -step;
    setVisibleCount((v) => Math.max(10, Math.min(240, v + delta)));
  };

  const touchDist = (t1: React.Touch, t2: React.Touch) =>
    Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

  const isConfirmed = activeTradeLevels.length > 0;
  const momentumClass = opportunity?.momentum.classification;

  return (
    <div
      ref={wrapperRef}
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-surface-deep flex flex-col'
          : 'rounded-xl border border-line/90 bg-surface-deep overflow-hidden flex flex-col'
      }
    >
      {/* Top Interactive Chart Toolbar */}
      <div className="px-3.5 py-2.5 bg-surface-deep/75 border-b border-line/80 flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-sm font-bold text-fg-1 tracking-tight">{displayName}</span>
            <span className="text-[11px] font-mono text-fg-4">{symbol}</span>
            <span className="text-fg-6">·</span>
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-mono font-semibold ${
                connectionState === 'CONNECTED' && !isStale
                  ? 'text-success'
                  : isStale || connectionState === 'RECONNECTING'
                  ? 'text-warning'
                  : 'text-danger'
              }`}
            >
              {connectionState === 'CONNECTED' ? (
                <Wifi className="w-3 h-3" />
              ) : (
                <WifiOff className="w-3 h-3" />
              )}
              <span>
                {isStale
                  ? 'STALE FEED'
                  : `${connectionState}${latencyMs ? ` ${latencyMs}ms` : ''}`}
              </span>
              {missedTicks > 0 && <span className="text-warning">({missedTicks} gaps)</span>}
            </span>
            <span className="text-fg-6">·</span>
            <span
              className={`text-[11px] font-mono font-bold ${
                chartStructure.trendLabel === 'Uptrend'
                  ? 'text-success'
                  : chartStructure.trendLabel === 'Downtrend'
                  ? 'text-danger'
                  : 'text-warning'
              }`}
            >
              Trend: {chartStructure.trendLabel} ({opportunity?.marketRegimeLabel || chartStructure.marketCondition})
            </span>
            {chartStructure.confirmedPattern && (
              <>
                <span className="text-fg-6">·</span>
                <span className="text-[11px] font-mono font-bold text-accent-soft">
                  Pattern: {chartStructure.confirmedPattern.label}
                </span>
              </>
            )}
            {momentumClass && (
              <>
                <span className="text-fg-6">·</span>
                <span
                  className={`text-[11px] font-mono font-bold ${
                    momentumClass === 'STRONG'
                      ? 'text-success'
                      : momentumClass === 'MODERATE'
                      ? 'text-accent-soft'
                      : momentumClass === 'DEVELOPING'
                      ? 'text-warning'
                      : 'text-fg-4'
                  }`}
                >
                  Momentum: {formatMomentumText(momentumClass)}
                </span>
              </>
            )}
            <span className="text-fg-6">·</span>
            <span
              className={`text-[11px] font-mono font-bold ${
                isConfirmed
                  ? opportunity?.direction === 'BULLISH'
                    ? 'text-success'
                    : 'text-danger'
                  : 'text-warning'
              }`}
            >
              {isConfirmed ? opportunity?.riseFallLabel : 'WAITING FOR SETUP'}
            </span>
          </div>

          {/* Continuous Live Forming Candle OHLCV & Countdown */}
          {inspectedCandle && (
            <div className="text-[11px] font-mono text-fg-4 tabular-nums mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span>
                O <strong className="text-fg-2">{fmtPrice(inspectedCandle.open)}</strong>
              </span>
              <span>
                H <strong className="text-accent-cyan">{fmtPrice(inspectedCandle.high)}</strong>
              </span>
              <span>
                L <strong className="text-danger">{fmtPrice(inspectedCandle.low)}</strong>
              </span>
              <span>
                Price <strong className="text-fg-1">{fmtPrice(inspectedCandle.close)}</strong>
              </span>
              {formingCandle && (
                <>
                  <span
                    className={`inline-flex items-center gap-1 font-bold ${
                      formingIsBull ? 'text-accent-cyan' : 'text-danger'
                    }`}
                  >
                    {formingIsBull ? (
                      <TrendingUp className="w-3 h-3" />
                    ) : (
                      <TrendingDown className="w-3 h-3" />
                    )}
                    <span>{formingIsBull ? 'Forming Bullish' : 'Forming Bearish'}</span>
                  </span>
                  <span className="inline-flex items-center gap-1 text-warning font-semibold">
                    <Clock className="w-3 h-3" />
                    <span>Closes in {countdownText}</span>
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Timeframe Switcher + Full Zoom/Scale/Fullscreen Controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Strict 5 Timeframes */}
          <div className="flex items-center bg-surface-deepest p-0.5 rounded-lg border border-line">
            {TIMEFRAMES.map((item) => (
              <button
                key={item.tf}
                onClick={() => onTimeframeChange(item.tf)}
                className={`px-2.5 py-1.5 min-h-[34px] text-[11px] font-mono font-semibold rounded-md whitespace-nowrap transition ${
                  timeframe === item.tf
                    ? 'bg-accent text-on-accent'
                    : 'text-fg-4 hover:text-fg-1'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Interactive Long / Short Position Drawing Tools */}
          <div className="flex items-center bg-surface-deepest p-0.5 rounded-lg border border-line">
            <button
              onClick={() => setPlacingSide((s) => (s === 'LONG' ? null : 'LONG'))}
              className={`px-2.5 py-1.5 min-h-[34px] flex items-center gap-1 text-[11px] font-mono font-semibold rounded-md whitespace-nowrap transition ${
                placingSide === 'LONG'
                  ? 'bg-success text-fg-1'
                  : 'text-success hover:bg-surface-deep'
              }`}
              title="Draw Long Position Tool (click chart to place)"
            >
              <ArrowUpRight className="w-3.5 h-3.5" />
              <span>Long Pos</span>
            </button>
            <button
              onClick={() => setPlacingSide((s) => (s === 'SHORT' ? null : 'SHORT'))}
              className={`px-2.5 py-1.5 min-h-[34px] flex items-center gap-1 text-[11px] font-mono font-semibold rounded-md whitespace-nowrap transition ${
                placingSide === 'SHORT'
                  ? 'bg-danger text-fg-1'
                  : 'text-danger hover:bg-surface-deep'
              }`}
              title="Draw Short Position Tool (click chart to place)"
            >
              <ArrowDownRight className="w-3.5 h-3.5" />
              <span>Short Pos</span>
            </button>
          </div>

          {/* Zoom +, Zoom -, Reset Zoom, Auto-Fit, Spacing/Scale, Fullscreen */}
          <div className="flex items-center bg-surface-deepest p-0.5 rounded-lg border border-line">
            <button
              onClick={() => setVisibleCount((v) => Math.max(10, Math.round(v * 0.78)))}
              className="p-1.5 min-h-[34px] min-w-[32px] flex items-center justify-center text-fg-3 hover:text-fg-1"
              title="Zoom In"
              aria-label="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setVisibleCount((v) => Math.min(240, Math.round(v * 1.25)))}
              className="p-1.5 min-h-[34px] min-w-[32px] flex items-center justify-center text-fg-3 hover:text-fg-1"
              title="Zoom Out"
              aria-label="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleResetZoom}
              className="px-2 py-1.5 min-h-[34px] flex items-center gap-1 text-[11px] font-mono text-fg-3 hover:text-fg-1 whitespace-nowrap"
              title="Reset Zoom"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="hidden sm:inline">Reset</span>
            </button>
            <button
              onClick={handleAutoFit}
              className="px-2 py-1.5 min-h-[34px] flex items-center gap-1 text-[11px] font-mono text-fg-3 hover:text-fg-1 whitespace-nowrap"
              title="Auto-Fit Chart"
            >
              <Scan className="w-3 h-3" />
              <span className="hidden sm:inline">Fit</span>
            </button>
            <button
              onClick={() => setShowOverlayControls((s) => !s)}
              className={`px-2 py-1.5 min-h-[34px] flex items-center gap-1 text-[11px] font-mono rounded whitespace-nowrap ${
                showOverlayControls ? 'text-accent-soft bg-surface-raised' : 'text-fg-3 hover:text-fg-1'
              }`}
              title="Toggle Chart Analysis Overlays"
              aria-label="Toggle Chart Analysis Overlays"
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Overlays</span>
            </button>
            <button
              onClick={() => setShowScaleControls((s) => !s)}
              className={`p-1.5 min-h-[34px] min-w-[32px] flex items-center justify-center rounded ${
                showScaleControls ? 'text-accent-soft bg-surface-raised' : 'text-fg-3 hover:text-fg-1'
              }`}
              title="Candle Spacing & Price Scaling"
              aria-label="Candle Spacing and Scaling"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={toggleFullscreen}
              className="p-1.5 min-h-[34px] min-w-[32px] flex items-center justify-center text-fg-3 hover:text-fg-1"
              title={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
              aria-label={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
            >
              {isFullscreen ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Placement Mode Prompt */}
      {placingSide && (
        <div className="px-3.5 py-2 bg-accent/60 border-b border-accent/40 flex items-center justify-between gap-3 text-xs font-mono">
          <span className="text-accent-cyan">
            Click anywhere on the chart to place a <strong>{placingSide} POSITION</strong> drawing (Entry, SL, TP &amp; R:R).
          </span>
          <button
            onClick={() => setPlacingSide(null)}
            className="px-2.5 py-1 rounded bg-surface-deep border border-line-strong text-fg-3 hover:text-fg-1 text-[11px]"
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* Selected Position Quick Editor & Inspector */}
      {selectedPosition && (
        <div className="px-3.5 py-2 bg-surface-deepest border-b border-line flex flex-wrap items-center justify-between gap-3 text-xs font-mono tabular-nums">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`font-bold ${
                selectedPosition.side === 'LONG' ? 'text-success' : 'text-danger'
              }`}
            >
              {selectedPosition.side} POSITION ({selectedPosition.source})
            </span>

            <label className="flex items-center gap-1.5 text-fg-4">
              <span>Entry:</span>
              <input
                type="number"
                step={pipSize}
                value={Number(selectedPosition.entryPrice.toFixed(decimals))}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!Number.isFinite(val)) return;
                  updatePositionById(selectedPosition.id, (p) => ({ ...p, entryPrice: val }));
                }}
                className="w-24 bg-surface-deep border border-line-strong rounded px-2 py-1 text-accent-cyan focus:border-accent focus:outline-none"
              />
            </label>

            <label className="flex items-center gap-1.5 text-fg-4">
              <span>SL:</span>
              <input
                type="number"
                step={pipSize}
                value={Number(selectedPosition.stopLoss.toFixed(decimals))}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!Number.isFinite(val)) return;
                  updatePositionById(selectedPosition.id, (p) => ({ ...p, stopLoss: val }));
                }}
                className="w-24 bg-surface-deep border border-line-strong rounded px-2 py-1 text-danger focus:border-danger focus:outline-none"
              />
            </label>

            <label className="flex items-center gap-1.5 text-fg-4">
              <span>TP:</span>
              <input
                type="number"
                step={pipSize}
                value={Number(selectedPosition.takeProfit.toFixed(decimals))}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!Number.isFinite(val)) return;
                  updatePositionById(selectedPosition.id, (p) => ({ ...p, takeProfit: val }));
                }}
                className="w-24 bg-surface-deep border border-line-strong rounded px-2 py-1 text-success focus:border-success focus:outline-none"
              />
            </label>

            <span className="text-fg-3 font-semibold">
              R:R{' '}
              {(
                Math.abs(selectedPosition.takeProfit - selectedPosition.entryPrice) /
                Math.max(1e-9, Math.abs(selectedPosition.entryPrice - selectedPosition.stopLoss))
              ).toFixed(2)}
              :1
            </span>
          </div>

          <div className="flex items-center gap-2">
            {selectedPosition.source === 'MANUAL' && (
              <button
                onClick={() =>
                  updatePositionById(selectedPosition.id, (p) => {
                    const risk = Math.abs(p.entryPrice - p.stopLoss);
                    const reward = Math.abs(p.takeProfit - p.entryPrice);
                    const nextSide = p.side === 'LONG' ? 'SHORT' : 'LONG';
                    return {
                      ...p,
                      side: nextSide,
                      stopLoss: nextSide === 'LONG' ? p.entryPrice - risk : p.entryPrice + risk,
                      takeProfit: nextSide === 'LONG' ? p.entryPrice + reward : p.entryPrice - reward
                    };
                  })
                }
                className="px-2.5 py-1 rounded bg-surface-raised hover:bg-surface-elevated text-fg-2 flex items-center gap-1 text-[11px]"
              >
                <ArrowLeftRight className="w-3 h-3" />
                <span>Flip</span>
              </button>
            )}

            {selectedPosition.source === 'AUTO' && selectedPosition.customized && selectedPosition.signalId && (
              <button
                onClick={() => {
                  const sigId = selectedPosition.signalId!;
                  setAutoOverrides((prev) => {
                    const next = { ...prev };
                    delete next[sigId];
                    return next;
                  });
                }}
                className="px-2.5 py-1 rounded bg-accent/20 border border-accent/40 text-accent-cyan hover:bg-accent/30 text-[11px]"
              >
                Sync Signal
              </button>
            )}

            <button
              onClick={() => deletePositionById(selectedPosition.id)}
              className="px-2.5 py-1 rounded bg-danger/15 border border-danger/40 text-danger hover:bg-danger/25 flex items-center gap-1 text-[11px]"
            >
              <Trash2 className="w-3 h-3" />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}

      {/* Collapsible Chart Overlay Controls */}
      {showOverlayControls && (
        <div className="px-3.5 py-2 bg-surface-deepest/95 border-b border-line/80 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] font-mono text-fg-3">
          <span className="text-fg-5 uppercase text-[10px] font-semibold">Overlays:</span>
          {(
            [
              ['showPositionTool', 'Position Tool'],
              ['showFlippedSR', 'Flipped S/R'],
              ['showTrendlines', 'Trendlines'],
              ['showSupportResistance', 'Support & Resistance'],
              ['showSupplyDemand', 'Supply & Demand'],
              ['showBreakoutLevels', 'Breakout / Retest'],
              ['showProtectedSwings', 'Protected H/L'],
              ['showChartPatterns', 'Chart Pattern'],
              ['showTradeLevels', 'Entry / SL / TP']
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="inline-flex items-center gap-1.5 cursor-pointer hover:text-fg-1">
              <input
                type="checkbox"
                checked={overlays[key] !== false}
                onChange={() => setOverlays((prev) => ({ ...prev, [key]: prev[key] === false }))}
                className="accent-accent rounded cursor-pointer"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )}

      {/* Collapsible Candle Spacing & Chart Scaling Bar */}
      {showScaleControls && (
        <div className="px-3.5 py-2 bg-surface-deepest/95 border-b border-line/80 flex flex-wrap items-center gap-4 text-[11px] font-mono text-fg-3 tabular-nums">
          <label className="flex items-center gap-2">
            <span className="text-fg-4">Candle Width / Spacing:</span>
            <input
              type="range"
              min={0.4}
              max={0.88}
              step={0.04}
              value={candleWidthRatio}
              onChange={(e) => setCandleWidthRatio(parseFloat(e.target.value))}
              className="w-24 accent-accent cursor-pointer"
            />
            <span>{Math.round(candleWidthRatio * 100)}%</span>
          </label>

          <label className="flex items-center gap-2">
            <span className="text-fg-4">Vertical Scale:</span>
            <input
              type="range"
              min={0.5}
              max={2.5}
              step={0.1}
              value={verticalScale}
              onChange={(e) => {
                setAutoScale(false);
                setVerticalScale(parseFloat(e.target.value));
              }}
              className="w-24 accent-accent cursor-pointer"
            />
            <span>{verticalScale.toFixed(1)}x</span>
          </label>

          {rightOffset > 0 && (
            <button
              onClick={() => setRightOffset(0)}
              className="px-2 py-1 rounded bg-accent/20 border border-accent/40 text-accent-cyan hover:bg-accent/30"
            >
              Jump to Live Candle
            </button>
          )}
        </div>
      )}

      {/* Visual Confluence Score & Model Agreement Breakdown Indicator */}
      <div className="px-3.5 py-2 bg-surface-deep/90 border-b border-line/80 flex flex-wrap items-center justify-between gap-3 text-xs font-mono tabular-nums">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-deepest border border-line">
            <span className="text-[11px] text-fg-4">Confluence Score:</span>
            <span
              className={`font-bold text-sm ${
                (opportunity?.score.total ?? 0) >= 75
                  ? 'text-success'
                  : (opportunity?.score.total ?? 0) >= 55
                  ? 'text-accent-soft'
                  : 'text-warning'
              }`}
            >
              {opportunity?.score.total ?? 62}%
            </span>
            <span className="text-[10px] text-fg-4 uppercase">
              ({opportunity?.setupTier === 'HIGH_QUALITY' ? 'High Confluence' : opportunity?.setupTier === 'DEVELOPING' ? 'Moderate' : 'Waiting'})
            </span>
          </div>

          <div className="hidden md:flex items-center gap-1.5 text-[11px] text-fg-3">
            <span className="text-fg-5">Active Strategy:</span>
            <span className="font-semibold text-accent-cyan">
              {opportunity?.selectedStrategy.label || chartStructure.confirmedPattern?.label || 'Price Action Multi-Model'}
            </span>
          </div>
        </div>

        {/* Model Agreement Breakdown Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Supply & Demand */}
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
              (opportunity?.zones?.some((z) => !z.broken && (z.type === 'DEMAND' || z.type === 'SUPPLY')) || chartStructure.supportZones.length > 0)
                ? 'bg-success/60 border-success/60 text-success'
                : 'bg-surface-deepest border-line text-fg-4'
            }`}
            title="Supply & Demand Zone Reaction Model"
          >
            S&D: {(opportunity?.zones?.some((z) => !z.broken && (z.type === 'DEMAND' || z.type === 'SUPPLY')) || chartStructure.supportZones.length > 0) ? 'Zone Reaction' : 'None'}
          </span>

          {/* Trendline Model */}
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
              (chartStructure.trendlines.length > 0 || (opportunity?.trendlines && opportunity.trendlines.length > 0))
                ? 'bg-accent/60 border-accent/60 text-accent-cyan'
                : 'bg-surface-deepest border-line text-fg-4'
            }`}
            title="Trendline Bounce / Retest Model"
          >
            Trendline: {(chartStructure.trendlines.length > 0 || (opportunity?.trendlines && opportunity.trendlines.length > 0)) ? 'Active Bounce' : 'None'}
          </span>

          {/* Chart Pattern Model */}
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
              (chartStructure.confirmedPattern || opportunity?.confirmedPattern)
                ? 'bg-accent/15 border-accent/40 text-accent-soft'
                : 'bg-surface-deepest border-line text-fg-4'
            }`}
            title="Chart Pattern Breakout Model"
          >
            Pattern: {chartStructure.confirmedPattern?.label || opportunity?.confirmedPattern?.label || 'None'}
          </span>

          {/* S&R / Flip Model */}
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
              (opportunity?.srFlipDetected || chartStructure.supportZones.some((z) => z.isFlip) || chartStructure.resistanceZones.some((z) => z.isFlip))
                ? 'bg-accent/15 border-accent/40 text-accent-soft'
                : 'bg-surface-deepest border-line text-fg-4'
            }`}
            title="Support & Resistance / Role Reversal Flip Model"
          >
            S&R Flip: {(opportunity?.srFlipDetected || chartStructure.supportZones.some((z) => z.isFlip)) ? 'Confirmed Flip' : 'Level Intact'}
          </span>

          {/* M1 Price Action Trigger */}
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
              (opportunity?.candleCloseConfirmed || opportunity?.entryAndTp.confirmed)
                ? 'bg-success/60 border-success/60 text-success'
                : 'bg-warning/40 border-warning/50 text-warning'
            }`}
            title="M1 Candle Close Confirmation Trigger"
          >
            M1 PA: {(opportunity?.candleCloseConfirmed || opportunity?.entryAndTp.confirmed) ? 'Confirmed Close' : 'Awaiting'}
          </span>

          {/* Momentum */}
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
              (opportunity?.momentum.passed || opportunity?.momentum.classification === 'STRONG' || opportunity?.momentum.classification === 'MODERATE')
                ? 'bg-accent/60 border-accent/60 text-accent-cyan'
                : 'bg-surface-deepest border-line text-fg-4'
            }`}
            title="Momentum & Displacement Assessment"
          >
            Momentum: {opportunity?.momentum.classification || 'Neutral'}
          </span>
        </div>
      </div>

      {/* Uncluttered Interactive Canvas */}
      <div
        ref={containerRef}
        className={`w-full relative select-none ${isFullscreen ? 'flex-1' : ''}`}
      >
        <canvas
          ref={canvasRef}
          style={{
            width: `${size.width}px`,
            height: `${size.height}px`,
            touchAction: 'none',
            cursor: placingSide ? 'cell' : cursorStyle
          }}
          className="block"
          onMouseDown={(e) => {
            if (placingSide) {
              placeManualPositionAt(placingSide, e.clientX, e.clientY);
              return;
            }
            const canvas = canvasRef.current;
            if (canvas) {
              const rect = canvas.getBoundingClientRect();
              const x = e.clientX - rect.left;
              const y = e.clientY - rect.top;
              const hit = hitTestPosition(x, y);
              if (hit) {
                setSelectedPositionId(hit.pos.id);
                setCursorStyle(hit.handle === 'BODY' ? 'grabbing' : cursorStyle);
                posDragRef.current = {
                  active: true,
                  posId: hit.pos.id,
                  isAuto: hit.pos.source === 'AUTO',
                  signalId: hit.pos.signalId,
                  handle: hit.handle,
                  startX: e.clientX,
                  startY: e.clientY,
                  initial: { ...hit.pos }
                };
                return;
              }
            }
            setSelectedPositionId(null);
            dragRef.current = {
              active: true,
              startX: e.clientX,
              startY: e.clientY,
              startOffset: rightOffset,
              startPricePan: pricePanOffset
            };
          }}
          onMouseUp={() => {
            dragRef.current.active = false;
            posDragRef.current = null;
          }}
          onMouseLeave={() => {
            dragRef.current.active = false;
            posDragRef.current = null;
            setHoverIndex(null);
            setHoverYPrice(null);
          }}
          onMouseMove={handleMouseMove}
          onTouchStart={(e) => {
            if (placingSide && e.touches.length === 1) {
              placeManualPositionAt(placingSide, e.touches[0].clientX, e.touches[0].clientY);
              return;
            }
            if (e.touches.length === 2) {
              dragRef.current.active = false;
              posDragRef.current = null;
              pinchRef.current = {
                active: true,
                startDist: touchDist(e.touches[0], e.touches[1]),
                startVisibleCount: visibleCount
              };
            } else if (e.touches.length === 1) {
              pinchRef.current.active = false;
              const canvas = canvasRef.current;
              if (canvas) {
                const rect = canvas.getBoundingClientRect();
                const hit = hitTestPosition(
                  e.touches[0].clientX - rect.left,
                  e.touches[0].clientY - rect.top
                );
                if (hit) {
                  setSelectedPositionId(hit.pos.id);
                  posDragRef.current = {
                    active: true,
                    posId: hit.pos.id,
                    isAuto: hit.pos.source === 'AUTO',
                    signalId: hit.pos.signalId,
                    handle: hit.handle,
                    startX: e.touches[0].clientX,
                    startY: e.touches[0].clientY,
                    initial: { ...hit.pos }
                  };
                  return;
                }
              }
              dragRef.current = {
                active: true,
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startOffset: rightOffset,
                startPricePan: pricePanOffset
              };
            }
          }}
          onTouchMove={(e) => {
            if (pinchRef.current.active && e.touches.length === 2) {
              e.preventDefault();
              const dist = touchDist(e.touches[0], e.touches[1]);
              if (pinchRef.current.startDist > 0 && dist > 0) {
                const ratio = pinchRef.current.startDist / dist;
                setVisibleCount(
                  Math.max(10, Math.min(240, Math.round(pinchRef.current.startVisibleCount * ratio)))
                );
              }
            } else if (posDragRef.current?.active && e.touches.length === 1) {
              e.preventDefault();
              applyPositionDrag(e.touches[0].clientX, e.touches[0].clientY);
            } else if (dragRef.current.active && e.touches.length === 1) {
              e.preventDefault();
              panByClientXY(e.touches[0].clientX, e.touches[0].clientY);
            }
          }}
          onTouchEnd={() => {
            dragRef.current.active = false;
            posDragRef.current = null;
            pinchRef.current.active = false;
          }}
          onWheel={handleWheel}
        />
      </div>
    </div>
  );
};
