import type { Store } from '../store/store.js';
import type { ServerConfig } from '../config.js';
import type { ExecutionFlags } from '../config/flags.js';
import { executionPermitted } from '../config/flags.js';
import { open } from '../lib/crypto.js';
import { redact } from '../execution/audit.js';
import { isHeld, isTradable } from './engine.js';
import type { CopyTradingFollowerRecord } from './types.js';

/**
 * Copy Trading operational readiness.
 *
 * This module answers one question for the console: given what is actually
 * persisted right now, would the copy engine fan a new DEMO master trade out to
 * anyone? It is a **projection** — it reads, and never writes. In particular it
 * will not create a missing `copyTradingControl` and will not flip one on. A
 * missing control is reported as "disabled" because that is exactly how the
 * engine treats it (`getCopyTradingControl` returns null, `enabled` is falsy,
 * `mirrorMasterTrade` returns an empty array).
 *
 * Eligibility is not re-invented here. `isHeld` and `isTradable` are the engine's
 * own predicates, imported so a change to what the engine skips shows up in the
 * indicator instead of silently diverging from it.
 *
 * `state: 'READY'` means the prerequisites are satisfied. It is not a promise
 * that a future trade executes: the three execution kill switches, the risk
 * engine, account ownership and the broker itself all still apply downstream.
 * The payload carries `guarantee: false` so a caller cannot render READY as
 * "trading is live".
 */

export type CopyReadinessState =
  | 'NO_FOLLOWERS'
  | 'AWAITING_AUTHORIZATION'
  | 'PAUSED'
  | 'READY'
  | 'DEGRADED'
  | 'UNKNOWN';

export type ReadinessCheckKey = 'connection' | 'authorization' | 'broker' | 'reconciliation' | 'switches';

/**
 * Which half of the picture a check belongs to.
 *
 * `follower` covers the client roster: can their credential be read, are they
 * still authorized, do they have a usable DEMO account. `execution` covers the
 * master's own trading substrate: unresolved broker outcomes and intents still
 * awaiting reconciliation. Keeping the two apart lets the console say *why*
 * copying is degraded, instead of lumping a client's expired token together with
 * a stuck purchase in one undifferentiated list.
 */
export type ReadinessScope = 'follower' | 'execution';

export interface CopyReadinessCheck {
  key: ReadinessCheckKey;
  scope: ReadinessScope;
  status: 'ok' | 'fail' | 'unknown';
  detail: string;
}

/**
 * What the follower roster looks like, independent of the switch.
 *
 * The overall `state` deliberately collapses some of these — "nobody invited" and
 * "every client paused" both leave copying with nothing to do — but they call for
 * different operator action, so the roster is reported separately and exactly.
 */
export type RosterStatus =
  | 'UNKNOWN'
  | 'EMPTY'
  | 'AWAITING_AUTHORIZATION'
  | 'ALL_HELD'
  | 'NONE_ELIGIBLE'
  | 'HAS_ELIGIBLE';

/** Why the overall state is DEGRADED, split by the half that failed. */
export interface CopyReadinessDegraded {
  /** Distinct scopes with at least one failing check. Empty when nothing failed. */
  by: ReadinessScope[];
  /** Failing follower-scoped check keys. */
  follower: ReadinessCheckKey[];
  /** Failing execution-scoped check keys. */
  execution: ReadinessCheckKey[];
  /** One line naming the source, rendered by the console. */
  summary: string;
}

export interface CopyReadinessLastCopy {
  at: number;
  followerId: string | null;
  /** Masked; the full account id is never sent to the console. */
  accountId: string | null;
  contractId: number | null;
}

export interface CopyReadinessLastFailure {
  at: number;
  followerId: string | null;
  accountId: string | null;
  reason: string | null;
  /** Already redacted by the audit layer; re-redacted here so it stays true. */
  detail: Record<string, unknown>;
}

