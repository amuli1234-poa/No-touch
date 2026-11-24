<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/ce44c8a1-975b-43b5-8479-4d969876d77b

## Run Locally

**Prerequisites:**  Node.js

1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

### Deriv OAuth login (local development)

Logging in with Deriv needs **both** servers running: the Vite dev server on
port **3000** (the browser hits it and it proxies `/auth/*` to the backend) and
the auth backend on port **8787**.

1. Create a `.env` file from `.env.example` and set:
   - `DERIV_APP_ID` — the app id from [app.deriv.com/app-registration](https://app.deriv.com/app-registration)
   - `DERIV_REDIRECT_URI=http://localhost:3000/auth/deriv/callback`
   - `SESSION_SECRET` — at least 32 chars, e.g. `openssl rand -base64 48`
2. In the Deriv dashboard, register the Redirect URI
   `http://localhost:3000/auth/deriv/callback` (it must match
   `DERIV_REDIRECT_URI` character-for-character).
3. Start both servers together:
   `npm run dev:all`

Then open `http://localhost:3000/login` and click **Login with Deriv**.

> `npm run dev` starts only Vite. If you use it, start the backend separately
> with `npm run server`, or the callback fails (connection refused on :3000, or
> a 502 when the backend on :8787 is down).

### Deriv Bot app (`/bot`)

`bot-app/` is the Deriv bot frontend, vendored from the upstream bot repo and
served as a **separate React app under `/bot`**. It has its own router, its own
global styles and its own dependencies, so it is deliberately *not* bundled into
the WickSentinel SPA — that keeps WickSentinel's hash routing
(`/#dashboard`, `/#scanner`, …) untouched.

Build it once (the backend serves the result, and the build output is
git-ignored):

```bash
npm run build:bot     # installs bot-app deps and builds into bot-app/out/bot
```

Then `npm run dev:all` (or `npm run server`) serves:

| URL      | Served by                                             |
| -------- | ----------------------------------------------------- |
| `/`      | WickSentinel SPA (`dist/`, hash routing)              |
| `/bot`   | Deriv bot app (`bot-app/out/bot`, own browser router) |
| `/api/*` | WickSentinel backend                                  |

`bot-app` is built with a matching asset prefix and router `basename` (see
`bot-app/rsbuild.bot.config.ts`), so its internal links and assets stay inside
its mount path instead of escaping to the WickSentinel shell. The **Deriv Bot**
entry in the sidebar includes the Vite base path, which is required on
GitHub Pages project sites. The Pages workflow builds the bot with that same
base path and includes it in `dist/bot`; local Express deployments continue to
serve `bot-app/out/bot` directly. Until `build:bot` has been run locally,
`/bot` logs a warning and falls through to the WickSentinel shell.
