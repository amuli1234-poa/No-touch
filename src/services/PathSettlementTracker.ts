import { DerivWebSocketManager } from './DerivWebSocketManager';
import { IndexedDbStorage } from './IndexedDbStorage';
import { OpportunitySignal, PerformanceRecord, TrendDirection } from '../types/scanner';

export interface ActiveObservedContract {
  id: string;
  symbol: string;
  displayName: string;
  is1s: boolean;
  direction: TrendDirection;
  barrierLevel: number;
  barrierDirection: 'ABOVE' | 'BELOW';
  startEpoch: number;
  expiryEpoch: number;
  durationSeconds: number;
  technicalScore: number;
  predictedTouchProb: number;
  payout: number;
  askPrice: number;
  hasTouched: boolean;
  settled: boolean;
  minPriceObserved: number;
  maxPriceObserved: number;
  currentDistance: number;
}

export type MonitoredContractsListener = (contracts: ActiveObservedContract[]) => void;

export class PathSettlementTracker {
  private activeContracts: Map<string, ActiveObservedContract> = new Map();
  private listeners: Set<MonitoredContractsListener> = new Set();
  private onSettledCallback?: (record: PerformanceRecord) => void;

  constructor(
    private wsManager: DerivWebSocketManager,
    private db: IndexedDbStorage
  ) {
    this.initTickListener();
  }

  public setOnSettledCallback(cb: (record: PerformanceRecord) => void) {
    this.onSettledCallback = cb;
  }

  private initTickListener() {
    this.wsManager.onTick((symbol: string, tick: { epoch: number; quote: number }) => {
      this.evaluateTick(symbol, tick.epoch, tick.quote);
    });
  }

  /**
   * Registers a qualified opportunity to monitor live path-dependent barrier survival
   */
  public registerContract(opp: OpportunitySignal) {
    if (!opp.barrierProposal) return;
    if (this.activeContracts.has(opp.id)) return;

    const startEpoch = Math.floor(Date.now() / 1000);
    const durationSeconds = opp.barrierProposal.durationSeconds;
    const expiryEpoch = startEpoch + durationSeconds;

    const contract: ActiveObservedContract = {
      id: opp.id,
      symbol: opp.symbol,
      displayName: opp.displayName,
      is1s: opp.is1s,
      direction: opp.direction,
      barrierLevel: opp.barrierProposal.barrierLevel,
      barrierDirection: opp.barrierProposal.direction,
      startEpoch,
      expiryEpoch,
      durationSeconds,
      technicalScore: opp.score.total,
      predictedTouchProb: 1 - opp.barrierProposal.pathSurvivalProb,
      payout: opp.barrierProposal.payout,
      askPrice: opp.barrierProposal.askPrice,
      hasTouched: false,
      settled: false,
      minPriceObserved: opp.currentPrice,
      maxPriceObserved: opp.currentPrice,
      currentDistance: Math.abs(opp.currentPrice - opp.barrierProposal.barrierLevel)
    };

    this.activeContracts.set(contract.id, contract);
    this.notifyListeners();
  }

  private evaluateTick(symbol: string, epoch: number, quote: number) {
    let stateChanged = false;

    for (const [id, c] of this.activeContracts.entries()) {
      if (c.symbol !== symbol || c.settled) continue;

      // Update price excursions
      c.minPriceObserved = Math.min(c.minPriceObserved, quote);
      c.maxPriceObserved = Math.max(c.maxPriceObserved, quote);
      c.currentDistance = Math.abs(quote - c.barrierLevel);

      // Check if barrier is touched (path breach)
      if (!c.hasTouched) {
        if (c.barrierDirection === 'BELOW' && quote <= c.barrierLevel) {
          c.hasTouched = true;
          stateChanged = true;
        } else if (c.barrierDirection === 'ABOVE' && quote >= c.barrierLevel) {
          c.hasTouched = true;
          stateChanged = true;
        }
      }

      // Check if contract has expired
      if (epoch >= c.expiryEpoch) {
        c.settled = true;
        stateChanged = true;
        this.finalizeContract(c);
        this.activeContracts.delete(id);
      }
    }

    if (stateChanged) {
      this.notifyListeners();
    }
  }

  private async finalizeContract(c: ActiveObservedContract) {
    // In No Touch: surviving the entire period without touching the barrier constitutes a win
    const won = !c.hasTouched;
    const profit = won ? c.payout - c.askPrice : -c.askPrice;

    const outcome: PerformanceRecord = {
      id: c.id,
      symbol: c.symbol,
      displayName: c.displayName,
      is1s: c.is1s,
      detectedEpoch: c.startEpoch,
      direction: c.direction,
      technicalScore: c.technicalScore,
      predictedTouchProb: c.predictedTouchProb,
      barrierTouched: c.hasTouched,
      contractSettledWon: won,
      expirySeconds: c.durationSeconds,
      payout: c.payout,
      askPrice: c.askPrice,
      profit,
      fvgMitigationDepth: 0,
      barrierLevel: c.barrierLevel,
      barrierDirection: c.barrierDirection
    };

    await this.db.recordOutcome(outcome);
    if (this.onSettledCallback) {
      this.onSettledCallback(outcome);
    }
  }

  public onUpdate(listener: MonitoredContractsListener) {
    this.listeners.add(listener);
  }

  public offUpdate(listener: MonitoredContractsListener) {
    this.listeners.delete(listener);
  }

  private notifyListeners() {
    const list = Array.from(this.activeContracts.values());
    this.listeners.forEach((l) => l(list));
  }

  public getActiveMonitored(): ActiveObservedContract[] {
    return Array.from(this.activeContracts.values());
  }
}
