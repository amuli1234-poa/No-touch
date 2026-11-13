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

## Public site (WickSentinel)

The product's public-facing brand is **WickSentinel**; the scanner keeps its
internal "Deriv No Touch" naming. `src/Root.tsx` is the entry component mounted
by `main.tsx` and decides which surface to render from the pathname:

| Path | Surface |
| --- | --- |
| `/` | `components/landing/LandingPage.tsx` — public homepage |
| `/app` (and `/app/*`) | `App.tsx` — the existing scanner workspace, unchanged |
| `/login`, `/get-started` | `components/landing/AccessPage.tsx` — access placeholders |
| `/privacy`, `/terms`, `/risk-disclaimer` | `components/landing/LegalPage.tsx` |
| anything else | `components/landing/NotFoundPage.tsx` |

- `src/lib/router.ts` — dependency-free pathname router (`useRoute`, `navigate`,
  `navigateToSection`). It is **base-aware**: it reads `import.meta.env.BASE_URL`
  so the same build works at `/` in dev and under a project-Pages subpath.
- `src/components/landing/*` — landing sections, `primitives.tsx` (Section,
  Reveal, WsButton, SectionHeading) and `ScannerPreview.tsx`.
- `src/components/brand/WickSentinelBrand.tsx` — `BrandLogo`, `WickSentinelMark`
  and the `BRAND` constants.
- Public-site palette lives in `src/index.css` as `--ws-*` tokens; the scanner
  keeps the original `--surface` / `--accent` tokens. Do not mix the two.

**There is no authentication system and no backend.** The app is fully
client-side (IndexedDB). The `/login` and `/get-started` routes are deliberate
placeholders that hand the visitor to the working scanner; do not build a fake
auth flow. Landing-page copy must only advertise features that exist in
`src/engines` / `src/services`, and preview graphics must stay labelled as
illustrative — never present mock numbers as live market data.

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

## Design language

The UI follows the design language of reatech360.com. Keep to it:

- Base surface is near-black navy `#060b16`; there is one primary blue
  `#0068B5` (hover `#2E8AD8`) and one light-blue accent `#60A5FA`. The
  previous indigo/violet brand (`#635BFF`, `#8057E5`) is retired — do not
  reintroduce it.
- The palette is defined once in `src/index.css` `:root`. Components still
  use Tailwind arbitrary values in places; when you touch them, prefer the
  tokens.
- Cards are `16px` radius with a multi-layer shadow (inset top highlight +
  ambient + deep) and an optional `glass` variant
  (`backdrop-blur-xl backdrop-saturate-150`). Radii scale is 8/10/14/18.
- Typography is Plus Jakarta Sans for headings, Inter for body, JetBrains
  Mono for figures.

## Pushing to GitHub

The dev-container `GITHUB_TOKEN` and the OpenHands git credential helper both
resolve to a GitHub **App** installation token with **read-only** access. It can
read the repo (and reports `push: true` in the API permissions map) but any
write — `git push`, creating a ref via the API — fails with
`403 Resource not accessible by integration`. The App installation is missing
the `contents: write` permission. Do not burn time retrying different
credential forms; the fix is to grant the App write access, or push from a
session that has a user PAT with `repo` scope.
