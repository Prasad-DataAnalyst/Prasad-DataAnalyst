import { describe, expect, it } from 'vitest';
import { applyConversion, conversionMethod } from '@tw/units';
import type { Step } from '@tw/model';
import { dataset, state } from './__fixtures__/dataset';
import { buildWorkingView, derivedColumnId, validateStep } from './index';

const ds = dataset();
const toKpa = (mode: 'replace' | 'add_column'): Step => ({
  id: 's1',
  seq: 7,
  kind: 'convert_unit',
  columnId: 'c3',
  toUnit: 'kPa',
  mode,
});

describe('convert_unit', () => {
  it('converts every value with the registry method; nulls and raw-rejected cells stay null', () => {
    const view = buildWorkingView(ds, state({ steps: [toKpa('replace')] }));
    const id = derivedColumnId('c3', 'kPa');
    const m = conversionMethod('psia', 'kPa');
    for (let r = 0; r < ds.rowCount; r++) {
      const before = ds.column('c3').get(r);
      expect(view.value(r, id)).toBe(typeof before === 'number' ? applyConversion(m, before) : null);
    }
    expect(view.value(4, id)).toBeNull();
    expect(ds.column('c3').raw(4)).toBe('n/a?');
  });

  it('replace mode hides the source and puts the converted column in its place', () => {
    const view = buildWorkingView(ds, state({ steps: [toKpa('replace')] }));
    const ids = view.schema.columns.map((c) => c.id);
    expect(ids).not.toContain('c3');
    expect(ids.indexOf('c3~kPa')).toBe(3);
    const col = view.schema.columns.find((c) => c.id === 'c3~kPa');
    expect(col?.unit.value).toBe('kPa');
    expect(col?.derivedFrom).toEqual({ column: 'c3', step: 's1' });
    expect(col?.name).toBe('Pressure');
  });

  it('add_column mode keeps both columns', () => {
    const view = buildWorkingView(ds, state({ steps: [toKpa('add_column')] }));
    const ids = view.schema.columns.map((c) => c.id);
    expect(ids.slice(3, 5)).toEqual(['c3', 'c3~kPa']);
    expect(view.schema.columns[4]?.name).toBe('Pressure (kPa)');
  });

  it('refuses psia to psig with UNIT_GAUGE_ABSOLUTE', () => {
    const r = validateStep({ kind: 'convert_unit', columnId: 'c3', toUnit: 'psig', mode: 'replace' }, ds.schema);
    expect(r).toMatchObject({ ok: false, error: { code: 'UNIT_GAUGE_ABSOLUTE' } });
  });

  it('refuses converting a string column with INVALID_INPUT', () => {
    const r = validateStep({ kind: 'convert_unit', columnId: 'c0', toUnit: 'kPa', mode: 'replace' }, ds.schema);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('refuses a dimension mismatch and converting the same column to the same unit twice', () => {
    expect(
      validateStep({ kind: 'convert_unit', columnId: 'c3', toUnit: 'm', mode: 'replace' }, ds.schema),
    ).toMatchObject({
      ok: false,
      error: { code: 'UNIT_DIMENSION' },
    });
    const working = buildWorkingView(ds, state({ steps: [toKpa('add_column')] }));
    expect(
      validateStep({ kind: 'convert_unit', columnId: 'c3', toUnit: 'kPa', mode: 'add_column' }, working.schema),
    ).toMatchObject({
      ok: false,
    });
  });

  it('sanitises the unit in derived column IDs', () => {
    expect(derivedColumnId('c2', 'm3/d')).toBe('c2~m3_d');
  });
});
