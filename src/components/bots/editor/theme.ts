/**
 * Blockly theme for the strategy editor.
 *
 * Colours are the workspace tokens from `src/index.css`, hard-coded here
 * because Blockly paints its own surfaces and cannot read CSS custom
 * properties. They are the same values, so the editor sits inside the app
 * rather than looking like an embedded third-party tool.
 *
 * The canvas is always dark: it is a trading surface, and a white workspace
 * would clash with every other panel.
 */

import * as Blockly from 'blockly/core';

/** Workspace palette, mirrored from `src/index.css`. */
export const PALETTE = {
  app: '#080d16',
  surface: '#101827',
  surfaceRaised: '#141e2e',
  surfaceInset: '#0b1220',
  line: '#202c3d',
  lineStrong: '#2c3a4f',
  ink: '#e6edf7',
  muted: '#93a4bd',
  accent: '#2878d0',
  accentStrong: '#3a8fe0',
  accentSoft: '#6fb2ea',
  success: '#25b887',
  warning: '#d9a441',
  danger: '#d64c58',
  teal: '#2dd4bf',
  violet: '#a78bfa'
} as const;

export const strategyTheme = Blockly.Theme.defineTheme('wicksentinel-strategy', {
  name: 'wicksentinel-strategy',
  base: Blockly.Themes.Classic,
  blockStyles: {
    trade_blocks: { colourPrimary: '#2878d0', colourSecondary: '#3a8fe0', colourTertiary: '#1d5fa8' },
    market_blocks: { colourPrimary: '#2c8fb8', colourSecondary: '#3aa3cc', colourTertiary: '#216f92' },
    contract_blocks: { colourPrimary: '#2aa39b', colourSecondary: '#38b8af', colourTertiary: '#1f807a' },
    stake_blocks: { colourPrimary: '#25b887', colourSecondary: '#31cc99', colourTertiary: '#1c9169' },
    entry_blocks: { colourPrimary: '#2f9e6e', colourSecondary: '#3cb37f', colourTertiary: '#257c55' },
    exit_blocks: { colourPrimary: '#d9a441', colourSecondary: '#e6b55c', colourTertiary: '#ac8231' },
    indicator_blocks: { colourPrimary: '#a78bfa', colourSecondary: '#b79dfb', colourTertiary: '#8468d6' },
    logic_blocks: { colourPrimary: '#6d8ee0', colourSecondary: '#82a0e8', colourTertiary: '#5470b8' },
    variable_blocks: { colourPrimary: '#b57fe0', colourSecondary: '#c496e8', colourTertiary: '#9063b8' },
    unknown_blocks: { colourPrimary: '#d64c58', colourSecondary: '#e06570', colourTertiary: '#ac3a45' }
  },
  categoryStyles: {
    trade_category: { colour: '#2878d0' },
    market_category: { colour: '#2c8fb8' },
    contract_category: { colour: '#2aa39b' },
    entry_category: { colour: '#2f9e6e' },
    exit_category: { colour: '#d9a441' },
    indicator_category: { colour: '#a78bfa' },
    logic_category: { colour: '#6d8ee0' },
    variable_category: { colour: '#b57fe0' }
  },
  componentStyles: {
    workspaceBackgroundColour: PALETTE.surfaceInset,
    toolboxBackgroundColour: PALETTE.surface,
    toolboxForegroundColour: PALETTE.ink,
    flyoutBackgroundColour: PALETTE.surfaceRaised,
    flyoutForegroundColour: PALETTE.muted,
    flyoutOpacity: 0.98,
    scrollbarColour: PALETTE.lineStrong,
    scrollbarOpacity: 0.7,
    insertionMarkerColour: PALETTE.accent,
    insertionMarkerOpacity: 0.5,
    markerColour: PALETTE.accent,
    cursorColour: PALETTE.accentSoft,
    selectedGlowColour: PALETTE.accentStrong,
    selectedGlowOpacity: 0.6
  },
  fontStyle: { family: "'Plus Jakarta Sans', Inter, system-ui, sans-serif", weight: '600', size: 12 },
  startHats: true
});
