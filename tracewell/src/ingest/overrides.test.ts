import { describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import { fixtureBytes, fixtureSource } from '@tw/fixtures';
import { applyOverrides, importSource, previewSource, reparseColumn } from './index';
import { context } from './__fixtures__/helpers';

describe('overrides', () => {
  it('a delimiter override on a semicolon file changes the column count', async () => {
    const src = fixtureSource('csv_semicolon_decimalcomma_cp1252.csv');
    const detected = await previewSource(src);
    if (detected.spec.options.format !== 'csv') throw new Error('expected csv');
    const forced = await previewSource(src, {
      options: { ...detected.spec.options, csv: { ...detected.spec.options.csv, delimiter: ',' } },
    });
    expect(forced.columns.length).not.toBe(detected.columns.length);
    expect(forced.sniff.detections['delimiter']).toMatchObject({ value: ',', source: 'user' });
  });

  it('a unit override changes only the schema, not the values', async () => {
    const src = fixtureSource('csv_well_daily_golden.csv');
    const preview = await previewSource(src);
    const measure = preview.spec.columns.find((c) => c.unit.value === 'psia');
    if (measure === undefined) throw new Error('fixture has no psia column');
    const before = await importSource(src, 'd1', preview.spec, context());
    const changed = applyOverrides(preview.spec, [{ columnId: measure.id, unit: 'kPa' }]);
    const after = await importSource(src, 'd1', changed, context());
    const col = after.dataset.schema.columns.find((c) => c.id === measure.id);
    expect(col?.unit).toMatchObject({ value: 'kPa', source: 'user', assumed: false });
    expect(col?.quantity).toBe('pressure_abs');
    for (let r = 0; r < before.dataset.rowCount; r++) {
      expect(after.dataset.column(measure.id).get(r)).toEqual(before.dataset.column(measure.id).get(r));
    }
  });

  it('rejects an unknown unit and an unknown column', async () => {
    const preview = await previewSource(fixtureSource('csv_well_daily_golden.csv'));
    const first = preview.spec.columns[0];
    if (first === undefined) throw new Error('no columns');
    expect(() => applyOverrides(preview.spec, [{ columnId: first.id, unit: 'furlongs' }])).toThrow(/unit registry/);
    expect(() => applyOverrides(preview.spec, [{ columnId: 'c99', name: 'x' }])).toThrow(/no column c99/);
  });

  it('reparseColumn with type string keeps the raw text exactly', async () => {
    const src = fixtureSource('csv_null_markers.csv');
    const preview = await previewSource(src);
    const outcome = await importSource(src, 'd1', preview.spec, context());
    const numeric = outcome.spec.columns.find((c) => c.type.value === 'number');
    if (numeric === undefined) throw new Error('fixture has no number column');
    const spec = {
      ...applyOverrides(outcome.spec, [{ columnId: numeric.id, type: 'string', nullMarkers: [] }]),
      fileId: outcome.spec.fileId,
    };
    const ds = await reparseColumn(outcome.dataset, src, spec, numeric.id, context());
    const col = ds.column(numeric.id);
    expect(col.type).toBe('string');
    expect(ds.rowCount).toBe(outcome.dataset.rowCount);
    // The source text, field by field, read independently with papaparse.
    const text = new TextDecoder().decode(fixtureBytes('csv_null_markers.csv')).replace(/^\uFEFF/, '');
    const records = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
    const index = numeric.sourceIndex;
    for (let r = 0; r < ds.rowCount; r++) {
      const source = records[ds.srcLoc(r) - 1]?.[index] ?? '';
      expect(col.get(r) ?? '').toBe(source);
    }
    // Every other column is untouched.
    for (const c of outcome.spec.columns.filter((x) => x.id !== numeric.id)) {
      expect(ds.column(c.id)).toBe(outcome.dataset.column(c.id));
    }
  });
});
