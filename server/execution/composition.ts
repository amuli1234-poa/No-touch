import type { Store, UserRecord } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import { loadExecutionFlags, type ExecutionFlags } from '../config/flags.js';
import { ExecutionGateway } from './gateway.js';
import { DerivBroker } from './broker/derivBroker.js';
import { BalanceService } from '../services/balance.js';
import { effectiveRiskProfile, evaluateRisk } from '../services/risk.js';
import { ExecutionAuditor } from './audit.js';
import { AutoExecutionRunner } from './autoRunner.js';
import { ContractMonitor } from './contractMonitor.js';
import { MarketScanner } from '../services/marketScanner.js';
import type { MarketDataService } from '../services/marketData.js';
import type { SignalRecord } from './types.js';

/**
 * Production composition for the execution layer.
 *
 * Wires the real Deriv broker, the risk engine and the balance reader into the
 * gateway. Kept out of `index.ts` so the gateway itself stays dependency-
 * injected and testable, and so the kill switches are read from the environment
 * in exactly one place.
 *
 * The REAL-execution flag is read but, in this build, REAL stays disabled: the
 * default is false and the release review that would enable it is a later phase.
 */

export interface ExecutionBundle {
  gateway: ExecutionGateway;
  runner: AutoExecutionRunner;
  monitor: ContractMonitor;
  flags: ExecutionFlags;
  /** The automatic-mode scanner. Created here so the runner has one owner. */
  scanner: MarketScanner;
}

export function createExecution(cfg: ServerConfig, store: Store, market: MarketDataService): ExecutionBundle {
  const flags = loadExecutionFlags();
  const broker = new DerivBroker(cfg);
  const balances = new BalanceService(cfg);

  const auditor = new ExecutionAuditor(store);
  const monitor = new ContractMonitor({ store, broker, auditor });

  const gateway = new ExecutionGateway({
    store,
    cfg,
    flags,
    broker,
    // When a purchase succeeds, hand the contract to the monitor so its
    // lifecycle is tracked to settlement.
    onContractOpened: (user, contract, accessToken) => monitor.monitor(user, contract, accessToken),
    balanceProvider: async (user: UserRecord, accountId: string, accessToken: string) => {
      try {
        const read = await balances.read(user, accountId, accessToken);
        return read.balance;
      } catch {
        // An unreadable balance must not be treated as a healthy one; the risk
        // engine fails closed on a null balance.
        return null;
      }
    },
    riskEvaluator: (
      user: UserRecord,
      accountId: string,
      stake: number,
      signal: SignalRecord,
      balance: number | null,
      now: number
    ) => {
      const profile = effectiveRiskProfile(store, user.id);
      const ageSeconds = (now - signal.createdAt) / 1000;
      const decision = evaluateRisk(
        store,
        { userId: user.id, accountId, stake, balance, signalAgeSeconds: ageSeconds, now },
        profile
      );
      return { approved: decision.approved, reasons: decision.reasons };
    },
    auditor
  });

  const runner = new AutoExecutionRunner({ store, gateway, auditor });
  const scanner = new MarketScanner({ store, cfg, market, runner });
  return { gateway, runner, monitor, flags, scanner };
}
