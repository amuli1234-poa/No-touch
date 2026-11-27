import React, { useState } from 'react';
import {
  ArrowRight,
  Radar,
  CandlestickChart,
  Crosshair,
  Waves,
  LineChart,
  ShieldCheck,
  Link2,
  ScanLine,
  Gauge,
  Compass,
  Eye,
  Layers,
  Sparkles,
  ChevronDown,
  Mail,
  AlertTriangle,
  Lock
} from 'lucide-react';
import { LandingNav } from './LandingNav';
import { ScannerPreview } from './ScannerPreview';
import { HeroBackground, HERO_IMAGE_2X } from './HeroBackground';
import { Reveal, Section, SectionHeading, WsButton } from './primitives';
import { BrandLogo, BRAND } from '../brand/WickSentinelBrand';
import { navigate, navigateToSection } from '../../lib/router';

/* --------------------------------------------------------------------------
   Hero
   -------------------------------------------------------------------------- */

const Hero: React.FC = () => (
  <section className="ws-hero-band relative isolate overflow-hidden pt-28 sm:pt-32 lg:pt-36">
    <HeroBackground />

    <div className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-8 sm:px-8">
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
        <Reveal className="text-center lg:text-left">
          <span className="inline-flex items-center gap-2 rounded-full border border-[var(--ws-hairline)] bg-surface/80 px-3.5 py-1.5 text-[12px] font-semibold text-fg-3">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-cyan" />
            {BRAND.category}
          </span>

          <h1 className="mt-6 text-[34px] font-extrabold leading-[1.04] tracking-[-0.035em] text-fg-1 sm:text-[46px] lg:text-[54px]">
            See Beyond the Candles.
            <span className="mt-1 block bg-gradient-to-r from-accent-soft via-accent to-accent-cyan bg-clip-text text-transparent">
              Understand the Market.
            </span>
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-[14.5px] leading-relaxed text-fg-4 sm:text-[16px] lg:mx-0">
            Advanced market scanning and analytical intelligence designed to help traders identify
            potential opportunities, understand market conditions and make more informed trading
            decisions.
          </p>

          <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center lg:justify-start">
            <WsButton
              size="lg"
              onClick={() => navigate('/get-started')}
              icon={<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
            >
              Get Started
            </WsButton>
            <WsButton
              size="lg"
              variant="secondary"
              onClick={() => navigate('/app')}
              icon={<Compass className="h-4 w-4" />}
            >
              Explore Platform
            </WsButton>
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[13px] text-fg-5 lg:justify-start">
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-tint-teal" />
              Structured, rules-based scanning
            </span>
            <span className="inline-flex items-center gap-2">
              <Eye className="h-4 w-4 text-tint-sky" />
              Transparent analytical output
            </span>
          </div>
        </Reveal>

        <Reveal delay={120} className="lg:pl-2">
          <ScannerPreview />
        </Reveal>
      </div>
    </div>
  </section>
);

/* --------------------------------------------------------------------------
   Trust / capability strip
   -------------------------------------------------------------------------- */

const TRUST: { icon: React.ReactNode; label: string }[] = [
  { icon: <Radar className="h-4 w-4" />, label: 'Multi-market scanning' },
  { icon: <Layers className="h-4 w-4" />, label: 'Multi-timeframe structure' },
  { icon: <Waves className="h-4 w-4" />, label: 'Liquidity & imbalance analysis' },
  { icon: <Gauge className="h-4 w-4" />, label: 'Adaptive barrier risk' },
  { icon: <LineChart className="h-4 w-4" />, label: 'Outcome calibration tracking' }
];

const TrustStrip: React.FC = () => (
  <Section className="py-8 sm:py-10 lg:py-12">
    <Reveal className="flex flex-wrap items-center justify-center gap-2.5">
      {TRUST.map((t) => (
        <span
          key={t.label}
          className="inline-flex items-center gap-2 rounded-full border border-[var(--ws-hairline)] bg-surface/70 px-3.5 py-2 text-[13px] font-medium text-fg-3"
        >
          <span className="text-accent-soft">{t.icon}</span>
          {t.label}
        </span>
      ))}
    </Reveal>
  </Section>
);

/* --------------------------------------------------------------------------
   Features — only capabilities that actually exist in the scanner
   -------------------------------------------------------------------------- */

const FEATURES: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <Radar className="h-5 w-5" />,
    title: 'Intelligent Market Scanning',
    body: 'Continuously qualifies synthetic indices in real time, surfacing only the markets that satisfy the model instead of forcing you to check each one by hand.'
  },
  {
    icon: <CandlestickChart className="h-5 w-5" />,
    title: 'Candle and Wick Analysis',
    body: 'Reads swing structure, candle displacement and wick behaviour to distinguish genuine liquidity sweeps from plain breakouts.'
  },
  {
    icon: <Crosshair className="h-5 w-5" />,
    title: 'Signal Evaluation',
    body: 'A weighted scoring model evaluates each setup across multiple components and enforces mandatory gates before anything is presented.'
  },
  {
    icon: <Compass className="h-5 w-5" />,
    title: 'Market Condition Detection',
    body: 'Multi-timeframe context identifies directional alignment or divergence, so you always know the conditions behind a reading.'
  },
  {
    icon: <LineChart className="h-5 w-5" />,
    title: 'Analytical Insights',
    body: 'Fair value gaps, protected swings, adaptive retracement levels and tradeable range are broken out into an explainable, structured view.'
  },
  {
    icon: <ShieldCheck className="h-5 w-5" />,
    title: 'Trading Risk Filters',
    body: 'Structural and risk gates screen out weak or incomplete setups, and path-dependent survival probability informs the adaptive barrier.'
  }
];

