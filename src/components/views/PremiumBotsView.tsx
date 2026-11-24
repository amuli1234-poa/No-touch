import { Bot, Sparkles } from 'lucide-react';

export function PremiumBotsView() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
            <Sparkles className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Strategy library</p>
            <h1 className="mt-1 text-2xl font-bold text-ink">Premium Bots</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
              Premium strategies will be listed here when the library is ready.
            </p>
          </div>
        </div>
      </header>
      <section className="rounded-2xl border border-line bg-surface p-6 sm:p-8" aria-label="Premium bot availability">
        <Bot className="h-6 w-6 text-accent" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-bold text-ink">No premium bots are published yet</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          There are no paid listings or purchase flow available at this time. This page is ready for the curated premium catalog to be added.
        </p>
      </section>
    </div>
  );
}
