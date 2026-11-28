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
npx tsc --noEmit                  # typecheck the browser app
npm run test                      # frontend suite: every src/**/*.test.ts (259 tests)
```

Admin console (uses npm scripts; `tsx` for the server, `vite` for the app):

```bash
npm run server        # backend on :8787 (serves trader API + /api/admin/v1 + /admin + /bot)
npm run dev:admin     # admin app on :3001, proxies /api/admin to :8787
npm run build:admin   # → dist-admin/, built with base /admin/ (override: ADMIN_BASE=…)
npm run lint:admin    # admin typecheck (tsc -p admin/tsconfig.json)
npm run test:admin    # admin test suite (20 tests)
npm run test:admin-routing # /admin hosting + security invariants (15 tests)
npm run test:admin-bootstrap # bootstrap backend selection, crypto, duplicate guard (23 tests)
npm run test:telemetry # telemetry ingest + admin read-path (8 tests)
npm run test:balance   # account balances: isolation, DEMO/REAL, stale (16 tests)
npm run test:copy-balance # client balances on the admin + manager copy surfaces (6 tests)
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

WickSentinel is a **multi-timeframe price-action analysis workspace**. The
dashboard was replaced by the Lucky Rise & Fall analyser (see "Dashboard
migration" below); the previous engine tree was removed.

Frontend layout:

- `src/App.tsx` — the dashboard shell. Hash-routed sections, the shared
  workspace context (`WorkspaceProvider`), and the single chart. One
  `<SingleChartCanvas>` is mounted for the whole app; chart-centric modules
  publish an overlay through `ModuleChartSlot` instead of rendering their own
  chart (enforced by `src/components/chart/singleChart.test.ts`).
- `src/analysis/*` — pure analytical engines, no React and no I/O. Includes
  `signalEngine`, `structureEngine`, `demandSupplyEngine`, `smcEngine`,
  `trendlineEngine`, `momentumEngine`, `rangeAnalysis`, `confluenceEngine`,
  `riskManagement`, `strategyOptimizer`, `systemHealth`, and the AI journal.
- `src/services/derivWebSocket.ts` — the Deriv feed: symbol discovery,
  historical candles, live OHLC/tick subscriptions, reconnect/backoff and
  diagnostics. Reads `src/config/deriv.ts` (public options WS endpoint).
  Switching instrument or timeframe must leave exactly **one** candle stream and
  one tick stream open. Cancelling a subscribe while its request is in flight
  forgets the id the server issues, and `subscribeTicks`/`subscribeCandles`
  never re-register a stream that was cancelled mid-flight. Locked down by
  `src/services/derivWebSocket.test.ts` (fake socket, in-flight cancellation and
  a rapid switch across every eligible index).
- `src/hooks/*` — the state layer that binds the feed to the engines
  (`useDerivChartData`, `usePriceActionAnalysis`, `useVolatilityScanner`,
  `useAiModules`, `useStrategyLab`, `useSystemHealth`, `useAppSettings`, …).
- `src/context/*` — `WorkspaceContext` (shared market/analysis state) and
  `ModuleOverlayContext` (the chart overlay a module publishes).
- `src/components/{nav,dashboard,ai,chart,views}/*` — presentation only.
  `nav/Navigation.tsx` is the single navigation surface (sidebar + mobile).
- `src/components/landing/*` — public marketing site (UNCHANGED by the
  dashboard migration; still carries legacy "No Touch barrier" copy in the hero
  preview).
- `src/components/brand/*`, `src/components/ui/{primitives,ThemeToggle}`,
  `src/lib/{router,auth,theme,balances}.ts` — shared with the public site.
- `src/types/*` — domain types, split per concern (`market`, `analysis`,
  `signals`, `scanner`, `engine`, …).

The dashboard keeps its state in `localStorage` (settings, alerts, training,
journal, model-performance records) and reads the market directly from the
public Deriv WebSocket. It places no orders.

Server-side (unchanged by the migration) lives in `server/`: accounts,
sessions, balances, the signal/risk/execution pipeline and the admin console.

## Scanner pipeline

The dashboard's signal path runs client-side. `useVolatilityScanner` sweeps the
eligible synthetic markets and, for each, `usePriceActionAnalysis` runs the
analysis engines in `src/analysis/` (`signalEngine`, `structureEngine`,
`demandSupplyEngine`, `smcEngine`, …). Candidates are scored by
`qualityScore.ts` (tier thresholds via `PUBLICATION_MIN_SCORE`) and reconciled
across engines by `coAnalysis.ts`. The Market Scanner rows are monitor-only:
they carry price, health and descriptive range, never a direction or confidence.


## Chart markup + live subscription model (2026-11 fork reconciliation)

The `2nd .zip` import was a **parallel fork**, not a superset of this repo: it
replaced the whole chart-markup layer (`chartMarkupStyle.ts` → `chart/markupStyle.ts`,
every primitive rewritten) and added derived timeframes + outbound request pacing to
`derivWebSocket.ts`, but it predated two of this repo's own commits — `463d73c`
(subscription-leak fix) and `6261303` (minimalist markup). When reconciling, keep the
zip's integrated layer and fold this repo's fixes into it; never blindly overwrite.

- **One markup module:** `src/components/chart/markupStyle.ts` is canonical. The old
  `chartMarkupStyle.ts` (and its static guard test) was retired. Every primitive draws
  through the shared tokens (`MARKUP_LINE` ≤ 1.35, `MARKUP_ALPHA.fill` ≤ 0.08,
  `drawTag`). The runtime guard `chartPrimitivesMarkup.test.ts` drives each primitive's
  real draw path against a recording canvas — keep it green when editing a primitive.
- **Badge vocabulary:** level badges read `ENTRY` / `SL` / `TP`, zone tokens come from
  `shortZoneLabel` (`DZ` / `SZ` / `BOS` / `CHoCH` / `R` / `S` / `WATCH`). No sentence
  labels (`NO TRADE` → `NT`).
- **Zone lifecycle:** `DsChartPrimitive` skips `INVALIDATED` / `FULLY_MITIGATED` zones
  unless `flipped`. `UserDrawingsPrimitive` uses the shared tokens (never a literal
  1.6px stroke).
- **Request pacing:** `derivWebSocket` paces outbound requests (`WS_MIN_REQUEST_INTERVAL_MS`,
  capped in-flight, FIFO with priority jumps). Tests that burst subscriptions must wait
  for the queue to drain (`getDiagnostics().queuedRequests === 0`) before asserting on
  `activeSubscriptions`.
- **Subscription leak:** `subscribeCandles` / `subscribeTicks` register intent before
  issuing the request and forget an orphaned subscription whose key no longer maps to
  the registered entry; `useDerivChartData` checks its staleness guard *before* opening
  a tick stream. `registerCandleSubscription` returns the subscription entry.

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
mode; the client cannot widen its view by naming another account id. The shared
`src/lib/balances.ts` store exposes the selected account's balance to any surface
that needs it, with DEMO and REAL listed separately. The shared
`formatMoney` / `pickAccount` / `BALANCE_STATE_LABEL` / `lastUpdatedShort` /
`lastUpdatedLabel` helpers live in `src/lib/balances.ts` so every surface renders
identically. A null balance renders as "—"/"Unavailable" and is never shown as
`0`. The figure is informational and never authorizes a trade.

The old dashboard's header balance chip (`AccountBalance.tsx`) was removed with
the dashboard migration; `src/lib/balances.ts` is unchanged and remains the
single client-side store for balance reads.

Balance tests: `npm run test:balance` (19 cases). The old frontend balance
display test (`test:balance-display`) was removed with the previous dashboard.

**Scanner telemetry.** The server-side telemetry ingest and admin read-paths
(`server/routes/telemetry.ts`, `test:telemetry`) are unchanged. Note: the old
dashboard's client emitter (`src/services/TelemetryService.ts`) was removed with
the dashboard migration, so the new dashboard currently reports no scan
telemetry — admin analytics that depend on it show **Unavailable** until a
client emitter is wired back up. Never substitute an estimate. Scanner sessions
are keyed by `<userId>:<clientSessionId>` because the client id is untrusted.

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
| `/login`, `/get-started` | `components/landing/AuthPage.tsx` — Deriv OAuth entry |
| `/privacy`, `/terms`, `/risk-disclaimer` | `components/landing/LegalPage.tsx` |
| anything else | `components/landing/NotFoundPage.tsx` |

- `src/lib/router.ts` — dependency-free pathname router (`useRoute`, `navigate`,
  `navigateToSection`). It is **base-aware**: it reads `import.meta.env.BASE_URL`
  so the same build works at `/` in dev and under a project-Pages subpath.
- `src/components/landing/*` — landing sections, `primitives.tsx` (Section,
  Reveal, WsButton, SectionHeading) and `ScannerPreview.tsx`.
- `src/components/brand/WickSentinelBrand.tsx` — `BrandLogo`, `WickSentinelMark`
  and the `BRAND` constants.
- Public-site palette lives in `src/index.css` as `--ws-*` tokens alongside the
  shared `--color-*` tokens the dashboard also uses. There is one token set; the
  dashboard retints `--color-accent` at runtime from live system status.

**Authentication is Deriv OAuth 2.0 (PKCE) with server-side sessions** — see the
section above. The dashboard's analytics run entirely client-side (localStorage),
but the app is served by `server/index.ts`, which also exposes the WhatsApp
dispatch endpoints. Do not build a fake auth flow. Landing-page copy must only
advertise features that exist in `src/analysis` / `src/components`, and preview
graphics must stay labelled as illustrative — never present mock numbers as live
market data.

> Legacy note: the landing hero copy still mentions an "adaptive No Touch
> barrier". That product was removed; the copy is a known leftover and the
> landing page is intentionally left untouched.

## Dashboard migration (Lucky Rise & Fall scanner)

The workspace dashboard was replaced wholesale by the **Lucky Rise & Fall**
analyser (from `lucky-rise-fall-scanner.zip`). The public site and auth were
deliberately left intact.

What changed:

- `src/App.tsx` is now the new dashboard shell (hash-routed sections:
  `dashboard`, `analyser`, `scanner`, `trendlines`, `demandsupply`, the AI
  module tabs (`boschoch`, `technical`, `smc`, `liquidity`, `fvg`,
  `orderblock`, `momentum`, `regime`, `confluence`, `live`, `performance`,
  `risk`, `alerts`), `strategylab`, `health`, `training`, `history`,
  `settings`).
- New trees: `src/analysis/` (signal + AI engines), `src/hooks/`,
  `src/context/`, `src/components/{nav,dashboard,ai,chart,views}/`,
  `src/theme/`, `src/config/`, `src/utils/`, `src/services/derivWebSocket.ts`,
  and the new `src/types/*`.
- Removed: the old `src/engines/`, `src/features/`, `src/components/{shell,
  views,analysis,controls,chart}/`, `src/services/{DerivWebSocketManager,
  IndexedDbStorage,TelemetryService,WhatsAppService}.ts`, and the old
  `src/tests/` frontend suites.

What is UNCHANGED (do not touch): `src/Root.tsx`, `src/main.tsx`,
`src/components/landing/*`, `src/components/auth/*`,
`src/components/brand/*`, `src/components/ui/ThemeToggle.tsx`, and
`src/lib/{router,auth,theme,balances}.ts`, plus the whole `server/` and
`admin/` trees. The landing page, OAuth login and legal pages behave exactly
as before.

`src/index.css` was **merged**: it carries both the public-site `--color-*`
tokens and the dashboard's terminal palette in one `@theme` block, plus the
dashboard animation library and the hero-band styles. A token is defined once.
The dashboard overrides `--color-accent`/`--color-accent-soft` at runtime from
live system status (`src/theme/accents.ts`), so the shared accent token is the
public-site value by default.

Tests: `npm run test` runs every frontend `src/**/*.test.ts` (259 tests, node's
built-in runner via `tsx`). `src/components/chart/singleChart.test.ts` enforces
"exactly one candlestick chart" — it matches only the chart *component* import,
because `lucide-react` also exports an icon named `CandlestickChart` used by the
landing page.

## Conventions

- Design tokens live in `src/index.css` as `--color-*` custom properties
  (`--color-app`, `--color-surface`, `--color-line`, `--color-accent`, …).
  Reuse them; do not hardcode new palette values in components. The dashboard
  may also use Tailwind arbitrary values; when you touch them, prefer the tokens.
- Analytical logic lives in `src/analysis/`; data access in `src/services/`
  and `src/hooks/`. Components are presentation only. The dashboard is
  client-side: it reads the public Deriv WebSocket directly and keeps its state
  in `localStorage`.
- Every settings/display control must drive real behaviour — no decorative
  controls.
- **The dashboard is analysis-only; the execution layer lives on the server.**
  The dashboard renders signals, overlays and analytics but places no orders.
  Order placement is server-side only, gated behind the execution flags in
  `server/config/flags.ts` (see the execution sections below). Do not add
  order-entry UI to the dashboard or imply the client trades.

## Design language

The workspace and the public site share one token set but have distinct
characters:

- Public site (WickSentinel brand): near-black navy `#060b16`, one primary blue
  `#0068B5` (hover `#2E8AD8`) and a light-blue accent `#60A5FA`. The previous
  indigo/violet brand (`#635BFF`, `#8057E5`) is retired — do not reintroduce it.
- Dashboard: a trading-terminal palette (`--color-app` `#080d16`, panel
  `#162033`, `--color-accent` retinted live by `src/theme/accents.ts`).
- Typography is Plus Jakarta Sans for headings, Inter for body, JetBrains
  Mono for figures.

## Theming (dark + light)

The product ships both a dark and a light palette and lets the operator switch
at runtime.

- All colours are semantic CSS variables in `src/index.css`: `:root` holds the
  dark values, `[data-theme='light']` overrides them. Tailwind bridges the
  variables through `@theme` (e.g. `--color-fg-1`), so components use
  `bg-surface`, `text-fg-3`, `border-line`, `text-success`, etc. Never hardcode
  a hex or `rgba()` in a component — add or reuse a token instead.
- `src/lib/theme.ts` owns the runtime. The choice is stored in `localStorage`
  (`ws-theme`) and applied to `<html data-theme>`; an inline script in
  `index.html` resolves it before React mounts so there is no flash. **Light is
  the default** (matching the reatech360.com design reference); a stored choice
  overrides it. Use the `useTheme()` hook; `setTheme`/`toggle` write the
  attribute. The workspace also persists its own `theme` in
  `deriv_ai_scanner_settings_v1` (`AppSettings.theme`, default `'light'`) and
  applies it via `src/hooks/useTheme.ts` — both defaults must agree, and a
  returning visitor's stored value wins over either.
- `src/components/ui/ThemeToggle.tsx` is the control (`icon` and `switch`
  variants). It is wired into the landing nav and the workspace top bar.
- Chart colours cannot be CSS classes. `src/theme/designTokens.ts` is the
  single source of truth for the canvas (`CHART_COLORS`, `UI_COLORS`,
  `CONNECTION_TONES`). The candlestick canvas is intentionally theme-independent:
  it always renders on white with fixed teal/red candles, so a theme switch or
  an AI-module change can never recolour a candle.
- `src/components/CandlestickChart.tsx` is the reusable Lightweight Charts v5
  wrapper. Exactly one instance exists, owned by
  `src/components/chart/SingleChartCanvas.tsx`. Chart-centric modules render no
  canvas of their own: `src/components/chart/ModuleChartSlot.tsx` publishes the
  module's overlay (AI zones, trendlines, supply/demand, structure) through
  `ModuleOverlayContext`, and the primitives in `src/components/chart/*`
  (`AiChartPrimitive`, `TrendlineChartPrimitive`, `DsChartPrimitive`,
  `StructureChartPrimitive`, `SignalAnnotationPrimitive`) paint them. The chart
  only annotates values the engines already published — never derives or invents
  levels of its own. `src/components/chart/singleChart.test.ts` enforces the
  single-chart rule.
- The chart's data effect distinguishes a full repaint from a one-bar update.
  Do not call `fitContent()` on an empty series — it collapses the visible range.
- Chart markup is minimalist by contract. Every primitive paints through
  `src/components/chart/chartMarkupStyle.ts` (palette `MARKUP`, `MARKUP_ALPHA`,
  `MARKUP_WIDTH`, the short-code `MARKUP_LABEL` vocabulary and the `drawLabel` /
  `drawZoneBox` / `drawHLine` / `drawAnchorDot` helpers). Boundaries stay thin
  (`<= 1.5px`), zone fills stay lightly transparent (`<= 0.1` alpha) and every
  on-chart label is a short code (`S`, `R`, `DZ`, `SZ`, `BOS`, `CHoCH`, `WATCH`,
  `FVG`, `TL`, `E`, `SL`, `TP`) — never a sentence or a status name.
  `chartMarkupStyle.test.ts` locks the source-level contract and
  `chartPrimitivesMarkup.test.ts` drives every primitive's real draw path against a
  recording canvas to assert thin strokes, faint fills and short labels at paint
  time. The cleanliness pass (`pruneOverlaysForLiveChart` / `pruneStructureOverlay`)
  drops everything that is no longer tradeable: broken S/R, mitigated rejection
  bands, failed / invalidated watch zones, filled FVGs and stale structure breaks.
- The landing hero sits on a dark photograph in both themes. `.ws-hero-band`
  pins the dark token values for that subtree so light-mode text stays legible
  over the image.
- Contrast is verified with a Puppeteer audit over both themes; muted text tiers
  (`fg-5`/`fg-6`) and the semantic tones are tuned to clear 4.5:1 on their
  surfaces in each theme.

## Login troubleshooting (verify before blaming the migration)

The dashboard migration did **not** touch the auth path: `src/lib/auth.ts`,
`src/lib/balances.ts`, `src/lib/router.ts`, `src/components/auth/*`,
`src/components/landing/*`, `src/Root.tsx`, `src/main.tsx`, `index.html`,
`vite.config.ts` and everything under `server/` are byte-identical to the
pre-migration commit. If login fails, check the environment, not the diff.

- The registered callback is `http://localhost:3000/auth/deriv/callback`. The
  **Vite dev server must be on :3000** (it proxies `/auth/*` to the backend on
  :8787). Both must be running or the callback is refused / the token exchange
  fails. `npm run dev:all` starts both.
- After Deriv redirects back, the backend 302s to `${DERIV_REDIRECT_URI origin}/app`.
  With `DERIV_REDIRECT_URI=http://localhost:3000/...` the login only completes
  **when the browser is on the `localhost:3000` dev preview**. A static GitHub
  Pages build (no backend) deliberately steps aside via `ProtectedRoute` — it
  cannot complete a real OAuth login.
- `NODE_ENV=production` enables HTTPS enforcement, which 308-redirects plain
  HTTP to `https://`; run dev with `NODE_ENV=development` (the committed `.env`).
- Debug with: `curl -sD - -o /dev/null http://localhost:3000/auth/start?mode=login`
  (expect a 302 to `auth.deriv.com` plus a `ws_oauth` cookie). Failures land on
  `/signin-error?code=…`: `invalid_state`/`duplicate_callback` = stale or reused
  link, `expired_code` = the code expired (finish promptly), `cancelled` = the
  user declined, `identity_unverified`/`authorization_failed` = Deriv side.

## Pushing to GitHub

Pushing works from this container. `git push origin <branch>` succeeds (verified
by pushing `feature/premium-saas-ui` to `amuli1234-poa/No-touch`); the push
output is short because of the shallow clone, so confirm the result with
`git ls-remote --heads origin <branch>` rather than relying on the local
remote-tracking ref. Do not open a pull request unless explicitly asked.

Earlier notes here claimed the token was read-only and that pushes failed with
`403 Resource not accessible by integration` — that is no longer accurate.

When pushing a brand-new branch, prefer the plain remote once it exists. If you
must push with an explicit token URL (`git push -u https://$GITHUB_TOKEN@…`),
Git writes that URL — token and all — into `branch.<name>.remote`. Reset it
afterwards so the credential is not left in `.git/config`:

```sh
git config branch.<name>.remote origin
git config branch.<name>.merge refs/heads/<name>
git fetch origin <name>   # populate the remote-tracking ref
```

## Multi-AI analysis modules

- The institutional restyle lives in the token layer, not in components:
  `src/index.css` `:root` holds the dark navy/charcoal palette and the `@theme`
  bridge maps semantic tokens to Tailwind classes. Use the Tailwind classes
  (`text-bull`, `text-bear`, `text-warn`, `text-live`, `bg-bull/10`, …) rather
  than raw hex. Blue/red and green/red mean rise/fall — they are semantics,
  never forecasts.
- Layout: `src/App.tsx` mounts a flex row where the chart column is `flex-1`
  and the analysis panel is a fixed aside; below `xl` the panel is a slide-over
  drawer, so the chart stays full-width on tablet/Android.
- Section routing is a **two-part registry**: an `AppSection` union
  (`src/components/nav/Navigation.tsx` + `src/context/WorkspaceContext.tsx`)
  and the `FULL_WIDTH_SECTIONS` array in `src/App.tsx`. Adding a section to the
  union and wiring its view is not enough — a section missing from
  `FULL_WIDTH_SECTIONS` falls into the chart+aside branch and, with no `case`
  in the aside's switch, renders a blank right pane. Add new sections to both.
- Module registry: `src/hooks/useAiModules.ts` exports
  `AI_MODULE_DEFINITIONS`, the single source of truth for the AI tabs. Each
  entry names an `AiEngine` and its publication gate; adding a module is a
  one-line addition. The engines live in `src/analysis/*` and are pure (no React,
  no I/O):
  - `src/analysis/aiCommon.ts` — shared primitives (ATR, SMA, confirmation).
  - `bosChochEngine.ts`, `technicalEngine.ts`, `smcEngine.ts`,
    `liquidityEngine.ts`, `fvgEngine.ts`, `orderBlockEngine.ts`,
    `momentumEngine.ts`, `marketRegimeEngine.ts`, `confluenceEngine.ts`,
    `liveScannerEngine.ts`, `riskManagement.ts`, `strategyOptimizer.ts`,
    `marketAnomaly.ts`, `marketIntelligence.ts`, `instrumentIntelligence.ts`.
  - `coAnalysis.ts` (`reconcileEngines`) reconciles peer decisions and flags
    disagreement, so no single module can fabricate a tradeable zone.
  - `src/types/aiModule.ts` defines the `AiSignal` / `AiZone` contract; the
    module view (`src/components/ai/moduleViews.tsx`, `AiModuleView.tsx`)
    renders it. A module never publishes a direction or zone the engine did not
    produce; `deriveSignalLifecycle` (`src/utils/signalStatus.ts`) tracks the
    signal through its lifecycle.
- Alerts: `src/analysis/alertEngine.ts` + `alertSources.ts` turn module
  observations into alerts; `src/hooks/useAlertManager.ts` owns the queue and
  `src/components/ai/AlertsView.tsx` renders it. Notifications use
  `src/utils/notify.ts` / `sound.ts`.
- The M2 timeframe is aggregated by the feed from the 1m batch (and updated
  live). The toolbar only marks a timeframe active once its buffer is non-empty,
  so a failed request never looks like a successful switch.
- Tests: `npm run test` runs every `src/**/*.test.ts` (259 tests).

## Deriv API reality check (verified 2026-11, read-only)

Verified by probing the live public API from this container — do not re-guess these:

- **The legacy WebSocket is unreachable from the server.** `wss://ws.derivws.com/websockets/v3`
  and `wss://ws.binaryws.com/websockets/v3` both return **HTTP 520** (Cloudflare)
  from Node. The browser still streams fine, but **no server-side feature may
  depend on the legacy WS.** The new options API works: REST
  `https://api.derivws.com/trading/v1/options/accounts` (401 without auth = reachable)
  and WS `wss://api.derivws.com/trading/v1/options/ws/public` (opens, real data).
  Auth: `https://auth.deriv.com` OIDC discovery is reachable (200).
- **Contract types are not `RISE`/`FALL`/`MULT`.** From live `contracts_for` on
  `R_100`: Rise/Fall is **`CALL`/`PUT`** (`contract_category: "callput"`,
  `expiry_type: "daily"`, `barriers: 1`, durations `1d`–`365d`); Multipliers is
  **`MULTUP`/`MULTDOWN`** (`contract_category: "multiplier"`, `expiry_type:
  "no_expiry"`, `barriers: 0`, `multiplier_range: [40,100,200,300,400]`,
  `cancellation_range: ["5m","10m","15m","30m","60m"]`). `R_100` lists `CALL`/`PUT`
  more than once (different expiry variants), so an adapter must pick the right
  variant, not the first match.
- `ticks` returns `{ ask, bid, epoch, quote, symbol, pip_size }`; `active_symbols`
  returns 95 rows with `underlying_symbol`/`underlying_symbol_name`/`pip_size`.

**Not yet verified** (needs a real Deriv app credential + demo account): the
authenticated demo/real WS host + auth mechanism, and the exact `proposal` /
`buy` / `proposal_open_contract` request+response field names. Do not write
execution code against assumed schemas. See `docs/TRADING_ARCHITECTURE_ASSESSMENT.md`.

Reproduce a probe from the project root with `node_modules/ws` (the `ws` package
must be imported from inside the repo so Node resolves it).

## Deriv authenticated trading spec (RESOLVED — use these, do not guess)

The official spec index is `https://developers.deriv.com/llms.txt`; each endpoint
has Markdown at `https://developers.deriv.com/llms/<endpoint>.md` (e.g. `buy.md`,
`proposal.md`, `proposal-open-contract.md`, `authentication.md`). Use it first.

- **Auth = OTP-URL flow, no WS handshake.** `GET /trading/v1/options/accounts`
  (Bearer) → account ids; `POST /trading/v1/options/accounts/{accountId}/otp`
  (Bearer) → `{data:{url:"wss://api.derivws.com/trading/v1/options/ws/{demo|real}?otp=..."}}`;
  connect to that URL and send messages — do NOT send an auth message. The URL is
  account-scoped, which gives per-account isolation.
- **Symbol field is `underlying_symbol`** (not `symbol`).
- **proposal**: `{proposal:1, amount, basis:"stake"|"payout", contract_type,
  currency, underlying_symbol, duration, duration_unit:"s"|"m"|"h"|"d"|"t",
  multiplier?, cancellation?, limit_order?:{stop_loss,take_profit}, subscribe:1}`
  → `proposal.id` (**only a streaming proposal's id is buyable**), `ask_price`,
  `payout`, `spot`, `date_start`, `longcode`.
- **buy**: `{buy:<proposal id>, price:<ask_price>}` → `buy:{contract_id,
  buy_price, balance_after, payout, purchase_time, start_time, transaction_id}`.
  Scope `trade`.
- **proposal_open_contract**: `{proposal_open_contract:1, contract_id, subscribe:1}`
  → `status:"open"|"sold"|"won"|"lost"|"cancelled"`, `profit`,
  `entry_spot`/`exit_spot`, `date_start`/`date_expiry`/`date_settlement`,
  `buy_price`, `payout`, `is_valid_to_sell`/`is_valid_to_cancel`.
- **No refresh token** — on `401`, send the user through OAuth again.
- **Contract types**: Rise/Fall `CALL`/`PUT`; Multipliers `MULTUP`/`MULTDOWN`
  (+`multiplier`, `cancellation`, `limit_order`).

## Trading domain (Phase 2 — isolation foundation)

- New server modules: `server/execution/types.ts` (durable records),
  `server/execution/accountGuard.ts` (ownership + mode enforcement),
  `server/config/flags.ts` (kill switches). `server/execution/` will grow
  `gateway.ts` (the only purchase submitter), `stateMachine.ts`, `intentStore.ts`,
  `locks.ts`, `adapters/`, `broker/` in later phases.
- Trading collections live in `server/store/backend.ts` (`COLLECTIONS` +
  `COLLECTION_SPECS`); the Store loads them and exposes tenant-scoped accessors
  (`getSignal(userId, id)` returns null on owner mismatch). Add a collection in
  both places or the SQLite migration will miss it.
- Kill switches: `ALLOW_EXECUTION`, `ALLOW_DEMO_EXECUTION`, `ALLOW_REAL_EXECUTION`,
  `ALLOW_AUTOMATIC_TRADING` — all default false; parsed strictly (`=== 'true'`).
  REAL needs the master switch **and** its own flag. `ALLOW_AUTOMATIC_TRADING` is
  independent of the others: it needs the master switch too, but turning manual
  DEMO trading on never turns automatic trading on. Never settable at runtime.
- `npm run test:isolation` covers cross-tenant IDOR, mode mismatch, kill
  switches and record durability. Keep it green.

## Execution layer (Phases 3–6)

- Market data: `server/services/marketData.ts` on the PUBLIC options gateway
  (`wss://api.derivws.com/trading/v1/options/ws/public`, no auth). The legacy
  `ws.derivws.com` WS is Cloudflare-blocked from the server (HTTP 520) — never
  depend on it server-side. Snapshots carry `receivedAt`; use `isSnapshotFresh`.
- `server/services/signals.ts` creates validated, expiring signals (needs a fresh
  price); `server/services/strategy.ts` is a pure policy verdict; both never trade.
- `server/services/risk.ts` is the gate: every rule runs, and it fails closed when
  the balance is unknown. No martingale exists anywhere.
- The `execution_frequency` and `trades_per_session` rules exclude the intent
  currently being submitted (`RiskEvaluationInput.excludeIntentId`, passed by the
  gateway). An intent is created moments before its own risk check, so without
  this it would count as the most recent trade and reject every first trade.
- Protected routes answer 401/403 with both an `error` code and a `message`; the
  Trade panel surfaces `message` (falling back to a code-keyed map) so a dead
  session reads as "session expired", never a bare "could not save".
- `server/execution/gateway.ts` is the ONLY purchase submitter. It applies, in
  order: kill switches -> ownership/mode -> approval window -> token -> account
  lock -> signal single-use -> risk -> proposal -> buy. A purchase that may have
  reached Deriv but was unconfirmed becomes `UNKNOWN` then
  `RECONCILIATION_REQUIRED`; never retry it blindly.
- Brokers: `server/execution/broker/derivBroker.ts` (real, OTP-URL flow, per-call
  socket) and `fakeBroker.ts` (tests only). Family payloads live in
  `server/execution/adapters/index.ts`; the broker never knows family rules.
- Auth is the OTP-URL flow: `POST /trading/v1/options/accounts/{id}/otp` then
  connect; no `authorize` message. `accessToken` is passed per call and never
  stored on an intent or written to an audit detail (`redact()` strips secrets).
- HTTP surface: `server/routes/execution.ts` (signals, intents, submit).
- Test scripts: `test:market`, `test:signals`, `test:risk`, `test:execution`,
  `test:broker`, `test:exec-routes`. Keep them green.

## Automatic execution (Phase 7)

- `server/execution/autoRunner.ts` (`AutoExecutionRunner`) is the automatic loop.
  It adds only "signal -> intent -> submit"; every gateway control still runs.
- Only `mode: 'automatic'` users run. REAL is refused outright: automatic
  execution is DEMO-only in this build.
- Single-flight per account: `inFlight` skips a second signal for an account with
  an execution in progress (skipped, never queued).
- Auto-stop: a terminal risk reason (`daily_loss`, `consecutive_losses`,
  `auto_stopped`) sets `autoStopped` on the user's preferences and audits it. It
  never clears itself; the customer must turn it back on.
- Wired in `composition.ts` (bundled as `runner`) and invoked from
  `POST /api/execution/signals` when the user is automatic. `test:auto` covers it.

## Automatic scanning (Phase 10) — superseded

> **Note (verified 2026-11-17):** `server/services/marketScanner.ts` and its
> `MarketScanner` loop do **not** exist in this tree. The `scanner` bundle in
> `composition.ts` is the status-only `SystemSignalStore`, and the markets are
> scanned **in the dashboard** (client), which publishes the best signal via
> `POST /api/execution/signals`. `GET /api/execution/scanner` returns
> `watchedMarkets: []` because "the server has none". The `market_scanner`
> signal in `data/wicksentinel.json` was written by an older build. The
> description below is kept for history only.

- `server/services/marketScanner.ts` (`MarketScanner`) was the loop that *feeds*
  the automatic runner: it watches every eligible Volatility Index, scores each
  one, and creates a signal when a market is directional enough to act on.
- It has no authority of its own. It cannot buy or skip a check; it can only
  propose a signal, which then travels the normal path (kill switches, ownership,
  risk engine, single-use signal, one purchase path). DEMO-only, like the runner.
- The score is fractal efficiency — `|last - first| / Σ|Δ|` over the tick window —
  used directly as the signal's confidence. A choppy market scores low and is
  ignored; a clean trend scores high. `minTicks` gates the window, `minEfficiency`
  the call, `perSymbolCooldownSeconds` the repeat rate, and `windowMs` the tick age.
- `minEfficiency` is calibrated, not guessed. Measured on live Volatility indices,
  a 60-tick window has median efficiency ~0.12 and 90th percentile ~0.36, so the
  default is 0.35 (near p90). A higher value makes signals so rare they never fire.
- It subscribes to watched markets so tick buffers fill, then reads the buffer via
  `MarketDataService.getTicks(symbol)`; it never asks Deriv for a price itself. A
  signal is built on a fresh snapshot, exactly as a manual one is.
- Wired in `composition.ts` (bundled as `scanner`) and started in `index.ts` only
  when `ALLOW_EXECUTION`, `ALLOW_DEMO_EXECUTION` **and** `ALLOW_AUTOMATIC_TRADING`
  are all on; stopped on shutdown. `GET /api/execution/scanner` returns per-user
  status (`test:scanner`).
- **Automatic trading is off by default and stays off unless opted in.** The
  scanner does not start, the gateway refuses any intent with no customer
  approval (`approvedBy === null`, i.e. the runner's own shape) with
  `automatic_disabled`, and `PUT /api/execution/preferences` refuses
  `mode: 'automatic'`. Manual trading is unaffected — it is a separate switch.
- **Local gotcha:** the switches live in the environment, and `.env` is
  git-ignored, so a fresh clone has them OFF — the scanner will not start and
  every trade is rejected. Set `ALLOW_EXECUTION=true` and
  `ALLOW_DEMO_EXECUTION=true` in `.env` and restart the backend (see
  `.env.example`). Leave `ALLOW_AUTOMATIC_TRADING` unset for manual-only. The
  status endpoint reports `reason` (`execution_disabled` / `demo_execution_disabled`
  / `automatic_disabled`) and the Trade panel shows it, so the cause is visible
  rather than a silent "not running".

## Contract monitoring and reconciliation (Phase 8)

- `server/execution/contractMonitor.ts` (`ContractMonitor`) settles contracts and
  reconciles stuck intents. It only observes and records; it never submits.
- Settlement is idempotent by the ledger `dedupeKey` (`settlement:<contractId>`)
  and by a stored-status check, so a replayed lifecycle update cannot double-post.
  A settlement entry is one per contract; a correction is a new `adjustment`.
- The gateway calls `onContractOpened` after a purchase succeeds; composition
  wires it to `monitor.monitor(...)`, which subscribes to the contract lifecycle.
- Reconciliation resolves UNKNOWN/RECONCILIATION_REQUIRED intents by reading
  Deriv: `getOpenContracts` (the `portfolio` call) first, then a bounded
  subscription probe. It NEVER retries a purchase. A boot pass
  (`reconcileStuckIntents` in `index.ts`) handles intents left by a crash.
- Routes: `GET /api/execution/ledger`, `POST /api/execution/intents/:id/reconcile`.
- `test:monitor` covers it. `BrokerAdapter` now requires `getOpenContracts`.

## Security and forward testing (Phase 9)

- `server/routes/execution.ts` rate-limits signals (120/min) and submits (30/min)
  per user; limits are injectable for tests. The risk engine's frequency rule is
  still the real trading throttle.
- `test:security` proves the token never appears in persisted state after a full
  lifecycle (a filesystem sweep), that `redact` strips secrets at any depth/case,
  that an uncertain purchase is never retried, that a rejected purchase FAILs
  cleanly, and that a signal drives exactly one purchase under a double submit.
- `test:forward` is a deterministic in-process simulation (tick -> signal ->
  risk -> automatic execution -> settlement -> ledger). It uses the REAL clock
  (the store stamps `updatedAt` with Date.now()) and an explicit risk profile
  with `maxExecutionFrequencySeconds: 0`, since the whole run is within a second.
- Duplication note: `contractTypeFor` lives in `server/services/signals.ts`;
  do not re-implement it elsewhere.

## REAL execution release review (Phase 10)

- REAL execution stays DISABLED. The review is `docs/REAL_EXECUTION_RELEASE_REVIEW.md`;
  its machine-checkable half is `test:real-gate` (5 tests pinning the fail-closed
  contract: every flag off by default, REAL needs the master switch too, DEMO
  never permits REAL, only exact lowercase "true" enables a switch).
- Do NOT enable REAL, do NOT add a setter to `server/config/flags.ts`, and do
  not document `ALLOW_REAL_EXECUTION` as settable. Enabling it is a separate,
  explicit release act requiring the preconditions in the review doc.

## Left sidebar (`nav/Navigation.tsx`)

The `Sidebar` is collapsible: 236px expanded, 68px icon rail when collapsed. The
collapsed state is owned by `App.tsx` (`sidebarCollapsed`) and persisted to
`localStorage` under `wicksentinel_sidebar_collapsed`. When collapsed the toggle
gets its own row below the logo, nav items show icon-only with `aria-label`/`title`
(the full label), badges move onto the icon, group headers become hairlines, and
the footer connection badge collapses to a status dot (`CONNECTION_STATUS_DOT`
from `ConnectionBadge.tsx`).

Sidebar type is deliberately small and bold: item labels `text-[11px] font-bold`,
group headers `text-[9px] font-bold uppercase`, brand `text-[13px] font-extrabold`.

**Gotcha — text size on `<button>`/`<input>`/`<select>`:** `src/index.css` has an
*unlayered* `button, input, select, textarea { font: inherit }` rule. Unlayered CSS
beats Tailwind's layered utilities, so `text-[11px]` on a `<button>` element is
ignored (it stays at the inherited 16px). Put the size on an inner `<span>` instead
(the sidebar and mobile sheet already do this). This also means `font-*` weight
utilities on buttons still apply, but `text-[Npx]` sizes do not.

## Panel layout: container queries, not viewport breakpoints

The right-hand intelligence panel is a fixed-width column (`xl:w-[420px]`) inside the
workspace, so the views it hosts must react to the PANEL's width, not the window's.
The panel `<aside>` in `src/App.tsx` carries `@container`; every view rendered inside it
(`AiModuleView`, `LiveScannerView`, `PerformanceView`, `TrendlineScannerView`,
`DemandSupplyAIView`, `VolatilityScannerView`, `RiskView`, `ChartAnalyserView` →
`AnalysisPanel`) uses container-query variants (`@sm:` `@md:` `@lg:` `@xl:` `@2xl:` `@3xl:`)
instead of viewport ones (`sm:` `md:` `lg:` `xl:`).

Using viewport breakpoints there is the bug: at a ≥1280px window the `xl:`/`lg:` grids
fire while the panel is only ~420px wide, cramming 3–6 columns into the panel and
overlapping text. If you add a multi-column grid to a panel view, reach for `@…:`.

Full-width sections (dashboard, health, settings, training, history, alerts, strategylab)
render in `<main>` and correctly keep viewport breakpoints. `SectionCard`'s header wraps
(`flex-wrap`) so a wide `right` action cluster drops below the title instead of overflowing.

## Dashboard fit (no horizontal scroll)

The dashboard must fit the whole viewport with no left-to-right scrolling. `<main>` already
carries `overflow-x-hidden` and the dashboard root (`views/DashboardView.tsx`) adds
`min-w-0 overflow-x-hidden`; keep both. When adding a row, prefer `minmax(0, …)` grid tracks
(the middle `BestSignalPanel` / `Live Market Readings` split is `minmax(0,1.5fr) minmax(0,1fr)`)
and `min-w-0` on flex children, so long market names truncate instead of widening the row.
The chart toolbar (`chart/SingleChartCanvas.tsx`) is `flex-wrap`, so its controls (market
selector, timeframes, Run/Refresh/Stop) drop to a second line on narrow chart columns; keep
the controls at `h-8` and the toolbar padding at `py-1.5` so that wrap costs as little
vertical space as possible. `TopBar.tsx` is intentionally compact (`h-12`, `w-8` icon
buttons) — the "top bar above the live charts".

## Branding

The product name is **WickSentinel** everywhere. `src/components/brand/WickSentinelBrand.tsx`
exports `BRAND` and the `WickSentinelMark` SVG for the public site. In-app surfaces spell it
out with the accent split — `Wick<span className="text-accent">Sentinel</span>` — in
`TopBar.tsx`, `nav/Navigation.tsx` (sidebar header) and `OpeningAnimation.tsx`. Document
titles live in the `TITLES` map in `src/Root.tsx` and in `index.html`. There is no
"DERIV AI SCANNER" / "Deriv AI" left; grep before reintroducing a name.

## Dashboard accounts and balances (new dashboard)

- The new dashboard's account surface is `src/components/AccountBalanceChip.tsx`
  (workspace header) and `src/components/dashboard/AccountsOverview.tsx` (a
  dashboard card). Both read `src/lib/balances.ts` only — never Deriv directly.
- DEMO and REAL are always listed separately (`splitByMode`); they are never
  merged. A failed read renders as an em dash, never `0.00`, and a group total is
  withheld (`totalBalance` returns null) unless every known balance shares one
  currency. Balances are informational and never authorise a trade.
- Balance lifecycle lives in `src/App.tsx`: `refreshBalances()` on first
  authenticated mount, `onReconnect()` when the market feed recovers, and
  `resetBalances()` on sign-out (also inside `logout()` in `src/lib/auth.ts`).
  The session is an HttpOnly cookie, so the browser never holds the Deriv token.
- The workspace defaults to the LIGHT (daylight) palette — the professional
  blue/slate look aligned with reatech360.com. Fonts: Plus Jakarta Sans (UI) and
  JetBrains Mono (figures), both loaded in `index.html` and declared in
  `src/index.css` `@theme`.
- `src/lib/balances.test.ts` (node:test) pins the display rules. Run `npm test`.

## Trade panel (left sidebar → "Trade")

`nav/Navigation.tsx` adds a `trade` section; `App.tsx` renders `views/TradeView.tsx`
in the right panel beside the shared chart. The ticket sets the *intent*: mode
(manual / automatic), contract family (rise_fall / multipliers), stake and duration.

- `src/lib/trade.ts` is the only client: GET/PUT `/api/execution/preferences`.
  The session is an HttpOnly cookie, so the browser never holds a Deriv token.
- `server/execution/preferences.ts` (`normalisePreferences`) validates every write.
  Duration is 5–300 minutes; stake must be positive; unknown mode/family is refused.
  Two fields are **never writable here**: `realExecutionAuthorised` and
  `autoStopped` — they are carried over from the stored record, so saving a stake
  can never switch real execution on or clear the emergency stop.
- A preference expresses intent only. It grants no authority: the gateway
  re-derives mode, account ownership and the server-side kill switches on every
  purchase. Keep it that way when adding fields.
- Contract facts (verified against `contracts_for`): Rise/Fall is `intraday`,
  15s–1d, `limit_order: null` — **no stop-loss/take-profit**. Multipliers is
  `no_expiry` with `multiplier` (40–400) and SL/TP, so it has no fixed duration.
  This is why the panel trades **durations** and disables the duration field for
  Multipliers. Do not promise SL/TP on Rise/Fall.
- `server/tests/preferences.test.ts` pins the validation and the two
  non-writable safety fields. Run `npx tsx --test server/tests/preferences.test.ts`.

### Phase status

1. Trade panel UI + preferences API — **done**.
2. Manual execution (confirm → place) — **done**.
3. Raise the conservative risk caps (currently maxOpen=3, exposure=$30, freq=30s).
4. Automatic scanning loop across the eligible volatility indices.
5. Tests + demo verification, then an explicit real-execution release.

### Manual vs automatic: who decides

Manual trading is the customer's own call. Any market, any direction, any time —
bounded only by the risk engine, the kill switches and a fresh price. A live
scanner setup is shown as *context* in the Trade panel, never as a gate, and the
panel never picks the direction for the customer.

Automatic trading is the scanner's domain: the customer has delegated the
decision, so an entry is only allowed on a live scanner setup for that market and
direction. That is enforced in two places — the scanner only ever offers
candidates it has itself validated, and `automaticSignalRejection` in
`server/routes/execution.ts` refuses a signal that would auto-execute outside a
live setup. Do not move this requirement onto the manual path: the trader places
their own trades, in their own direction, on their own judgement.

### Manual trade placement — one round-trip

`POST /api/execution/place` runs signal → intent → submit **server-side** so a
clicked trade costs one HTTP round-trip, not the three the client used to make
(`/signals` → `/intents` → `/intents/:id/submit`). It reuses the same helpers
(`createSignal`, `gateway.createIntent`, `gateway.submit`) so the safety
properties are unchanged: a fresh-price signal, single-use, risk and the one
purchase path all still apply. A repeated `idempotencyKey` replays the original
result and never places a second purchase — so a double-click is a no-op.
`src/lib/trade.ts` `placeTrade()` calls only this route.

The other half of the latency was the risk engine's balance read: `createExecution`
used to build its **own** `BalanceService`, so it never shared the cache the
`/api/balances` routes keep warm and each submit opened a fresh Deriv OTP +
WebSocket just to read a balance. `createExecution(cfg, store, market, cache,
balances)` now takes the process-wide instance from `server/index.ts`, and
`TradeView` refreshes balances every 20s while the ticket is open to keep that
cache inside its freshness window. Keep that sharing in place — a second
`BalanceService` reintroduces the handshake.

### Live positions and closing a trade

The Trade panel mounts `src/components/views/ExecutionPositions.tsx` below the
ticket. It polls `GET /api/execution/contracts` (every 15s) and shows, per
DEMO/REAL and per account, the open P/L and realized P/L (`summarizeContracts`
in `src/lib/positions.ts` — a missing profit makes the total "unavailable"
rather than a misleading partial sum). Each open contract has a **Close** action:
a confirm step, then `POST /api/execution/contracts/:contractId/close`, so a
trader can cut a loss or take a favourable profit without leaving the panel.
The server owns the close: `closePending` marks an unconfirmed sale and the
monitor reconciles it, so the client never retries a close blindly.

### Expired Deriv token

A Deriv OAuth token lasts ~24h and **cannot be refreshed** (Deriv issues no
refresh tokens). When `session.derivTokenExpiresAt` has passed, `tokenFor()`
returns null, so `/place`, the balance read and the risk engine all fail — the
risk engine fails closed on a null balance, which surfaced as a confusing
`risk_rejected: min_balance`. `GET /api/balances` reports `tokenExpiresAt`, and
the Trade panel shows a "Reconnect Deriv" banner and disables placing while it
is in the past. Do not treat a `min_balance` rejection as a real balance problem
until you have checked the token expiry.


## Imported bot execution (real Deriv DEMO runs)

Bots imported into the Bot Builder can be **run for real on a Deriv DEMO
account**. This is execution, not backtesting: a satisfied strategy creates a
signal, an intent and a purchase through the same `gateway.submit` path a
hand-placed trade uses. Backtesting is a separate concern and must never be
presented as "running the bot".

Files:

- `server/bots/runTypes.ts` — `BotRunRecord`. **Deliberately separate from
  `ImportedBotRecord.status`.** The import lifecycle (`imported` | `paused` |
  `archived`) describes the document; a run describes the session. Do not fold
  run state into bot status, and do not relax `TRANSITIONS` in `bots/service.ts`.
- `server/bots/evaluator.ts` — `planStrategy` / `evaluateStrategy`. A *pure*
  function of the supplied ticks. Only a narrow block set is executable; a
  strategy containing anything else is **refused at start** rather than
  partially executed. Insufficient history yields `insufficient`, never an
  entry. Early selling (`check_sell`, `sell_price`, `sell_at_market` inside
  `during_purchase`) is implemented, so a strategy that uses it is runnable.
- `server/bots/runService.ts` — `startBotRun` / `tickBotRun` / `stopBotRun`.
- `server/bots/routes.ts` — `POST /api/bots/:id/run`,
  `POST /api/bots/runs/:runId/tick`, `POST /api/bots/runs/:runId/stop`,
  `GET /api/bots/runs`, `GET /api/bots/:id/run`, `GET /api/bots/markets`,
  `GET /api/bots/markets/:symbol/contracts`, `GET /api/bots/:id/compatibility`.
  The `GET /api/bots/runs` and `GET /api/bots/markets` routes must stay
  registered **before** `GET /api/bots/:id`, or `runs`/`markets` is read as an id.
- `AutoExecutionRunner.runForBot` shares `submitSignal` with the scanner loop, so
  there is exactly one purchase path. Bot intents carry no manual approval, so
  the gateway classifies them as automatic and `allowAutomaticTrading` must be on.
- `server/bots/markets.ts` — Synthetic-only market discovery. This is **not**
  `src/utils/eligibleMarkets.ts`; that file decides what the *scanner* may
  analyse and excludes Boom/Crash, Range Break and others. A customer's imported
  bot is a different product, so the Bots catalogue lists every Synthetic family
  Deriv publishes and only excludes non-synthetic markets. No symbol list is
  hardcoded: `active_symbols` is the source of truth. Discovery is bounded by
  `DISCOVERY_TIMEOUT_MS`, because `getActiveSymbols()` never settles on a dead
  connection and a route must not hang.
- `server/bots/compatibility.ts` — `evaluateCompatibility`. Answers a different
  question from `parser.ts`'s `classify()`: not "can this XML be interpreted" but
  "can it run on this symbol, with this contract, right now". States are
  `compatible` | `incompatible` | `unsupported` | `unavailable` | `invalid`, and
  only `compatible` may execute. Keep them distinct — collapsing "we have not
  implemented it" into "Deriv does not offer it" tells the customer the wrong
  thing. An empty contract catalogue is `unavailable`, never `compatible`.
- `src/components/bots/BotRunPanel.tsx` + `useBotRun` in `src/lib/bots.ts`.

Invariants worth keeping:

- DEMO only. A REAL account is refused, never downgraded to a demo run.
- One active run per bot; a second start is refused, not queued.
- The strategy is snapshotted by revision at start. An edit mid-run **fails** the
  run rather than silently trading the new version.
- Ticking is browser-driven, so closing the tab stops the bot. This is disclosed
  in the UI. An abandoned run (no tick for `RUN_IDLE_TIMEOUT_MS`) is settled on
  the next start so a customer can always restart; settling goes through
  `stopBotRun` so an uncertain submission is reconciled, never retried.
- Every tick re-checks the kill switches, so flipping `ALLOW_DEMO_EXECUTION` off
  stops a live run at its next tick.
- Tenant isolation is enforced by the store accessors (`getBotRun`,
  `listBotRuns`, `findActiveBotRun` all take `userId`); another tenant's run is a
  404, not a 403.
- `test:bot-run` covers the lifecycle, the refusals, isolation and the routes.
- `test:bot-markets` covers Synthetic discovery, contract discovery, the
  compatibility states and the digit/barrier adapters.

Contract families:

- `ContractFamily` is shared with the scanner, so the union covers every family
  the gateway may be asked to price. The scanner still only ever *selects*
  `rise_fall` (`MULTIPLIERS_ENABLED` is false); the extra members exist for bots.
- `DIGIT_PREDICTION_TYPES` is the single authority on which digit contracts need
  a prediction. `DIGITEVEN`/`DIGITODD` do **not**; `DIGITMATCH`/`DIGITDIFF`/
  `DIGITOVER`/`DIGITUNDER` do. Do not re-derive this with `startsWith('DIGIT')`.
- A CALL/PUT strategy that configures a barrier is Higher/Lower, not Rise/Fall.
  DBot writes the same contract types for both and distinguishes them only by the
  barrier, so the plan's family follows the barrier rather than assuming Rise/Fall.
- `runService` must take `contractFamily`/`contractType` from the plan. It once
  hardcoded `'rise_fall'`, which silently turned a digit bot into a Rise/Fall bot.
- Multipliers and Accumulators are visible but unimplemented; compatibility
  reports `unsupported` with a reason rather than pretending they are unavailable.

`JsonBackend.close()` now drains its write queue before releasing the lock;
without that a shutdown could lose the last record.

## Two compatibility vocabularies — do not conflate them

`CompatibilityLevel` (`src/lib/bots.ts`) and `CompatibilityState`
(`server/bots/compatibility.ts`) answer different questions and must not share
a copy map:

- `CompatibilityLevel` — `full | partial | unsupported | invalid`. How much of
  an imported DBot file this build understands. Stored on the bot record.
- `CompatibilityState` — `compatible | incompatible | unsupported |
  unavailable | invalid`. Whether a *saved* strategy can trade a *specific*
  symbol right now. Returned by `GET /api/bots/:id/compatibility`.

The availability panel once keyed its copy map by `full`/`partial`, so a
`compatible` verdict had no entry and rendered as a bare "Checked" — a silent
wrong answer rather than a visible error. `STATE_COPY` now lives in
`compatibilityCopy.ts`, is typed `Record<BotCompatibilityState, …>` so a missing
state fails to compile, and is checked against the server's
`COMPATIBILITY_STATES` array by `compatibilityCopy.test.ts`.

## The server has its own typecheck — `tsc --noEmit` does not cover it

`tsconfig.json` excludes `server`, so `npm run lint` (plain `tsc --noEmit`) will
happily pass while `server/` is broken. Use `npm run lint:server`
(`tsc --noEmit -p server/tsconfig.json`) for anything under `server/`. This bit
once: a required `BotRunRecord.variables` field was missing from the run literal
and the default typecheck never saw it.

`npm test` likewise only covers `src`. Server tests run via
`npm run test:server`, which is serial (`--test-concurrency=1`) on purpose:
several suites point a `Store` at `os.tmpdir()` and contend on the same lock
when files run in parallel.

## Two strategy engines: `plan` and `interpreter`

`planStrategy` picks one engine per strategy (`StrategyPlan.engine`):

- `plan` — the simplified dialect. Conditions are reduced to a flat list and
  compared by `evaluateStrategy`. Cannot branch, so `controls_if` and friends
  are not executable there.
- `interpreter` — a genuine DBot export, detected by `isDbProgram`. Runs the
  real `before_purchase` / `after_purchase` stacks from `server/bots/interpreter.ts`.

Consequences worth remembering:

- `EXECUTABLE` (in `evaluator.ts`) is the *union* of both engines' blocks.
  `planStrategy` checks against the set for the engine it will actually use
  (`PLAN_EXECUTABLE` vs `EXECUTABLE`), so a branching program is not refused for
  a limitation only the plan engine has.
- `evaluateStrategy` refuses an `interpreter` plan outright. An interpreter plan
  carries no condition list, and an empty condition list reads as "always
  trade" — a vacuous entry. Only `interpretTick` may decide for that engine.
- Variable field names differ by block: `VAR` for `variables_set`/`variables_get`,
  `math_change`, `text_append`, `controls_for`; `VARIABLE` for `text_join`,
  `lists_create_with`, and indicator blocks. `variableKey()` accepts both.
- Run variables live on `BotRunRecord.variables` (per run, never module-global),
  so two runs of one bot cannot read each other's state.

## Bot builder routing and UI shape

The app has **two routers**, and this trips up browser testing:

- `Root.tsx` resolves the *pathname*: the public marketing site is `/`, and the
  scanner workspace mounts at `/app` (guarded by `ProtectedRoute`, which sends
  anonymous visitors to `/login` only when `/healthz` answers — a static build
  skips the guard).
- Inside `/app`, `App.tsx` resolves the *hash*: `sectionFromHash()` parses
  `#/<section>` against `VALID_SECTIONS` (`botbuilder`, `mybots`, `dashboard`,
  …).

So the builder is `/app#/botbuilder`. `#/botbuilder` alone renders the landing
page, and `?section=botbuilder` does nothing — the section is read from the hash.

Session cookies are signed (`sign(value, secret, 'cookie-sign')` over an HKDF
key). To drive the API from curl, mint one with
`node --env-file=.env` and pass `-b "ws_session=<value>"`. `data/` is gitignored,
so bots imported while testing do not pollute the working tree.

The builder mirrors Deriv Bot's layout, which is worth keeping when editing it:

- `RunControl` floats over the canvas and owns run/stop plus the status chip.
  It is the *only* place a run is started — do not add a second run button.
- `RunPanel` is the right rail and is a readout: Summary / Transactions /
  Journal tabs, statistics tiles beneath them, reset in the footer.
- `useBotExecution` is the single owner of run state. Two `useBotRun` instances
  would each drive a tick loop and advance the bot twice per interval.
- Reset moves a *baseline*, not the data: statistics are derived from contracts
  the server owns and cannot be deleted, so the tiles report "since reset".

## DBot compatibility engine

`server/bots/` is a DBot interpreter, not a condition extractor. Two rules keep
the compatibility report honest:

- **Capability is derived, never listed.** `blocks.ts` computes `supported` from
  `isInterpreted()` in `interpreter.ts`. A hand-maintained list drifted from the
  interpreter once and reported 34 runnable blocks as unknown. If you add a
  block, add its handler — the catalogue follows.
- **Refuse, don't fake.** A block with no handler throws `UnsupportedBlockError`;
  a strategy whose conditions cannot be honoured is reported `partial` with the
  reason. `trade_definition_multiplier` is the live example. Do not add a handler
  that answers a block from a guess: a wrong answer trades the customer's money.
- **The palette and the runtime must agree, in both directions.**
  `toolbox.test.ts` asserts the palette offers nothing `EXECUTABLE` refuses
  *and* hides nothing it can run. The second half matters: 50 runnable blocks
  (every loop, procedure and text/list/math block) were unreachable from the
  editor because only 24 were listed. A block that runs but cannot be placed is
  a silent capability loss, not a cosmetic gap.

`trade_definition_tradeoptions_payout` is the worked example for "refuse, don't
fake". DBot aliases it to the ordinary trade-options block, so the fields look
identical, but its generator emits `basis: 'payout'` and its `AMOUNT` is a
**payout target, not a stake**. Every intent this build creates is
`basis: 'stake'` with `stake = plan.stake ?? 1`, so treating the payout figure as
a stake would have opened real contracts at the wrong size. It sits in
`DELIBERATELY_UNEXECUTED` with a reason, and a payout strategy reports as
non-runnable. The gateway already accepts `basis: 'payout'`; what is missing is
carrying a basis through `BotStakeConfig` and `plan.stake`, not transport.

Deriv-specific shapes that are easy to get wrong:

- Procedure *calls* keep the target name in `<mutation name="...">`; procedure
  *definitions* keep it in the `NAME` field. `procedureName()` reads both.
- Procedure parameters are `<mutation><arg name=... varid=...>` children. They
  are stored in `TreeNode.mutationChildren`; dropping them deletes the
  signature on save.
- `lists_create_with` is a *statement* that fills `VARIABLE` from a `STACK` of
  `lists_statement`, not a value expression like stock Blockly.
- `controls_whileUntil` throws "Infinite loop detected" at 10000 passes; the
  interpreter mirrors that cap rather than exiting quietly.
- `break`/`continue` are consumed by the loop that owns them. Only `halt` and
  `return` escape a loop body.

## Verification: what "supported" must mean

Five test files exist to keep the compatibility report honest. They are the
specification, so read them before changing the interpreter:

- `bot_stress.test.ts` — procedures: nested calls, repeated calls, shadowing,
  binding by name and by varid.
- `bot_loops.test.ts` — repeat/while/until/for against the official generators.
- `bot_xml_integrity.test.ts` — a semantic tree comparator, not a block count.
  Two real defects were found this way: `<comment>` was dropped on save, and
  `<mutation>` children were flattened into a map (losing parameter order).
  If you add a `TreeNode` field, add it to `semantic()` or the tests cannot
  see it.
- `bot_execution_safety.test.ts` — every entry is attributable to the run,
  audited, risk-checked, non-duplicable, stoppable and tenant-isolated.
- `bot_early_sell.test.ts` — pins the early-sell implementation to the real
  Deriv behaviour so it cannot regress into a guess.
- `bot_sell_rejection.test.ts` — every way a sale can fail is distinguished
  from success: `InvalidOfferings`, uncertain outcomes, and the full
  sell/expire lifecycles.

Early selling, verified from `packages/bot-skeleton/src/services/tradeEngine/`:

- `check_sell` → `Bot.isSellAvailable()` = `contractId && !isSold &&
  isSellAvailable && !isExpired`, where `isSellAvailable` comes from
  `is_valid_to_sell` on a live `proposal_open_contract`.
- `sell_price` → `Bot.getSellPrice()` = `getRoundedNumber(bid - buy, currency)`,
  i.e. `Number(diff.toFixed(digits))` where the digits come from the currency
  (USD 2, BTC 8, XRP 6, IDK 0). It is **not** an integer round: see
  `CURRENCY_FRACTIONAL_DIGITS` in `interpreter.ts`.
- `sell_at_market` → `Bot.sellAtMarket()` sends `{ sell: id, price: 0 }`. A zero
  price means "at market".

The three facts the blocks read (`is_valid_to_sell`, `bid_price`, `buy_price`)
are mapped by `mapContract()` and persisted on `ContractRecord`. A field Deriv
has not reported stays `null`, and the blocks treat `null` as "cannot decide",
never as a false answer. Do not default a missing bid to `0` or a missing verdict
to `false`: that would sell on data the engine never had.

`during_purchase` executes on every tick while a contract is open, in
`duringPurchaseStep` in `runService.ts`. Two rules are load-bearing:

- The sale goes through `gateway.closeContract`, never the broker directly. That
  is where ownership, the account lock, idempotency and the audit row live.
- A completed sale settles the contract, so the same tick continues into
  `after_purchase` — which is DBot's loop. Do not return early after a sale.
  A *refused* sale leaves the contract open and must not be followed by a new
  entry in the same tick; the open-contract guard below handles that.

A sale can fail three ways, and they are not interchangeable. Verified against
`tradeEngine/trade/Sell.js`:

- **`InvalidOfferings`** — the contract is too close to expiry to be offered.
  Deriv refused it, nothing was sold, and the same request cannot succeed. The
  broker maps it to `BrokerError.code === 'invalid_offerings'` (only for
  `sell`; a buy keeps the generic `rejected`), the gateway to
  `ExecutionError.code === 'close_offerings_unavailable'`. The run records
  `sellRefusedFor` / `sellRefusedReason` and stops asking for that contract,
  then lets it expire. DBot does the same: it swallows this error and lets the
  contract finish. Do not disable early selling globally, and do not treat
  other rejections as this one — the classification is by exact code.
- **Uncertain** (`close_pending`) — the request may have reached Deriv. Never
  assumed to have failed and never retried blindly. `duringPurchaseStep` calls
  `monitor.refreshContract` to read the contract's real state; the gateway's
  pending-close guard already blocks a duplicate submission in the meantime.
  The in-tick re-read is bounded (2s) so a slow answer cannot stall the loop;
  the contract's live subscription remains the authoritative path.
- **Any other refusal** — reported and left for the next tick, where Deriv's own
  `is_valid_to_sell` decides whether another attempt is reasonable.

A refusal is remembered per contract, so a new contract starts with a clean
slate and one bot's refusal never silences another. The tests for all of this
are in `bot_sell_rejection.test.ts`; the broker-level mapping is pinned in
`broker.test.ts`.

A strategy whose `during_purchase` stack cannot reach a sell is refused at plan
time, before any money moves. `planStrategy` rejects a value block in statement
position — a bare `check_sell`, say — because the interpreter throws
`UnsupportedBlockError` on it. That throw would land on the first tick *after*
the purchase, so the contract would be bought and then never managed: held open
until expiry with its sell branch unreachable. The check applies only to
programs routed to the interpreter; the simplified dialect puts a bare
`check_direction` in statement position on purpose and the plan engine models
that shape.

The run holds one contract at a time, as DBot does. `tickBotRun` refuses a new
entry while `lastContractId` is still open. The entry ceiling
(`run.counters.entries >= run.maxEntries`) caps *entries*, so it is checked
before a new entry but **after** the during-purchase and settlement steps —
checking it first would strand an open contract with no further ticks to sell or
settle it.

## Test harness notes

- Use the real `Store`, `ExecutionGateway`, `AutoExecutionRunner` and
  `ContractMonitor` with `FakeBroker`. Stubbing the gateway makes the safety
  assertions vacuous.
- Gateway audit rows: `execution.submit` is the pre-flight decision,
  `execution.purchase` is the confirmed buy, and `execution.risk` is written
  **only on refusal** — prove approval via the intent state and the signal's
  `consumedByIntentId` instead.
- Imports between server modules use `.js` specifiers (ESM).

## Block editor: undeclared types crash the whole load

`Blockly.Xml.domToWorkspace` throws `Invalid block definition for type: X` and
**abandons the entire load** on the first undefined type — it does not skip the
block. So every block the engine executes must also be *declared* in
`DBOT_DECLS` (`src/components/bots/editor/definitions.ts`), even ones we never
expect users to drag out.

Placeholders are not a substitute. `registerUnknownBlocks` only seeds types the
server reports as unsupported; a type the server *can* execute but the editor
never declares gets no placeholder and no declaration, and the import crashes.

When adding an engine handler, add the matching declaration — field names and
input names must match DBot's `message0`/`args0` shape exactly, because the XML
is the source of truth. `definitions.test.ts` parses the shipped
`Digit_Differs_AI.xml` and asserts this; extend that audit when you add blocks.

One legacy DBot type stays a placeholder on purpose: `loader` (fetches blocks
from a URL at run time). It is visible and preserved, never executed.

## The oldest generation keeps everything on a `market` block

Exports older than `trade_definition*` nest one `market` block inside the `trade`
block's `SUBMARKET` statement and hang market, contract, candle interval, stake
and duration off it. `parser.ts` reads those fields, and `evaluator.ts` reads
them for the plan, so a strategy is not reported as naming no symbol or no
contract just because it predates the current blocks.

Three rules there are not obvious:

- **`TYPE_LIST: both` is not a contract type.** It means "either direction" and
  DBot expands it through `config.opposites[tradeType]`; the author's `purchase`
  block picks one per entry. Both parser and planner expand it, because storing
  `both` would refuse the ordinary legacy configuration.
- **Legacy field values are renamed, not aliased.** `volidx`→`synthetic_index`,
  `risefall`→`callput`, `callputequal`→`callput`, `endsinout`/`staysinout`→
  `inout`. `LEGACY_FIELD_VALUES` in `blocks.ts` is the single table; both parser
  and planner go through `normaliseLegacyValue` so they cannot drift.
- **Declarations in `SUBMARKET` are initialisation.** DBot's
  `naivelyFixLegacyStrategyAfterConversion` moves every non-trade-options block
  out of `SUBMARKET` into `INITIALIZATION`, because `SUBMARKET` re-runs before
  each trade and a martingale counter kept there would reset every time.
  `runInitialization` applies the same rule, gated on the `market` block being
  present, and copies the blocks rather than re-linking them so the strategy
  tree is not rewritten.

`Great Martingale.xml` initialises nothing even though it is a martingale: its
variables are set inside a `procedures_defreturn` body, so they are function
scope, not top-level declarations. Empty `vars after init` is correct there.

## There is no candle data source

`MarketDataService` only ever requests `ticks_history` with `style: 'ticks'`, and
`TickContext` carries ticks alone. Every candle block (`ohlc`, `ohlc_values`,
`ohlc_values_in_list`, `get_ohlc`, `read_ohlc`, `read_ohlc_obj`,
`is_candle_black`) is therefore unbacked, and so are the indicators that read
candle closes. They are declared and preserved, never executed.

This is the single biggest compatibility lever left: of the 32 runnable
strategies in the 57 DBot examples, 6 are blocked by candle blocks and nothing
else, so adding them would take fully compatible strategies from 10 to 16. (11
files reference candle blocks with no other blocker, but 5 of those are snippets
missing mandatory blocks, which no amount of block support can make runnable.)

Two further gaps sit on the same path and must be fixed with it, not after:
`plan.timeframe` is computed but nothing consumes it as an indicator
granularity, and the tick buffer is never primed from `getTicksHistory` at run
start, so an SMA warms up from zero on a live run.

DBot's semantics, for whoever builds it: `getOhlc` maps the dropdown to a
`granularity` (`default` → the trade's candle interval, else 60), `get_ohlc` and
`read_ohlc` index **from the end** with a positive integer, `is_candle_black` is
`close < open`, and `read_ohlc_obj`/`ohlc_values` just project a field
(`open`/`high`/`low`/`close`/`epoch`).

## DBot `timeout` pauses the whole strategy, not just its body

DBot compiles the block to `sleep(n); <TIMEOUTSTACK>; <rest of the chain>`, so
everything after it waits. The interpreter signals this with a `suspend` flow
signal that must unwind loops and procedure calls exactly like `halt`; a handler
that swallows it makes a paused strategy look like a finished one.

Because a run is persisted between ticks, deferred work is stored on the run
record as XML (`stackToXml`/`xmlToStack`) rather than as a live tree, and each
deferral carries its `phase`. `before_purchase` and `after_purchase` resume into
different places, and `settleAfterPurchase` must return `waiting` rather than
reading "no `trade_again` yet" as a refusal — that bug silently ended strategies
that only asked to wait between contracts.

`isDbProgram` (in `interpreter.ts`) decides whether a strategy runs on the
interpreter or the plan engine. It must search nested statement inputs, not just
the top-level `<next>` chain: a `controls_if` wrapped in `timeout` or a loop is
still a decision, and judging it by the plan engine's narrow block set refuses a
program the interpreter can run.

## Verifying a bots fix

`npx tsx --test server/tests/bot_timeout.test.ts` for the deferral suite, and
`npx tsx --test $(find src server -name '*.test.ts')` for everything. The
harness in `server/tests/bot_run.test.ts` builds the real store, gateway, risk
engine and market service over a temp dir with only the broker faked; copy it
rather than stubbing. `BotRunDeps.now` is injectable — use it instead of
sleeping.

Before claiming a fix works, delete the fix and confirm the new test fails. A
test that passes either way proves nothing.

## The `/bot` app is a separate frontend

`bot-app/` is the Deriv bot frontend, vendored from upstream and built
independently with rsbuild. It is **not** part of the Vite/React SPA: it has its
own React Router, its own global SCSS resets and a different Blockly version. It
is mounted by the Express server at `/bot` (see the "vendored bot app" block in
`server/index.ts`) and reached from the sidebar's "Deriv Bot" link.

Keeping it separate is what preserves WickSentinel's hash routing. Do not import
`bot-app` source into `src/` or add it to the root `tsconfig` — both tsconfigs
exclude it for that reason.

`bot-app/rsbuild.bot.config.ts` sets `assetPrefix: '/bot/'` and injects
`process.env.NEXT_PUBLIC_BASE_PATH='/bot'`, which the router `basename` and the
logo/home links read. Any new absolute link inside `bot-app` must honour that
variable, or it will escape into the WickSentinel shell. Build with
`npm run build:bot`; the output (`bot-app/out/`) is git-ignored and
`server/tests/bot_app.test.ts` covers the mount with a synthetic build.

**The bot build needs dev dependencies.** Render builds with
`NODE_ENV=production`, and npm omits `devDependencies` in that mode.
`@rsbuild/core` is a devDependency of `bot-app`, so a plain
`npm --prefix bot-app install` leaves no `rsbuild` binary and the build fails
with `sh: 1: rsbuild: not found` (exit 127). `build:bot` therefore passes
`--include=dev`; keep it. The root build is unaffected because `vite` is a
runtime dependency. `server/tests/bot_routing.test.ts` pins this.

A missing bot build is not silent: `/bot` answers `503 bot_build_missing`
rather than letting the SPA fallback serve the WickSentinel shell, which has no
`/bot` route and renders its own 404.

### The bot app reuses the WickSentinel session

Because `/bot` is served from the same origin, a trader already signed in to the
scanner must not be asked to authorise Deriv again. There is exactly one SSO
path: `POST /api/bot/session` in `server/routes/botSession.ts`, called from
`DerivWSAccountsService.getWickSentinelWebSocketURL()`
(`bot-app/src/services/derivws-accounts.service.ts`).

That one request both identifies the session and mints the socket: it returns
the selected account, the accounts the session owns, and an account-bound
WebSocket URL. It enforces `requireSession`, an exact same-origin `Origin`, a
live (unexpired) Deriv token, and account ownership on every call, and it sets
`Cache-Control: no-store`. The OTP exchange happens server-side in
`requestDerivSocketUrl` precisely so the OAuth access token never reaches the
browser — keep it that way. Do not add a second session endpoint.

`getSocketURL` in `bot-app/.../config/config.ts` prefers that URL and only falls
back to the app's own OAuth token when there is no session, so the bot app still
works standalone.

### Balances are never fabricated

An unknown balance is `null`/`''`, never `0`. `useActiveAccount` renders a known
figure or "Unavailable"; `client.balance` starts empty and
`client.all_accounts_balance` is filled from live `balance` messages so the
account switcher shows real per-account figures. A `0.00` on screen must mean a
real zero balance.


## Admin console: Copy Trading client management

The admin app (`admin/`, built separately to `dist-admin/`) gained a Copy Trading
module and a read-only Bot Builder module. Both are additive; no existing route,
record or trader-facing behaviour was changed.

### Ownership model — read this before touching follower code

A `CopyTradingFollowerRecord.ownerUserId` is the **master**: the WickSentinel user
on whose behalf copied trades would be placed. The record's `derivSub` and
`accounts` identify the **client** whose Deriv account is the source. So
"assign a client to a master" means *setting `ownerUserId`*, and there is no
second assignment table. `clientView()` in `server/routes/admin/copyTrading.ts`
resolves both sides: master via `getUserById(ownerUserId)`, client via
`getUserByDerivSub(derivSub)`.

Do not confuse this with the Users module, where a user's own accounts are their
own. Copy Trading is the only place one user's record points at another user.

### The copy-execution engine

`CopyExecutionEngine` (`server/copyTrading/engine.ts`) fans a DEMO manager trade
out to the manager's connected followers. It is reached from two places: the
manual/auto execution path and `tickBotRun` in `server/bots/runService.ts`, which
mirrors a bot's entry like any other manager trade. Both pass the engine in as an
optional dependency (`copyEngine?`), so a build without it still trades.

`mirrorMasterTrade` returns early unless the signal is DEMO and the master's
switch is on, and it never throws for a normal skip or rejection: a refused
follower is audited and the rest still copy. The bot call site swallows a mirror
failure on purpose — the bot's own contract is already open by then.

The old "no engine" wording is gone from the admin UI; `engine.implemented` is
true on `/dashboard/summary`. Do not reintroduce a notice that claims less than
the backend does.

### Two authorization paths, one validator

- **OAuth** (`authMethod: 'oauth'`): the client authorizes their own account
  through `/auth/copy-trading/connect/:id` → the callback in `routes/auth.ts`.
  The platform never sees the credential. Removing the follower revokes the
  grant via `revokeToken`.
- **API token** (`authMethod: 'pat'`): an administrator submits a client-supplied
  token. It is validated by `server/copyTrading/pat.ts` (`validatePatToken`),
  which is the *same* function the trader route calls — there is exactly one
  validator, so a token accepted by one path is accepted by the other. It is
  sealed with AES-256-GCM before persistence and never returned, logged, or
  written to an audit record. A PAT cannot be revoked by us; removal says so
  rather than pretending the credential is dead.

`pat.ts` also enforces that the PAT App ID (`DERIV_PAT_APP_ID`) is distinct from
the OAuth App ID. When it is unset the endpoint returns `503
pat_app_not_configured` instead of falling back to the OAuth app.

### Consent is a separate record

`copyTradingConsents` (keyed by `followerId`) holds the consent attestation,
independent of the credential. Token authorization refuses with
`consent_required` unless `consent === true`. The OAuth callback writes a consent
record automatically, because the client approving the grant *is* the consent.
Do not fold consent into the follower record — it has its own lifecycle and is
deleted with the follower.

### Invitations do not create accounts

`UserRecord` has no email field: accounts exist only after a Deriv identity is
verified. An invitation therefore stores the email on the invitation, not on a
user, and "duplicate" means an outstanding invitation for that address — never a
fabricated user. Only the SHA-256 hash of the single-use secret is stored, so the
link is shown once and cannot be recovered.

### Copying is opt-in, per master

`copyTradingControls` (keyed by `ownerUserId`) holds one switch per master. The
engine reads it in `mirrorMasterTrade` and returns `[]` when it is off, so a
manager's trade is theirs alone until someone presses Start. The switch is off by
default and is per master, not global: starting one master must never start
another. Stopping affects the *next* trade only — it cannot cancel a contract the
broker already accepted.

Two surfaces toggle it: `POST /api/admin/v1/copy-trading/control` (needs
`copytrading.control`) and `POST /api/copy-trading/control` for the signed-in
manager, scoped to their own id. Starting with no connected client returns `409
no_followers` rather than silently doing nothing.

### Readiness is a read-only projection

`server/copyTrading/readiness.ts` answers "would a new DEMO trade be mirrored to
anyone right now?" from persisted state alone. It **never writes**: it does not
create a missing `copyTradingControl` and does not enable one. A missing control
is reported as `enabled: false` because that is literally how the engine reads it
(`getCopyTradingControl` → `null`, falsy `enabled`, `mirrorMasterTrade` returns
`[]`). This is why a data wipe can never surface as ready: with no followers the
state is `NO_FOLLOWERS`, and a leftover enabled switch with an empty roster is
still not ready.

Each check carries a `scope`. `connection` and `authorization` are **follower**
checks — the client roster. `broker` and `reconciliation` are **execution**
checks — the master's own ledger, and they are evaluated even when no client is
connected. This matters because the two call for different action, and because
execution faults must not be mistaken for a client problem.

States, in precedence order: `DEGRADED`, `AWAITING_AUTHORIZATION` (invitations
out, none connected), `NO_FOLLOWERS`, `PAUSED` (eligible clients, switch off or
absent), `READY`. `UNKNOWN` covers a master that cannot be resolved or a store
read that throws. DEGRADED outranks PAUSED and NO_FOLLOWERS deliberately: a pause
or an empty roster must not hide a broken credential or a stuck purchase.

`state` collapses several situations that all leave copying with nothing to do,
so the payload reports the roster shape separately in `roster`:
`EMPTY` (no records), `AWAITING_AUTHORIZATION` (no records *and* invitations
outstanding), `ALL_HELD` (records exist, every one paused/suspended),
`NONE_ELIGIBLE` (records exist, none held, none usable) and `HAS_ELIGIBLE`.
`AWAITING_AUTHORIZATION` deliberately requires zero records: once a record
exists, an unusable client is a credential problem rather than a wait, and
calling it "awaiting" would hide the record. `counts` reports `followers`,
`eligible`, `held`, `disconnected` and `pendingInvitations` directly, and every
follower lands in exactly one of eligible / held / disconnected.

Credential readability is checked for every follower, held or not. A hold means
the engine skips the client, not that its sealed token is irrelevant: gating the
check on the hold would let `connection` report "readable" about a credential
that provably is not, and would hide a rotated session secret behind an admin
hold.

When the state is DEGRADED, `degraded` names the source so the console can say
*why*: `by` (which scopes failed), `follower` and `execution` (the failing check
keys) and a one-line `summary`. It is `null` in every other state, so a consumer
cannot read a stale reason.

Fail-safe rule, unchanged and load-bearing: unresolved master purchase outcomes
(`UNKNOWN` intents) and `RECONCILIATION_REQUIRED` intents are execution checks
that take part in the ordinary failing-check test, so they keep the state out of
READY even when every client is eligible. Readiness never *causes* replication —
it only reports on it.

Eligibility reuses the engine's own `isHeld` / `isTradable` predicates so the two
cannot drift. `READY` carries `guarantee: false` — it means prerequisites are
satisfied, not that a trade will execute; the kill switches, risk engine and
broker all still apply. Surfaced at
`GET /api/admin/v1/copy-trading/readiness` (`copytrading.read`) and rendered by
`admin/src/components/CopyReadinessPanel.tsx`, which has no controls of its own.

### Performance reporting reads across principals

A copied contract is owned by `copy_follower_<followerId>`, a synthetic
principal, so the manager's owner-scoped `listContracts` never sees it.
`server/copyTrading/performance.ts` instead calls `listContractsForUsers()` with
the master plus every follower principal and attributes each contract back to its
account. Accounts are enumerated from the *user records*, so an account that has
not traded still shows a zero row — the manager sees the whole book.

Both surfaces expose it: `GET /api/admin/v1/copy-trading/performance?masterUserId=`
and `GET /api/copy-trading/performance` (scoped to the session user). It is a
read-only projection; it never places, sizes or alters a trade.

### Client balances are read through the client's own credential

A client balance is not in the store and is not derived from P/L. Both surfaces
read it live from Deriv over the follower's sealed token, reusing `BalanceService`
(so the per-account cache, the 8-second timeout and the Deriv-host guard apply):

- `GET /api/admin/v1/copy-trading/clients/:id/balance` (`copytrading.read`) —
  masks account ids; `?refresh=1` bypasses the cache.
- `GET /api/copy-trading/followers/:id/balance` — the id is looked up inside
  `listCopyTradingFollowers(req.user.id)`, so ownership is proven by the manager's
  own list and a foreign id is a 404, not a read.

The principal is `copy_follower_<followerId>` with the follower's own accounts, so
`BalanceService`'s ownership and mode checks still apply. DEMO and REAL are always
reported separately, a null balance is never rendered as zero, and an expired or
unreadable token returns `available: false` with a reason rather than a figure.
Both surfaces render "—" for a missing number.

The balance columns sit next to the profit/loss column on the manager's
performance table and on the admin copy-engine panel; the admin client drawer
shows the full per-account breakdown.

### Permissions

`copytrading.read | onboard | authorize | followers.manage | risk.manage |
control` in `server/admin/permissions.ts`. Only `SUPER_ADMIN` and `PLATFORM_ADMIN`
mutate; `FINANCE_ADMIN`, `SUPPORT_AGENT` and `ANALYST` are read-only. The
read-only roles must stay read-only — a support agent can look, not connect, and
cannot start the engine.

### Pause and suspend stop future work only

`POST /clients/:id/status` blocks *future* copied submissions. It cannot cancel a
contract the broker has already accepted, and the response says so verbatim. Keep
that wording: it is the difference between a truthful control and a dangerous
one.

### Bot Builder admin is read-only by design

`server/routes/admin/bots.ts` lists imports and runs across all owners via
`listAllImportedBots()` / `listAllBotRuns()`. It never executes, edits or deletes,
and it reports the compatibility verdict *recorded at import* — it must never
re-derive a `partial` or `unsupported` bot as supported.

### Verification

`npm run test:copy-admin` covers the module (35 tests), including that no token
appears in a response or an audit record, that a mismatched token is refused
before any record is written, and that read-only roles cannot mutate. Deriv is
faked at the HTTP level in `server/tests/copy_trading_admin.test.ts`; the real
`server/config.ts` hardcodes the Deriv endpoints, so a live server cannot be
pointed at a fake — use the test harness, not a running process, for token flow.

### The invitation page must not send `form-action`

`GET /auth/copy-trading/connect/:id` renders a two-button choice page; the
"I Already Have a Deriv Account" button is a same-origin POST that answers 302
into Deriv's authorization flow.

CSP3 applies `form-action` to the form's request *and to every redirect that
request follows*. This page once sent `form-action 'self'`, which silently
blocked the redirect: the POST succeeded, a transaction was created, and the
browser then refused to navigate, so the button looked dead. Widening the list
does not fix it either — Deriv's chain moves to `home.deriv.com` when the visitor
must sign in, and any host added later would break it again. The directive is
deliberately absent; `default-src 'none'`, script-free markup, escaping,
`no-store` and `no-referrer` are what protect the page. Do not reintroduce it
without a browser click-through test; `curl` alone cannot see this bug.

### Referral link has a code default

`derivReferralUrl` resolves to a built-in referral link when
`DERIV_REFERRAL_URL` is unset, so the signup button works on a fresh deployment
with no configuration. A malformed override warns and falls back; it is never
silently dropped, because dropping it previously hid the button with no
explanation.

### Production trades nothing by default

`render.yaml` ships `ALLOW_EXECUTION`, `ALLOW_DEMO_EXECUTION`,
`ALLOW_REAL_EXECUTION` and `ALLOW_AUTOMATIC_TRADING` all `false`. Connecting an
account therefore does not move money: a copy requires the manager's
`/api/copy-trading/control` switch *and* these server-side flags. They are read
from the environment only and have no setter, so enabling them needs a deliberate
env change and a restart.
