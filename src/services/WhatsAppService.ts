import { OpportunitySignal, WhatsAppProviderStatus, WhatsAppSignalRecord } from '../types/scanner';

export class WhatsAppService {
  private dispatchedSignatures: Map<string, { signature: string; entryPrice?: number; takeProfit?: number; direction: string }> = new Map();

  public async getStatus(): Promise<WhatsAppProviderStatus> {
    try {
      const resp = await fetch('/api/whatsapp/status');
      if (!resp.ok) {
        return {
          configured: false,
          provider: null,
          recipientMasked: null,
          missingFields: ['Backend status endpoint unavailable']
        };
      }
      return await resp.json();
    } catch {
      return {
        configured: false,
        provider: null,
        recipientMasked: null,
        missingFields: ['Server unreachable']
      };
    }
  }

  public buildSignalSignature(opp: OpportunitySignal): string {
    const entryBucket = opp.entryAndTp.entryPrice ? opp.entryAndTp.entryPrice.toFixed(2) : 'NONE';
    const tpBucket = opp.entryAndTp.takeProfit ? opp.entryAndTp.takeProfit.toFixed(2) : 'NONE';
    return `${opp.symbol}|${opp.direction}|${opp.entryAndTp.status}|${entryBucket}|${tpBucket}`;
  }

  public formatSignalMessage(
    opp: OpportunitySignal,
    eventType: 'NEW_SIGNAL' | 'MATERIAL_UPDATE' | 'INVALIDATED'
  ): string {
    const decimals = opp.pipSize < 0.01 ? 3 : 2;
    const fmt = (n?: number) => (typeof n === 'number' ? n.toFixed(decimals) : '—');
    const category = opp.is1s ? 'Volatility 1-Second' : 'Plain Volatility';

    if (eventType === 'INVALIDATED') {
      return [
        `WICKSENTINEL SIGNAL ENGINE — SETUP INVALIDATED`,
        `Instrument: ${opp.displayName} (${category})`,
        `Previous Direction: ${opp.direction === 'BULLISH' ? 'Buy / Rise' : 'Sell / Fall'}`,
        `Strategy: ${opp.selectedStrategy.label}`,
        `Current Price: ${fmt(opp.currentPrice)}`,
        `Reason: ${opp.rejectionReasons[0] || opp.entryAndTp.waitReason || 'Structure or momentum conditions invalidated.'}`,
        `Action: Stand aside / WAIT`
      ].join('\n');
    }

    const header =
      eventType === 'MATERIAL_UPDATE'
        ? `WICKSENTINEL SIGNAL ENGINE — SIGNAL UPDATE`
        : `WICKSENTINEL SIGNAL ENGINE — CONFIRMED SIGNAL`;

    const riseFallText = opp.direction === 'BULLISH' ? 'Buy / Rise' : 'Sell / Fall';

    return [
      header,
      `Instrument: ${opp.displayName} (${category})`,
      `Direction: ${riseFallText}`,
      `Selected Strategy: ${opp.selectedStrategy.label}`,
      `Market Trend & Regime: ${opp.marketRegimeLabel || opp.marketCondition}`,
      opp.confirmedPattern ? `Chart Pattern: ${opp.confirmedPattern.label} (${opp.confirmedPattern.direction})` : null,
      opp.fibConfluence && opp.fibConfluence.zoneLevel !== 'NONE'
        ? `Fibonacci Confluence: ${opp.fibConfluence.zoneLevel} (${opp.fibConfluence.retracementPct}%)`
        : null,
      `Momentum: ${opp.momentum.classification} (${opp.momentum.score}/100)`,
      `M15 Trading Range: ${opp.tradingRange.isValid ? `VALID (${opp.tradingRange.currentPosition})` : 'INVALID'}`,
      `Confluence Score: ${opp.score.total}% (Setup quality, not guaranteed win probability)`,
      `Entry Price: ${fmt(opp.entryAndTp.entryPrice)} (${opp.entryAndTp.entryRationale || 'M1 Trigger'})`,
      `Stop Loss: ${fmt(opp.entryAndTp.invalidationLevel)}`,
      `Take Profit: ${fmt(opp.entryAndTp.takeProfit)} (${opp.entryAndTp.tpRationale || 'Structural target'})`,
      `Timeframes Used: ${(opp.timeframesUsed || ['4H', '1H', '15M', '5M', '1M']).join(' · ')}`,
      `Expected Holding Time: ${opp.expectedHoldingTime || '15 – 45 mins'}`,
      `Timeframe Alignment:`,
      `• H4: ${opp.timeframeMatrix.h4.bias} (${opp.timeframeMatrix.h4.condition})`,
      `• H1: ${opp.timeframeMatrix.h1.bias} (${opp.timeframeMatrix.h1.condition})`,
      `• M15: ${opp.timeframeMatrix.m15.bias} (${opp.timeframeMatrix.m15.structureSummary})`,
      `• M5: ${opp.timeframeMatrix.m5.bias} (${opp.timeframeMatrix.m5.structureSummary})`,
      `• M1: ${opp.timeframeMatrix.m1.bias} (${opp.timeframeMatrix.m1.structureSummary})`,
      `Confirmation: ${opp.explanation}`,
      `Timestamp: ${new Date(opp.detectedEpoch * 1000).toISOString()}`
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Evaluates whether a signal warrants a WhatsApp dispatch (new confirmed >=75%, material change, or invalidation).
   * Prevents duplicate alerts.
   */
  public evaluateDispatchEvent(
    opp: OpportunitySignal,
    minThreshold: number,
    notifyUpdates: boolean
  ): 'NEW_SIGNAL' | 'MATERIAL_UPDATE' | 'INVALIDATED' | null {
    const prev = this.dispatchedSignatures.get(opp.symbol);
    const isConfirmedReady =
      opp.setupTier === 'HIGH_QUALITY' &&
      opp.entryAndTp.confirmed &&
      opp.score.total >= Math.max(75, minThreshold);

    if (isConfirmedReady) {
      const signature = this.buildSignalSignature(opp);
      if (!prev) {
        return 'NEW_SIGNAL';
      }
      if (prev.signature === signature) {
        return null; // Duplicate — suppress
      }
      if (!notifyUpdates) return null;

      // Material change check: direction flip OR entry/TP shifted by >= 0.25%
      const dirChanged = prev.direction !== opp.direction;
      const entryChanged =
        prev.entryPrice &&
        opp.entryAndTp.entryPrice &&
        Math.abs(opp.entryAndTp.entryPrice - prev.entryPrice) / prev.entryPrice >= 0.0025;
      const tpChanged =
        prev.takeProfit &&
        opp.entryAndTp.takeProfit &&
        Math.abs(opp.entryAndTp.takeProfit - prev.takeProfit) / prev.takeProfit >= 0.0025;

      return dirChanged || entryChanged || tpChanged ? 'MATERIAL_UPDATE' : null;
    }

    // If a confirmed signal was previously sent and is now invalidated / broken
    if (prev && notifyUpdates && (opp.setupTier === 'AVOID' || opp.status === 'INVALIDATED')) {
      return 'INVALIDATED';
    }

    return null;
  }

  public async sendSignal(
    opp: OpportunitySignal,
    eventType: 'NEW_SIGNAL' | 'MATERIAL_UPDATE' | 'INVALIDATED'
  ): Promise<WhatsAppSignalRecord> {
    const message = this.formatSignalMessage(opp, eventType);
    const signature = this.buildSignalSignature(opp);

    try {
      const resp = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          metadata: {
            symbol: opp.symbol,
            eventType,
            direction: opp.direction,
            confluenceScore: opp.score.total,
            entryPrice: opp.entryAndTp.entryPrice,
            takeProfit: opp.entryAndTp.takeProfit
          }
        })
      });

