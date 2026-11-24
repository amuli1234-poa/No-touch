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
import { SystemSignalService } from '../services/systemSignals.js';
import { CopyExecutionEngine } from '../copyTrading/engine.js';
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
  /** The bridge the dashboard's best signal is published to. */
  systemSignals: SystemSignalService;
  /** Mirrors an accepted DEMO master trade onto connected followers. */
  copyEngine: CopyExecutionEngine;
}

export function createExecution(
  cfg: ServerConfig,
  store: Store,
  balances?: BalanceService
): ExecutionBundle {
  const flags = loadExecutionFlags();
  const broker = new DerivBroker(cfg);
  // Reuse the process-wide balance service when one is supplied, so the risk
  // engine's balance read is served from the cache the balance routes keep warm
  // instead of opening a fresh Deriv OTP + WebSocket on every submit.
  const balanceService = balances ?? new BalanceService(cfg);

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
    onContractClosed: async (user, contract, sale) => {
      await monitor.recordSale(user, contract.id, sale);
    },
    balanceProvider: async (user: UserRecord, accountId: string, accessToken: string) => {
      try {
        const read = await balanceService.read(user, accountId, accessToken);
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
      now: number,
      intentId: string,
      symbol: string
    ) => {
      const profile = effectiveRiskProfile(store, user.id);
      const ageSeconds = (now - signal.createdAt) / 1000;
      const decision = evaluateRisk(
        store,
        {
          userId: user.id,
          accountId,
          stake,
          balance,
          signalAgeSeconds: ageSeconds,
          now,
          excludeIntentId: intentId,
          symbol
        },
        profile
      );
      return { approved: decision.approved, reasons: decision.reasons };
    },
    auditor
  });

  const runner = new AutoExecutionRunner({ store, gateway, auditor });
  const systemSignals = new SystemSignalService();
  const copyEngine = new CopyExecutionEngine({ store, cfg, gateway, auditor });
  return { gateway, runner, monitor, flags, systemSignals, copyEngine };
}
