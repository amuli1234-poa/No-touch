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
