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

### Running locally with Deriv OAuth

The registered callback is `http://localhost:3000/auth/deriv/callback`, so the
**Vite dev server must listen on port 3000** — the browser redirects there, and
Vite proxies `/auth/*` to the backend on `:8787`. Two processes must both be up,
or the callback returns `ERR_CONNECTION_REFUSED` (nothing on :3000) or the
token exchange fails (nothing on :8787):

```bash
npm run dev:all        # starts backend :8787 + Vite :3000 together
```

`npm run dev` alone only starts Vite on :3000; start the backend separately with
`npm run server` (or `npm start`). If the callback port is changed, update the
Redirect URI in the Deriv dashboard **and** `DERIV_REDIRECT_URI` to match
character-for-character.

## Architecture

WickSentinel is a **multi-timeframe price-action signal engine** (H4 → H1 →
M15 → M5 → M1). The original No Touch barrier product was replaced wholesale;
no barrier / path-touch logic remains in the app.

- `src/engines/*` — pure analytical engines, no React and no I/O:
  `MarketStructureEngine`, `MarketShiftEngine`, `CandlestickEngine`, `FvgEngine`,
  `SupportResistanceEngine`, `TrendlineAndRangeEngine`, `ChartPatternEngine`,
  `TechnicalIndicatorsEngine`, `MultiStrategyEngine`, `AdaptiveFillEngine`,
  and `OpportunityScoringEngine` (the top-down orchestrator that produces the
  56-field `OpportunitySignal`).
- `src/services/DerivWebSocketManager.ts` — feed, symbol discovery, and
  multi-timeframe candle construction. **Mutates candle arrays in place**:
  `candles: Map<symbol, Map<timeframe, Candle[]>>`. Consumers must copy the
  array (`[...list]`) and force re-derivation; a bare `useMemo` keyed only on
  symbol/timeframe will never update (App bumps a `candleRevision` counter).
- `src/services/IndexedDbStorage.ts` — persistence (DB `WickSentinel_DB`) plus
  `computeHistoryAnalytics()` for signal-outcome stats.
- `src/services/WhatsAppService.ts` — client for `/api/whatsapp/*`; formats the
  alert payload and evaluates dispatch events (NEW_SIGNAL / MATERIAL_UPDATE /
  INVALIDATED). Secrets stay server-side.
- `src/App.tsx` — orchestrator. Owns scanner state, the `scanMarket` pipeline,
  the auto-scan interval, signal resolution on live ticks, and route selection.
- `src/components/shell/*` — AppShell, Sidebar, Topbar, MobileNav, navigation.
  `navigation.ts` is the single source of truth for the 10 routes.
- `src/components/views/*` — one view per route (BestMarket, StrategyScanner,
  MtfPrecisionEntry, LiveMarketScannerTable reused for Plain/1s, DerivAdvancedChart,
  OpportunityCard, Signals, PerformanceDashboard, Settings).
- `src/components/landing/*` — public marketing site (unchanged by the scanner
  work; still carries legacy "No Touch barrier" copy in the hero preview).
- `src/components/ui/*` — design-system primitives and `format.ts` helpers.
- `src/types/scanner.ts` — domain types (single source of truth).

## Scanner pipeline

`OpportunityScoringEngine.analyzeTopDown({ symbolInfo, c4h, c1h, c15m, c5m, c1m,
minScoreThreshold, fvgMinDisplacement })` returns an `OpportunitySignal` or null.
Confluence is weighted 20/20/20/15/15/10 (market structure, valid range & POI,
price-action trigger, momentum, MTF alignment, technical confirmation). The
minimum score floor is hard-clamped to 75%. A setup can score ≥75% and still
report `WAIT` when a mandatory gate fails.

## WhatsApp alerts (server-side)

`server/routes/whatsapp.ts` mounts on the existing Express app (no separate
server):

- `GET /api/whatsapp/status` — public, masked (provider, masked recipient,
  missing field names only; never a secret).
- `POST /api/whatsapp/send` — requires a session; body `{ message, metadata }`.

Providers are chosen from env: `WHATSAPP_PROVIDER` = `meta` | `twilio` |
`callmebot` | `webhook`, plus `WHATSAPP_RECIPIENT` and the provider credentials
(`WHATSAPP_PHONE_NUMBER_ID`/`WHATSAPP_ACCESS_TOKEN`, `TWILIO_*`,
`CALLMEBOT_API_KEY`, or `WHATSAPP_WEBHOOK_URL`/`_SECRET`). Credentials never
reach the browser.

## Authentication (Deriv OAuth 2.0 + PKCE)

WickSentinel authenticates users through **Deriv OAuth 2.0 Authorization Code +
PKCE**. The scanner itself is untouched: authentication is an additive Express
backend (`server/`) that also serves the built SPA from `dist/`.

Endpoints (from `https://auth.deriv.com/.well-known/openid-configuration`):
- Authorization: `https://auth.deriv.com/oauth2/auth` (`prompt=registration`
  makes it the signup form; its absence is login)
- Token: `POST https://auth.deriv.com/oauth2/token` (form-encoded, PKCE S256,
  no client secret for the documented public-client flow)
- Identity: `GET https://auth.deriv.com/userinfo` (OIDC `sub` is the identity)
- Accounts: `GET https://api.derivws.com/trading/v1/options/accounts` (needs the
  `trade` scope; demo vs real via `account_type`)
