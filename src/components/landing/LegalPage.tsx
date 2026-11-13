import React from 'react';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { BrandLogo } from '../brand/WickSentinelBrand';
import { navigate } from '../../lib/router';

type LegalKind = 'privacy' | 'terms' | 'risk-disclaimer';

const INDEPENDENCE_NOTICE = (
  <div className="flex items-start gap-3 rounded-[12px] border border-[var(--ws-hairline)] bg-surface px-4 py-3.5">
    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-tint-sky" />
    <p className="text-[12.5px] leading-relaxed text-fg-4">
      WickSentinel is an independent third-party market intelligence platform. It is not officially
      affiliated with, endorsed by, sponsored by or otherwise connected to Deriv. All product names
      and brands are the property of their respective owners.
    </p>
  </div>
);

const DOCS: Record<
  LegalKind,
  { title: string; updated: string; intro: string; sections: { heading: string; body: string }[] }
> = {
  privacy: {
    title: 'Privacy Policy',
    updated: 'Draft — pending legal review',
    intro:
      'This policy describes how the WickSentinel web application handles information. It reflects the current build, which runs entirely in the browser.',
    sections: [
      {
        heading: 'Information we do not collect',
        body: 'The application does not request or store account credentials, trading logins, payment details, names or email addresses. No sign-up is required to use the scanner in this build.'
      },
      {
        heading: 'Data processed in your browser',
        body: 'Market data is streamed from the public feed and processed locally in your browser. Scanner settings, display preferences and calibration history are stored in your browser’s local storage on your own device. This information is not transmitted to us.'
      },
      {
        heading: 'Third-party services',
        body: 'The application connects to a public market data feed to retrieve pricing. Fonts are served from Google Fonts. Any data those providers receive is governed by their own privacy policies.'
      },
      {
        heading: 'Cookies and tracking',
        body: 'The application does not set advertising or cross-site tracking cookies. Clearing your browser storage will remove any locally saved settings and history.'
      },
      {
        heading: 'Contact',
        body: 'Questions about privacy can be directed to contact@wicksentinel.app.'
      }
    ]
  },
  terms: {
    title: 'Terms of Service',
    updated: 'Draft — pending legal review',
    intro:
      'By accessing the WickSentinel web application you agree to the terms below. This document is a draft and must be reviewed before publication.',
    sections: [
      {
        heading: 'Purpose of the service',
        body: 'WickSentinel provides analytical tools that help users review market conditions. It is an information and analysis product only.'
      },
      {
        heading: 'No financial advice',
        body: 'Nothing produced by the platform constitutes financial, investment or trading advice, a recommendation, or a solicitation to trade. You are solely responsible for your own decisions.'
      },
      {
        heading: 'No execution or custody',
        body: 'The platform does not place orders, hold funds, or act as a broker, intermediary or counterparty. It does not connect to any trading account on your behalf.'
      },
      {
        heading: 'Acceptable use',
        body: 'You agree not to misuse the service, attempt to disrupt it, or use it in breach of any applicable law or regulation in your jurisdiction.'
      },
      {
        heading: 'Availability and warranty',
        body: 'The service is provided “as is” and “as available”, without warranties of any kind. Analytical output may contain errors or omissions, and availability may be interrupted without notice.'
      },
      {
        heading: 'Limitation of liability',
        body: 'To the maximum extent permitted by law, WickSentinel accepts no liability for any trading losses or other damages arising from use of, or reliance on, the platform.'
      }
    ]
  },
  'risk-disclaimer': {
    title: 'Risk Disclaimer',
    updated: 'Draft — pending legal review',
    intro:
      'Trading involves substantial risk. Read this disclaimer carefully before relying on any output from the platform.',
    sections: [
      {
        heading: 'High-risk instruments',
        body: 'Synthetic indices and related options are high-risk, leveraged products. You may lose some or all of the capital you commit, and losses can occur rapidly. Do not trade with money you cannot afford to lose.'
      },
      {
        heading: 'Analytical output is not a prediction',
        body: 'Scanner readings, scores and signals are observations about current market conditions derived from historical price structure. They are not forecasts, and they do not guarantee any outcome.'
      },
      {
        heading: 'No guarantee of accuracy',
        body: 'Market data and analysis may be delayed, incomplete or incorrect. Structural readings can be invalidated immediately after they are produced as conditions change.'
      },
      {
        heading: 'Your responsibility',
        body: 'You are solely responsible for evaluating the suitability of any instrument, for your own risk management, and for compliance with the laws and regulations that apply to you.'
      },
      {
        heading: 'Seek independent advice',
        body: 'If you do not fully understand these risks, seek independent professional advice before trading.'
      }
    ]
  }
};

export const LegalPage: React.FC<{ kind: LegalKind }> = ({ kind }) => {
  const doc = DOCS[kind];

  return (
    <div className="min-h-screen bg-app">
      <header className="sticky top-0 z-20 border-b border-[var(--ws-hairline)] bg-app/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-4xl items-center justify-between px-5 sm:px-8">
          <BrandLogo onClick={() => navigate('/')} />
          <button
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-1.5 rounded-[9px] px-3 py-2 text-[13px] font-semibold text-fg-3 transition-colors hover:bg-surface-raised hover:text-fg-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Home
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-5 py-14 sm:px-8">
        <h1 className="text-[30px] font-extrabold tracking-[-0.03em] text-fg-1 sm:text-[36px]">
          {doc.title}
        </h1>
        <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-warning/25 bg-warning/[0.07] px-3 py-1 text-[11px] font-semibold text-tint-amber">
          {doc.updated}
        </p>
        <p className="mt-5 max-w-2xl text-[14px] leading-relaxed text-fg-4">{doc.intro}</p>

        <div className="mt-8 space-y-3">
          {doc.sections.map((s) => (
            <div
              key={s.heading}
              className="rounded-[14px] border border-[var(--ws-hairline)] bg-surface p-5"
            >
              <h2 className="text-[15px] font-bold tracking-tight text-fg-1">{s.heading}</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-fg-4">{s.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-8">{INDEPENDENCE_NOTICE}</div>
      </main>
    </div>
  );
};
