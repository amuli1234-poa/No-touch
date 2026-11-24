import React, { lazy, Suspense, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { ToastContainer } from 'react-toastify';
import AuthLoadingWrapper from '@/components/auth-loading-wrapper';
import useLiveChat from '@/components/chat/useLiveChat';
import ChunkLoader from '@/components/loader/chunk-loader';
import { getUrlBase } from '@/components/shared';
import TransactionDetailsModal from '@/components/transaction-details';
import { api_base, ApiHelpers, ServerTime } from '@/external/bot-skeleton';
import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { useApiBase } from '@/hooks/useApiBase';
import useDevMode from '@/hooks/useDevMode';
import { useStore } from '@/hooks/useStore';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import { ThemeProvider } from '@deriv-com/quill-ui';
import { setSmartChartsPublicPath } from '@deriv-com/smartcharts-champion';
import { localize } from '@deriv-com/translations';
import { botNotification } from '@/components/bot-notification/bot-notification';
import Audio from '../components/audio';
import BlocklyLoading from '../components/blockly-loading';
import BotStopped from '../components/bot-stopped';
import BotBuilder from '../pages/bot-builder';
import Main from '../pages/main';
import './app.scss';
import '../components/bot-notification/bot-notification.scss';

// App Builder live-preview branding listener. Mounted only in the preview deployment
// (NEXT_PUBLIC_APP_BUILD === 'true'); the inline check is constant-folded by rsbuild so
// the import — and all of src/preview/ — is dead-code-eliminated from standalone partner
// builds (where the BFF strips src/preview/ entirely).
const PreviewBranding =
    process.env.NEXT_PUBLIC_APP_BUILD === 'true' ? lazy(() => import('../preview/preview-branding')) : null;

// Upper bound on waiting for the socket before rendering the UI anyway. Matches
// the guard in app-root.tsx.
const API_INIT_TIMEOUT_MS = 5000;

// Upper bound on waiting for active symbols before rendering the shell without
// them.
const SYMBOLS_LOAD_TIMEOUT_MS = 15000;

const AppContent = observer(() => {
    const [is_api_initialized, setIsApiInitialized] = React.useState(false);
    const [is_loading, setIsLoading] = React.useState(true);

    const store = useStore();
    const { app, transactions, common, client } = store;
    const { is_dark_mode_on } = useThemeSwitcher();

    const { recovered_transactions, recoverPendingContracts } = transactions;
    const is_subscribed_to_msg_listener = React.useRef(false);
    const msg_listener = React.useRef(null);
    const connection_warning_shown = React.useRef(false);
    const { connectionStatus } = useApiBase();

    // Initialize dev mode keyboard shortcuts
    useDevMode();

    // The OAuth app id warning was removed with the disabled auth buttons: this
    // build defers sign-in to WickSentinel, so a missing local app id is expected
    // rather than a misconfiguration.

    const livechat_client_information = {
        is_client_store_initialized: client?.is_logged_in ? true : !!client,
        is_logged_in: client?.is_logged_in,
        loginid: client?.loginid,
        currency: client?.currency,
        residence: client?.residence,
        email: '',
        first_name: '',
        last_name: '',
    };

    useLiveChat(livechat_client_information);

    // NOTE: Disabled Intercom until further notice
    // const token = V2GetActiveToken() ?? null;
    // useIntercom(token);

    useEffect(() => {
        if (connectionStatus === CONNECTION_STATUS.OPENED) {
            connection_warning_shown.current = false;
            setIsApiInitialized(true);
            common.setSocketOpened(true);
        } else if (connectionStatus !== CONNECTION_STATUS.OPENED) {
            common.setSocketOpened(false);
        }
    }, [common, connectionStatus]);

    // The loader below is gated on `is_api_initialized`, which otherwise only
    // flips when the WebSocket reports OPENED. A socket that never opens (blocked
    // network, rejected authorisation) would leave the app on "Initializing Deriv
    // Bot account..." forever, so fall through to the UI after a bounded wait.
    // The app-root loader already uses the same guard.
    useEffect(() => {
        if (is_api_initialized) return undefined;

        const timeoutId = setTimeout(() => {
            setIsApiInitialized(true);
        }, API_INIT_TIMEOUT_MS);

        return () => clearTimeout(timeoutId);
    }, [is_api_initialized]);

    useEffect(() => {
        if (connectionStatus === CONNECTION_STATUS.OPENED) return undefined;

        const timeoutId = setTimeout(() => {
            if (connection_warning_shown.current) return;
            connection_warning_shown.current = true;
            console.warn('[Deriv Bot] WebSocket connection did not open before the loading timeout.');
            botNotification(
                localize('Could not connect to Deriv. Check your connection and sign in if needed.'),
                undefined,
                { type: 'warning' }
            );
            // Show the app shell so a slow or unavailable feed cannot trap the
            // user on the initial loading screen indefinitely.
            setIsLoading(false);
        }, 20000);

        return () => clearTimeout(timeoutId);
    }, [connectionStatus]);

    const { current_language } = common;
    const html = document.documentElement;
    React.useEffect(() => {
        html?.setAttribute('lang', current_language.toLowerCase());
        html?.setAttribute('dir', current_language.toLowerCase() === 'ar' ? 'rtl' : 'ltr');
    }, [current_language, html]);

    const handleMessage = React.useCallback(
        ({ data }) => {
            if (data?.msg_type === 'proposal_open_contract' && !data?.error) {
                const { proposal_open_contract } = data;
                if (
                    proposal_open_contract?.status !== 'open' &&
                    !recovered_transactions?.includes(proposal_open_contract?.contract_id)
                ) {
                    recoverPendingContracts(proposal_open_contract);
                }
            }
        },
        [recovered_transactions, recoverPendingContracts]
    );

    React.useEffect(() => {
        setSmartChartsPublicPath(getUrlBase('/js/smartcharts/'));
    }, []);

    React.useEffect(() => {
        // Check if api is initialized and then subscribe to the api messages
        // Also we should only subscribe to the messages once user is logged in
        // And is not already subscribed to the messages
        if (!is_subscribed_to_msg_listener.current && client.is_logged_in && is_api_initialized && api_base?.api) {
            is_subscribed_to_msg_listener.current = true;
            msg_listener.current = api_base.api.onMessage()?.subscribe(handleMessage);
        }
        return () => {
            if (is_subscribed_to_msg_listener.current && msg_listener.current) {
                is_subscribed_to_msg_listener.current = false;
                msg_listener.current.unsubscribe?.();
            }
        };
    }, [is_api_initialized, client.is_logged_in, client.loginid, handleMessage, connectionStatus]);

    const init = () => {
        ServerTime.init(common);
        app.setDBotEngineStores();
        ApiHelpers.setInstance(app.api_helpers_store);
        import('@/utils/gtm').then(({ default: GTM }) => {
            GTM.init(store);
        });
    };

    const changeActiveSymbolLoadingState = async () => {
        init();
        setIsLoading(true);

        try {
            // The API helper may be registered slightly after the socket opens.
            // Bound the wait so a missing helper cannot leave the whole app on a
            // permanent account-initialization screen.
            const deadline = Date.now() + 15000;
            while (!ApiHelpers?.instance?.active_symbols && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 250));
            }

            const activeSymbols = ApiHelpers?.instance?.active_symbols;
            if (!activeSymbols) throw new Error('Deriv active-symbol service did not initialize.');

            let timeoutId;
            try {
                await Promise.race([
                    activeSymbols.retrieveActiveSymbols(true),
                    new Promise((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('Deriv active-symbol request timed out.')), 15000);
                    }),
                ]);
            } finally {
                clearTimeout(timeoutId);
            }
            if (activeSymbols.has_initialization_error) {
                throw new Error('Deriv did not return the active-symbol catalogue.');
            }
        } catch (error) {
            console.error('Failed to initialize Deriv active symbols:', error);
            botNotification(
                localize('Could not load Deriv markets. The bot will open, but market lists may be unavailable.'),
                undefined,
                { type: 'warning' }
            );
        } finally {
            setIsLoading(false);
        }
    };

    React.useEffect(() => {
        if (is_api_initialized) {
            init();
            if (!client.is_logged_in) {
                changeActiveSymbolLoadingState();
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [is_api_initialized]);

    React.useEffect(() => {
        if (client.is_logged_in && is_api_initialized) {
            changeActiveSymbolLoadingState();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [is_api_initialized, client.loginid]);

    if (common?.error) return null;

    return (
        <React.Fragment>
            {PreviewBranding && (
                <Suspense fallback={null}>
                    <PreviewBranding uiReady={!is_loading} />
                </Suspense>
            )}
            {is_loading ? (
                <ChunkLoader message={localize('Initializing Deriv Bot account...')} />
            ) : (
                <AuthLoadingWrapper>
                    <ThemeProvider theme={is_dark_mode_on ? 'dark' : 'light'}>
                        <BlocklyLoading />
                        <div className='bot-dashboard bot' data-testid='dt_bot_dashboard'>
                            <Audio />
                            <Main />
                            <BotBuilder />
                            <BotStopped />
                            <TransactionDetailsModal />
                            <ToastContainer limit={3} draggable={false} />
                        </div>
                    </ThemeProvider>
                </AuthLoadingWrapper>
            )}
        </React.Fragment>
    );
});

export default AppContent;
