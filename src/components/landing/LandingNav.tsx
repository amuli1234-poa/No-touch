import React, { useEffect, useState } from 'react';
import { Menu, X, ArrowRight } from 'lucide-react';
import { BrandLogo } from '../brand/WickSentinelBrand';
import { WsButton } from './primitives';
import { ThemeToggle } from '../ui/ThemeToggle';
import { navigate, navigateToSection } from '../../lib/router';

interface NavLink {
  label: string;
  target: string;
}

const LINKS: NavLink[] = [
  { label: 'Home', target: '/' },
  { label: 'Features', target: 'features' },
  { label: 'How It Works', target: 'how-it-works' },
  { label: 'About', target: 'about' }
];

export const LandingNav: React.FC = () => {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const go = (link: NavLink) => {
    setOpen(false);
    if (link.target === '/') navigate('/');
    else navigateToSection(link.target);
  };

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled || open
          ? 'border-b border-[var(--ws-hairline)] bg-app/85 backdrop-blur-xl'
          : 'ws-hero-band border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
        <BrandLogo onClick={() => navigate('/')} />

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
          {LINKS.map((link) => (
            <button
              key={link.label}
              onClick={() => go(link)}
              className="rounded-[9px] px-3 py-2 text-[13px] font-semibold tracking-tight text-fg-3 transition-colors hover:bg-surface-raised hover:text-fg-1"
            >
              {link.label}
            </button>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <WsButton variant="ghost" size="sm" onClick={() => navigate('/login')}>
            Login
          </WsButton>
          <WsButton
            size="sm"
            onClick={() => navigate('/get-started')}
            icon={<ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />}
          >
            Get Started
          </WsButton>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-[var(--ws-hairline)] bg-surface text-fg-2 lg:hidden"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="border-t border-[var(--ws-hairline)] bg-app/98 px-5 pb-6 pt-3 backdrop-blur-xl lg:hidden">
          <nav className="flex flex-col" aria-label="Mobile">
            {LINKS.map((link) => (
              <button
                key={link.label}
                onClick={() => go(link)}
                className="border-b border-[var(--ws-hairline)] py-3 text-left text-[15px] font-semibold text-fg-2"
              >
                {link.label}
              </button>
            ))}
          </nav>
          <div className="mt-5 flex flex-col gap-2.5">
            <WsButton
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={() => {
                setOpen(false);
                navigate('/login');
              }}
            >
              Login
            </WsButton>
            <WsButton
              size="lg"
              className="w-full"
              onClick={() => {
                setOpen(false);
                navigate('/get-started');
              }}
            >
              Get Started
            </WsButton>
          </div>
        </div>
      )}
    </header>
  );
};