const Features: React.FC = () => (
  <Section id="features" className="border-t border-[var(--ws-hairline)]">
    <SectionHeading
      eyebrow="Capabilities"
      title="Built for traders who read structure, not noise"
      description="Every capability below is part of the working scanner. Nothing here is theoretical — it is what the platform evaluates on every scan."
    />

    <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {FEATURES.map((f, i) => (
        <Reveal key={f.title} delay={i * 60} as="article">
          <div className="group h-full rounded-[16px] border border-[var(--ws-hairline)] bg-surface p-5 transition-colors hover:border-accent/45 hover:bg-surface-raised">
            <span className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-accent/25 bg-accent/10 text-accent-soft">
              {f.icon}
            </span>
            <h3 className="mt-4 text-[15px] font-bold tracking-tight text-fg-1">{f.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-4">{f.body}</p>
          </div>
        </Reveal>
      ))}
    </div>
  </Section>
);

/* --------------------------------------------------------------------------
   Scanner preview section
   -------------------------------------------------------------------------- */

const ScannerShowcase: React.FC = () => (
  <Section className="border-t border-[var(--ws-hairline)]">
    <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-14">
      <Reveal>
        <SectionHeading
          align="left"
          eyebrow="The Workspace"
          title="Understand what WickSentinel does before you sign in"
          description="The scanner is a single analytical workspace: a live qualification table, an interactive chart with barrier and structure overlays, and a breakdown of the market context behind each reading."
        />
        <ul className="mt-7 space-y-3">
          {[
            'Qualification table across every supported synthetic market',
            'Interactive candle chart with No Touch barrier and structure overlays',
            'Per-market breakdown of alignment, sweeps, gaps and protected swings',
            'Session and calibration view for reviewing outcomes over time'
          ].map((item) => (
            <li key={item} className="flex items-start gap-3 text-[13.5px] leading-relaxed text-fg-3">
              <span className="mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-accent-cyan/30 bg-accent-cyan/10">
                <Sparkles className="h-3 w-3 text-tint-sky" />
              </span>
              {item}
            </li>
          ))}
        </ul>
        <div className="mt-8">
          <WsButton
            variant="secondary"
            onClick={() => navigate('/app')}
            icon={<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
          >
            Explore Platform
          </WsButton>
        </div>
      </Reveal>

      <Reveal delay={120}>
        <ScannerPreview />
      </Reveal>
    </div>
  </Section>
);

/* --------------------------------------------------------------------------
   How it works
   -------------------------------------------------------------------------- */

const STEPS: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <Link2 className="h-5 w-5" />,
    title: 'Connect',
    body: 'The platform connects to the market feed and discovers the available synthetic indices, streaming live pricing into the workspace.'
  },
  {
    icon: <ScanLine className="h-5 w-5" />,
    title: 'Scan',
    body: 'Markets are scanned continuously across multiple timeframes, building structure, sweeps and imbalance context as new candles form.'
  },
  {
    icon: <Gauge className="h-5 w-5" />,
    title: 'Analyze',
    body: 'Each market is scored against the model and gated on mandatory conditions, producing an explainable reading rather than a black-box call.'
  },
  {
    icon: <Compass className="h-5 w-5" />,
    title: 'Make informed decisions',
    body: 'Review the conditions, the structure behind the reading and the risk context, then decide for yourself how to act.'
  }
];

