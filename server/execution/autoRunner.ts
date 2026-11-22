import type { Store, UserRecord } from '../store/store.js';
import type { SignalRecord } from './types.js';
import type { ExecutionGateway, ExecutionResult } from './gateway.js';
import { ExecutionError } from './gateway.js';
import type { ExecutionPreferencesRecord } from './types.js';
import { resolveContractType } from '../services/signals.js';
import type { ExecutionAuditor } from './audit.js';

/**
 * Automatic DEMO execution.
 *
 * A customer in `automatic` mode has pre-delegated the *decision to submit* a
 * validated signal — nothing more. Every server-side control still applies: the
 * kill switches, ownership, the risk engine and signal single-use all run inside
 * the gateway exactly as for a manual trade. This runner adds only the loop that
 * turns a fresh signal into an intent and submits it.
 *
 * Three safety properties are enforced here and nowhere else:
 *
 *  - Only `automatic` users run. A manual user's signal is never auto-submitted.
 *  - Single-flight per account. A second signal for an account with an execution
 *    in progress is skipped, not queued, so signals cannot pile into trades.
 *  - Auto-stop. When the risk engine reports a terminal limit breach (daily loss
 *    or consecutive losses), automatic execution is switched OFF for that user
 *    and stays off until they turn it back on. It never resumes by itself.
 *
 * REAL accounts never run automatically: the gateway requires the explicit REAL
 * authorisation and the global flag, and this runner refuses REAL outright so an
 * automatic loop can never touch a real balance in this build.
 */

export type AutoRunOutcome =
  | 'executed'
  | 'skipped_manual_mode'
  | 'skipped_stopped'
  | 'skipped_in_flight'
  | 'skipped_real'
  | 'skipped_disabled'
  | 'rejected';

export interface AutoRunResult {
  outcome: AutoRunOutcome;
  result: ExecutionResult | null;
  reason: string | null;
}

/** Risk reasons that mean "stop automatic execution entirely". */
const TERMINAL_RISK_REASONS = new Set(['daily_loss', 'consecutive_losses', 'auto_stopped']);

export interface AutoRunnerDeps {
  store: Store;
  gateway: ExecutionGateway;
  auditor: ExecutionAuditor;
  now?: () => number;
}

/**
 * Sizing and identity for a bot-driven execution.
 *
 * The stake and parameters come from the strategy the customer saved, not from
 * their global scanner preferences, so a bot trades what its own blocks say.
 */
export interface BotRunExecutionInput {
  user: UserRecord;
  signal: SignalRecord;
  accessToken: string | null;
  sizing: {
    stake: number;
    basis: 'stake' | 'payout';
    currency: string;
    parameters: ExecutionPreferencesRecord['parameters'];
  };
  /** Stable per (run, signal) so a retried tick cannot double-submit. */
  idempotencyKey: string;
}

export class AutoExecutionRunner {
  private readonly store: Store;
  private readonly gateway: ExecutionGateway;
  private readonly auditor: ExecutionAuditor;
  private readonly now: () => number;
  /** Accounts with an execution currently in flight. */
  private readonly inFlight = new Set<string>();

