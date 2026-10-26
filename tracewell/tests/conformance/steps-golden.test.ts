/** Unit conversion on the reference file matches the cited registry method for every row. */
import { describe, expect, it } from 'vitest';
import { fixtureSource } from '@tw/fixtures';
import { importSource, previewSource } from '@tw/ingest';
import { buildWorkingView, derivedColumnId } from '@tw/steps';
import { Overlay, RowSet } from '@tw/table';
import { applyConversion, conversionMethod } from '@tw/units';

describe('convert_unit on csv_well_daily_golden.csv', () => {
  it('converts Pressure (psia) to kPa exactly as units.applyConversion does', async () => {
    const src = fixtureSource('csv_well_daily_golden.csv');
    const preview = await previewSource(src);
    const { dataset } = await importSource(src, 'd1', preview.spec, {
      signal: new AbortController().signal,
      memoryBudgetBytes: 512 * 1024 ** 2,
      onProgress: () => undefined,
    });
    const pressure = dataset.schema.columns.find((c) => c.unit.value === 'psia');
    if (pressure === undefined) throw new Error('no psia column');
    const view = buildWorkingView(dataset, {
      overlay: new Overlay(),
      excluded: new RowSet(dataset.rowCount),
      steps: [{ id: 's1', seq: 5, kind: 'convert_unit', columnId: pressure.id, toUnit: 'kPa', mode: 'replace' }],
    });
    const m = conversionMethod('psia', 'kPa');
    const id = derivedColumnId(pressure.id, 'kPa');
    let converted = 0;
    for (let r = 0; r < dataset.rowCount; r++) {
      const v = dataset.column(pressure.id).get(r);
      expect(view.value(r, id)).toBe(typeof v === 'number' ? applyConversion(m, v) : null);
      if (typeof v === 'number') converted++;
    }
    expect(converted).toBeGreaterThan(200);
  });
});
