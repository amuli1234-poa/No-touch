# WickSentinel Admin — Operations Guide

The admin console is a **separate application** from the trader app. It has its
own entry HTML, source root, build output and API namespace. Deploying it does
not change the trader app, and the trader app runs unchanged without it.

- Frontend: `admin/` → builds to `dist-admin/`
- Backend API: `server/routes/admin/` → served under `/api/admin/v1`
- Seed command: `npm run admin:bootstrap`

---

## 1. Design language

The console follows **reateach360.com**. Tokens in `admin/src/styles/theme.css`
are lifted from that site's live stylesheet:

| Token | Value | Use |
| --- | --- | --- |
| `--blue` | `#0068b5` | primary buttons, links, active nav, focus rings |
| `--blue-dk` | `#0057a0` | hover / pressed |
| `--blue-light` | `#60a5fa` | dark-mode links and highlights |
| `--ink` … `--ink-5` | `#0a1628` … `#cbd5e1` | text ramp |

Violet (`#7c3aed`) is kept only as a restrained accent for status badges, matching
reateach360's own `.dp-badge-purple` usage. The older WickSentinel violet
(`#635BFF` / `#8057E5`) is retired.

Typography: **Plus Jakarta Sans** (headings/UI), **Inter** (body), **JetBrains
Mono** (code, IDs, numerics). Light and dark are both first-class; the theme
toggle persists to `localStorage` and is applied before first paint.

---

## 2. Local development

```bash
# 1. Backend (also serves the trader app) on :8787
npm run server

# 2. Admin frontend on :3001, proxying /api/admin to :8787
npm run dev:admin
```

Open `http://localhost:3001`. The Vite dev proxy forwards `/api/admin/v1` and
`/healthz` to the backend, so cookies are same-origin and no CORS is involved.

### Seed the first administrator

There is no public admin registration route. The only way to create the first
Super Admin is the bootstrap CLI:

```bash
npm run admin:bootstrap
# or non-interactively:
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='a-strong-password' \
ADMIN_NAME='Your Name' \
npm run admin:bootstrap
```

It prints an `otpauth://` URI and a secret. On first sign-in the console shows an
enrolment step: confirm a TOTP code and it displays eight one-time recovery codes.
**Those codes are shown once — store them in a password manager.**

---

## 3. Production build and deploy

```bash
npm run build        # trader app  → dist/
npm run build:admin  # admin app   → dist-admin/
```

`dist-admin/` is a self-contained static bundle. Serve it from its own origin (or
its own path) — for example `admin.example.com`, or `/admin` on the same host with
`ADMIN_BASE=/admin/`. Because it is a single-page app, rewrite unknown paths to
`dist-admin/index.html`.

### Cross-origin deployment

If the admin app is on a different origin from the API, set an explicit allowlist
(never `*`, since credentialed requests are used):

```bash
ADMIN_ALLOWED_ORIGINS="https://admin.example.com"
```

The server echoes the origin only when it matches, and always with
`Access-Control-Allow-Credentials: true`.

---

## 4. Environment variables

All optional; the defaults are safe for development.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_SESSION_TTL_SECONDS` | `28800` (8h) | admin session lifetime |
| `ADMIN_MFA_PENDING_TTL_SECONDS` | `300` | window to finish the MFA step |
| `ADMIN_INVITATION_TTL_SECONDS` | `172800` (48h) | invitation validity |
| `ADMIN_RESET_TTL_SECONDS` | `3600` | password-reset token validity |
| `ADMIN_ALLOWED_ORIGINS` | *(empty)* | comma-separated CORS allowlist |
| `ADMIN_MAX_FAILED_LOGINS` | `5` | failed attempts before lockout |
| `ADMIN_LOCKOUT_SECONDS` | `900` | lockout duration |

`SESSION_SECRET` (shared with the trader app) signs the admin cookie using a
distinct signing context, so a trader cookie can never be replayed as an admin
cookie.

---

## 5. Security model

- **Separate session.** Admins get their own HttpOnly cookie
  (`ws_admin_session`), their own signed session records, and a distinct signing
  context. Trader sessions are never accepted on `/api/admin/v1`, and vice versa
  (verified by test).
- **Two-step authentication.** Password (scrypt-hashed) then TOTP. First sign-in
  enrols MFA and issues one-time recovery codes. Failed attempts are rate-limited
  per account and per IP.
- **RBAC.** Five roles (Super Admin, Platform Admin, Finance Admin, Support
  Agent, Analyst) plus per-account extra permissions. The server checks the
  permission on every request; the UI only hides controls it knows are denied.
- **CSRF.** Double-submit token: a random token is issued with the session and
  must be echoed in `X-CSRF-Token` on every state-changing request.
- **Last-Super-Admin protection.** The final active Super Admin cannot be
  demoted or suspended.
- **Audit log.** Every sensitive action is appended with actor, target, previous
  and new state, reason, correlation id and source IP. The API exposes **no**
  mutation route for audit records — the log is append-only by construction.
- **Suspension is enforced server-side.** Suspending a user is enforced on the
  existing trader authorization path, so it takes effect on the user's next
  request — not merely as a UI label.
- **Protected controls.** Trading-safety and security settings (entries per
  candle, account-mode validation, scanner thresholds, OAuth credentials) are
  deliberately outside the admin surface and cannot be changed from it.

---

## 6. What is intentionally reported as unavailable

This deployment has no billing provider, no client-side telemetry heartbeat and
no event history. Rather than fabricate figures, the console states plainly that
these are unavailable:

- **Subscriptions / Revenue** — no payment gateway or billing records exist.
- **Scanner sessions / signals generated** — the engines run in the browser and
  send no telemetry to the server.
- **Daily / monthly active users, retention, churn, feature usage** — require an
  event history the platform does not retain.

Each of these has a working page and empty state; the figures populate
automatically once the underlying source (a billing provider, a client
heartbeat, or an events table) is connected. Service health shows `UNKNOWN` for
exactly these reasons.

---

## 7. Tests

```bash
npm test           # strategy engine (48)
npm run test:auth  # trader auth (16)
npm run test:admin # admin surface (20)
npm run lint       # trader typecheck
npm run lint:admin # admin typecheck
```

The admin suite covers the login/MFA flow, RBAC denial for each role, trader
cookie rejection, last-Super-Admin protection, suspension enforcement, audit
content (and that secrets are never stored), CSRF, and rate limiting.
