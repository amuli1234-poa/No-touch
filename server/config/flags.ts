/**
 * Execution kill switches.
 *
 * Three independent server-side flags gate every purchase. They are read from
 * the environment only — never from a request body, a cookie or a header — so
 * no frontend setting can enable trading. All three default to `false`.
 *
 * The release ladder is deliberately staged:
 *   ALLOW_EXECUTION=false        master switch; nothing trades while false
 *   ALLOW_DEMO_EXECUTION=false   DEMO trading, enabled only after demo gates pass
 *   ALLOW_REAL_EXECUTION=false   REAL money; stays false until a separate,
 *                                explicit release approval
 *
 * This module intentionally offers no setter. A flag can only change by
 * restarting the process with a different environment, which keeps the switch
 * out of reach of any runtime code path.
 */

export interface ExecutionFlags {
  /** Master switch. While false, no execution of any kind is permitted. */
  allowExecution: boolean;
  /** Permits DEMO execution once the master switch and demo gates allow it. */
  allowDemoExecution: boolean;
  /**
   * Permits REAL execution. Remains false until a deliberate release review
   * changes it — see `loadExecutionFlags`.
   */
  allowRealExecution: boolean;
  /**
   * Permits AUTOMATIC trading — the scanner placing trades on its own. Defaults
   * to false, so a fresh install only ever trades by hand. This is deliberately
   * separate from the execution switches: turning manual trading on must never
   * silently turn automatic trading on as well.
   */
  allowAutomaticTrading: boolean;
}

/**
 * Parses a boolean env var strictly: only the exact lowercase string "true"
 * enables it. A kill switch must not be turned on by a typo, a stray value, or
 * a differently-cased variant, so anything else — including "TRUE" or "1" —
 * stays off.
 */
function flag(value: string | undefined): boolean {
  return value === 'true';
}

export function loadExecutionFlags(env: NodeJS.ProcessEnv = process.env): ExecutionFlags {
  const allowExecution = flag(env.ALLOW_EXECUTION);
  const allowDemoExecution = flag(env.ALLOW_DEMO_EXECUTION);

  // REAL execution requires BOTH the dedicated flag and the master switch.
  // Even with ALLOW_REAL_EXECUTION=true it cannot run while the master switch is
  // off, and the flag is not documented as settable in this release.
  const allowRealExecution = flag(env.ALLOW_REAL_EXECUTION) && allowExecution;

  // Automatic trading is opt-in and independent: it needs its own flag AND the
  // master switch, so enabling manual execution never enables the scanner.
  const allowAutomaticTrading = flag(env.ALLOW_AUTOMATIC_TRADING) && allowExecution;

  return { allowExecution, allowDemoExecution, allowRealExecution, allowAutomaticTrading };
}

/**
 * Resolves whether a given account mode may execute, given the flags. Returns a
 * reason when it may not, so callers never have to guess.
 */
export function executionPermitted(
  flags: ExecutionFlags,
  mode: 'demo' | 'real'
): { permitted: boolean; reason: string | null } {
  if (!flags.allowExecution) {
    return { permitted: false, reason: 'global_execution_disabled' };
  }
  if (mode === 'demo') {
    return flags.allowDemoExecution
      ? { permitted: true, reason: null }
      : { permitted: false, reason: 'demo_execution_disabled' };
  }
  return flags.allowRealExecution
    ? { permitted: true, reason: null }
    : { permitted: false, reason: 'real_execution_disabled' };
}
