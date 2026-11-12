import { OpportunitySignal, PerformanceRecord } from '../types/scanner';

export interface PerformanceAnalytics {
  totalLogged: number;
  totalSettled: number;
  barrierSurvivalRate: number; // % of contracts where barrier was never touched
  actualTouchFrequency: number; // % touched
  contractWinRate: number; // % won (survived)
  netProfit: number;
  resultsByMarket: { symbol: string; total: number; winRate: number; survivalRate: number }[];
  resultsByExpiry: { durationMinutes: number; total: number; winRate: number }[];
  resultsByMarketType: { standardWinRate: number; oneSecWinRate: number };
  calibrationCurve: { bucket: string; predictedProb: number; actualSurvivalRate: number; count: number }[];
}

export class IndexedDbStorage {
  private dbName = 'DerivNoTouchScannerV4_DB';
  private version = 1;
  private db: IDBDatabase | null = null;

  public async init(): Promise<void> {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('opportunities')) {
          const oppStore = db.createObjectStore('opportunities', { keyPath: 'id' });
          oppStore.createIndex('symbol', 'symbol', { unique: false });
          oppStore.createIndex('status', 'status', { unique: false });
          oppStore.createIndex('detectedEpoch', 'detectedEpoch', { unique: false });
        }
        if (!db.objectStoreNames.contains('performance')) {
          const perfStore = db.createObjectStore('performance', { keyPath: 'id' });
          perfStore.createIndex('symbol', 'symbol', { unique: false });
          perfStore.createIndex('detectedEpoch', 'detectedEpoch', { unique: false });
          perfStore.createIndex('is1s', 'is1s', { unique: false });
        }
      };

      request.onsuccess = (event: any) => {
        this.db = event.target.result;
        resolve();
      };

      request.onerror = (err) => reject(err);
    });
  }

  public async saveOpportunity(opp: OpportunitySignal): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('opportunities', 'readwrite');
      const store = tx.objectStore('opportunities');
      store.put(opp);
      tx.oncomplete = () => resolve();
      tx.onerror = (err) => reject(err);
    });
  }

  public async recordOutcome(outcome: PerformanceRecord): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('performance', 'readwrite');
      const store = tx.objectStore('performance');
      store.put(outcome);
      tx.oncomplete = () => resolve();
      tx.onerror = (err) => reject(err);
    });
  }

  public async getAllPerformanceRecords(): Promise<PerformanceRecord[]> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('performance', 'readonly');
      const store = tx.objectStore('performance');
      const req = store.getAll();

      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (err) => reject(err);
    });
  }

  public async getHistoricalOpportunities(): Promise<OpportunitySignal[]> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('opportunities', 'readonly');
      const store = tx.objectStore('opportunities');
      const req = store.getAll();

      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (err) => reject(err);
    });
  }

  public async computeAnalytics(): Promise<PerformanceAnalytics> {
    const records = await this.getAllPerformanceRecords();

    if (records.length === 0) {
      return {
        totalLogged: 0,
        totalSettled: 0,
        barrierSurvivalRate: 0,
        actualTouchFrequency: 0,
        contractWinRate: 0,
        netProfit: 0,
        resultsByMarket: [],
        resultsByExpiry: [],
        resultsByMarketType: { standardWinRate: 0, oneSecWinRate: 0 },
        calibrationCurve: []
      };
    }

    const totalSettled = records.length;
    const survived = records.filter((r) => !r.barrierTouched).length;
    const wins = records.filter((r) => r.contractSettledWon).length;
    const netProfit = records.reduce((acc, r) => acc + (r.profit || 0), 0);

    // Results by Market
    const marketMap = new Map<string, { total: number; wins: number; survived: number }>();
    records.forEach((r) => {
      const cur = marketMap.get(r.symbol) || { total: 0, wins: 0, survived: 0 };
      cur.total++;
      if (r.contractSettledWon) cur.wins++;
      if (!r.barrierTouched) cur.survived++;
      marketMap.set(r.symbol, cur);
    });

    const resultsByMarket = Array.from(marketMap.entries()).map(([symbol, stat]) => ({
      symbol,
      total: stat.total,
      winRate: (stat.wins / stat.total) * 100,
      survivalRate: (stat.survived / stat.total) * 100
    }));

    // Results by Expiry
    const expiryMap = new Map<number, { total: number; wins: number }>();
    records.forEach((r) => {
      const mins = Math.round(r.expirySeconds / 60);
      const cur = expiryMap.get(mins) || { total: 0, wins: 0 };
      cur.total++;
      if (r.contractSettledWon) cur.wins++;
      expiryMap.set(mins, cur);
    });

    const resultsByExpiry = Array.from(expiryMap.entries()).map(([mins, stat]) => ({
      durationMinutes: mins,
      total: stat.total,
      winRate: (stat.wins / stat.total) * 100
    }));

    // Results by Standard vs 1s
    const stdRecords = records.filter((r) => !r.is1s);
    const oneSecRecords = records.filter((r) => r.is1s);

    const standardWinRate =
      stdRecords.length > 0
        ? (stdRecords.filter((r) => r.contractSettledWon).length / stdRecords.length) * 100
        : 0;
    const oneSecWinRate =
      oneSecRecords.length > 0
        ? (oneSecRecords.filter((r) => r.contractSettledWon).length / oneSecRecords.length) * 100
        : 0;

    // Probability Calibration Curve (Bins: 70-80%, 80-90%, 90-100%)
    const bins = [
      { min: 0.7, max: 0.8, label: '70% - 80%' },
      { min: 0.8, max: 0.9, label: '80% - 90%' },
      { min: 0.9, max: 1.0, label: '90% - 100%' }
    ];

    const calibrationCurve = bins.map((bin) => {
      const inBin = records.filter(
        (r) => 1 - r.predictedTouchProb >= bin.min && 1 - r.predictedTouchProb < bin.max
      );
      const survivedInBin = inBin.filter((r) => !r.barrierTouched).length;
      return {
        bucket: bin.label,
        predictedProb: (bin.min + bin.max) / 2 * 100,
        actualSurvivalRate: inBin.length > 0 ? (survivedInBin / inBin.length) * 100 : 0,
        count: inBin.length
      };
    });

    return {
      totalLogged: totalSettled,
      totalSettled,
      barrierSurvivalRate: (survived / totalSettled) * 100,
      actualTouchFrequency: ((totalSettled - survived) / totalSettled) * 100,
      contractWinRate: (wins / totalSettled) * 100,
      netProfit,
      resultsByMarket,
      resultsByExpiry,
      resultsByMarketType: { standardWinRate, oneSecWinRate },
      calibrationCurve
    };
  }

  public async clearAll(): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(['opportunities', 'performance'], 'readwrite');
      tx.objectStore('opportunities').clear();
      tx.objectStore('performance').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (err) => reject(err);
    });
  }
}
