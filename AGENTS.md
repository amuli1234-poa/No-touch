# AGENTS.md

## Project

Deriv No Touch Scanner V4.0 PRO — a Vite + React 19 + TypeScript fintech
trading scanner for Deriv synthetic indices. It streams live quotes over the
Deriv WebSocket API, qualifies setups with a 7-step sequence, and recommends
adaptive No Touch barriers.

A second, independently deployable application lives in `admin/`: the
**WickSentinel Admin Console**. See `docs/ADMIN_DEPLOYMENT.md`. It is a separate
Vite app (own `index.html`, own source root, builds to `dist-admin/`) that talks
to a separate backend namespace `/api/admin/v1` with its own cookie, session
store and RBAC. It must never share a session with the trader app.

## Commands

Package manager is **bun** (project has `bun.lock`).

```bash
bun install                       # install deps
bun run dev                       # dev server on :3000 (vite --port=3000 --host=0.0.0.0)
bun run build                     # production build
npx tsc --noEmit                  # typecheck
npx tsx src/tests/strategy_engine.test.ts   # engine test suite (18 tests)
```

Admin console (uses npm scripts; `tsx` for the server, `vite` for the app):

```bash
npm run server        # backend on :8787 (serves trader API + /api/admin/v1)
npm run dev:admin     # admin app on :3001, proxies /api/admin to :8787
npm run build:admin   # → dist-admin/
npm run lint:admin    # admin typecheck (tsc -p admin/tsconfig.json)
npm run test:admin    # admin test suite (20 tests)
npm run test:telemetry # telemetry ingest + admin read-path (8 tests)
npm run test:balance   # account balances: isolation, DEMO/REAL, stale (16 tests)
npm run admin:bootstrap   # seed the first Super Admin (prints otpauth URI)
```

`npx tsc --noEmit` only covers the browser app: the root `tsconfig.json`
excludes `server/`. Typecheck the backend with `npm run lint:server`
(`tsc -p server/tsconfig.json`), which is not part of `npm run lint`.

Data store (see `docs/storage-migration.md` for the full procedure):

```bash
npm run test:store    # cross-process lock + foreign-write tests (10 tests)
npm run test:migrate  # JSON -> SQLite migration safety tests (8 tests)
npm run db:migrate    # migrate data/ JSON into SQLite (server must be stopped)
npm run db:migrate -- --verify-only   # check an existing database, read-only
```

`STORAGE_ENGINE` picks the backend: `auto` (default; SQLite when
`wicksentinel.db` exists, else JSON), `json`, or `sqlite`. Tests honour
`TEST_STORAGE_ENGINE` the same way, so the full auth/admin suites can be run
against SQLite with `TEST_STORAGE_ENGINE=sqlite npm run test:admin`.

`npm run test:admin` and `npm run test:auth` both construct an app with
`createApp(cfg, store)`. Any test config fixture must include the `admin` block
(cookieName, sessionTtlSeconds, mfaPendingTtlSeconds, invitationTtlSeconds,
resetTtlSeconds, allowedOrigins, maxFailedLogins, lockoutSeconds) or the admin
router throws at construction.

### Admin test client gotcha

Tests use Node's global `fetch`. To capture `Set-Cookie`, read
`res.headers.getSetCookie()` — the older `res.headers['set-cookie']` form is
empty on the fetch Headers object and the cookie jar silently stays empty,
producing confusing 401s.

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
- `src/components/shell/*` — `AppShell.tsx` (frame), `TopNav.tsx` (the single
  navigation bar) and `navigation.ts`. `navigation.ts` is the single source of
  truth: it holds the 10 `Route`s and maps them onto the five `NAV_SECTIONS`
  (Overview, Scanner, Markets, Activity, Settings) that appear in the nav.
  Extra routes in a section render as in-page tabs; `ANALYSIS` is a chart
  drill-down and is not a top-level destination. The former `Sidebar`,
  `Topbar` and `MobileNav` were removed in the minimal-workspace pass — do not
  reintroduce a second navigation surface.
