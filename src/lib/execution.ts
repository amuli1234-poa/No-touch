import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  fetchExecutionPreferences,
  fetchScannerStatus,
  saveExecutionPreferences,
  type ExecutionMode,
  type ScannerStatus
} from './trade';

/**
 * Frontend automatic-trading control.
 *
 * A small shared store so every surface that reflects (or toggles) automatic
 * trading — the header switch and the Trade panel — reads one source of truth.
 * The server remains the only authority: this store only records what the
 * customer asked for and what the server last reported. A preference expresses
 * intent and grants no authority; the gateway re-derives every permission on
 * each purchase.
 */

export interface ExecutionControlState {
  /** Last known server permission to auto-trade at all. Optimistic until told. */
  automaticEnabled: boolean;
  /** The customer's stored intent. */
  mode: ExecutionMode | null;
  /** The full server scanner status (setups, recent passes, watched markets). */
  status: ScannerStatus | null;
  /** True while a toggle is in flight. */
  saving: boolean;
  /** Last toggle error, if any. */
  error: string | null;
  /** Whether the store has heard from the server at least once. */
  loaded: boolean;
}

let state: ExecutionControlState = {
  automaticEnabled: true,
  mode: null,
  status: null,
  saving: false,
  error: null,
  loaded: false
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(next: Partial<ExecutionControlState>): void {
  state = { ...state, ...next };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): ExecutionControlState {
  return state;
}

/** Applies a scanner status to the store, without clobbering an in-flight save. */
function applyStatus(status: ScannerStatus | null): void {
  if (!status) return;
  setState({
    status,
    automaticEnabled: status.automaticEnabled,
    loaded: true
  });
}

/** Refreshes both the stored intent and the server's scanner status. */
export async function refreshExecutionControl(): Promise<void> {
  const [prefs, status] = await Promise.all([
    fetchExecutionPreferences(),
    fetchScannerStatus()
  ]);
  if (prefs) setState({ mode: prefs.preferences.mode });
  applyStatus(status);
}

/** Polls the scanner status while signed in, so the header stays current. */
export function useExecutionControlPolling(active: boolean, intervalMs = 10_000): void {
  useEffect(() => {
    if (!active) {
      resetExecutionControl();
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const status = await fetchScannerStatus();
      if (!cancelled) applyStatus(status);
    };
    void refreshExecutionControl();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, intervalMs]);
}

/**
 * Toggles automatic trading. Turning it on is refused by the server when a kill
 * switch is off; the refusal is surfaced rather than hidden. The returned value
 * is the notice text the caller should show, or null on success.
 */
export async function toggleAutomaticTrading(next: boolean): Promise<{ ok: boolean; message: string | null }> {
  const reason = state.status?.reason ?? null;
  if (!state.automaticEnabled && next) {
    const message =
      reason === 'execution_disabled'
        ? 'Automatic trading is off — the server master switch is off (set ALLOW_EXECUTION=true).'
        : reason === 'demo_execution_disabled'
          ? 'Automatic trading is off — demo execution is off (set ALLOW_DEMO_EXECUTION=true).'
          : 'Automatic trading is switched off on this server.';
    setState({ error: message });
    return { ok: false, message };
  }
  setState({ saving: true, error: null });
  const result = await saveExecutionPreferences({ mode: next ? 'automatic' : 'manual' });
  if (!result.ok) {
    setState({ saving: false, error: result.message });
    return { ok: false, message: result.message };
  }
  setState({ saving: false, mode: result.preferences.mode, error: null });
  return { ok: true, message: null };
}

/** Clears local control state (e.g. on sign-out). */
export function resetExecutionControl(): void {
  state = {
    automaticEnabled: true,
    mode: null,
    status: null,
    saving: false,
    error: null,
    loaded: false
  };
  emit();
}

/** Reactive view of the automatic-trading control state. */
export function useExecutionControl(): ExecutionControlState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Kept for symmetry with the balances store; used by tests. */
export function _setExecutionControlForTest(next: Partial<ExecutionControlState>): void {
  setState(next);
}
