# WickSentinel — Hosting Architecture & Deployment Plan

## 1. Existing architecture

WickSentinel is a monorepo with three deployable surfaces:

| Surface | Build | Output | Port |
|---|---|---|---|
| Trader SPA | `vite build` | `dist/` | served by Express |
| Backend API | `tsx server/index.ts` | n/a (Node) | `PORT` (default 8787) |
| Admin console | `vite build --config admin/vite.config.ts` | `dist-admin/` | separate origin |
| Bot app (vendored) | `npm run build:bot` | `bot-app/out/bot` | served at `/bot` |

Storage: JSON file (`data/wicksentinel.json`) or SQLite (`data/wicksentinel.db`), selected by `STORAGE_ENGINE` (auto/json/sqlite). No PostgreSQL adapter exists.

Auth: Deriv OAuth 2.0 + PKCE, server-side sessions (signed HttpOnly cookies). Admin: separate cookie + TOTP MFA.

Trading execution: server-side gateway, broker (Deriv OTP-URL flow), risk engine, contract monitor. DEMO-only by default (kill switches).

## 2. Recommended production architecture

**Single Render Web Service** serving both the built frontend (`dist/`) and the Express backend API on one origin. This avoids CORS complexity and keeps the session cookie same-origin.

```
Render Web Service (Node)
├── Express (server/index.ts)
│   ├── /healthz, /auth/*, /api/*, /api/admin/v1/*
│   ├── /bot/* (vendored bot app)
│   └── static: dist/ (SPA fallback)
├── SQLite (data/wicksentinel.db) on persistent disk
└── Optional: Redis (if REDIS_URL set)
```

Admin console (`dist-admin/`) can be served from the same service at `/admin` or a separate static site.

## 3. Render Free assessment

| Feature | Render Free | Impact on WickSentinel |
|---|---|---|
| Service sleeping | After 15 min inactivity | **Critical:** trading execution stops; bot runs halt; WebSocket connections drop |
| Ephemeral filesystem | Data lost on restart/sleep | **Critical:** JSON/SQLite data lost unless persistent disk (paid) or external DB |
| RAM | 512 MB | Adequate for Express + SQLite |
| CPU | Shared, limited | Adequate for current load |
| WebSockets | Supported | Deriv WS connections work but drop on sleep |
| Background workers | Not supported on Free | Auto-trading scanner cannot run continuously |
| Cold start | 30-60s | Users see loading on first request |

**Conclusion:** Render Free is suitable for **demonstration, staging, and limited testing only**. It is **not suitable** for continuous automated trading or persistent financial records. For production trading, either:
- Use Render paid tier with persistent disk (SQLite) + always-on service, OR
- Migrate to Supabase PostgreSQL (requires new adapter) + Render paid for execution.

## 4. Database architecture

**Current:** JSON or SQLite, file-based, on local filesystem.

**Problem for Render Free:** Ephemeral filesystem → data loss on every restart/sleep.

**Options:**
1. **SQLite on Render persistent disk** (paid tier, $0.25/GB/mo) — simplest, keeps existing code. Requires Render paid service ($7/mo).
2. **Supabase PostgreSQL** — requires building a new `PostgresBackend` adapter implementing the `Backend` interface in `server/store/backend.ts`. No adapter exists today. This is the proper long-term solution but requires development work.
3. **JSON/SQLite on Render Free** — acceptable for demo only. Data resets on sleep.

**Recommendation:** Start with SQLite on Render paid tier for simplicity. Plan Postgres adapter for production scale.

**No production migrations should be run until the adapter is built and tested.**

## 5. Trading execution architecture

The execution gateway, risk engine, and contract monitor run in-process with the Express server. On Render Free:
- Service sleep kills all execution.
- Auto-trading scanner stops.
- Open contracts are not monitored.

For production: the execution service should be a separate always-on process (or Render paid with no sleep). The current architecture does not support splitting execution from the web service without refactoring.

**Recommendation:** Keep execution in-process for now. Document the limitation. Plan separation for production.

## 6. Domain and networking

- Production domain: not yet configured. Plan for `app.wicksentinel.com` or similar.
- HTTPS: Render provides automatic HTTPS.
- CORS: `ADMIN_ALLOWED_ORIGINS` must be set for cross-origin admin.
- Cookies: `Secure` flag auto-enabled in production (`NODE_ENV=production`).
- WebSocket: Deriv WS is browser-side; no server-side WS proxy needed.

## 7. Security

Already implemented:
- OAuth 2.0 + PKCE (no client secret for public clients).
- Signed HttpOnly session cookies (HMAC + AES-256-GCM token sealing).
- Admin: separate cookie, TOTP MFA, RBAC, CSRF double-submit.
- Kill switches (env-only, all default false).
- Rate limiting on execution endpoints.
- Input validation via `normalisePreferences`.
- No secrets in frontend bundle.

Remaining:
- `SESSION_SECRET` must be ≥32 chars, generated via `openssl rand -base64 48`.
- `DERIV_CLIENT_SECRET` optional (only for confidential clients).
- Admin bootstrap requires `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_NAME` env vars or interactive CLI.

## 8. Backup and recovery

- SQLite: Render persistent disk snapshots (paid) or manual `cp data/wicksentinel.db`.
- JSON: file-based, backup via `wicksentinel.json.backup-*` (migration creates these).
- Audit log: append-only, never mutated.
- Recovery: restore from backup, run `--verify-only`.

## 9. Monitoring

- Health check: `GET /healthz` → `{ ok: true }`.
- Render provides basic health checks and logs.
- Trading execution status: not externally monitored. Recommend adding execution status to `/healthz` or a separate endpoint.
- Error tracking: not configured. Recommend Sentry or similar (optional).

