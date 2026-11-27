'use client';

/**
 * Manual Trader — one page, two contract families.
 *
 * A contract-type switcher (Digits / Accumulators) mounts the corresponding
 * vendored app under its own provider tree, so exactly one Deriv WebSocket is
 * open at a time. Both apps authenticate through the WickSentinel session
 * (POST /api/bot/session) and place real trades over the account-bound socket;
 * a confirmed buy is mirrored to the master's copy-trading followers.
 */

import { useState } from 'react';
import { ThemeProvider } from 'next-themes';
import { AppI18nProvider as DigitsI18n } from '@/components/custom/i18n-provider';
import { DerivWSProvider as DigitsWS } from '@/components/custom/deriv-ws-provider';
import { LiveDigits } from './components/live-digits';
import { AppI18nProvider as AccI18n } from '@acc/components/custom/i18n-provider';
import { DerivWSProvider as AccWS } from '@acc/components/custom/deriv-ws-provider';
import { LiveAccumulator } from '@acc/components/live-accumulator';
import type { LocaleCatalogs } from '@/lib/i18n';
import en from '@/lib/i18n/en.json';
import es from '@/lib/i18n/es.json';
import fr from '@/lib/i18n/fr.json';
import pt from '@/lib/i18n/pt.json';
import accEn from '@acc/lib/i18n/en.json';
import accEs from '@acc/lib/i18n/es.json';
import accFr from '@acc/lib/i18n/fr.json';
import accPt from '@acc/lib/i18n/pt.json';

const DIGITS_CATALOGS = { EN: en, ES: es, FR: fr, PT: pt } as unknown as LocaleCatalogs;
const ACC_CATALOGS = { EN: accEn, ES: accEs, FR: accFr, PT: accPt } as unknown as LocaleCatalogs;

type Family = 'digits' | 'accumulators';

const FAMILIES: { key: Family; label: string }[] = [
  { key: 'digits', label: 'Digits' },
  { key: 'accumulators', label: 'Accumulators' },
];

export function ManualTraderSection() {
  const [family, setFamily] = useState<Family>('digits');

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        {FAMILIES.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFamily(f.key)}
            className={
              'rounded-md px-3 py-1 text-[13px] font-semibold transition-colors ' +
              (family === f.key
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted')
            }
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          {family === 'digits' ? (
            <DigitsI18n catalogs={DIGITS_CATALOGS}>
              <DigitsWS>
                <LiveDigits />
              </DigitsWS>
            </DigitsI18n>
          ) : (
            <AccI18n catalogs={ACC_CATALOGS}>
              <AccWS>
                <LiveAccumulator />
              </AccWS>
            </AccI18n>
          )}
        </ThemeProvider>
      </div>
    </div>
  );
}