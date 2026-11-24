import { ArrowDownToLine, Bot, ExternalLink, FileCode2 } from 'lucide-react';

const FREE_BOTS = [
  {
    id: 'moving-average-example',
    name: 'Moving Average Example',
    style: 'Trend following',
    description: 'A Deriv DBot example that demonstrates a moving-average based Rise/Fall setup.',
    file: 'moving-average-example.xml',
  },
  {
    id: 'three-same-candle-colors',
    name: 'Three Same Candle Colors',
    style: 'Candle pattern',
    description: 'A sample strategy that checks for three consecutive candles with matching direction.',
    file: 'three-same-candle-colors.xml',
  },
  {
    id: 'rsi-call-put',
    name: 'RSI Call / Put Example',
    style: 'Momentum',
    description: 'A DBot RSI example for exploring momentum conditions and Rise/Fall contracts.',
    file: 'rsi-call-put.xml',
  },
] as const;

export function FreeBotsView() {
  const base = import.meta.env.BASE_URL;
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="rounded-2xl border border-line bg-surface p-5 sm:p-7">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
            <Bot className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Strategy library</p>
            <h1 className="mt-1 text-2xl font-bold text-ink">Free Bots</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted">
              Browse sample Deriv DBot strategies, download an XML file, then import it in Deriv Bot to inspect and run it.
              These are examples, not performance-tested recommendations.
            </p>
          </div>
        </div>
      </header>

      <section aria-label="Available free bots" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {FREE_BOTS.map((bot) => (
          <article key={bot.id} className="flex flex-col rounded-2xl border border-line bg-surface p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-elevated text-accent">
                <FileCode2 className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold text-muted">{bot.style}</span>
            </div>
            <h2 className="mt-4 text-base font-bold text-ink">{bot.name}</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{bot.description}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <a
                href={`${base}free-bots/${bot.file}`}
                download={bot.file}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white transition hover:bg-accent-strong"
              >
                <ArrowDownToLine className="h-4 w-4" aria-hidden="true" /> Download XML
              </a>
              <a
                href={`${base}bot/`}
                className="inline-flex items-center gap-2 rounded-lg border border-line bg-elevated px-3 py-2 text-xs font-semibold text-ink transition hover:border-accent/50"
              >
                Open Deriv Bot <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </article>
        ))}
      </section>
      <p className="rounded-xl border border-line bg-surface px-4 py-3 text-xs leading-relaxed text-muted">
        To use a strategy, download its XML, open Deriv Bot, and choose the option to load or import a local strategy file.
        Review the market, contract, stake, and all trade logic before starting. Use a demo account while evaluating it.
      </p>
    </div>
  );
}
