import { DrawingStore, isValidDrawingRecord } from '../features/drawing-management/DrawingStore';
import { drawingsToOverlayShapes } from '../features/drawing-management/geometry';
import type { DrawingRecord } from '../features/drawing-management/types';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL: ${name}`);
  }
}

const zone = (over: Partial<Parameters<DrawingStore['addFromZone']>[0]> = {}) => ({
  symbol: 'R_100',
  direction: 'RISE' as const,
  timeframe: '5m' as const,
  startEpoch: 1700000000,
  endEpoch: 1700003600,
  upperPrice: 105.5,
  lowerPrice: 104.2,
  sourceAnalysisId: 'analysis-1',
  ...over
});

console.log('\n[1] Creation requires a validated analysis zone');
{
  const store = new DrawingStore({ persist: false });
  const rec = store.addFromZone(zone());
  check('creates a drawing from a validated zone', rec !== null && store.size() === 1);
  check('assigns a unique id', typeof rec?.id === 'string' && rec!.id.length > 0);
  check('stores coordinates verbatim', rec!.upperPrice === 105.5 && rec!.lowerPrice === 104.2);
  check('records the source analysis id', rec!.sourceAnalysisId === 'analysis-1');
  check('stamps a creation time', Number.isFinite(rec!.createdAt) && rec!.createdAt > 0);

  const noAnalysis = store.addFromZone(zone({ sourceAnalysisId: '' }));
  check('rejects a drawing with no source analysis', noAnalysis === null && store.size() === 1);

  const twoIds = store.addFromZone(zone({ id: 'fixed-1' }));
  const twoIds2 = store.addFromZone(zone({ id: 'fixed-2' }));
  check('ids are distinct across drawings', twoIds!.id !== twoIds2!.id);
}

console.log('\n[2] Invalid coordinates are rejected, never coerced');
{
  const store = new DrawingStore({ persist: false });
  check('rejects upper <= lower', store.addFromZone(zone({ upperPrice: 100, lowerPrice: 101 })) === null);
  check('rejects end <= start', store.addFromZone(zone({ startEpoch: 2000, endEpoch: 2000 })) === null);
  check('rejects NaN price', store.addFromZone(zone({ upperPrice: Number.NaN })) === null);
  check('rejects non-positive epoch', store.addFromZone(zone({ startEpoch: 0 })) === null);
  check('stores nothing after all rejections', store.size() === 0);
}

console.log('\n[3] Visibility, deletion and clearing');
{
  const store = new DrawingStore({ persist: false });
  const a = store.addFromZone(zone())!;
  store.addFromZone(zone({ direction: 'FALL' }));
  check('two records stored', store.size() === 2);

  check('remove returns true for an existing id', store.remove(a.id) === true);
  check('record count drops after removal', store.size() === 1);
  check('remove returns false for a missing id', store.remove('nope') === false);

  store.setVisible(false);
  check('visibility flag is off', store.getSnapshot().visible === false);
  store.setVisible(true);
  store.clear();
  check('clear removes every drawing', store.size() === 0 && store.getSnapshot().records.length === 0);
}

console.log('\n[4] Geometry projection copies stored coordinates');
{
  const store = new DrawingStore({ persist: false });
  store.addFromZone(zone({ id: 'g1', direction: 'RISE', timeframe: '5m' }));
  store.addFromZone(zone({ id: 'g2', direction: 'FALL', timeframe: '15m' }));
  store.addFromZone(zone({ id: 'g3', symbol: 'R_50', direction: 'RISE', timeframe: '5m' }));

  const shapes5m = drawingsToOverlayShapes(store.listForSymbol('R_100', '5m'), {
    visible: true,
    symbol: 'R_100',
    timeframe: '5m'
  });
  check('only the matching symbol+timeframe is projected', shapes5m.length === 1);
  const shape = shapes5m[0];
  check('projected as a zone shape', shape.kind === 'zone');
  check(
    'coordinates are copied verbatim',
    shape.kind === 'zone' &&
      shape.from === 1700000000 &&
      shape.to === 1700003600 &&
      shape.top === 105.5 &&
      shape.bottom === 104.2
  );
  check('rise maps to the rise tone', shape.kind === 'zone' && shape.tone === 'rise');

  const fall = drawingsToOverlayShapes(store.listForSymbol('R_100', '15m'), {
    visible: true,
    symbol: 'R_100',
    timeframe: '15m'
  });
  check('fall maps to the fall tone', fall[0].kind === 'zone' && fall[0].tone === 'fall');

  const hidden = drawingsToOverlayShapes(store.listForSymbol('R_100', '5m'), {
    visible: false,
    symbol: 'R_100',
    timeframe: '5m'
  });
  check('hidden drawings project to nothing', hidden.length === 0);
}

console.log('\n[5] Records survive a store round-trip (persistence contract)');
{
  const records: DrawingRecord[] = [
    {
      id: 'persist-1',
      symbol: 'R_75',
      direction: 'FALL',
      timeframe: '1h',
      startEpoch: 1700000000,
      endEpoch: 1700014400,
      upperPrice: 2500.5,
      lowerPrice: 2480.25,
      sourceAnalysisId: 'analysis-9',
      createdAt: 1700000100000,
      source: 'ANALYSIS',
      reason: 'validated supply'
    }
  ];
  const store = new DrawingStore({ persist: false, initial: records });
  check('rehydrates a valid record', store.size() === 1);
  const [rec] = store.listForSymbol('R_75');
  check('preserves exact prices after rehydration', rec.upperPrice === 2500.5 && rec.lowerPrice === 2480.25);
  check('isValidDrawingRecord accepts a well-formed record', isValidDrawingRecord(rec));
  check(
    'isValidDrawingRecord rejects an inverted band',
    !isValidDrawingRecord({ ...rec, upperPrice: 1, lowerPrice: 2 })
  );

  const poisoned = new DrawingStore({
    persist: false,
    initial: [{ ...records[0], id: 'bad', upperPrice: 1, lowerPrice: 2 }]
  });
  check('invalid persisted records are dropped on load', poisoned.size() === 0);
}

console.log('\n========================================');
console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
console.log('========================================\n');

if (failed > 0) process.exit(1);