- `src/components/views/*` — one view per route (BestMarket, StrategyScanner,
  MtfPrecisionEntry, LiveMarketScannerTable reused for Plain/1s, DerivAdvancedChart,
  OpportunityCard, Signals, PerformanceDashboard, Settings). `ScannerSummary.tsx`
  is the compact status strip under the chart (state, condition, headline
  indicators, signal time, tick freshness, confluence score); it replaced the
  `IndicatorPanel`/`SignalPanel` card grids, which were deleted. The score is
  the engine's own confluence total and is labelled "score", never
  "confidence" — do not add a confidence figure the engine does not produce.
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
- `store/store.ts` — durable store: users, sessions, one-time OAuth
  transactions, plus the admin domain. Keyed by a stable id derived from the
  Deriv `sub`, never a display name. Reads are served from an in-memory cache;
  writes go through a pluggable backend (`store/backend.ts`):
  `store/json_backend.ts` (`data/wicksentinel.json`, the original engine) or
  `store/sqlite_backend.ts` (`data/wicksentinel.db`, WAL + transactions).
  Both take an exclusive `data/wicksentinel.lock`, so one process per data
  directory. Migrate with `npm run db:migrate`.
- `routes/auth.ts` — `/auth/start`, `/auth/deriv/callback`, `/auth/logout`,
  `/auth/session`, `/api/preferences`, `/api/deriv/verify`. Sign-in/sign-out also
  emit best-effort activity events (see telemetry below).
- `activity/types.ts` — activity-event and scanner-session record shapes, plus
  `SCANNER_ACTIVE_WINDOW_MS` (a scanner counts as "active now" if seen within
  2 minutes).
- `activity/service.ts` — validation and aggregation for telemetry. `ingestEvents`
  accepts only known client kinds and bounded primitives; `recordHeartbeat`
  upserts a scanner session; `summarise()` computes DAU/MAU/active sessions.
- `routes/telemetry.ts` — `POST /api/telemetry/events` and
  `/api/telemetry/heartbeat`. Session-required, rate-limited and size-capped;
  best-effort (a rejection never blocks the scanner). `userId` always comes from
  the verified session, never the body.
- `lib/balance.ts` — reads one account's balance over Deriv's WebSocket API:
  `POST /trading/v1/options/accounts/{id}/otp` (scope `trade`) returns an
  account-bound socket URL, then `{ "balance": 1 }` yields the figure. Deriv
  **nests** the fields — `{ "balance": { "balance": …, "currency": …,
  "loginid": … }, "msg_type": "balance" }` — so the reader accepts the nested
  object (and a flat payload for older servers). A message with no usable figure
  is rejected as `balance_failed`, never resolved as `null`, so a parse failure
  can never be cached as `ok`. No new scope and no dependency (Node 24 has a
  global `WebSocket`).
- `services/balance.ts` — `BalanceService`: enforces account ownership and mode
  against the user's own stored accounts, keeps DEMO and REAL strictly separate,
  and caches per account with a TTL. Reports `ok` / `stale` / `unavailable` /
  `disconnected`; a failed read never becomes `0`.
- `routes/balances.ts` — `GET /api/balances` (all accounts) and
  `GET /api/balances/:accountId` (`?mode=` asserts mode, `?refresh=1` forces a
  re-read). Session-required; a foreign account id or a mode mismatch is `403`,
  never a substituted account.

**Account balances are read-only.** The backend holds the Deriv token (sealed,
server-side only) and is the sole authority on which accounts exist and their
mode; the client cannot widen its view by naming another account id. The
workspace header shows the selected account's balance via
`src/components/shell/AccountBalance.tsx` and `src/lib/balances.ts`, with DEMO
and REAL listed separately. The right-hand account panel
(`views/TradePanel.tsx`) renders the same store: one row per mode showing the
actual balance and currency, with the selected account highlighted and a
per-row loading / live / stale / unavailable / disconnected state. The shared
`formatMoney` / `pickAccount` / `BALANCE_STATE_LABEL` helpers live in
`src/lib/balances.ts` so both surfaces render identically. A null balance
renders as "—"/"Unavailable" and is never shown as `0`. The figure is
informational and never authorizes a trade. Balance tests:
`npm run test:balance` (19 cases) and `npm run test:balance-display` (14 cases).

