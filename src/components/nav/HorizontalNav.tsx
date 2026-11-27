import { useEffect, useState } from 'react';
import { Activity, Bot } from 'lucide-react';
import {
  MAIN_TABS,
  mainTabForSection,
  type AppSection,
  type SectionBadges,
} from './Navigation';

interface HorizontalNavProps {
  active: AppSection;
  onSelect: (section: AppSection) => void;
  badges?: SectionBadges;
  hidden?: boolean;
}

const LINK =
  'rounded-[9px] px-2.5 py-2 text-[13px] font-semibold tracking-tight whitespace-nowrap transition-colors cursor-pointer';
const LINK_IDLE = 'text-fg-3 hover:bg-surface-raised hover:text-fg-1';
const LINK_ACTIVE = 'bg-surface-raised text-fg-1';
const SUB_IDLE = 'text-fg-3 hover:bg-surface-raised hover:text-fg-1';
const SUB_ACTIVE = 'bg-surface-raised text-accent-strong';

/**
 * Horizontal primary navigation — the left-to-right replacement for the sidebar,
 * styled to match the landing-page top bar (13px semibold links, rounded-[9px],
 * surface-raised hover). The active group expands its sub-sections inline.
 */
export function HorizontalNav({ active, onSelect, badges, hidden = false }: HorizontalNavProps) {
  const activeTabKey = mainTabForSection(active)?.key ?? null;
  const [openSub, setOpenSub] = useState(false);

  // Close the dropdown whenever the active section changes (e.g. after picking a sub-page).
  useEffect(() => {
    setOpenSub(false);
  }, [active]);

  return (
    <nav
      aria-label="Primary"
      className={`${hidden ? 'hidden' : 'hidden lg:flex'} relative items-center justify-center gap-1 h-12 shrink-0 border-b border-[var(--ws-hairline)] bg-app/85 backdrop-blur-xl px-2 sm:px-4 z-30`}
    >
      {MAIN_TABS.map((tab) => {
        const isActive = tab.key === activeTabKey;
        const tabBadge = tab.sections.reduce((n, s) => Math.max(n, badges?.[s.key] ?? 0), 0);
        const hasSub = isActive && tab.sections.length > 1;
        return (
          <div
            key={tab.key}
            className={`flex items-center gap-1 shrink-0 ${hasSub ? 'relative' : ''}`}
          >
            <button
              type="button"
              onClick={() => {
                if (hasSub) {
                  setOpenSub((v) => !v);
                } else {
                  setOpenSub(false);
                  onSelect(tab.defaultSection);
                }
              }}
              aria-current={isActive ? 'page' : undefined}
              aria-expanded={hasSub ? openSub : undefined}
              className={`${LINK} flex items-center gap-1.5 ${isActive ? LINK_ACTIVE : LINK_IDLE}`}
            >
              <span className={isActive ? 'text-accent-strong' : 'text-fg-5'}>{tab.icon}</span>
              <span className="hidden lg:inline">{tab.label}</span>
              {tabBadge > 0 && (
                <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-accent text-white text-[10px] font-bold">
                  {tabBadge > 99 ? '99+' : tabBadge}
                </span>
              )}
            </button>

            {hasSub && openSub && (
              <div className="absolute left-0 top-full z-50 mt-1 min-w-[190px] rounded-xl border border-line bg-surface p-1 shadow-lg">
                {tab.sections.map((s) => {
                  const sub = s.key === active;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => {
                        setOpenSub(false);
                        onSelect(s.key);
                      }}
                      aria-current={sub ? 'page' : undefined}
                      className={`w-full text-left rounded-[9px] px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                        sub ? SUB_ACTIVE : SUB_IDLE
                      }`}
                    >
                      {s.shortLabel ?? s.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <a
        href={`${import.meta.env.BASE_URL}bot/`}
        className={`${LINK} flex items-center gap-1.5 ${LINK_IDLE}`}
      >
        <span className="text-fg-5">
          <Bot className="h-4 w-4" />
        </span>
        <span className="hidden lg:inline">Bot Builder</span>
      </a>

      {/* Copy-trading trader surfaces (replacing the old Manual Trader tab). */}
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onSelect('digits-manual-trader');
        }}
        className={`${LINK} flex items-center gap-1.5 ${LINK_IDLE}`}
      >
        <span className="text-fg-5">
          <Activity className="h-4 w-4" />
        </span>
        <span className="hidden lg:inline">Digits Manual Trader</span>
      </a>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onSelect('bulk-trader');
        }}
        className={`${LINK} flex items-center gap-1.5 ${LINK_IDLE}`}
      >
        <span className="text-fg-5">
          <Activity className="h-4 w-4" />
        </span>
        <span className="hidden lg:inline">Bulk Trader</span>
      </a>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onSelect('automated-trader');
        }}
        className={`${LINK} flex items-center gap-1.5 ${LINK_IDLE}`}
      >
        <span className="text-fg-5">
          <Activity className="h-4 w-4" />
        </span>
        <span className="hidden lg:inline">Automated Trader</span>
      </a>
    </nav>
  );
}