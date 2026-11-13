import React, { useEffect } from 'react';
import { ArrowRight, ArrowLeft, ShieldCheck, Eye, Loader2, AlertTriangle, Lock } from 'lucide-react';
import { BrandLogo } from '../brand/WickSentinelBrand';
import { WsButton } from './primitives';
import { navigate } from '../../lib/router';
import { startDerivAuth, useAuth } from '../../lib/auth';

interface AuthPageProps {
  mode: 'login' | 'get-started';
}

const COPY = {
  login: {
    eyebrow: 'Account access',
    title: 'Log in to WickSentinel',
    description:
      'Sign in with your Deriv account to reach your scanner workspace and saved calibration history.',
    primary: 'Login with Deriv',
    secondary: 'New here? Sign up with Deriv'
  },
  'get-started': {
    eyebrow: 'Get started',
    title: 'Start with WickSentinel',
    description:
      'Create your WickSentinel profile with a Deriv account and open the market intelligence workspace.',
    primary: 'Sign Up with Deriv',
    secondary: 'Already have an account? Login with Deriv'
  }
} as const;

const DerivMark: React.FC<{ className?: string }> = ({ className = 'h-4 w-4' }) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
    <circle cx="8" cy="8" r="8" fill="currentColor" opacity="0.15" />
    <path d="M8 3.2l4.2 2.4v4.8L8 12.8 3.8 10.4V5.6L8 3.2z" fill="currentColor" opacity="0.9" />
  </svg>
);

/**
 * Authentication entry point. Both actions use the same registered Deriv OAuth
 * application; the difference is only the `prompt` parameter the backend adds
 * (registration vs login). No credentials are ever requested by this page.
 */
export const AuthPage: React.FC<AuthPageProps> = ({ mode }) => {
  const copy = COPY[mode];
  const auth = useAuth();

  // An already-authenticated visitor is sent straight to their workspace.
  useEffect(() => {
    if (auth.status === 'authenticated') navigate('/app');
  }, [auth.status]);

  const handleDeriv = () => startDerivAuth(mode === 'login' ? 'login' : 'signup');
  const handleSwitch = () => navigate(mode === 'login' ? '/get-started' : '/login');

  return (
    <div className="relative flex min-h-screen flex-col bg-app">
      <div className="surface-grid pointer-events-none absolute inset-0 opacity-[0.25]" />
      <div className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-accent/12 blur-[130px]" />

      <header className="relative z-10 border-b border-[var(--ws-hairline)]">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <BrandLogo onClick={() => navigate('/')} />
          <button
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-1.5 rounded-[9px] px-3 py-2 text-[13px] font-semibold text-fg-3 transition-colors hover:bg-surface-raised hover:text-fg-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to home
          </button>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-14 sm:px-8">
        <div className="w-full max-w-md">
          <div className="rounded-[18px] border border-[var(--ws-hairline)] bg-surface p-6 shadow-[var(--shadow-modal)] sm:p-8">
            <span className="inline-flex items-center gap-2 rounded-full border border-[var(--ws-hairline)] bg-surface-deepest px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-accent-soft">
              {copy.eyebrow}
            </span>

            <h1 className="mt-5 text-[24px] font-extrabold leading-tight tracking-[-0.03em] text-fg-1 sm:text-[27px]">
              {copy.title}
            </h1>
            <p className="mt-3 text-[13.5px] leading-relaxed text-fg-4">{copy.description}</p>

            {auth.status === 'loading' && (
              <div className="mt-6 flex items-center gap-2 text-[12.5px] text-fg-5">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking your session…
              </div>
            )}

            <div className="mt-6 space-y-2.5">
              <WsButton
                size="lg"
                className="w-full"
                onClick={handleDeriv}
                icon={<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
              >
                <span className="inline-flex items-center gap-2">
                  <DerivMark className="h-4 w-4" />
                  {copy.primary}
                </span>
              </WsButton>
              <WsButton variant="secondary" size="lg" className="w-full" onClick={handleSwitch}>
                {copy.secondary}
              </WsButton>
            </div>

            <p className="mt-4 text-[11.5px] leading-relaxed text-fg-5">
              You'll be redirected to Deriv to {mode === 'login' ? 'sign in' : 'register'}. WickSentinel
              never sees your Deriv password and requests no trading or payment permissions.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--ws-hairline)] pt-5 text-[11.5px] text-fg-5">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-tint-teal" />
                Official Deriv OAuth 2.0 + PKCE
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5 text-tint-sky" />
                Public market data only
              </span>
            </div>
          </div>

          <p className="mt-5 text-center text-[11px] leading-relaxed text-fg-6">
            WickSentinel is an independent market intelligence platform and is not affiliated with or
            endorsed by Deriv.
          </p>
        </div>
      </main>
    </div>
  );
};

