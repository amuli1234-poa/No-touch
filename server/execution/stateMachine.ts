import { INTENT_STATES, TERMINAL_INTENT_STATES, type IntentState } from './types.js';

/**
 * Trade-intent state machine.
 *
 * A trade intent moves through an explicit, durable set of states. Illegal
 * transitions are rejected rather than silently applied, so a bug cannot drive
 * an intent into an impossible state (for example, re-opening a settled trade).
 *
 * The two recovery states matter most:
 *  - `UNKNOWN` is entered when a submission may have reached Deriv but no
 *    confirmation came back. It is never a dead end: it must move to
 *    `RECONCILIATION_REQUIRED` so the outcome is resolved against Deriv, never
 *    blindly retried.
 *  - `RECONCILIATION_REQUIRED` is the same idea made explicit — the system knows
 *    it does not know, and must check.
 */

export class IllegalTransitionError extends Error {
  readonly from: IntentState;
  readonly to: IntentState;
  constructor(from: IntentState, to: IntentState) {
    super(`Illegal intent transition ${from} -> ${to}.`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** The allowed transitions. Anything absent is illegal. */
export const ALLOWED_TRANSITIONS: Record<IntentState, readonly IntentState[]> = {
  CREATED: ['VALIDATING', 'REJECTED', 'FAILED'],
  VALIDATING: ['RISK_APPROVED', 'REJECTED', 'FAILED'],
  RISK_APPROVED: ['PROPOSAL_REQUESTED', 'REJECTED', 'FAILED'],
  PROPOSAL_REQUESTED: ['PROPOSAL_VALIDATED', 'REJECTED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'],
  PROPOSAL_VALIDATED: ['PURCHASE_PENDING', 'REJECTED', 'FAILED'],
  PURCHASE_PENDING: ['OPEN', 'FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'],
  OPEN: ['CLOSE_PENDING', 'SETTLED', 'RECONCILIATION_REQUIRED'],
  CLOSE_PENDING: ['OPEN', 'SETTLED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'],
  // A purchase we could not confirm: resolve against Deriv, never retry blindly.
  UNKNOWN: ['RECONCILIATION_REQUIRED', 'OPEN', 'FAILED'],
  RECONCILIATION_REQUIRED: ['OPEN', 'SETTLED', 'FAILED', 'REJECTED'],
  SETTLED: [],
  REJECTED: [],
  FAILED: []
};

export function isTerminal(state: IntentState): boolean {
  return TERMINAL_INTENT_STATES.includes(state);
}

export function canTransition(from: IntentState, to: IntentState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Asserts a transition is legal, throwing IllegalTransitionError otherwise. */
export function assertTransition(from: IntentState, to: IntentState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Validates a state string is a known intent state. */
export function isIntentState(value: unknown): value is IntentState {
  return typeof value === 'string' && (INTENT_STATES as readonly string[]).includes(value);
}
