/**
 * Single sign-on bridge between WickSentinel and this bot app.
 *
 * The bot app is served from the same origin as WickSentinel and therefore
 * shares its session cookie. When that session exists the trader is already
 * authenticated, so this module adopts it instead of showing a second Deriv
 * login:
 *
 *   GET  /api/bot/session  -> the accounts this session owns
 *   POST /api/bot/ws-url   -> a single-use authenticated WebSocket URL
 *
 * The OAuth access token never reaches the browser; only the OTP URL does.
 */

export interface WickSentinelAccount {
    accountId: string;
    type: 'demo' | 'real';
    currency: string | null;
}

interface WickSentinelSession {
    authenticated: boolean;
    accounts: WickSentinelAccount[];
    defaultAccountId: string | null;
    tokenExpiresAt?: number;
}

const SESSION_ENDPOINT = '/api/bot/session';
const WS_URL_ENDPOINT = '/api/bot/ws-url';

// Marks that the keys below were written by this bridge, so signing out of
// WickSentinel can clear them without touching a genuine bot-app OAuth login.
const ADOPTED_FLAG = 'ws_sso_adopted';

let sessionPromise: Promise<WickSentinelSession | null> | null = null;


const readSession = async (): Promise<WickSentinelSession | null> => {
    try {
        const res = await fetch(SESSION_ENDPOINT, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const data = (await res.json()) as WickSentinelSession;
        return data?.authenticated ? data : null;
    } catch {
        return null;
    }
};

/**
 * Resolves the WickSentinel session once per page load.
 *
 * The result is cached as a promise so the several callers that race at startup
 * (socket creation, account list) share a single request.
 */
export const loadWickSentinelSession = (): Promise<WickSentinelSession | null> => {
    if (!sessionPromise) sessionPromise = readSession();
    return sessionPromise;
};

/**
 * Seeds the localStorage/sessionStorage keys the bot skeleton reads, so a
 * WickSentinel login looks like an account the bot app has already chosen.
 */
const adoptSession = (session: WickSentinelSession) => {
    const account =
        session.accounts.find(a => a.accountId === session.defaultAccountId) ?? session.accounts[0];
    if (!account) return null;

    localStorage.setItem('active_loginid', account.accountId);
    localStorage.setItem('account_type', account.type);
    localStorage.setItem(ADOPTED_FLAG, '1');

    // api-base rebuilds the account switcher from `deriv_accounts`, and the
    // switcher reads `balance` as a string.
    sessionStorage.setItem(
        'deriv_accounts',
        JSON.stringify(
            session.accounts.map(a => ({
                account_id: a.accountId,
                account_type: a.type,
                currency: a.currency ?? 'USD',
                balance: '0',
                group: '',
                status: 'active',
            }))
        )
    );

    return account.accountId;
};

/**
 * Drops keys seeded by {@link adoptSession} once the WickSentinel session is
 * gone, so a signed-out trader is not left looking half-authenticated. Keys from
 * a genuine bot-app OAuth login are left alone.
 */
const releaseAdoptedSession = () => {
    if (localStorage.getItem(ADOPTED_FLAG) !== '1') return;
    localStorage.removeItem('active_loginid');
    localStorage.removeItem('account_type');
    localStorage.removeItem(ADOPTED_FLAG);
    sessionStorage.removeItem('deriv_accounts');
};

/**
 * Returns an authenticated WebSocket URL for the signed-in trader, or null when
 * there is no WickSentinel session (the bot app then uses its own OAuth flow).
 */
export const getWickSentinelWebSocketUrl = async (): Promise<string | null> => {
    const session = await loadWickSentinelSession();
    if (!session) {
        releaseAdoptedSession();
        return null;
    }

    const accountId = adoptSession(session);
    if (!accountId) return null;

    const url = await requestWebSocketUrl(accountId);
    if (url !== undefined) return url;

    // A 401 means the cached view of the session is stale (the token lapsed or
    // the trader signed out in another tab). Re-read it once before giving up.
    sessionPromise = null;
    const refreshed = await loadWickSentinelSession();
    if (!refreshed) {
        releaseAdoptedSession();
        return null;
    }

    const retryId = adoptSession(refreshed);
    if (!retryId) return null;

    const retried = await requestWebSocketUrl(retryId);
    return retried ?? null;
};

/** Returns the URL, or `undefined` when the session was rejected (401). */
const requestWebSocketUrl = async (accountId: string): Promise<string | null | undefined> => {
    try {
        const res = await fetch(WS_URL_ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ accountId }),
        });
        if (res.status === 401) return undefined;
        if (!res.ok) return null;
        const data = (await res.json()) as { url?: string };
        return typeof data?.url === 'string' && data.url !== '' ? data.url : null;
    } catch {
        return null;
    }
};