      const data = await resp.json().catch(() => ({}));
      const sent = resp.ok && Boolean(data.sent);

      if (sent) {
        if (eventType === 'INVALIDATED') {
          this.dispatchedSignatures.delete(opp.symbol);
        } else {
          this.dispatchedSignatures.set(opp.symbol, {
            signature,
            entryPrice: opp.entryAndTp.entryPrice,
            takeProfit: opp.entryAndTp.takeProfit,
            direction: opp.direction
          });
        }
      }

      return {
        id: `wa_${opp.symbol}_${Date.now()}`,
        symbol: opp.symbol,
        displayName: opp.displayName,
        eventType,
        direction: opp.direction,
        confluenceScore: opp.score.total,
        entryPrice: opp.entryAndTp.entryPrice,
        takeProfit: opp.entryAndTp.takeProfit,
        message,
        sent,
        provider: data.provider || null,
        messageId: data.messageId,
        error: sent ? undefined : data.error || `HTTP ${resp.status}`,
        timestampEpoch: Math.floor(Date.now() / 1000),
        signature
      };
    } catch (err: any) {
      return {
        id: `wa_${opp.symbol}_${Date.now()}`,
        symbol: opp.symbol,
        displayName: opp.displayName,
        eventType,
        direction: opp.direction,
        confluenceScore: opp.score.total,
        entryPrice: opp.entryAndTp.entryPrice,
        takeProfit: opp.entryAndTp.takeProfit,
        message,
        sent: false,
        provider: null,
        error: err?.message || 'Network failure calling WhatsApp dispatch API',
        timestampEpoch: Math.floor(Date.now() / 1000),
        signature
      };
    }
  }
}
