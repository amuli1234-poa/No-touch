/**
 * Bot runtime service: start, tick, stop.
 *
 * This is the loop that turns a saved strategy into real Deriv DEMO trades. It
 * is deliberately thin, because the safety guarantees live elsewhere and must
 * not be duplicated here:
 *
 *   - `evaluateStrategy` decides, from ticks alone, whether the strategy's
 *     conditions hold. It is a pure function.
 *   - `createSignal` validates the direction and stamps an expiry, so a signal
 *     cannot be replayed.
 *   - `AutoExecutionRunner.runForBot` creates the intent and calls
 *     `gateway.submit`, which is the single purchase path in the system.
 *
 * What this module owns is the *session*: proving the run may exist at all,
 * proving each tick still may act, and reconciling honestly when it stops.
 *
 * Ticking is driven by the browser. That is a deliberate, disclosed trade-off:
 * closing the tab stops the bot. It also means every tick is an authenticated
 * request that re-proves ownership, so a stolen run id is useless on its own.
 */

import { randomUUID } from 'node:crypto';

import type { Store, UserRecord } from '../store/store.js';
import type { MarketDataService } from '../services/marketData.js';
import type { ExecutionGateway } from '../execution/gateway.js';
import { ExecutionError } from '../execution/gateway.js';
import type { AutoExecutionRunner } from '../execution/autoRunner.js';
import type { ExecutionAuditor } from '../execution/audit.js';
import type { ContractMonitor } from '../execution/contractMonitor.js';
import { createSignal, SignalError } from '../services/signals.js';

import { resolveTradableAccountForUser, AccountAccessError } from '../execution/accountGuard.js';
import { executionPermitted } from '../config/flags.js';
import type { ExecutionFlags } from '../config/flags.js';
import { evaluateStrategy, planStrategy, type StrategyPlan } from './evaluator.js';
import type { BotRunEvent, BotRunRecord, BotRunStatus } from './runTypes.js';
import { emptyCounters } from './runTypes.js';
import { loadBotTree } from './service.js';
import type { ImportedBotRecord } from './types.js';

/** How long a run may go without a tick before it is considered abandoned. */
export const RUN_IDLE_TIMEOUT_MS = 120_000;

/** Maximum entries a single run may open, regardless of what the client asks. */
export const MAX_ENTRIES_CEILING = 20;

/** How long Stop waits for an uncertain submission to resolve. */
export const STOP_RECONCILE_TIMEOUT_MS = 15_000;

export type BotRunErrorCode =
  | 'bot_not_found'
  | 'run_not_found'
  | 'run_not_active'
  | 'run_already_active'
  | 'account_not_authorized'
  | 'account_mode_mismatch'
  | 'real_account_refused'
  | 'account_unavailable'
  | 'deriv_not_authenticated'
  | 'execution_disabled'
  | 'market_data_stale'
  | 'strategy_not_runnable'
  | 'max_entries_reached'
  | 'invalid_request';

export class BotRunError extends Error {
  readonly code: BotRunErrorCode;
  readonly status: number;
  readonly reasons: string[];
  constructor(code: BotRunErrorCode, message: string, status = 400, reasons: string[] = []) {
    super(message);
    this.name = 'BotRunError';
    this.code = code;
    this.status = status;
    this.reasons = reasons;
  }
}

export interface BotRunDeps {
  store: Store;
  market: MarketDataService;
  gateway: ExecutionGateway;
  runner: AutoExecutionRunner;
  monitor: ContractMonitor;
  auditor: ExecutionAuditor;
  flags: ExecutionFlags;
  now?: () => number;
}

/** Everything the caller asserts about a start; nothing here is trusted. */
export interface StartRunInput {
  accountId: string;
  /** Optional client assertion; must agree with the stored account. */
  accountMode?: string;
  maxEntries?: number;
}

const MAX_EVENTS = 60;

function pushEvent(run: BotRunRecord, event: BotRunEvent): void {
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
}

/**
 * Validates that a bot may run on this account right now.
 *
 * Every check here is a refusal, never a correction: the account is never
 * substituted, the mode is never switched, and a demo account is never assumed
 * from a label.
 */
