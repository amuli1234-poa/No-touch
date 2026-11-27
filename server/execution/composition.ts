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
import { applyFollowerCommissions } from '../copyTrading/finance.js';
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
  /** The broker, exposed so the copy-on-buy route can verify a master contract. */
  broker: DerivBroker;
}

export function createExecution(
  cfg: ServerConfig,
  store: Store,
  balances?: BalanceService
): ExecutionBundle {
  const flags = loadExecutionFlags();
  const broker = new DerivBroker(cfg, { reuseSockets: true });
  // Reuse the process-wide balance service when one is supplied, so the risk
  // engine's balance read is served from the cache the balance routes keep warm
  // instead of opening a fresh Deriv OTP + WebSocket on every submit.
  const balanceService = balances ?? new BalanceService(cfg);

  const auditor = new ExecutionAuditor(store);
  const monitor = new ContractMonitor({
    store,
    broker,
    auditor,
    cfg,
    // Event-driven commission: when a copy follower's contract settles, apply the
    // fee at the authoritative moment (idempotent; recomputed on read regardless).
    onSettled: async (user) => {
      if (!user.id.startsWith('copy_follower_')) return;
      const followerId = user.id.slice('copy_follower_'.length);
      const follower = store.listAllCopyTradingFollowers().find((f) => f.id === followerId);
      if (follower) await applyFollowerCommissions(store, follower.ownerUserId);
    }
  });

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
        // A follower principal is `copy_follower_<id>`; a PAT-authenticated
        // follower needs the PAT App ID on the OTP call or Deriv rejects it, so
        // the risk engine's balance read fails closed. OAuth reads need no header.
        const followerId = user.id.startsWith('copy_follower_') ? user.id.slice('copy_follower_'.length) : null;
        const follower = followerId
          ? store.listAllCopyTradingFollowers().find((f) => f.id === followerId)
          : undefined;
        const appId = follower?.authMethod === 'pat' ? (cfg.deriv.patAppId ?? undefined) : undefined;
        const read = await balanceService.read(user, accountId, accessToken, { appId });
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
      // A copied trade mirrors an already-accepted master entry, so the
      // one-open-per-symbol rule must not drop it: a fast master can fire two
      // entries on the same symbol before the follower's prior copy settles, and
      // skipping the overlap would lose a trade the customer asked to mirror.
      // Exposure is still bounded by maxOpenContracts and maxAccountExposure.
      const isCopy = signal.reason.startsWith('copy:');
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
          ...(isCopy ? {} : { symbol })
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
  return { gateway, runner, monitor, flags, systemSignals, copyEngine, broker };
}