const HowItWorks: React.FC = () => (
  <Section id="how-it-works" className="border-t border-[var(--ws-hairline)]">
    <SectionHeading
      eyebrow="How It Works"
      title="From raw ticks to an explainable reading"
      description="Four stages, in order. The platform does the scanning and the structure work; the decision stays with you."
    />

    <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map((s, i) => (
        <Reveal key={s.title} delay={i * 70} as="article" className="h-full">
          <div className="relative h-full rounded-[16px] border border-[var(--ws-hairline)] bg-surface p-5">
            <div className="flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-[12px] border border-accent-cyan/25 bg-accent-cyan/10 text-tint-sky">
                {s.icon}
              </span>
              <span className="tabular text-[26px] font-extrabold leading-none text-fg-7">
                {String(i + 1).padStart(2, '0')}
              </span>
            </div>
            <h3 className="mt-4 text-[15px] font-bold tracking-tight text-fg-1">{s.title}</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-4">{s.body}</p>
          </div>
        </Reveal>
      ))}
    </div>
  </Section>
);

/* --------------------------------------------------------------------------
   Why WickSentinel
   -------------------------------------------------------------------------- */

const PILLARS: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <Eye className="h-5 w-5" />,
    title: 'Market intelligence',
    body: 'One workspace that turns streaming prices into structured, readable market conditions.'
  },
  {
    icon: <Layers className="h-5 w-5" />,
    title: 'Analytical clarity',
    body: 'Every reading is broken into the components behind it, not condensed into a single opaque verdict.'
  },
  {
    icon: <Radar className="h-5 w-5" />,
    title: 'Structured scanning',
    body: 'A repeatable model applied uniformly across markets, so comparisons stay consistent.'
  },
  {
    icon: <Sparkles className="h-5 w-5" />,
    title: 'Transparent signals',
    body: 'Conditions, gates and scores are visible, so you can see exactly why a market was surfaced.'
  },
  {
    icon: <ShieldCheck className="h-5 w-5" />,
    title: 'Disciplined decision-making',
    body: 'Risk filters and structural gates encourage patience over reaction to every price move.'
  }
];

const WhyWickSentinel: React.FC = () => (
  <Section id="about" className="border-t border-[var(--ws-hairline)]">
    <SectionHeading
      eyebrow="Why WickSentinel"
      title="Intelligence over impulse"
      description="WickSentinel is an independent market intelligence platform. It is designed to support your own analysis and judgement — not to replace them."
    />

    <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {PILLARS.map((p, i) => (
        <Reveal key={p.title} delay={i * 60} as="article" className="h-full">
          <div className="h-full rounded-[16px] border border-[var(--ws-hairline)] bg-gradient-to-b from-surface-raised to-surface p-5">
            <span className="flex h-10 w-10 items-center justify-center rounded-[11px] border border-[var(--ws-hairline)] bg-surface-raised text-accent-soft">
              {p.icon}
            </span>
            <h3 className="mt-4 text-[14.5px] font-bold tracking-tight text-fg-1">{p.title}</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-fg-4">{p.body}</p>
          </div>
        </Reveal>
      ))}

      <Reveal delay={300} as="article" className="h-full">
        <div className="flex h-full flex-col justify-center rounded-[16px] border border-accent/30 bg-accent/[0.08] p-5">
          <h3 className="text-[14.5px] font-bold tracking-tight text-fg-1">Independent by design</h3>
          <p className="mt-2 text-[13.5px] leading-relaxed text-fg-3">
            WickSentinel is a third-party analytical tool. It is not affiliated with, endorsed by, or
            operated by Deriv or any broker.
          </p>
        </div>
      </Reveal>
    </div>
  </Section>
);

