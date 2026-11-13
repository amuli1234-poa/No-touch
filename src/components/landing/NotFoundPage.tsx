import React from 'react';
import { ArrowLeft, Compass } from 'lucide-react';
import { BrandLogo } from '../brand/WickSentinelBrand';
import { WsButton } from './primitives';
import { navigate } from '../../lib/router';

export const NotFoundPage: React.FC = () => (
  <div className="relative flex min-h-screen flex-col bg-app">
    <div className="surface-grid pointer-events-none absolute inset-0 opacity-[0.25]" />
    <header className="relative z-10 border-b border-[var(--ws-hairline)]">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center px-5 sm:px-8">
        <BrandLogo onClick={() => navigate('/')} />
      </div>
    </header>

    <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-5 py-16 text-center">
      <span className="tabular text-[64px] font-extrabold leading-none text-fg-7 sm:text-[88px]">
        404
      </span>
      <h1 className="mt-4 text-[24px] font-extrabold tracking-[-0.03em] text-fg-1 sm:text-[28px]">
        This page isn’t here
      </h1>
      <p className="mt-3 max-w-md text-[14px] leading-relaxed text-fg-4">
        The address you followed doesn’t match a page on WickSentinel. Head back to the homepage, or
        open the workspace directly.
      </p>
      <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <WsButton onClick={() => navigate('/')} icon={<ArrowLeft className="h-4 w-4" />}>
          Back to homepage
        </WsButton>
        <WsButton variant="secondary" onClick={() => navigate('/app')} icon={<Compass className="h-4 w-4" />}>
          Explore Platform
        </WsButton>
      </div>
    </main>
  </div>
);
