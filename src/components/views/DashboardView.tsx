import { useEffect, useState } from 'react';
import { Activity, Bot, BrainCircuit, Radio, ScanSearch, Sparkles } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useAuth } from '../../lib/auth';
import { useSelectedBalance } from '../../lib/balances';
import { SectionCard } from '../ui/primitives';
import { BestSignalPanel } from '../dashboard/BestSignalPanel';
import { MarketCard } from '../dashboard/MarketCard';

/**
 * Dashboard — the welcome surface.
 *
 * A welcome band (client name / id) with a moving tagline, four navigation
 * shortcuts (Pro Scanner, Manual Trader, Market Analysis, AI Intelligence), and
 * the two retained live panels: Best Signal and Live Market Readings. Everything
 * else from the old overview is intentionally removed.
 */
function QuickAccess() {
  const ws = useWorkspace();
  const entries: {
    key: string;
    section?: 'scanner' | 'digits-manual-trader' | 'bulk-trader' | 'automated-trader' | 'chart' | 'aiintelligence' | 'copytrading' | 'premiumbots' | 'freebots';
    href?: string;
    title: string;
    detail: string;
    icon: typeof Activity;
    primary?: boolean;
  }[] = [
    {
      key: 'scanner',
      section: 'scanner',
      title: 'Pro Scanner',
      detail: 'Sweep eligible markets with the live engines and review opportunities.',
      icon: Sparkles,
      primary: true,
    },
    {
      key: 'digits-manual-trader',
      section: 'digits-manual-trader',
      title: 'Digits Manual Trader',
      detail: 'Trade Digits manually on your Deriv account.',
      icon: Activity,
    },
    {
      key: 'bulk-trader',
      section: 'bulk-trader',
      title: 'Bulk Trader',
      detail: 'Place bulk trades across multiple accounts.',
      icon: Activity,
    },
    {
      key: 'automated-trader',
      section: 'automated-trader',
      title: 'Automated Trader',
      detail: 'Run automated trading strategies on your Deriv account.',
      icon: Activity,
    },
    {
      key: 'chart',
      section: 'chart',
      title: 'Market Analysis',
      detail: 'Open the chart workspace and the analysis modules.',
      icon: ScanSearch,
    },
    {
      key: 'aiintelligence',
      section: 'aiintelligence',
      title: 'AI Intelligence',
      detail: 'Entry models, confluence, risk and system health.',
      icon: BrainCircuit,
    },
    {
      key: 'copytrading',
      section: 'copytrading',
      title: 'Copy Trading',
      detail: 'Mirror a master’s trades to connected followers.',
      icon: Activity,
    },
    {
      key: 'premiumbots',
      section: 'premiumbots',
      title: 'Premium Bots',
      detail: 'Curated premium Deriv strategies.',
      icon: Bot,
    },
    {
      key: 'freebots',
      section: 'freebots',
      title: 'Free Bots',
      detail: 'Sample Deriv DBot strategies from the free library.',
      icon: Bot,
    },
    {
      key: 'botbuilder',
      href: `${import.meta.env.BASE_URL}bot/`,
      title: 'Bot Builder',
      detail: 'Open the Deriv Bot builder.',
      icon: Bot,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {entries.map((entry) => {
        const Icon = entry.icon;
        const className = `text-left rounded-xl border px-4 py-4 transition-colors cursor-pointer ${
          entry.primary
            ? 'bg-accent/10 border-accent/30 hover:bg-accent/15'
            : 'bg-surface border-line hover:border-accent/50'
        }`;
        const inner = (
          <>
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-lg bg-elevated border border-line text-accent flex items-center justify-center shrink-0">
                <Icon className="w-5 h-5" aria-hidden="true" />
              </span>
              <span className="text-sm font-bold text-ink">{entry.title}</span>
            </div>
            <p className="text-xs text-muted leading-snug mt-2">{entry.detail}</p>
          </>
        );
        return entry.href ? (
          <a key={entry.key} href={entry.href} className={className}>
            {inner}
          </a>
        ) : (
          <button
            key={entry.key}
            type="button"
            onClick={() => entry.section && ws.navigate(entry.section)}
            className={className}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

const QUOTES = [
  'Cut your losses short. Let your profits run.',
  'The trend is your friend until the end.',
  'Plan your trade. Trade your plan.',
  'Risk comes from not knowing what you are doing.',
  'Do not hold a position unless you know where it goes.',
  'Amateurs think about how much money they can make. Professionals think about how much they can lose.',
  'The market rewards patience and punishes greed.',
];

export function DashboardView() {
  const ws = useWorkspace();
  const auth = useAuth();
  const selected = useSelectedBalance();
  const clientLabel =
    selected?.accountId ??
    (auth.status === 'authenticated' ? auth.user.loginId ?? auth.user.id : 'guest');

  const now = new Date();
  const hour = now.getHours();
  const timeGreeting =
    hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : hour < 21 ? 'Good evening' : 'Good night';
  const greetingList = [timeGreeting, 'Welcome', 'How are you'];

  const [greetIndex, setGreetIndex] = useState(0);
  useEffect(() => {
    setGreetIndex(0);
    const id = setInterval(() => setGreetIndex((i) => (i + 1) % 3), 4000);
    return () => clearInterval(id);
  }, [timeGreeting]);
  const greeting = greetingList[greetIndex];

  const [quoteIndex, setQuoteIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setQuoteIndex((i) => (i + 1) % QUOTES.length), 6000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5 max-w-[1400px] w-full mx-auto">
      {/* Welcome band — plain (no box), centered, with a bigger contained marquee. */}
      <div className="text-center py-2">
        <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight truncate text-transparent bg-clip-text bg-[linear-gradient(90deg,var(--color-accent),var(--color-violet))]">
          {greeting},{' '}
          <span className="text-transparent bg-clip-text bg-[linear-gradient(90deg,var(--color-teal),var(--color-accent-cyan))]">
            {clientLabel}
          </span>
        </h1>
        <div className="mt-2 h-9 flex items-center justify-center overflow-hidden">
          <div
            key={quoteIndex}
            className="ws-fade whitespace-nowrap text-lg sm:text-xl font-bold tracking-tight text-accent"
          >
            {QUOTES[quoteIndex]}
          </div>
        </div>
      </div>

      <QuickAccess />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4">
        <BestSignalPanel />
        <SectionCard
          title="Live Market Readings"
          subtitle="Monitor-only breadth readings — colour and icon both show direction"
          icon={<Radio className="w-4 h-4" />}
          right={
            <button
              type="button"
              onClick={() => ws.navigate('scanner')}
              className="text-[12px] font-semibold text-accent hover:text-accent-soft cursor-pointer"
            >
              Full scanner
            </button>
          }
        >
          {ws.monitorSummary && ws.monitorSummary.readings.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[...ws.monitorSummary.readings]
                .sort((a, b) => (b.lastCandleChangePercent ?? 0) - (a.lastCandleChangePercent ?? 0))
                .slice(0, 6)
                .map((reading) => (
                  <MarketCard
                    key={reading.symbol}
                    reading={reading}
                    selected={reading.symbol === ws.selectedSymbol}
                    onSelect={() => ws.openChart(reading.symbol, ws.timeframe, null)}
                  />
                ))}
            </div>
          ) : (
            <p className="text-xs text-muted leading-relaxed">
              No live readings yet. Open the Market Scanner and run a sweep to populate
              real-time volatility and activity readings.
            </p>
          )}
        </SectionCard>
      </div>
    </div>
  );
}