**Scanner telemetry.** The engines run in the browser, so the admin console can
only show measured figures because the client reports them. `src/services/
TelemetryService.ts` batches events (one page load = one session id) and posts
them via `/api/telemetry/*`; `src/App.tsx` drives its lifecycle and emits
`scan.started`/`scan.stopped`/`signal.generated`/`settings.changed`. The admin
read-paths (`analytics/active-users`, `analytics/feature-usage`,
`monitoring/scanner-sessions`, `monitoring/data-freshness`, `dashboard/summary`)
consume these records. Where no source exists — billing, subscriptions, market
data — the admin UI reports **Unavailable**; never substitute an estimate.
Scanner sessions are keyed by `<userId>:<clientSessionId>` because the client id
is untrusted.

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
- **WickSentinel is a signal scanner, not an execution platform.** There is no
  stake sizing, risk config, martingale, order placement or trade automation
  anywhere in `src/` or `server/`. Do not add order-entry UI or imply that the
  product trades: the right-hand workspace panel (`views/TradePanel.tsx`)
  deliberately shows account status, real signal levels and an explicit advisory
  notice instead. Signal levels drawn on the chart are annotations of values the
  engine already published — the chart must never derive or suggest its own.

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
  variants). It is wired into the landing nav and the workspace top bar.
- Chart colours cannot be CSS classes, so the palette is mirrored as
  `--chart-*` variables and read at runtime via `readChartColors()` in
  `src/components/chart/chartTheme.ts`. `src/components/chart/TradingChart.tsx`
  is the reusable Lightweight Charts wrapper (v5 `chart.addSeries(CandlestickSeries
  | AreaSeries, …)` API); it applies theme colours live and rebuilds the series
  in place rather than recreating the chart, so pan/zoom survives every tick.
  `TONE_HEX` in `ui/format.ts` likewise returns `var(...)` strings so inline
  styles and SVG follow the theme.
- Chart-structure overlays (S/R + flip zones, supply/demand, trendlines,
  protected swings, confirmed patterns, breakout levels) are split so each layer
  is independently testable: `src/engines/ChartStructureEngine.ts` derives the
  structure from candles (pure engine logic), `src/components/chart/chartOverlays.ts`
  maps structure to a flat list of drawable shapes, and
  `src/components/chart/overlayPrimitives.ts` paints them through a Lightweight
  Charts `ISeriesPrimitive` (the library has no zone/segment primitive of its
  own). Visibility toggles live in `OverlayLegend.tsx` and persist via
  `src/lib/overlayPreferences.ts`. The chart still only annotates values the
  engine already published — never derives or invents levels of its own.
- The chart's data effect distinguishes a full repaint from a one-bar update via
  `loadMode()` in `chartData.ts`. This matters because a symbol's first render
  often happens before its history arrives; treating that empty state as
  "loaded" left the chart showing a single bar. Do not call `fitContent()` on an
  empty series — it collapses the visible range.
- The landing hero sits on a dark photograph in both themes. `.ws-hero-band`
  pins the dark token values for that subtree so light-mode text stays legible
  over the image.
- Contrast is verified with a Puppeteer audit over both themes; muted text tiers
  (`fg-5`/`fg-6`) and the semantic tones are tuned to clear 4.5:1 on their
  surfaces in each theme.

## Pushing to GitHub

Pushing works from this container. `git push origin <branch>` succeeds (verified
by pushing `feature/premium-saas-ui` to `amuli1234-poa/No-touch`); the push
output is short because of the shallow clone, so confirm the result with
`git ls-remote --heads origin <branch>` rather than relying on the local
remote-tracking ref. Do not open a pull request unless explicitly asked.

Earlier notes here claimed the token was read-only and that pushes failed with
`403 Resource not accessible by integration` — that is no longer accurate.
