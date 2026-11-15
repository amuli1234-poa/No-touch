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
  `index.html` resolves it before React mounts so there is no flash. Dark is the
  default; a stored choice overrides it. Use the `useTheme()` hook;
  `setTheme`/`toggle` write the attribute.
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
- Kill switches: `ALLOW_EXECUTION`, `ALLOW_DEMO_EXECUTION`, `ALLOW_REAL_EXECUTION`
  — all default false; parsed strictly (`=== 'true'`). REAL needs the master
  switch **and** its own flag. Never settable at runtime.
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

## Automatic scanning (Phase 10)

- `server/services/marketScanner.ts` (`MarketScanner`) is the loop that *feeds*
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
  when `ALLOW_EXECUTION` and `ALLOW_DEMO_EXECUTION` are both on; stopped on
  shutdown. `GET /api/execution/scanner` returns per-user status (`test:scanner`).
- **Local gotcha:** the switches live in the environment, and `.env` is
  git-ignored, so a fresh clone has them OFF — the scanner will not start and
  every trade is rejected. Set `ALLOW_EXECUTION=true` and
  `ALLOW_DEMO_EXECUTION=true` in `.env` and restart the backend (see
  `.env.example`). The status endpoint reports `reason` (`execution_disabled` /
  `demo_execution_disabled`) and the Trade panel shows it, so the cause is
  visible rather than a silent "not running".

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
2. Manual execution (confirm → place) — next.
3. Raise the conservative risk caps (currently maxOpen=3, exposure=$30, freq=30s).
4. Automatic scanning loop across the eligible volatility indices.
5. Tests + demo verification, then an explicit real-execution release.