function verifyRunPreconditions(
  deps: BotRunDeps,
  user: UserRecord,
  bot: ImportedBotRecord,
  accountId: string,
  assertedMode: string | undefined,
  accessToken: string | null
): { accountId: string; currency: string } {
  const { flags } = deps;

  // Execution must be permitted for DEMO. Checked first so a disabled build
  // never even resolves an account.
  const permitted = executionPermitted(flags, 'demo');
  if (!permitted.permitted) {
    throw new BotRunError(
      'execution_disabled',
      'Demo execution is disabled on this server.',
      403,
      [permitted.reason ?? 'demo_execution_disabled']
    );
  }

  // The account must belong to the user, and its stored mode is authoritative.
  let account;
  try {
    account = resolveTradableAccountForUser(user, accountId, assertedMode as 'demo' | 'real' | undefined);
  } catch (err) {
    if (err instanceof AccountAccessError) {
      const code: BotRunErrorCode =
        err.code === 'account_mode_mismatch'
          ? 'account_mode_mismatch'
          : err.code === 'account_unavailable'
            ? 'account_unavailable'
            : 'account_not_authorized';
      throw new BotRunError(code, err.message, 403);
    }
    throw err;
  }

  // Demo only. A real account is refused outright — not silently downgraded and
  // not "run in simulation".
  if (account.mode !== 'demo') {
    throw new BotRunError(
      'real_account_refused',
      'Bots run on a Deriv demo account only. This account is a real account.',
      403
    );
  }

  // A live Deriv authorisation is required. Without it the gateway would refuse
  // the purchase anyway, but failing here gives the customer a clear reason
  // instead of a run that starts and then cannot trade.
  if (!accessToken) {
    throw new BotRunError(
      'deriv_not_authenticated',
      'Your Deriv session has expired. Reconnect your Deriv account to run a bot.',
      401
    );
  }

  // The saved strategy must exist and be interpretable.
  if (bot.status === 'archived') {
    throw new BotRunError('strategy_not_runnable', 'This bot is archived.', 409);
  }

  return { accountId: account.accountId, currency: account.currency ?? 'USD' };
}

/** Resolves the plan for a bot, or throws a refusal that names the reason. */
export function planForBot(bot: ImportedBotRecord): StrategyPlan {
  const { tree } = loadBotTree(bot);
  const planned = planStrategy(tree);
  if (!planned.ok || !planned.plan) {
    throw new BotRunError(
      'strategy_not_runnable',
      'This strategy cannot run in this build.',
      422,
      planned.reasons
    );
  }
  return planned.plan;
}

/**
 * Starts a run.
 *
 * Returns the record in `running`. The strategy is snapshotted here (symbol,
 * timeframe, conditions, revision), so a mid-run edit cannot change the
 * strategy underneath a live run — the customer must stop and start again.
 */
export async function startBotRun(
  deps: BotRunDeps,
  user: UserRecord,
  botId: string,
  input: StartRunInput,
  accessToken: string | null
): Promise<BotRunRecord> {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());

  const bot = store.getImportedBot(user.id, botId);
  if (!bot) throw new BotRunError('bot_not_found', 'Bot not found.', 404);

  // At most one active run per bot. A second start is refused rather than
  // queued, so two loops can never trade the same strategy concurrently.
  //
  // An abandoned run — the tab was closed, so ticks stopped arriving — is
  // settled first, otherwise a customer could never restart a bot whose browser
  // went away. Settling goes through `stopBotRun`, so an uncertain submission is
  // reconciled rather than assumed.
  const existing = store.findActiveBotRun(user.id, botId);
  if (existing) {
    const idleSince = now() - (existing.lastTickAt ?? existing.startedAt);
    if (idleSince > RUN_IDLE_TIMEOUT_MS) {
      await stopBotRun(deps, user, existing.runId, accessToken, 'abandoned: no ticks received');
    } else {
      throw new BotRunError(
        'run_already_active',
        'This bot is already running. Stop it before starting again.',
        409
      );
    }
  }

  const { accountId } = verifyRunPreconditions(
    deps,
    user,
    bot,
    input.accountId,
    input.accountMode,
    accessToken
  );

  const plan = planForBot(bot);

  // Market data must be fresh before the run begins. A run that starts against
  // a stale price would evaluate its first tick on data the customer never saw.
  const snapshot = await deps.market.freshSnapshot(plan.symbol);
  if (!snapshot) {
    throw new BotRunError(
      'market_data_stale',
      `No fresh price for ${plan.symbol}. Market data is not available yet.`,
      422
    );
  }

  const requested = Number(input.maxEntries);
  const maxEntries =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_ENTRIES_CEILING)
      : MAX_ENTRIES_CEILING;

  const startedAt = now();
  const run: BotRunRecord = {
    runId: `run_${randomUUID()}`,
    botId: bot.id,
    userId: user.id,
    accountId,
    accountMode: 'demo',
    runtimeStatus: 'running',
    startedAt,
    stoppedAt: null,
    lastEvaluationAt: null,
    lastExecutionId: null,
    lastContractId: null,
    error: null,
    counters: emptyCounters(),
    events: [],
    maxEntries,
    strategyRevision: bot.revision ?? 0,
    symbol: plan.symbol,
    timeframe: plan.timeframe,
    lastTickKey: null,
    lastTickAt: startedAt
  };

  pushEvent(run, {
    at: startedAt,
    kind: 'start',
    detail: `Run started on ${accountId} for ${plan.symbol} (${plan.contractType}).`
  });

  await store.putBotRun(run);
  await deps.auditor.record({
    userId: user.id,
    action: 'bot.run.start',
    outcome: 'allowed',
    accountId,
    detail: {
      runId: run.runId,
      botId: bot.id,
      symbol: plan.symbol,
      contractType: plan.contractType,
      revision: run.strategyRevision,
      maxEntries
    }
  });

  return run;
}

