/**
 * Bot runtime model.
 *
 * This is deliberately separate from `ImportedBotRecord.status`. A bot's import
 * lifecycle (`imported` | `paused` | `archived`) describes the *document*: where
 * it came from and whether the customer has filed it away. A run describes the
 * *session* in which that document was evaluated against live market data.
 *
 * Keeping them apart is what allows a bot to be stopped and started again
 * without ever weakening the import lifecycle rules, and it means a run can
 * never be used to smuggle a status transition past `setBotStatus`.
 *
 * Nothing here is authority to trade. A run records intent and outcome; every
 * purchase still passes through `ExecutionGateway.submit`, which owns the kill
 * switches, ownership, risk and idempotency checks.
 */

/** Runtime state of one evaluation session. */
export type BotRunStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'failed';

/** A JSON-serialisable value, the only shape a persisted variable may take. */
export type JsonValue = number | string | boolean | null | JsonValue[];

/** A single evaluated condition, kept for the run log and the UI. */
export interface BotRunEvent {
  at: number;
  /** Machine-readable kind, e.g. `tick`, `signal`, `entry`, `skip`, `error`. */
  kind: string;
  /** Short human sentence; never contains a token or a full account id. */
  detail: string;
  signalId?: string;
  intentId?: string;
  contractId?: number;
}

/** Counters the UI shows, so a run's work is visible without reading the log. */
export interface BotRunCounters {
  /** Evaluation ticks performed. */
  ticks: number;
  /** Ticks where the strategy's conditions were satisfied. */
  signals: number;
  /** Entries submitted through the gateway. */
  entries: number;
  /** Entries the gateway refused (risk, flags, duplicate). */
  rejected: number;
  /** Ticks skipped because market data was stale or absent. */
  skipped: number;
}

/**
 * A `timeout` block's deferred work, waiting on the run's clock.
 *
 * The stack is held as XML rather than as a live tree because the run record is
 * persisted between ticks; re-parsing it on resume is what keeps the deferral
 * valid across a store round-trip.
 */
export interface PendingDeferral {
  /** When the delay elapses, as an epoch millisecond timestamp. */
  dueAt: number;
  /**
   * Which lifecycle phase paused.
   *
   * A `timeout` in `before_purchase` pauses the entry decision; one in
   * `after_purchase` pauses the decision to trade again. They resume into
   * different places, so the phase has to be persisted with the work.
   */
  phase: 'entry' | 'after_purchase';
  /** The `TIMEOUTSTACK` body, serialised as a standalone XML fragment. */
  stackXml: string | null;
  /** The rest of the statement chain, to run after the stack. */
  continuationXml: string | null;
}

export interface BotRunRecord {
  runId: string;
  botId: string;
  userId: string;
  accountId: string;
  /** Always `demo`: a run refuses a real account outright. */
  accountMode: 'demo';
  runtimeStatus: BotRunStatus;
  startedAt: number;
  stoppedAt: number | null;
  lastEvaluationAt: number | null;
  /** The most recent contract opened by this run, when one exists. */
  lastExecutionId: string | null;
  lastContractId: number | null;
  /**
   * The contract whose `after_purchase` stack has already run.
   *
   * DBot runs `after_purchase` once per settled contract, not once per tick. The
   * tick loop is the only clock this build has, so the run remembers which
   * settlement it has already reacted to and does not repeat it.
   */
  afterPurchaseFor: number | null;
  /**
   * The contract Deriv has refused to let this run sell, and why.
   *
   * `InvalidOfferings` means the contract is too close to expiry to be offered.
   * That is a property of the contract's remaining life, not a transient fault,
   * so the run stops asking for that contract instead of re-submitting the same
   * rejected sale on every tick. Cleared whenever a different contract becomes
   * the held one.
   */
  sellRefusedFor: number | null;
  sellRefusedReason: string | null;
  /** Set when the run failed; cleared on a fresh start. */
  error: string | null;
  counters: BotRunCounters;
  /** Bounded event log, newest last. */
  events: BotRunEvent[];
  /**
   * Highest number of entries this run may open. Enforced per tick so a fast
   * tick loop cannot outrun the customer's intent.
   */
  maxEntries: number;
  /** The revision of `workingXml` the run was started against. */
  strategyRevision: number;
  /** Symbol/timeframe resolved from the saved strategy at start. */
  symbol: string;
  timeframe: string;
  /**
   * Idempotency key of the most recent tick. A repeated tick with the same key
   * is a no-op, so a retried HTTP request cannot double-submit.
   */
  lastTickKey: string | null;
  /** Timestamp of the last tick accepted, used to expire an abandoned run. */
  lastTickAt: number | null;
  /**
   * Interpreter variables for this run, keyed by Blockly variable id (or name
   * when the export omits ids).
   *
   * This lives on the run, not in a module global, so two bots — or two runs of
   * one bot — can never read each other's variables. It is plain JSON so the
   * run survives a store round-trip.
   */
  variables: Record<string, JsonValue>;
  /**
   * Work a `timeout` block deferred, waiting for its delay to elapse.
   *
   * DBot pauses the strategy at a `timeout` and resumes inside the block once
   * `sleep(n)` returns. The tick loop is this build's only clock, so the run
   * records what to resume and when, and refuses to evaluate anything else
   * until the deferral has run. Null when nothing is waiting.
   *
   * Held on the run for the same isolation reason as `variables`: one run's
   * pending work must never be visible to another.
   */
  pendingDeferral: PendingDeferral | null;
}

/** Fields a client may see. Identical to the record today, but explicit. */
export type BotRunView = BotRunRecord;

export const BOT_RUN_ACTIVE: readonly BotRunStatus[] = ['running', 'stopping'];

export function isRunActive(run: BotRunRecord): boolean {
  return BOT_RUN_ACTIVE.includes(run.runtimeStatus);
}

export function emptyCounters(): BotRunCounters {
  return { ticks: 0, signals: 0, entries: 0, rejected: 0, skipped: 0 };
}
