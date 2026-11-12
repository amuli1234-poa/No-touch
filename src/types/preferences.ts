import { Timeframe } from './scanner';

/* Persisted operator preferences. Every field is consumed by the UI — no
   decorative controls. Stored alongside scanner settings in localStorage. */

export interface DisplayPreferences {
  /** Scanner table row density. */
  density: 'comfortable' | 'compact';
  /** Show the live in-flight path monitor strip on the scanner page. */
  showPathMonitor: boolean;
  /** Timeframe the chart workspace opens on. */
  defaultTimeframe: Timeframe;
}

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  density: 'comfortable',
  showPathMonitor: true,
  defaultTimeframe: '2m'
};