  constructor(deps: AutoRunnerDeps) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.auditor = deps.auditor;
    this.now = deps.now ?? (() => Date.now());
  }

  isInFlight(accountId: string): boolean {
    return this.inFlight.has(accountId);
  }

  /**
   * Executes one signal on behalf of a running bot.
   *
   * A bot run is the customer's explicit instruction to trade this strategy, so
   * the `automatic` preference gate that governs the scanner does not apply —
   * but nothing else is relaxed. The same in-flight guard, the same DEMO-only
   * rule, the same terminal-risk auto-stop and, above all, the same
   * `createIntent` → `submit` tail are used. `submit` remains the only purchase
   * path in the system, so a bot cannot buy anything a hand-placed trade could
   * not.
   */
  async runForBot(input: BotRunExecutionInput): Promise<AutoRunResult> {
    const { user, signal, accessToken } = input;

    const prefs = this.store.getExecutionPreferences(user.id);
    if (prefs?.autoStopped) {
      return this.record(user, signal, 'skipped_stopped', 'auto stop is engaged');
    }

    const account = user.accounts.find((a) => a.accountId === signal.accountId);
    if (!account) {
      return this.record(user, signal, 'rejected', 'account not authorized');
    }
    if (account.type !== 'demo') {
      return this.record(user, signal, 'skipped_real', 'bot execution is DEMO only');
    }

    if (this.inFlight.has(signal.accountId)) {
      return this.record(user, signal, 'skipped_in_flight', 'an execution is already in progress');
    }

    this.inFlight.add(signal.accountId);
    try {
      return await this.submitSignal(user, signal, accessToken, {
        ...input.sizing,
        idempotencyKey: input.idempotencyKey
      });
    } finally {
      this.inFlight.delete(signal.accountId);
    }
  }

  /**
   * Attempts to execute one signal automatically. Never throws for a normal
   * skip or rejection — it returns an outcome, so a caller loop is not derailed
   * by a single refused signal.
   */
  async runForUser(user: UserRecord, signal: SignalRecord, accessToken: string | null): Promise<AutoRunResult> {
    const prefs = this.store.getExecutionPreferences(user.id);

    if (!prefs) {
      return this.record(user, signal, 'skipped_manual_mode', 'no preferences');
    }
    if (prefs.mode !== 'automatic') {
      return this.record(user, signal, 'skipped_manual_mode', 'manual mode');
    }
    if (prefs.autoStopped) {
      return this.record(user, signal, 'skipped_stopped', 'auto stop is engaged');
    }

    // Resolve the account from the user's own records via the same guard the
    // gateway uses; a REAL account is refused for automatic execution.
    const account = user.accounts.find((a) => a.accountId === signal.accountId);
    if (!account) {
      return this.record(user, signal, 'rejected', 'account not authorized');
    }
    if (account.type !== 'demo') {
      return this.record(user, signal, 'skipped_real', 'automatic execution is DEMO only');
    }

    if (this.inFlight.has(signal.accountId)) {
      return this.record(user, signal, 'skipped_in_flight', 'an execution is already in progress');
    }

    this.inFlight.add(signal.accountId);
    try {
      return await this.submitSignal(user, signal, accessToken, {
        stake: prefs.stake.amount,
        basis: prefs.stake.basis,
        currency: prefs.stake.currency ?? account.currency ?? 'USD',
        parameters: prefs.parameters,
        // Automatic execution carries no manual approval window; the customer's
        // standing preference is the approval, and the signal's own expiry caps it.
        idempotencyKey: `auto:${signal.id}`
      });
    } finally {
      this.inFlight.delete(signal.accountId);
    }
  }

  /**
   * The shared submission tail: intent, then the one purchase path.
   *
   * Both the scanner loop and a bot run funnel through here, so neither can
   * diverge from the other's safety behaviour. `gateway.submit` still applies the
   * kill switches, ownership, risk and idempotency checks.
   */
  private async submitSignal(
    user: UserRecord,
    signal: SignalRecord,
    accessToken: string | null,
    sizing: BotRunExecutionInput['sizing'] & { idempotencyKey: string }
  ): Promise<AutoRunResult> {
    try {
      const intent = await this.gateway.createIntent({
        user,
        accountId: signal.accountId,
        signal,
        contractType: resolveContractType(signal),
        contractFamily: signal.contractFamily,
        stake: sizing.stake,
        basis: sizing.basis,
        currency: sizing.currency,
        parameters: sizing.parameters,
        idempotencyKey: sizing.idempotencyKey
      });

      const result = await this.gateway.submit(user, intent.id, accessToken);
      await this.auditor.record({
        userId: user.id,
        action: 'execution.auto',
        outcome: 'allowed',
        accountId: signal.accountId,
        intentId: intent.id,
        detail: { signalId: signal.id, contractId: result.contractId }
      });
      return { outcome: 'executed', result, reason: null };
    } catch (err) {
      if (err instanceof ExecutionError) {
        // A terminal risk breach stops automatic execution for good.
        if (err.code === 'risk_rejected' && err.reasons.some((r) => TERMINAL_RISK_REASONS.has(r))) {
          await this.engageAutoStop(user.id, err.reasons);
        }
        return this.record(user, signal, err.code === 'execution_disabled' ? 'skipped_disabled' : 'rejected', err.code);
      }
      throw err;
    }
  }

  /** Switches automatic execution off for a user and audits why. */
  async engageAutoStop(userId: string, reasons: string[]): Promise<void> {
    const prefs = this.store.getExecutionPreferences(userId);
    if (!prefs || prefs.autoStopped) return;
    const updated: ExecutionPreferencesRecord = { ...prefs, autoStopped: true, updatedAt: this.now() };
    await this.store.putExecutionPreferences(updated);
    await this.auditor.record({
      userId,
      action: 'execution.autostop',
      outcome: 'denied',
      detail: { reasons }
    });
  }

  private async record(
    user: UserRecord,
    signal: SignalRecord,
    outcome: AutoRunOutcome,
    reason: string
  ): Promise<AutoRunResult> {
    await this.auditor.record({
      userId: user.id,
      action: 'execution.auto',
      outcome: outcome === 'executed' ? 'allowed' : 'denied',
      accountId: signal.accountId,
      detail: { signalId: signal.id, outcome, reason }
    });
    return { outcome, result: null, reason };
  }
}