export interface CopyReadiness {
  generatedAt: number;
  ownerUserId: string;
  master: { userId: string; loginId: string | null } | null;
  state: CopyReadinessState;
  /** Operator-facing explanation, rendered verbatim. */
  explanation: string;
  /** Literal false: READY is a prerequisite check, never an execution promise. */
  guarantee: false;
  /**
   * Roster shape with the switch factored out. Distinct from `state`, which also
   * weighs the control and overall health.
   */
  roster: RosterStatus;
  /**
   * Which half failed when `state` is DEGRADED. Null in every other state, so a
   * consumer cannot read a stale reason from a previous evaluation.
   */
  degraded: CopyReadinessDegraded | null;
  counts: {
    followers: number;
    eligible: number;
    held: number;
    disconnected: number;
    pendingInvitations: number;
    eligibleDerivAccounts: number;
  };
  control: {
    exists: boolean;
    enabled: boolean;
    updatedAt: number | null;
    updatedByEmail: string | null;
    stoppedReason: string | null;
  };
  health: CopyReadinessCheck[];
  lastCopy: CopyReadinessLastCopy | null;
  lastFailure: CopyReadinessLastFailure | null;
}

export interface ReadinessDeps {
  store: Store;
  cfg: ServerConfig;
  /**
   * The server-side execution kill switches. When supplied, readiness reports a
   * `switches` execution check so it can never say READY while the gateway would
   * reject every copy (e.g. DEMO execution disabled). When absent (older callers,
   * tests) the check is omitted rather than guessed, so the projection is never
   * wrong about a switch it cannot see.
   */
  flags?: ExecutionFlags;
  now?: () => number;
}

/** Mirrors `maskAccountId` in the admin routes: keep a hint, never the id. */
function maskAccountId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.length <= 4) return '••••';
  return `${id.slice(0, 2)}${'•'.repeat(Math.max(0, id.length - 4))}${id.slice(-2)}`;
}

interface FollowerDiagnosis {
  held: boolean;
  tokenExpired: boolean;
  tokenUnopenable: boolean;
  missingConsent: boolean;
  tradableDemoAccounts: number;
  /** Would the engine actually copy for this follower right now? */
  eligible: boolean;
}

/**
 * Diagnoses one follower using the same rules `mirrorForFollower` applies.
 *
 * The sealed token is opened only to test that it *can* be opened — the plaintext
 * is discarded immediately and never returned, logged or compared.
 */
function diagnose(
  deps: ReadinessDeps,
  follower: CopyTradingFollowerRecord,
  now: number
): FollowerDiagnosis {
  const held = isHeld(follower);
  const tokenExpired = follower.tokenExpiresAt > 0 && follower.tokenExpiresAt <= now;
  const missingConsent = deps.store.getCopyTradingConsent(follower.id) === null;
  const tradableDemoAccounts = follower.accounts.filter((a) => a.type === 'demo' && isTradable(a)).length;

  // `open` returns null rather than throwing, so a null here is the only
  // "cannot decrypt" signal. The plaintext is discarded immediately.
  //
  // Deliberately not gated on `held` or `tokenExpired`: an unreadable credential
  // is a real fault whether or not an admin also holds the client, and gating it
  // would let the `connection` check report "readable" about a credential that is
  // provably not — and would hide a rotated session secret behind an admin hold.
  const tokenUnopenable = open(follower.tokenSealed, deps.cfg.session.secret) === null;

  const eligible =
    !held && !tokenExpired && !tokenUnopenable && !missingConsent && tradableDemoAccounts > 0;

  return { held, tokenExpired, tokenUnopenable, missingConsent, tradableDemoAccounts, eligible };
}

function pendingInvitations(deps: ReadinessDeps, ownerUserId: string, now: number): number {
  return deps.store
    .listAllCopyTradingInvitations()
    .filter(
      (invitation) =>
        invitation.ownerUserId === ownerUserId &&
        invitation.consumedAt === null &&
        !invitation.revokedAt &&
        invitation.expiresAt > now
    ).length;
}

