import React from 'react';
import { ArrowRight, ArrowLeft, Info, ShieldCheck, Eye } from 'lucide-react';
import { BrandLogo } from '../brand/WickSentinelBrand';
import { WsButton } from './primitives';
import { navigate } from '../../lib/router';

interface AccessPageProps {
  mode: 'login' | 'get-started';
}

const COPY = {
  login: {
    eyebrow: 'Account access',
    title: 'Log in to WickSentinel',
    description:
      'Sign in to reach your scanner workspace and saved calibration history.',
    primary: 'Continue to workspace'
  },
  'get-started': {
    eyebrow: 'Get started',
    title: 'Start with WickSentinel',
    description:
      'Open the market intelligence workspace and review live conditions across the supported synthetic indices.',
    primary: 'Open the workspace'
  }
} as const;

/**
 * Access entry point. Authentication is not implemented in this build, so this
 * page is deliberately explicit about that and hands the visitor to the working
 * scanner rather than presenting a non-functional form. The route exists so a
 * real auth flow can be dropped in later without touching the scanner.
 */
export const AccessPage: React.FC<AccessPageProps> = ({ mode }) => {
  const copy = COPY[mode];

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

            <div className="mt-6 flex items-start gap-3 rounded-[12px] border border-accent-cyan/25 bg-accent-cyan/[0.06] px-4 py-3.5">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-tint-sky" />
              <p className="text-[12px] leading-relaxed text-fg-3">
                <span className="font-semibold text-fg-1">No account required yet.</span> Account
                handling is not implemented in this build — the scanner runs entirely in your browser
                with no sign-up, and no trading credentials are ever requested.
              </p>
            </div>

            <div className="mt-6 space-y-2.5">
              <WsButton
                size="lg"
                className="w-full"
                onClick={() => navigate('/app')}
                icon={<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
              >
                {copy.primary}
              </WsButton>
              <WsButton variant="secondary" size="lg" className="w-full" onClick={() => navigate('/')}>
                Return to homepage
              </WsButton>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--ws-hairline)] pt-5 text-[11.5px] text-fg-5">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-tint-teal" />
                No credentials requested
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
