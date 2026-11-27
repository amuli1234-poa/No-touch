'use client';

/**
 * Digits section wrapper.
 *
 * Mounts the vendored Digits app (LiveDigits) inside the WickSentinel shell with
 * the provider tree it needs: next-themes (for the header theme toggle), the
 * Digits i18n catalogs, and the Deriv WebSocket provider. The WS provider's auth
 * is the session-reuse hook (POST /api/bot/session), so the browser never holds
 * the Deriv token — it only ever receives the short-lived account-bound socket.
 */

import { ThemeProvider } from 'next-themes';
import { AppI18nProvider } from '@/components/custom/i18n-provider';
import { DerivWSProvider } from '@/components/custom/deriv-ws-provider';
import { LiveDigits } from './components/live-digits';
import en from '@/lib/i18n/en.json';
import es from '@/lib/i18n/es.json';
import fr from '@/lib/i18n/fr.json';
import pt from '@/lib/i18n/pt.json';
import type { LocaleCatalogs } from '@/lib/i18n';

const CATALOGS = { EN: en, ES: es, FR: fr, PT: pt } as unknown as LocaleCatalogs;

export function DigitsSection() {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <AppI18nProvider catalogs={CATALOGS}>
        <DerivWSProvider>
          <LiveDigits />
        </DerivWSProvider>
      </AppI18nProvider>
    </ThemeProvider>
  );
}