export interface TickResult {
  run: BotRunRecord;
  verdict: 'entry' | 'no_entry' | 'insufficient' | 'ineligible' | 'skipped' | 'stopped';
  reason: string | null;
  contractId: number | null;
}

/**
 * Performs one evaluation tick.
 *
 * The caller has already re-authenticated and re-proved ownership. This function
 * re-checks the run itself, because a tick can arrive after a stop and must not
 * act on a run that is no longer active.
 */
export async function tickBotRun(
  deps: BotRunDeps,
  user: UserRecord,
  runId: string,
  accessToken: string | null,
  tickKey?: string
): Promise<TickResult> {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());

  const run = store.getBotRun(user.id, runId);
  if (!run) throw new BotRunError('run_not_found', 'Run not found.', 404);

  // A tick for a stopped run is a no-op, not an error: the browser may have a
  // request in flight when the customer presses Stop.
  if (run.runtimeStatus !== 'running') {
    return { run, verdict: 'stopped', reason: `run is ${run.runtimeStatus}`, contractId: null };
  }

  // Duplicate-request protection: a retried tick with the same key does nothing.
  if (tickKey && run.lastTickKey === tickKey) {
    return { run, verdict: 'skipped', reason: 'duplicate tick', contractId: null };
  }

  const bot = store.getImportedBot(user.id, run.botId);
  if (!bot) {
    return failRun(deps, run, 'The bot was deleted while it was running.', now());
  }

  // Re-resolve the plan from the *saved* strategy each tick, but refuse to act
  // if the revision changed: a live run must not silently adopt an edit.
  let plan: StrategyPlan;
  try {
    plan = planForBot(bot);
  } catch (err) {
    const reasons = err instanceof BotRunError ? err.reasons.join(' ') : 'The strategy became unreadable.';
    return failRun(deps, run, reasons, now());
  }
  if ((bot.revision ?? 0) !== run.strategyRevision) {
    return failRun(
      deps,
      run,
      'The strategy was edited during the run. Stop and start the bot to run the new version.',
      now()
    );
  }

  // Kill switches can be turned off mid-run; re-check each tick so a flag flip
  // takes effect immediately rather than at the next restart.
  const permitted = executionPermitted(deps.flags, 'demo');
  if (!permitted.permitted) {
    return failRun(deps, run, 'Demo execution was disabled while the run was active.', now());
  }

  if (run.counters.entries >= run.maxEntries) {
    const stopped = await stopBotRun(deps, user, runId, accessToken, 'max entries reached');
    return { run: stopped, verdict: 'stopped', reason: 'max entries reached', contractId: null };
  }

  // Fresh market data, or skip this tick. A stale price never becomes a signal.
  const snapshot = await deps.market.freshSnapshot(plan.symbol);
  if (!snapshot) {
    run.counters.ticks += 1;
    run.counters.skipped += 1;
    run.lastEvaluationAt = now();
    run.lastTickKey = tickKey ?? null;
    run.lastTickAt = now();
    pushEvent(run, { at: now(), kind: 'skip', detail: `No fresh price for ${plan.symbol}.` });
    await store.putBotRun(run);
    return { run, verdict: 'insufficient', reason: 'no fresh price', contractId: null };
  }

  const ticks = deps.market.getTicks(plan.symbol);
  const verdict = evaluateStrategy({ plan, ticks });

  run.counters.ticks += 1;
  run.lastEvaluationAt = now();
  run.lastTickKey = tickKey ?? null;
  run.lastTickAt = now();

  if (verdict.kind === 'insufficient') {
    run.counters.skipped += 1;
    pushEvent(run, { at: now(), kind: 'skip', detail: verdict.reason });
    await store.putBotRun(run);
    return { run, verdict: 'insufficient', reason: verdict.reason, contractId: null };
  }

  if (verdict.kind === 'no_entry' || verdict.kind === 'ineligible') {
    pushEvent(run, { at: now(), kind: 'no_entry', detail: verdict.reason });
    await store.putBotRun(run);
    return { run, verdict: verdict.kind, reason: verdict.reason, contractId: null };
  }

  // The strategy's conditions hold. Record a validated, expiring signal.
  run.counters.signals += 1;
  let signal;
  try {
    signal = await createSignal(store, deps.market, {
      userId: user.id,
      accountId: run.accountId,
      accountMode: 'demo',
      symbol: plan.symbol,
      timeframe: plan.timeframe,
      direction: verdict.direction,
      contractFamily: plan.contractFamily,
      contractType: plan.contractType,
      analysisId: `bot:${run.botId}:${run.strategyRevision}`,
      reason: `bot ${bot.name}`
    });
  } catch (err) {
    if (err instanceof SignalError) {
      run.counters.skipped += 1;
      pushEvent(run, { at: now(), kind: 'skip', detail: `Signal rejected: ${err.code}.` });
      await store.putBotRun(run);
      return { run, verdict: 'insufficient', reason: err.code, contractId: null };
    }
    throw err;
  }

  pushEvent(run, {
    at: now(),
    kind: 'signal',
    detail: `${verdict.direction} signal recorded.`,
    signalId: signal.id
  });

  // Sizing comes from the strategy, falling back to conservative defaults only
  // where the strategy is silent. The gateway's risk engine still judges it.
  const account = user.accounts.find((a) => a.accountId === run.accountId);
  const currency = plan.currency ?? account?.currency ?? 'USD';
  const stake = plan.stake ?? 1;
  const digit =
    verdict.kind === 'entry' && typeof verdict.digit === 'number'
      ? verdict.digit
      : plan.digit;

  const auto = await deps.runner.runForBot({
    user,
    signal,
    accessToken,
    sizing: {
      stake,
      basis: 'stake',
      currency,
      parameters: {
        duration: plan.duration ?? 5,
        durationUnit: (plan.durationUnit as 's' | 'm' | 'h' | 'd' | 't' | null) ?? 'm',
        multiplier: null,
        cancellation: null,
        stopLoss: null,
        takeProfit: null,
        digit,
        barrier: plan.barrier,
        growthRate: null
      }
    },
    idempotencyKey: `bot:${run.runId}:${signal.id}`
  });

  if (auto.outcome === 'executed' && auto.result) {
    run.counters.entries += 1;
    run.lastExecutionId = auto.result.intent.id;
    run.lastContractId = auto.result.contractId;
    pushEvent(run, {
      at: now(),
      kind: 'entry',
      detail: `Contract ${auto.result.contractId} opened.`,
      signalId: signal.id,
      intentId: auto.result.intent.id,
      contractId: auto.result.contractId ?? undefined
    });
    await store.putBotRun(run);
    await deps.auditor.record({
      userId: user.id,
      action: 'bot.run.entry',
      outcome: 'allowed',
      accountId: run.accountId,
      intentId: auto.result.intent.id,
      detail: { runId: run.runId, botId: run.botId, contractId: auto.result.contractId }
    });
    return {
      run,
      verdict: 'entry',
      reason: null,
      contractId: auto.result.contractId
    };
  }

  // Refused by a control, not by the strategy. Recorded so the customer can see
  // that the bot tried and why nothing was bought.
  run.counters.rejected += 1;
  pushEvent(run, {
    at: now(),
    kind: 'rejected',
    detail: `Entry refused: ${auto.reason ?? auto.outcome}.`,
    signalId: signal.id
  });
  await store.putBotRun(run);
  return { run, verdict: 'no_entry', reason: auto.reason ?? auto.outcome, contractId: null };
}

