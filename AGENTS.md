# AGENTS.md

## Project

Deriv No Touch Scanner V4.0 PRO — a Vite + React 19 + TypeScript fintech
trading scanner for Deriv synthetic indices. It streams live quotes over the
Deriv WebSocket API, qualifies setups with a 7-step sequence, and recommends
adaptive No Touch barriers.

## Commands

Package manager is **bun** (project has `bun.lock`).

```bash
bun install                       # install deps
bun run dev                       # dev server on :3000 (vite --port=3000 --host=0.0.0.0)
bun run build                     # production build
npx tsc --noEmit                  # typecheck
npx tsx src/tests/strategy_engine.test.ts   # engine test suite (18 tests)
```

There is no unit-test framework; the engine suite is a plain `tsx` script with
its own assertion helper. Run it directly, do not expect `bun test` to pick it up.

### Running the public preview

The workspace proxy maps the public host to port **12000**, not 3000, and Vite
needs `server.allowedHosts` to include `.prod-runtime.all-hands.dev` or it
returns 403 for the proxied Host header (already set in `vite.config.ts`).

`bun` is not always present in a fresh sandbox. When it is missing, start Vite
with node directly:

```bash
node node_modules/vite/bin/vite.js --port=12000 --host=0.0.0.0
```

Run it detached (`setsid nohup ... & disown`) so it survives the command
returning, and log to a file (e.g. `/tmp/vite-live.log`).

## Architecture

- `src/engines/*` — pure analytical engines (MarketStructureEngine,
  CandlestickEngine, FvgEngine, MarketShiftEngine, TradeableRangeEngine,
  AdaptiveBarrierEngine, DualExpiryEngine, OpportunityScoringEngine,
  SupportResistanceEngine, PathTouchProbability). No React, no I/O.
- `src/services/DerivWebSocketManager.ts` — feed, symbol discovery, and
  multi-timeframe candle construction. **Mutates candle arrays in place**:
  `candles: Map<symbol, Map<timeframe, Candle[]>>`. Consumers must copy the
  array (`list.slice()`) and force re-derivation; a bare `useMemo` keyed only
  on symbol/timeframe will never update.
- `src/services/IndexedDbStorage.ts` — persistence plus `computeAnalytics()`
  for calibration stats.
- `src/services/PathSettlementTracker.ts` — tick-by-tick settlement tracking of
  registered contracts.
- `src/App.tsx` — orchestrator. Owns scanner state, the `scanMarket` pipeline,
  the auto-scan interval, and route selection.
- `src/components/shell/*` — AppShell, Sidebar, Topbar, MobileNav, navigation.
- `src/components/pages/*` — one page per route (Scanner, Analysis, Performance,
  Settings, Overview).
- `src/components/ui/*` — design-system primitives and `format.ts` helpers.
- `src/types/scanner.ts` — domain types; `src/types/preferences.ts` — display
  preferences.

## Conventions

- Design tokens live in `src/index.css` (`--app-bg`, `--surface`, `--accent`,
  `--border`, …). Reuse them; do not hardcode new palette values in components.
- Tailwind v4 utility classes with arbitrary values are used heavily, e.g.
  `bg-[#101829]`. `TONE_HEX` in `src/components/ui/format.ts` maps semantic
  tones to hex for inline `style` usage (charts, bars).
- All engine/scanner logic must stay in `src/engines` and `src/services`;
  components are presentation only.
- Every settings/display control must drive real behaviour — no decorative
  controls.
