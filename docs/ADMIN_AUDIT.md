# WickSentinel Admin — Milestone 0 Repository Audit

## Existing architecture (as found)

| Concern | Reality in repo |
| --- | --- |
| Frontend | Vite 8 + React 19 + TS + Tailwind 4 (`@tailwindcss/vite`), SPA at `src/`, mounts at `/`, `/app`, `/login` via `src/Root.tsx` and a tiny pathname router (`src/lib/router.ts`). |
| Backend | Express 4 in `server/` (`server/index.ts` `createApp`), started with `tsx`. Serves `dist/` + API. |
| Database | **No SQL database.** A single JSON file `data/wicksentinel.json` behind `server/store/store.ts` (`Store` class): collections `users`, `sessions`, `oauthTransactions`. Serialised writes, atomic tmp+rename. |
| Auth | Deriv OAuth 2.0 Authorization Code + PKCE (`server/routes/auth.ts`, `server/lib/deriv.ts`, `server/lib/pkce.ts`). Session = HMAC-signed opaque id in HttpOnly cookie `ws_session`; Deriv access token AES-256-GCM sealed at rest (`server/lib/crypto.ts`). |
| User identity | `UserRecord.id = u_<base64url(derivSub)>`. **No email, name or password** — identity is the Deriv OIDC `sub` (+ account ids fallback). |
| Migrations | None. JSON is created on first run; `load()` maps known collections and defaults the rest. |
| Tests | `src/tests/strategy_engine.test.ts` (48 engine tests), `server/tests/auth.test.ts` (16 auth tests), `node:test`. |
| CI | `.github/workflows/deploy-pages.yml` — builds `dist/` with Bun, deploys to GitHub Pages. |
| Design system | `src/index.css` tokens: navy `#060b16`, blue `#0068B5`, accents `#2E8AD8`/`#60A5FA`; Plus Jakarta Sans / Inter / JetBrains Mono; radii 8/10/14/18; card shadows. |

## Missing services (requested by the admin spec, absent in repo)

- **Billing / subscriptions / payments** — no gateway (Stripe/Paddle/Paystack), no plan, no invoice table, no subscription record. Revenue/MRR/churn cannot be computed from real data.
- **Telemetry / metrics** — no APM, no request counters, no scanner-session registry, no engine error sink.
- **Support / tickets** — none.
- **Announcements / notifications** — only an outbound WhatsApp alert route (`server/routes/whatsapp.ts`), which is a *signal dispatch* channel, not a user-notification system.
- **Email / user name** — user profiles carry neither.
- **Audit log** — none.

Per the spec (§20), these gaps are **documented, not fabricated**: the admin UI shows honest "unavailable / no source" states where no real data exists, and new collections are created empty rather than seeded with fake rows.

## Design-language conflict (resolved)

The spec §16 says "restrained violet accents", but the recorded design language (and the live reatech360.com stylesheet, fetched 2026-11-13) shows the product is **blue-led** (`#0068B5` / `#2563eb`), with violet `#7c3aed` used only as a *restrained accent* (badges, stat-icon-purple, a single CTA). Violet `#635BFF`/`#8057E5` was explicitly retired. Decision: **follow reatech360.com** — navy/charcoal base, blue primary, violet used sparingly for accent. Documented in `admin/src/styles/theme.css`.

## Compatibility risks

1. `Store.load()` maps a fixed set of collections -> new collections must be defaulted or older data files break. *Mitigation: additive defaults.*
2. Admin must **not** reuse the trader cookie (`ws_session`) -> separate cookie `ws_admin_session`, separate signing context.
3. Admin session validation must **not** alter `requireSession` used by trader routes. *Mitigation: new middleware, trader middleware untouched.*
4. Suspension must be enforced by the **existing** session/authorization path, not a label. *Mitigation: `requireSession` consults `user.suspended`.*
5. Adding files must not break the Pages build. *Mitigation: admin is a separate build; root `build` script unchanged.*