/** Moves a run to `failed` with a reason, and audits it. */
async function failRun(
  deps: BotRunDeps,
  run: BotRunRecord,
  reason: string,
  now: number
): Promise<TickResult> {
  run.runtimeStatus = 'failed';
  run.error = reason;
  run.stoppedAt = now;
  pushEvent(run, { at: now, kind: 'error', detail: reason });
  await deps.store.putBotRun(run);
  await deps.auditor.record({
    userId: run.userId,
    action: 'bot.run.failed',
    outcome: 'error',
    accountId: run.accountId,
    detail: { runId: run.runId, botId: run.botId, reason }
  });
  return { run, verdict: 'stopped', reason, contractId: null };
}

/**
 * Stops a run.
 *
 * Order matters. The status moves to `stopping` and is persisted *before* any
 * reconciliation begins, so a concurrent tick already sees a non-running run and
 * cannot open a new entry. Then any submission whose outcome is uncertain is
 * reconciled by asking Deriv what actually exists — never by retrying the buy.
 * Once reconciliation settles, the run finishes `stopped`; if it cannot be
 * settled within the bound, it finishes `failed` so the contract is not
 * forgotten.
 */
export async function stopBotRun(
  deps: BotRunDeps,
  user: UserRecord,
  runId: string,
  accessToken: string | null,
  reason = 'stopped by customer'
): Promise<BotRunRecord> {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());

  const run = store.getBotRun(user.id, runId);
  if (!run) throw new BotRunError('run_not_found', 'Run not found.', 404);

  if (run.runtimeStatus === 'stopped' || run.runtimeStatus === 'failed') return run;

  // 1. Block new entries immediately, before any await.
  run.runtimeStatus = 'stopping';
  pushEvent(run, { at: now(), kind: 'stopping', detail: `Stopping: ${reason}.` });
  await store.putBotRun(run);

  // 2. Reconcile an uncertain submission, if one exists. The intent may have
  //    reached Deriv without us receiving its confirmation.
  const uncertain = findUncertainIntent(store, user.id, run);
  if (uncertain) {
    if (!accessToken) {
      // Without a token we cannot ask Deriv. Leaving the run `stopping` forever
      // would be a lie, so it is marked failed with the intent named.
      run.runtimeStatus = 'failed';
      run.error = 'An unconfirmed submission could not be reconciled: the Deriv session expired.';
      run.stoppedAt = now();
      pushEvent(run, { at: now(), kind: 'error', detail: run.error });
      await store.putBotRun(run);
      return run;
    }
    try {
      const reconciled = await withTimeout(
        deps.monitor.reconcile(user, uncertain, accessToken),
        STOP_RECONCILE_TIMEOUT_MS
      );
      if (reconciled?.contractId) {
        run.lastContractId = reconciled.contractId;
        run.counters.entries += 1;
        pushEvent(run, {
          at: now(),
          kind: 'entry',
          detail: `Reconciled contract ${reconciled.contractId}.`,
          intentId: reconciled.id,
          contractId: reconciled.contractId
        });
      } else if (reconciled?.state === 'FAILED') {
        pushEvent(run, {
          at: now(),
          kind: 'no_entry',
          detail: 'The unconfirmed submission did not reach Deriv.',
          intentId: reconciled.id
        });
      }
    } catch {
      run.runtimeStatus = 'failed';
      run.error = 'An unconfirmed submission could not be reconciled before the timeout.';
      run.stoppedAt = now();
      pushEvent(run, { at: now(), kind: 'error', detail: run.error });
      await store.putBotRun(run);
      await deps.auditor.record({
        userId: user.id,
        action: 'bot.run.stop',
        outcome: 'error',
        accountId: run.accountId,
        detail: { runId, reason: 'reconcile_timeout', intentId: uncertain }
      });
      return run;
    }
  }

  // 3. Settle.
  run.runtimeStatus = 'stopped';
  run.stoppedAt = now();
  pushEvent(run, { at: now(), kind: 'stopped', detail: `Stopped: ${reason}.` });
  await store.putBotRun(run);
  await deps.auditor.record({
    userId: user.id,
    action: 'bot.run.stop',
    outcome: 'allowed',
    accountId: run.accountId,
    detail: {
      runId,
      botId: run.botId,
      reason,
      entries: run.counters.entries,
      contracts: run.counters.signals
    }
  });
  return run;
}

/** The most recent intent of this run whose purchase outcome is unresolved. */
function findUncertainIntent(store: Store, userId: string, run: BotRunRecord): string | null {
  if (!run.lastExecutionId) return null;
  const intent = store.getTradeIntent(userId, run.lastExecutionId);
  if (!intent) return null;
  return intent.state === 'UNKNOWN' || intent.state === 'RECONCILIATION_REQUIRED'
    ? intent.id
    : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reconcile_timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** The run view returned to the client. Never includes a token. */
export function toRunView(run: BotRunRecord): BotRunRecord {
  return run;
}

export { ExecutionError };
