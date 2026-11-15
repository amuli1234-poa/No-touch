import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SINGLE CHART GUARD — the application must render exactly ONE candlestick chart. This test
 * statically verifies that only the shared canvas imports the chart component; every other
 * module must publish an overlay through ModuleChartSlot instead of rendering its own chart.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('single shared chart', () => {
  it('is imported by exactly one component', () => {
    const importers = walk(SRC).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /import\s*\{[^}]*\bCandlestickChart\b[^}]*\}\s*from\s*['"][^'"]*CandlestickChart['"]/.test(
        source
      );
    });
    assert.deepEqual(
      importers.map((f) => f.replace(SRC, '').replace(/\\/g, '/')),
      ['/components/chart/SingleChartCanvas.tsx']
    );
  });

  it('never renders a second <CandlestickChart /> outside the shared canvas', () => {
    // Only the chart component itself counts. `lucide-react` also exports an
    // icon named `CandlestickChart` (used by the marketing site), so a bare
    // `<CandlestickChart>` match would flag the landing page; require the file
    // to actually import the chart component from the chart module.
    const offenders = walk(SRC).filter((file) => {
      if (file.endsWith('CandlestickChart.tsx') || file.endsWith('SingleChartCanvas.tsx')) {
        return false;
      }
      const source = readFileSync(file, 'utf8');
      const importsChartComponent =
        /import\s*\{[^}]*\bCandlestickChart\b[^}]*\}\s*from\s*['"][^'"]*CandlestickChart['"]/.test(
          source
        );
      return importsChartComponent && /<CandlestickChart\b/.test(source);
    });
    assert.deepEqual(offenders, []);
  });

  it('has every module publish its overlay through ModuleChartSlot', () => {
    const slots = walk(SRC).filter((file) => /<ModuleChartSlot\b/.test(readFileSync(file, 'utf8')));
    assert.ok(slots.length >= 4, `expected module views to use ModuleChartSlot, found ${slots.length}`);
  });
});
