# WickSentinel — Deployment Guide (Staging & Production)

## Prerequisites

- Node.js 24+ (project uses Node 24 global WebSocket)
- npm or bun (project has `bun.lock` but npm works)
- Git

## 1. Build

```bash
npm install                    # install deps (use --legacy-peer-deps if peer conflicts)
npm run build                  # trader SPA → dist/
npm run build:admin            # admin console → dist-admin/
npm run build:bot              # vendored bot app → bot-app/out/bot (optional)
```

Verify: `dist/index.html` exists, `dist-admin/index.html` exists.

## 2. Environment variables

Copy `.env.example` to `.env` and fill in:

**Required:**
- `DERIV_APP_ID` — Deriv OAuth app ID
- `DERIV_REDIRECT_URI` — exact callback URL (e.g. `https://app.example.com/auth/deriv/callback`)
- `SESSION_SECRET` — ≥32 chars, generate: `openssl rand -base64 48`

**Optional (defaults shown):**
- `PORT=8787`
- `NODE_ENV=production`
- `STORAGE_ENGINE=auto` (auto|json|sqlite)
- `DATA_DIR=./data`
- `DERIV_SCOPES=trade`
- `SESSION_TTL_SECONDS=604800`
- `REDIS_URL` (unset = in-process cache)
- `ALLOW_EXECUTION=false` (keep false until ready)
- `ALLOW_DEMO_EXECUTION=false`
- `ALLOW_REAL_EXECUTION=false` (never set true without authorization)
- `ALLOW_AUTOMATIC_TRADING=false`
- Admin vars: `ADMIN_SESSION_TTL_SECONDS`, `ADMIN_ALLOWED_ORIGINS`, etc.
- `WHATSAPP_*` vars (if using alerts)

**Never commit `.env` files with real credentials.**

## 3. Database migration

```bash
# Migrate JSON → SQLite (server must be stopped)
npm run db:migrate

# Verify (read-only)
npm run db:migrate -- --verify-only
```

- Source JSON is never modified.
- Timestamped backup created automatically.
- Migration refuses to run if DB already exists.

## 4. Seed first admin

```bash
# Interactive
npm run admin:bootstrap

# Non-interactive
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='strong-pass' ADMIN_NAME='Admin' npm run admin:bootstrap
```

Store the TOTP secret and recovery codes securely.

## 5. Start (staging)

```bash
NODE_ENV=development npm run server    # backend on :8787
# In another terminal:
npm run dev                            # Vite on :3000 (proxies /auth, /api, /healthz)
```

Verify:
- `curl http://localhost:3000/healthz` → `{ "ok": true }`
- `curl http://localhost:3000/auth/start?mode=login` → 302 to auth.deriv.com

## 6. Start (production)

```bash
NODE_ENV=production npm run server
```

The server serves `dist/` as static files with SPA fallback. Admin at `dist-admin/` if configured.

## 7. Render deployment (when authorized)

### Option A: Single paid web service (recommended for staging)

1. Create Render Web Service (Node environment).
2. Build command: `npm install && npm run build && npm run build:admin`
3. Start command: `npm run server`
4. Health check path: `/healthz`
5. Set all env vars from `.env.example`.
6. Add persistent disk (paid, $0.25/GB/mo) mounted at `./data`.
7. Run migration via Render shell: `npm run db:migrate`
8. Bootstrap admin via Render shell.
9. Verify `/healthz` and auth flow.

### Option B: Free tier (demo only)

Same as Option A but `plan: free`. Data is ephemeral (lost on sleep). Kill switches must remain off. Do not enable trading.

## 8. Rollback

```bash
# Stop server
# Restore from backup (migration creates wicksentinel.json.backup-<timestamp>)
# Or start with STORAGE_ENGINE=json to use the original JSON file
STORAGE_ENGINE=json npm run server
```

## 9. Health verification

```bash
curl https://your-app.onrender.com/healthz
# Expected: {"ok":true}
```

## 10. Monitoring

- Render provides basic logs and health checks.
- Check `/healthz` for uptime.
- Monitor server logs for errors, broker connection status.
- Execution status is not externally monitored yet (recommend enhancement).

## 11. Security checklist

- [ ] `SESSION_SECRET` ≥32 chars, unique per environment
- [ ] `NODE_ENV=production` (enables HTTPS enforcement)
- [ ] `ALLOW_REAL_EXECUTION=false` (never enable without authorization)
- [ ] `ADMIN_ALLOWED_ORIGINS` set for cross-origin admin
- [ ] No `.env` files committed
- [ ] Admin MFA enrolled
- [ ] Kill switches verified off

## 12. What Render Free cannot support

- Continuous automated trading (service sleeps)
- Persistent financial records (ephemeral filesystem)
- Always-on bot execution
- Real-time contract monitoring across sleep cycles
- WebSocket connections survive sleep

**Do not enable live-money execution on Render Free.**