/**
 * The principals whose intents can belong to this master's copy activity.
 *
 * The master's own principal is included on purpose: a stuck manual trade means
 * the broker/reconciliation subsystem is unhealthy, which is relevant to copy
 * readiness too. Erring toward DEGRADED is the safe direction — this must never
 * under-report a problem into a false READY.
 */
function principalsFor(ownerUserId: string, followers: CopyTradingFollowerRecord[]): string[] {
  return [ownerUserId, ...followers.map((f) => `copy_follower_${f.id}`)];
}

interface AuditFacts {
  lastCopy: CopyReadinessLastCopy | null;
  lastFailure: CopyReadinessLastFailure | null;
  brokerUnknownIntents: number;
  reconciliationIntents: number;
}

/**
 * Derives "last successful copy", "last failure" and stuck-intent counts from
 * the execution audit and the intent ledger. Both are append-only evidence of
 * what really happened, so nothing here is inferred or invented.
 */
function auditFacts(
  deps: ReadinessDeps,
  ownerUserId: string,
  followers: CopyTradingFollowerRecord[]
): AuditFacts {
  const followerIds = new Set(followers.map((f) => f.id));
  const principals = principalsFor(ownerUserId, followers);

  let brokerUnknownIntents = 0;
  let reconciliationIntents = 0;
  for (const principal of principals) {
    for (const intent of deps.store.listTradeIntents(principal)) {
      if (intent.state === 'UNKNOWN') brokerUnknownIntents += 1;
      else if (intent.state === 'RECONCILIATION_REQUIRED') reconciliationIntents += 1;
    }
  }

  let lastCopy: CopyReadinessLastCopy | null = null;
  let lastFailure: CopyReadinessLastFailure | null = null;

  for (const entry of deps.store.listExecutionAudit()) {
    if (entry.action !== 'execution.copy') continue;

    const detail = (entry.detail ?? {}) as Record<string, unknown>;
    const detailFollowerId = typeof detail.followerId === 'string' ? detail.followerId : null;
    const detailMasterId = typeof detail.masterUserId === 'string' ? detail.masterUserId : null;

    // A failure entry does not carry `masterUserId`, so attribute through the
    // follower it names. Success entries carry both; either is sufficient.
    const owned =
      detailMasterId === ownerUserId ||
      (detailFollowerId !== null && followerIds.has(detailFollowerId));
    if (!owned) continue;

    if (entry.outcome === 'allowed') {
      if (!lastCopy || entry.timestamp > lastCopy.at) {
        lastCopy = {
          at: entry.timestamp,
          followerId: detailFollowerId,
          accountId: maskAccountId(entry.accountId),
          contractId: typeof detail.contractId === 'number' ? detail.contractId : null
        };
      }
    } else if (!lastFailure || entry.timestamp > lastFailure.at) {
      lastFailure = {
        at: entry.timestamp,
        followerId: detailFollowerId,
        accountId: maskAccountId(entry.accountId),
        reason: typeof detail.reason === 'string' ? detail.reason : null,
        detail: (redact(detail) as Record<string, unknown>) ?? {}
      };
    }
  }

  return { lastCopy, lastFailure, brokerUnknownIntents, reconciliationIntents };
}

const NOT_EVALUATED = 'Not evaluated: readiness could not be read.';

