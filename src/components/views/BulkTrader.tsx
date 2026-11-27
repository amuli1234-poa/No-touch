'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Bulk Trader — loads the standalone HTML trader surface from
 * /traders/bulk-trader.html in a full-size iframe.
 *
 * Navigates exactly like CopyTradingView: the section switches inline inside
 * the SPA (hash-routed, full-width), no page reload. The iframe fills the
 * whole section so the trader owns all available screen space.
 */
export function BulkTrader() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => setLoaded(true);
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 bg-surface">
        <span className="text-[13px] font-semibold text-ink">Bulk Trader</span>
        <span className="ml-auto text-[11px] text-muted">
          {loaded ? 'loaded' : 'loading…'}
        </span>
      </div>
      <div className="flex-1 min-h-0 w-full overflow-hidden">
        <iframe
          ref={iframeRef}
          src="/traders/bulk-trader.html"
          className="w-full h-full"
          title="Bulk Trader"
        />
      </div>
    </div>
  );
}