/* --------------------------------------------------------------------------
   Auth error — rendered when Deriv returns an error or state validation fails
   -------------------------------------------------------------------------- */

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  cancelled: {
    title: 'Authorization cancelled',
    body: 'You cancelled the Deriv authorization request. Nothing was changed — you can try again whenever you are ready.'
  },
  invalid_state: {
    title: 'Security check failed',
    body: 'The authorization response could not be verified against this browser session. This can happen if the request expired or was tampered with. Please start again.'
  },
  duplicate_callback: {
    title: 'Already processed',
    body: 'This authorization link has already been used. Each login link works only once — start a new sign in to continue.'
  },
  expired_code: {
    title: 'Authorization code expired',
    body: 'The Deriv authorization code expired or was already used. Please start the sign in again.'
  },
  identity_unverified: {
    title: "Couldn't verify your Deriv identity",
    body: 'The authorization succeeded but the account could not be verified. Please try again; if it keeps happening, contact support.'
  },
  authorization_failed: {
    title: 'Deriv authorization failed',
    body: 'Deriv could not complete the authorization. Please try again.'
  },
  invalid_callback: {
    title: 'Incomplete response',
    body: 'Deriv returned without the expected authorization values. Please start the sign in again.'
  }
};

export const AuthErrorPage: React.FC<{ code: string }> = ({ code }) => {
  const copy = ERROR_COPY[code] ?? {
    title: 'Sign in failed',
    body: 'Something went wrong during authentication. Please try again.'
  };

  return (
    <div className="relative flex min-h-screen flex-col bg-app">
      <div className="surface-grid pointer-events-none absolute inset-0 opacity-[0.25]" />
      <header className="relative z-10 border-b border-[var(--ws-hairline)]">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <BrandLogo onClick={() => navigate('/')} />
        </div>
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-14 sm:px-8">
        <div className="w-full max-w-md">
          <div className="rounded-[18px] border border-[var(--ws-hairline)] bg-surface p-6 shadow-[var(--shadow-modal)] sm:p-8">
            <span className="inline-flex items-center gap-2 rounded-full border border-danger/25 bg-danger/[0.07] px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              Authentication error
            </span>
            <h1 className="mt-5 text-[22px] font-extrabold leading-tight tracking-[-0.03em] text-fg-1 sm:text-[25px]">
              {copy.title}
            </h1>
            <p className="mt-3 text-[13.5px] leading-relaxed text-fg-4">{copy.body}</p>

            <div className="mt-6 space-y-2.5">
              <WsButton size="lg" className="w-full" onClick={() => startDerivAuth('login')}>
                Try logging in again
              </WsButton>
              <WsButton variant="secondary" size="lg" className="w-full" onClick={() => startDerivAuth('signup')}>
                Sign up with Deriv
              </WsButton>
            </div>

            <div className="mt-6 flex items-center gap-1.5 border-t border-[var(--ws-hairline)] pt-5 text-[11.5px] text-fg-5">
              <Lock className="h-3.5 w-3.5 text-tint-sky" />
              Error reference: <span className="font-mono text-fg-4">{code}</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