function unknownReadiness(ownerUserId: string, reason: string, now: number): CopyReadiness {
  return {
    generatedAt: now,
    ownerUserId,
    master: null,
    state: 'UNKNOWN',
    explanation: `Readiness could not be determined reliably (${reason.replace(/_/g, ' ')}). Treat copying as not ready until this clears.`,
    guarantee: false,
    roster: 'UNKNOWN',
    degraded: null,
    counts: {
      followers: 0,
      eligible: 0,
      held: 0,
      disconnected: 0,
      pendingInvitations: 0,
      eligibleDerivAccounts: 0
    },
    control: { exists: false, enabled: false, updatedAt: null, updatedByEmail: null, stoppedReason: null },
    health: [
      { key: 'connection', scope: 'follower', status: 'unknown', detail: NOT_EVALUATED },
      { key: 'authorization', scope: 'follower', status: 'unknown', detail: NOT_EVALUATED },
      { key: 'broker', scope: 'execution', status: 'unknown', detail: NOT_EVALUATED },
      { key: 'reconciliation', scope: 'execution', status: 'unknown', detail: NOT_EVALUATED }
    ],
    lastCopy: null,
    lastFailure: null
  };
}

function compute(deps: ReadinessDeps, ownerUserId: string): CopyReadiness {
  const now = (deps.now ?? (() => Date.now()))();
  const master = deps.store.getUserById(ownerUserId);

  // A follower pointing at a user that no longer exists means the ledger and the
  // user table disagree. That is not something this projection should paper over.
  if (!master) return unknownReadiness(ownerUserId, 'master_record_missing', now);

  const followers = deps.store
    .listAllCopyTradingFollowers()
    .filter((f) => f.ownerUserId === ownerUserId);

  const diagnoses = followers.map((follower) => ({ follower, diagnosis: diagnose(deps, follower, now) }));

  const eligible = diagnoses.filter((d) => d.diagnosis.eligible);
  const held = diagnoses.filter((d) => d.diagnosis.held);
  // "Disconnected" is a fault, not an administrative hold: the credential or the
  // account is unusable, so the engine would skip this follower for a reason
  // nobody chose.
  const disconnected = diagnoses.filter(
    (d) =>
      !d.diagnosis.eligible &&
      !d.diagnosis.held &&
      (d.diagnosis.tokenExpired || d.diagnosis.tokenUnopenable || d.diagnosis.missingConsent || d.diagnosis.tradableDemoAccounts === 0)
  );

  const eligibleDerivAccounts = eligible.reduce((sum, d) => sum + d.diagnosis.tradableDemoAccounts, 0);

  const controlRecord = deps.store.getCopyTradingControl(ownerUserId);
  const control = {
    exists: controlRecord !== null,
    // Missing control is disabled. This is the engine's own reading of the
    // store, not a default this module invents.
    enabled: Boolean(controlRecord?.enabled),
    updatedAt: controlRecord?.updatedAt ?? null,
    updatedByEmail: controlRecord?.updatedByEmail ?? null,
    stoppedReason: controlRecord?.stoppedReason ?? null
  };

  const invitations = pendingInvitations(deps, ownerUserId, now);
  const facts = auditFacts(deps, ownerUserId, followers);

  const expiredAuthorizations = diagnoses.filter((d) => d.diagnosis.tokenExpired).length;
  const unopenable = diagnoses.filter((d) => d.diagnosis.tokenUnopenable).length;
  const missingConsent = diagnoses.filter((d) => d.diagnosis.missingConsent).length;
  const noDemoAccount = diagnoses.filter((d) => d.diagnosis.tradableDemoAccounts === 0).length;

  const health: CopyReadinessCheck[] = [
    followers.length === 0
      ? { key: 'connection', scope: 'follower', status: 'unknown', detail: 'No connected client to check.' }
      : unopenable > 0
        ? {
            key: 'connection',
            scope: 'follower',
            status: 'fail',
            detail: `${unopenable} client credential(s) could not be opened with the current session secret.`
          }
        : {
            key: 'connection',
            scope: 'follower',
            status: 'ok',
            detail: `${followers.length} client credential(s) readable.`
          },
    followers.length === 0
      ? { key: 'authorization', scope: 'follower', status: 'unknown', detail: 'No connected client to check.' }
      : expiredAuthorizations > 0 || missingConsent > 0 || noDemoAccount > 0
        ? {
            key: 'authorization',
            scope: 'follower',
            status: 'fail',
            detail: [
              expiredAuthorizations > 0 ? `${expiredAuthorizations} expired authorization(s)` : null,
              missingConsent > 0 ? `${missingConsent} missing consent record(s)` : null,
              noDemoAccount > 0 ? `${noDemoAccount} with no tradable DEMO account` : null
            ]
              .filter(Boolean)
              .join(', ')
          }
        : {
            key: 'authorization',
            scope: 'follower',
            status: 'ok',
            detail: 'Every connected client is authorized for a DEMO account.'
          },
    facts.brokerUnknownIntents > 0
      ? {
          key: 'broker',
          scope: 'execution',
          status: 'fail',
          detail: `${facts.brokerUnknownIntents} purchase outcome(s) unknown; the broker result was never confirmed.`
        }
      : {
          key: 'broker',
          scope: 'execution',
          status: 'ok',
          detail: 'No purchase in the ledger has an unknown broker outcome.'
        },
    facts.reconciliationIntents > 0
      ? {
          key: 'reconciliation',
          scope: 'execution',
          status: 'fail',
          detail: `${facts.reconciliationIntents} intent(s) require reconciliation.`
        }
      : {
          key: 'reconciliation',
          scope: 'execution',
          status: 'ok',
          detail: 'No intent in the ledger is awaiting reconciliation.'
        }
  ];

  // Execution kill switches. A copy is a DEMO trade, so it needs the master
  // switch AND the DEMO switch; without them the gateway rejects every copy and
  // a READY projection would be a lie. Only evaluated when the caller supplies
  // the flags — an absent flag set is reported as unknown, never as "ok", and
  // (being neither 'fail' nor counted) never degrades the state on its own.
  if (deps.flags) {
    const demo = executionPermitted(deps.flags, 'demo');
    health.push(
      demo.permitted
        ? {
            key: 'switches',
            scope: 'execution',
            status: 'ok',
            detail: 'Execution and DEMO switches are on, so the gateway will accept a copy.'
          }
        : {
            key: 'switches',
            scope: 'execution',
            status: 'fail',
            detail: `The gateway will reject every copy: ${(demo.reason ?? 'execution_disabled').replace(/_/g, ' ')}. Enable the execution kill switches to allow copying.`
          }
    );
  }

  const failing = health.filter((check) => check.status === 'fail');
  const failingFollower = failing.filter((c) => c.scope === 'follower').map((c) => c.key);
  const failingExecution = failing.filter((c) => c.scope === 'execution').map((c) => c.key);

  /*
   * Roster shape, with the switch factored out entirely. States that all leave
   * copying with nothing to do are kept distinct here because they need
   * different operator action: invite somebody, release a hold, fix a
   * credential, or wait for a client to finish authorizing.
   *
   * AWAITING_AUTHORIZATION is reserved for the case where nobody has connected
   * yet and an invitation is outstanding. It deliberately does not apply once
   * records exist: a connected-but-unusable client is a credential problem, not
   * a wait, and reporting it as "awaiting" would hide the record that is already
   * there. The invitation is still counted in `counts.pendingInvitations`, so
   * nothing is lost by describing the roster as it actually is.
   */
  let roster: RosterStatus;
  if (followers.length === 0) roster = invitations > 0 ? 'AWAITING_AUTHORIZATION' : 'EMPTY';
  else if (eligible.length > 0) roster = 'HAS_ELIGIBLE';
  else if (held.length === followers.length) roster = 'ALL_HELD';
  else roster = 'NONE_ELIGIBLE';

  /*
   * Precedence, highest first:
   *   UNKNOWN                — nothing can be asserted
   *   DEGRADED               — a fault the operator must see; a pause or an empty
   *                            roster must not hide a broken credential or a
   *                            stuck purchase
   *   AWAITING_AUTHORIZATION — invitations out, nobody connected yet
   *   NO_FOLLOWERS           — nothing to copy to (no records, all held, or none
   *                            eligible); `roster` says which
   *   PAUSED                 — eligible clients, switch off or absent
   *   READY                  — eligible clients, switch on
   * The switch state is always reported in `control`, so ranking DEGRADED above
   * PAUSED loses no information.
   *
   * Unresolved master purchase outcomes and reconciliation failures are
   * `execution`-scoped checks, and they participate in `failing` like any other,
   * so they can never produce READY.
   */
  let state: CopyReadinessState;
  let explanation: string;
  let degraded: CopyReadinessDegraded | null = null;

  if (failing.length > 0) {
    state = 'DEGRADED';
    const by: ReadinessScope[] = [];
    if (failingFollower.length > 0) by.push('follower');
    if (failingExecution.length > 0) by.push('execution');
    const parts: string[] = [];
    if (failingFollower.length > 0) parts.push(`client health (${failingFollower.join(', ')})`);
    if (failingExecution.length > 0) parts.push(`master execution health (${failingExecution.join(', ')})`);
    const summary = `${parts.join(' and ')} failing.`;
    degraded = { by, follower: failingFollower, execution: failingExecution, summary };
    explanation = `${summary} Copying may fail or be skipped until this is resolved.`;
  } else if (roster === 'AWAITING_AUTHORIZATION') {
    // Keyed off `roster` so the two can never disagree about whether anyone has
    // connected: AWAITING_AUTHORIZATION means zero records plus an invitation.
    state = 'AWAITING_AUTHORIZATION';
    explanation = `${invitations} invitation(s) are outstanding and no client has finished authorizing yet. Copying stays off until one connects.`;
  } else if (eligible.length === 0) {
    state = 'NO_FOLLOWERS';
    explanation =
      roster === 'EMPTY'
        ? 'No client is connected to this master. Copying has nothing to copy to.'
        : roster === 'ALL_HELD'
          ? `All ${followers.length} connected client(s) are paused or suspended. Copying has nothing to copy to until a hold is released.`
          : `${followers.length} client(s) are connected but none is currently eligible. Check their authorization and DEMO accounts.`;
  } else if (!control.enabled) {
    state = 'PAUSED';
    explanation = control.exists
      ? `${eligible.length} client(s) are eligible, but copying is stopped. Press Start to mirror future DEMO trades.`
      : `${eligible.length} client(s) are eligible, but copying has never been started for this master. A missing switch is treated as stopped.`;
  } else {
    state = 'READY';
    explanation = `${eligible.length} eligible client(s) across ${eligibleDerivAccounts} DEMO account(s) and the switch is on. Prerequisites are satisfied; a future trade is not guaranteed to execute — the kill switches, risk engine and broker still apply.`;
  }

  return {
    generatedAt: now,
    ownerUserId,
    master: { userId: master.id, loginId: master.loginId ?? null },
    state,
    explanation,
    guarantee: false,
    roster,
    degraded,
    counts: {
      followers: followers.length,
      eligible: eligible.length,
      held: held.length,
      disconnected: disconnected.length,
      pendingInvitations: invitations,
      eligibleDerivAccounts
    },
    control,
    health,
    lastCopy: facts.lastCopy,
    lastFailure: facts.lastFailure
  };
}

/**
 * Builds the readiness projection for one master. Never throws: an unreadable
 * store is reported as UNKNOWN rather than guessed at.
 */
export function buildCopyReadiness(deps: ReadinessDeps, ownerUserId: string): CopyReadiness {
  try {
    return compute(deps, ownerUserId);
  } catch {
    return unknownReadiness(ownerUserId, 'readiness_read_failed', (deps.now ?? (() => Date.now()))());
  }
}

/** Every master that has a follower or a persisted control, for the list view. */
export function listReadinessOwners(store: Store): string[] {
  const ids = new Set<string>([
    ...store.listAllCopyTradingFollowers().map((f) => f.ownerUserId),
    ...store.listUsers().map((u) => u.id).filter((id) => store.getCopyTradingControl(id) !== null)
  ]);
  return [...ids];
}