/* --------------------------------------------------------------------------
   FAQ
   -------------------------------------------------------------------------- */

const FAQS: { q: string; a: React.ReactNode }[] = [
  {
    q: 'What exactly does WickSentinel do?',
    a: 'It is a market intelligence workspace. It scans synthetic indices in real time, builds multi-timeframe structure and imbalance context, evaluates each market against a defined model, and presents the result with the reasoning behind it so you can review conditions yourself.'
  },
  {
    q: 'Which markets are supported?',
    a: 'The scanner works across the synthetic indices available from the market feed it connects to — the volatility, step, jump, range-break and boom/crash families, including their 1-second variants where offered. The available list is discovered automatically on connect.'
  },
  {
    q: 'Do I need an account to use it?',
    a: (
      <>
        Authentication is not yet part of this build — the scanner runs entirely in your browser with
        no account required. The Login and Get Started entries on this site are placeholders wired to
        dedicated routes so that account handling can be added later without disturbing the scanner or
        this page.
      </>
    )
  },
  {
    q: 'Is my trading or account information accessed?',
    a: 'No. The platform reads public market data only. It does not request, store or transmit trading credentials or account balances, and it never places orders on your behalf.'
  },
  {
    q: 'Are the signals financial advice or a guarantee?',
    a: 'No. Output is analytical observation about market conditions, not advice, and not a prediction of outcome. Signals can be wrong, and market conditions can change immediately after a reading.'
  },
  {
    q: 'What are the trading risks?',
    a: 'Deriv synthetic indices and related options are high-risk instruments. You can lose some or all of the money you commit, and losses can occur rapidly. Nothing on this platform changes that. Trade only with capital you can afford to lose, and seek independent advice if you are unsure.'
  },
  {
    q: 'Is WickSentinel affiliated with Deriv?',
    a: 'No. WickSentinel is an independent third-party platform. It is not officially affiliated with, endorsed by, sponsored by or connected to Deriv, and all trademarks belong to their respective owners.'
  }
];

