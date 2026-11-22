import type { BotCompatibilityState } from '../../lib/bots';

/**
 * Copy for the live availability check.
 *
 * Keyed by `CompatibilityState` from `server/bots/compatibility.ts`, which is a
 * different vocabulary from the import-time `CompatibilityLevel`
 * (`full`/`partial`). Conflating the two made a compatible symbol fall through
 * to a bare "Checked", so they are kept apart deliberately and the map is typed
 * to require every state.
 *
 * Kept free of React so `compatibilityCopy.test.ts` can assert full coverage
 * under the plain test runner.
 */
export const STATE_COPY: Record<
  BotCompatibilityState,
  { label: string; tone: string; ok: boolean }
> = {
  compatible: { label: 'Runs on this symbol', tone: 'text-emerald-400', ok: true },
  incompatible: { label: 'Not compatible with this symbol', tone: 'text-amber-400', ok: false },
  unsupported: { label: 'This build cannot trade it', tone: 'text-orange-400', ok: false },
  unavailable: { label: 'Deriv does not offer it right now', tone: 'text-amber-400', ok: false },
  invalid: { label: 'Strategy cannot run', tone: 'text-rose-400', ok: false }
};
