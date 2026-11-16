import path from 'node:path';

/**
 * Server configuration, read once from the environment.
 *
 * Nothing here is ever sent to the browser. The OAuth client secret (when the
 * registered flow uses one) and the session signing secret stay server-side.
 */

export interface ServerConfig {
  port: number;
  isProduction: boolean;
  dataDir: string;
  /**
   * Persistence engine. `auto` uses SQLite when a database file is present and
   * JSON otherwise; `sqlite`/`json` force one. Set STORAGE_ENGINE to pin it.
   */
  storageEngine: 'auto' | 'json' | 'sqlite';
  /**
   * Optional Redis cache. When REDIS_URL is set the server keeps a shared,
   * in-memory cache in Redis for hot, recomputable data (the Deriv symbol
   * catalogue, market snapshots and scanner readings) so repeated reads do not
   * re-hit the upstream socket. It is a cache only: losing it never loses a
   * trade, a session or a signal. When unset, an in-process fallback is used and
   * the app behaves exactly as before.
   */
  redis?: {
    url: string | null;
    /** Prefix for every key, so several environments can share one server. */
    keyPrefix: string;
    /** Default entry TTL, in seconds, for cached values. */
    ttlSeconds: number;
  };
  /** Client telemetry retention and liveness. */
  telemetry: {
    /** Days of activity events to keep; older rows are pruned at boot. */
    retentionDays: number;
    /** Scanner rows unseen for longer than this are pruned. */
    scannerSessionTtlSeconds: number;
  };
  deriv: {
    appId: string;
    redirectUri: string;
    clientSecret: string | null;
    scopes: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string;
    revocationEndpoint: string;
    apiBaseUrl: string;
  };
  session: {
    secret: string;
    ttlSeconds: number;
    cookieName: string;
    oauthCookieName: string;
    oauthCookieTtlSeconds: number;
  };
  /** Administrative surface. Separate cookie, TTL and origin allowlist. */
  admin: {
    cookieName: string;
    sessionTtlSeconds: number;
    mfaPendingTtlSeconds: number;
    invitationTtlSeconds: number;
    resetTtlSeconds: number;
    /** Explicit CORS allowlist for credentialed admin requests. Never "*". */
    allowedOrigins: string[];
    /** Maximum failed logins before a temporary lockout. */
    maxFailedLogins: number;
    lockoutSeconds: number;
  };
  /** Public origin allowed for same-origin checks on the callback. */
  appOrigin: string;
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for the full list.`
    );
  }
  return value.trim();
}

function int(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Validates STORAGE_ENGINE. An unknown value is a config error, not a silent default. */
function parseEngine(value: string | undefined): ServerConfig['storageEngine'] {
  const v = value?.trim().toLowerCase();
  if (!v) return 'auto';
  if (v === 'auto' || v === 'json' || v === 'sqlite') return v;
  throw new Error(`STORAGE_ENGINE must be one of auto, json, sqlite (got "${value}").`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const isProduction = env.NODE_ENV === 'production';
  const appId = required('DERIV_APP_ID', env.DERIV_APP_ID);
  const redirectUri = required('DERIV_REDIRECT_URI', env.DERIV_REDIRECT_URI);
  const secret = required('SESSION_SECRET', env.SESSION_SECRET);

  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long.');
  }

  let appOrigin = '';
  try {
    appOrigin = new URL(redirectUri).origin;
  } catch {
    throw new Error(
      'DERIV_REDIRECT_URI must be an absolute URL (e.g. https://app.example.com/auth/deriv/callback).'
    );
  }

  return {
    port: int(env.PORT, 8787),
    isProduction,
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.resolve(process.cwd(), 'data'),
    storageEngine: parseEngine(env.STORAGE_ENGINE),
    redis: {
      // Redis is opt-in: no URL means the in-process cache is used and the
      // server behaves exactly as before. A URL (redis:// or rediss://) turns on
      // the shared cache. It is never required for correctness.
      url: env.REDIS_URL?.trim() || null,
      keyPrefix: env.REDIS_KEY_PREFIX?.trim() || 'wicksentinel:',
      ttlSeconds: Math.max(1, int(env.REDIS_TTL_SECONDS, 60))
    },
    telemetry: {
      // 90 days is enough to compute 30-day DAU/MAU with history to spare.
      retentionDays: Math.max(1, int(env.TELEMETRY_RETENTION_DAYS, 90)),
      // Keep a scanner row for 1 hour after its last heartbeat.
      scannerSessionTtlSeconds: Math.max(60, int(env.SCANNER_SESSION_TTL_SECONDS, 3600))
    },
    deriv: {
      appId,
      redirectUri,
      // Deriv's OAuth 2.0 + PKCE flow does not use a client secret for public
      // clients (token_endpoint_auth_methods_supported includes "none"). It is
      // only used if the registered app is a confidential client.
      clientSecret: env.DERIV_CLIENT_SECRET?.trim() || null,
      // Minimum scope required. Deriv's OAuth scopes are `trade`,
      // `account_manage`, `application_read` and `payment`; `openid` is NOT
      // allowed for Deriv OAuth apps (Deriv returns invalid_scope), so the
      // trade-scoped accounts endpoint is the only identity source. `trade`
      // also backs the dashboard's account selection and demo/real separation.
      // It is read-only here: no write scope (account_manage/payment) is ever
      // requested. If `openid` is later enabled for the app, set
      // DERIV_SCOPES=openid to identify via userinfo without any trading scope.
      scopes: env.DERIV_SCOPES?.trim() || 'trade',
      authorizationEndpoint: 'https://auth.deriv.com/oauth2/auth',
      tokenEndpoint: 'https://auth.deriv.com/oauth2/token',
      userinfoEndpoint: 'https://auth.deriv.com/userinfo',
      revocationEndpoint: 'https://auth.deriv.com/oauth2/revoke',
      apiBaseUrl: 'https://api.derivws.com'
    },
    session: {
      secret,
      ttlSeconds: int(env.SESSION_TTL_SECONDS, 60 * 60 * 24 * 7),
      cookieName: 'ws_session',
      oauthCookieName: 'ws_oauth',
      oauthCookieTtlSeconds: 600
    },
    admin: {
      cookieName: 'ws_admin_session',
      sessionTtlSeconds: int(env.ADMIN_SESSION_TTL_SECONDS, 60 * 60 * 8),
      mfaPendingTtlSeconds: int(env.ADMIN_MFA_PENDING_TTL_SECONDS, 300),
      invitationTtlSeconds: int(env.ADMIN_INVITATION_TTL_SECONDS, 60 * 60 * 48),
      resetTtlSeconds: int(env.ADMIN_RESET_TTL_SECONDS, 60 * 60),
      // Comma-separated allowlist. Empty in dev (same-origin via the Vite proxy).
      allowedOrigins: (env.ADMIN_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      maxFailedLogins: int(env.ADMIN_MAX_FAILED_LOGINS, 5),
      lockoutSeconds: int(env.ADMIN_LOCKOUT_SECONDS, 15 * 60)
    },
    appOrigin
  };
}