- Revocation: `https://auth.deriv.com/oauth2/revoke`

Server layout (`server/`):
- `index.ts` — `createApp(cfg, store)` (testable) + auto-start; HTTPS enforcement,
  SPA fallback, `/healthz`.
- `config.ts` — reads `DERIV_APP_ID`, `DERIV_REDIRECT_URI`, `DERIV_CLIENT_SECRET`
  (optional), `DERIV_SCOPES`, `SESSION_SECRET`, `PORT`, `NODE_ENV`.
- `lib/pkce.ts` — CSPRNG verifier/challenge/state, timing-safe compare.
- `lib/deriv.ts` — authorization URL, token exchange, userinfo, accounts, revoke.
- `lib/session.ts` — signed cookie resolution, guards, sliding renewal.
- `lib/crypto.ts` — HMAC-signed cookies + AES-256-GCM sealing of the Deriv token.
- `store/store.ts` — JSON-file store (`data/wicksentinel.json`): users, sessions,
  one-time OAuth transactions. Keyed by a stable id derived from the Deriv `sub`,
  never a display name.
- `routes/auth.ts` — `/auth/start`, `/auth/deriv/callback`, `/auth/logout`,
  `/auth/session`, `/api/preferences`, `/api/deriv/verify`.

Frontend: `src/lib/auth.ts` (client store + actions), `src/components/landing/
AuthPage.tsx` (Sign Up / Login + error page), `src/components/auth/
ProtectedRoute.tsx` (guards `/app`; steps aside on static hosts where no backend
exists, so the GitHub Pages preview keeps working). Routes: `/login`,
`/get-started`, `/signin-error` (`src/Root.tsx`).

Run it: `npm run build` then `npm run server` (needs the `DERIV_*`/`SESSION_SECRET`
env vars; see `.env.example`). In dev, Vite proxies `/auth`, `/api`, `/healthz`
to the backend (`vite.config.ts`). Auth tests: `npm run test:auth` (14 cases).


## Public site (WickSentinel)

The product's public-facing brand is **WickSentinel**. `src/Root.tsx` is the
entry component mounted by `main.tsx` and decides which surface to render from
the pathname:

| Path | Surface |
| --- | --- |
| `/` | `components/landing/LandingPage.tsx` — public homepage (unchanged by scanner work) |
| `/app` (and `/app/*`) | `App.tsx` — the WickSentinel scanner workspace |
| `/login`, `/get-started` | `components/landing/AccessPage.tsx` — Deriv OAuth entry |
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

**Authentication is Deriv OAuth 2.0 (PKCE) with server-side sessions** — see the
section above. The scanner's analytics run entirely client-side (IndexedDB), but
the app is served by `server/index.ts`, which also exposes the WhatsApp dispatch
endpoints. Do not build a fake auth flow. Landing-page copy must only advertise
features that exist in `src/engines` / `src/services`, and preview graphics must
stay labelled as illustrative — never present mock numbers as live market data.

> Legacy note: the landing hero copy still mentions an "adaptive No Touch
> barrier". That product was removed; the copy is a known leftover and the
> landing page is intentionally left untouched.

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

## Theming (dark + light)

The product ships both a dark and a light palette and lets the operator switch
at runtime.

- All colours are semantic CSS variables in `src/index.css`: `:root` holds the
  dark values, `[data-theme='light']` overrides them. Tailwind bridges the
  variables through `@theme inline` (e.g. `--color-fg-1`), so components use
  `bg-surface`, `text-fg-3`, `border-line`, `text-success`, etc. Never hardcode
  a hex or `rgba()` in a component — add or reuse a token instead.
- `src/lib/theme.ts` owns the runtime. The choice is stored in `localStorage`
  (`ws-theme`) and applied to `<html data-theme>`; an inline script in
  `index.html` resolves it before React mounts so there is no flash. Dark is the
  default; a stored choice overrides it. Use the `useTheme()` hook;
  `setTheme`/`toggle` write the attribute.
- `src/components/ui/ThemeToggle.tsx` is the control (`icon` and `switch`
  variants). It is wired into the landing nav, the workspace topbar and the
  sidebar footer.
- Chart colours cannot be CSS classes, so the palette is mirrored as
  `--chart-*` variables and read at runtime via `readChartColors()` in
  `InteractiveLightweightChart.tsx`, which rebuilds the chart when the theme
  changes. `TONE_HEX` in `ui/format.ts` likewise returns `var(...)` strings so
  inline styles and SVG follow the theme.
- The landing hero sits on a dark photograph in both themes. `.ws-hero-band`
  pins the dark token values for that subtree so light-mode text stays legible
  over the image.
- Contrast is verified with a Puppeteer audit over both themes; muted text tiers
  (`fg-5`/`fg-6`) and the semantic tones are tuned to clear 4.5:1 on their
  surfaces in each theme.

## Pushing to GitHub

The dev-container `GITHUB_TOKEN` and the OpenHands git credential helper both
resolve to a GitHub **App** installation token with **read-only** access. It can
read the repo (and reports `push: true` in the API permissions map) but any
write — `git push`, creating a ref via the API — fails with
`403 Resource not accessible by integration`. The App installation is missing
the `contents: write` permission. Do not burn time retrying different
credential forms; the fix is to grant the App write access, or push from a
session that has a user PAT with `repo` scope.