## 10. Estimated monthly costs

| Component | Render Free | Render Paid (Starter) | Supabase Free |
|---|---|---|---|
| Web service | $0 (sleeps) | $7/mo (always-on) | n/a |
| Persistent disk | n/a | $0.25/GB/mo | n/a |
| PostgreSQL | n/a | n/a | $0 (500MB, 2 projects) |
| Redis | n/a (in-process fallback) | $0 (Upstash free) | n/a |

**Minimum production (paid):** ~$7-10/mo for always-on service + disk.
**Demo/staging (free):** $0 but with sleep and data loss.

## 11. Migration sequence (when authorized)

1. Set environment variables on Render.
2. Build: `npm run build` (frontend) + `npm run build:admin` (admin).
3. Start: `npm run server` (or `tsx server/index.ts`).
4. Run migration: `npm run db:migrate` (if migrating JSON→SQLite).
5. Verify: `npm run db:migrate -- --verify-only`.
6. Bootstrap admin: `npm run admin:bootstrap`.
7. Health check: `GET /healthz`.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Data loss on Render Free | Use paid tier with persistent disk, or migrate to Postgres |
| Service sleep kills trading | Use paid always-on, or document as demo-only |
| No Postgres adapter | Plan adapter development; SQLite on disk as interim |
| Cold start delays | Acceptable for demo; paid tier reduces |
| Secret exposure | Never commit .env; use Render env vars |

## 13. Deployment procedure (when authorized)

1. Create Render Web Service (Node environment).
2. Set build command: `npm install && npm run build && npm run build:admin`.
3. Set start command: `npm run server`.
4. Configure all env vars from `.env.example`.
5. Add persistent disk mounted at `./data` (paid tier).
6. Run migration and bootstrap via Render shell.
7. Verify `/healthz`.
8. Test auth flow end-to-end.

## 14. What Render Free cannot reliably support

- Continuous automated trading (service sleeps).
- Persistent financial records (ephemeral filesystem).
- Always-on bot execution.
- Real-time contract monitoring across sleep cycles.
- WebSocket connections survive sleep.

**Do not enable live-money execution on Render Free.**

## 15. How demo and real trading modes are protected

- Kill switches default to `false` (env-only, never runtime-settable).
- `ALLOW_REAL_EXECUTION` requires master switch AND its own flag.
- Account-mode verification enforced server-side (gateway checks ownership + mode).
- DEMO and REAL accounts strictly separated (no cross-mode execution).
- Risk engine fails closed on unknown balance.
- No martingale; max open positions, exposure limits, frequency caps enforced.

## 16. Deeper audit findings (Phase 4 verification)

### Storage abstraction
- StorageBackend interface in server/store/backend.ts with 12 methods: open, close, loadKeyed, loadAppend, putKeyed, deleteKeyed, appendRecord, deleteAppendBefore, loadSingleton, putSingleton, transaction, counts.
- 53 collections defined in COLLECTIONS array (users, sessions, signals, contracts, ledgerEntries, etc.).
- Two implementations: JsonBackend and SqliteBackend. No Postgres adapter exists.
- COLLECTION_SPECS defines keyed vs append, key fields, and index fields — designed for DB portability.

### Shared state / singletons (would break if split)
- BalanceService (per-process, shared cache)
- MarketDataService (WebSocket connection, in-memory tick buffers)
- ExecutionGateway, AutoExecutionRunner, ContractMonitor (in-process, share store + broker)
- Telemetry, ExecutionAuditor
- All instantiated in createApp() and passed via AppBundle.

Splitting web/worker would require: shared database, message queue or event bus for execution triggers, and distributed locking for idempotency. Not feasible without significant refactoring.

### Health endpoint
- GET /healthz returns { ok: true } unconditionally.
- Does NOT check: store connectivity, market data connection, broker status, or execution health.
- Recommendation: Enhance to check store + market data before reporting healthy.

### Process lifecycle
- Graceful shutdown on SIGINT/SIGTERM: closes market data, contract monitor, store.
- process.once handlers (single-fire).
- Store close is async with .finally(() => process.exit(0)).

### Security audit (verified)
- OAuth: PKCE S256, no client secret for public clients.
- Sessions: signed HttpOnly cookies, AES-256-GCM token sealing.
- Admin: separate cookie, TOTP MFA, RBAC, CSRF double-submit.
- Kill switches: env-only, === 'true' strict parsing, no runtime setter.
- Rate limiting: 120/min signals, 30/min submits per user.
- Input validation: normalisePreferences validates all writes.
- SQL injection: N/A (SQLite with parameterized queries).
- XSS: React escapes by default.
- CORS: explicit allowlist for admin; never * for credentialed requests.

### Blockers (implementation order)
1. Postgres adapter — implement PostgresBackend implementing StorageBackend interface. Required for persistent data on Render.
2. Health endpoint enhancement — add store/market/broker checks.
3. Execution service separation — only if continuous trading needed on paid tier; requires message queue.
4. Admin console hosting — serve dist-admin/ at /admin or separate origin.
5. Monitoring — add execution status to health endpoint or separate endpoint.
6. Backup automation — Render disk snapshots or scheduled DB dumps.

### Cost estimate (updated)
| Option | Monthly cost | Capabilities |
|---|---|---|
| Free (demo) | $0 | Sleeps, ephemeral data, no trading |
| Paid single service + disk | ~$7-10 | Always-on, persistent SQLite, in-process execution |
| Paid + separate worker + Supabase | ~$14-20 | Always-on, Postgres, separated execution (requires adapter + queue) |