const Faq: React.FC = () => {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <Section className="border-t border-[var(--ws-hairline)]">
      <SectionHeading
        eyebrow="FAQ"
        title="Questions, answered plainly"
        description="What the platform is, what it needs from you, and the risks that come with this kind of trading."
      />

      <div className="mx-auto mt-11 max-w-3xl divide-y divide-[var(--ws-hairline)] overflow-hidden rounded-[16px] border border-[var(--ws-hairline)] bg-surface">
        {FAQS.map((item, i) => {
          const isOpen = open === i;
          return (
            <div key={item.q}>
              <button
                onClick={() => setOpen(isOpen ? null : i)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-raised"
              >
                <span className="text-[14px] font-semibold tracking-tight text-fg-1">{item.q}</span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-fg-5 transition-transform duration-300 ${
                    isOpen ? 'rotate-180 text-accent-soft' : ''
                  }`}
                />
              </button>
              <div
                className={`grid transition-all duration-300 ease-out ${
                  isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                }`}
              >
                <div className="overflow-hidden">
                  <p className="px-5 pb-5 text-[13px] leading-relaxed text-fg-4">{item.a}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
};

/* --------------------------------------------------------------------------
   Closing call to action
   -------------------------------------------------------------------------- */

const ClosingCta: React.FC = () => (
  <Section className="border-t border-[var(--ws-hairline)]">
    <Reveal>
      <div className="relative overflow-hidden rounded-[20px] border border-[var(--ws-hairline)] bg-gradient-to-br from-surface-raised via-surface to-surface-deepest px-6 py-12 text-center sm:px-12 sm:py-14">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full bg-accent/15 blur-[110px]" />
        <div className="relative">
          <h2 className="mx-auto max-w-xl text-[26px] font-extrabold leading-tight tracking-[-0.03em] text-fg-1 sm:text-[32px]">
            See beyond the candles
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-[14.5px] leading-relaxed text-fg-4">
            Open the workspace and review live market conditions across the supported synthetic
            indices — no account needed in this build.
          </p>
          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <WsButton
              size="lg"
              onClick={() => navigate('/get-started')}
              icon={<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
            >
              Get Started
            </WsButton>
            <WsButton size="lg" variant="secondary" onClick={() => navigate('/app')}>
              Explore Platform
            </WsButton>
          </div>
        </div>
      </div>
    </Reveal>
  </Section>
);

/* --------------------------------------------------------------------------
   Footer
   -------------------------------------------------------------------------- */

const FOOTER_NAV: { heading: string; links: { label: string; onClick: () => void }[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Home', onClick: () => navigate('/') },
      { label: 'Features', onClick: () => navigateToSection('features') },
      { label: 'How It Works', onClick: () => navigateToSection('how-it-works') },
      { label: 'About', onClick: () => navigateToSection('about') },
      { label: 'Explore Platform', onClick: () => navigate('/app') }
    ]
  },
  {
    heading: 'Account',
    links: [
      { label: 'Login', onClick: () => navigate('/login') },
      { label: 'Get Started', onClick: () => navigate('/get-started') }
    ]
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy Policy', onClick: () => navigate('/privacy') },
      { label: 'Terms of Service', onClick: () => navigate('/terms') },
      { label: 'Risk Disclaimer', onClick: () => navigate('/risk-disclaimer') }
    ]
  }
];

const LandingFooter: React.FC = () => (
  <footer className="border-t border-[var(--ws-hairline)] bg-surface-deep">
    <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8">
      <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <BrandLogo showTagline />
          <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-fg-4">
            {BRAND.tagline}
          </p>
          <a
            href="mailto:contact@wicksentinel.app"
            className="mt-4 inline-flex max-sm:min-h-[44px] items-center gap-2 text-[13.5px] font-medium text-fg-3 transition-colors hover:text-fg-1"
          >
            <Mail className="h-3.5 w-3.5 text-accent-soft" />
            contact@wicksentinel.app
          </a>
        </div>

        {FOOTER_NAV.map((col) => (
          <div key={col.heading}>
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-fg-5">
              {col.heading}
            </h3>
            <ul className="mt-4 space-y-2.5 max-sm:space-y-1">
              {col.links.map((link) => (
                <li key={link.label}>
                  <button
                    onClick={link.onClick}
                    className="max-sm:block max-sm:min-h-[44px] max-sm:py-2 text-left text-[13px] text-fg-3 transition-colors hover:text-fg-1"
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-12 space-y-4 border-t border-[var(--ws-hairline)] pt-8">
        <div className="flex items-start gap-3 rounded-[12px] border border-warning/20 bg-warning/[0.06] px-4 py-3.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-tint-amber" />
          <p className="text-[13px] leading-relaxed text-fg-3">
            <span className="font-semibold text-fg-1">Risk warning.</span> Trading synthetic indices
            and related options is high risk and can result in the loss of all capital committed.
            WickSentinel provides analytical tools only. It does not provide financial advice, does
            not execute trades, and does not guarantee any outcome. Past performance and analytical
            output are not reliable indicators of future results.
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-[12px] border border-[var(--ws-hairline)] bg-surface px-4 py-3.5">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-tint-sky" />
          <p className="text-[13px] leading-relaxed text-fg-4">
            <span className="font-semibold text-fg-2">Independent platform.</span> WickSentinel
            is an independent third-party market intelligence platform. It is not officially
            affiliated with, endorsed by, sponsored by or otherwise connected to Deriv. All product
            names, logos and brands are the property of their respective owners and are used for
            identification purposes only.
          </p>
        </div>

        <div className="flex flex-col gap-2 pt-2 text-[12.5px] text-fg-5 sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} WickSentinel. All rights reserved.</span>
          <span>{BRAND.category}</span>
        </div>
      </div>
    </div>
  </footer>
);

/* --------------------------------------------------------------------------
   Page
   -------------------------------------------------------------------------- */

export const LandingPage: React.FC = () => (
  <div className="min-h-screen bg-app">
    {/* Warm the hero photograph as early as possible without blocking render. */}
    <link rel="preload" as="image" href={HERO_IMAGE_2X} fetchPriority="high" />
    <LandingNav />
    <main>
      <Hero />
      <TrustStrip />
      <Features />
      <ScannerShowcase />
      <HowItWorks />
      <WhyWickSentinel />
      <Faq />
      <ClosingCta />
    </main>
    <LandingFooter />
  </div>
);
