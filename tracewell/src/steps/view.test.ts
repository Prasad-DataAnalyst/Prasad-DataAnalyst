import { describe, expect, it } from 'vitest';
import { Overlay, RowSet } from '@tw/table';
import type { Step } from '@tw/model';
import { dataset, state } from './__fixtures__/dataset';
import { buildOutputView, buildWorkingView, describeStep, previewStep, validateStep } from './index';

const ds = dataset();

describe('output view', () => {
  it('evaluates a filter after a conversion on the converted values', () => {
    const steps: Step[] = [
      { id: 's1', seq: 5, kind: 'convert_unit', columnId: 'c3', toUnit: 'kPa', mode: 'replace' },
      { id: 's2', seq: 6, kind: 'filter', predicate: { column: 'c3~kPa', op: 'gt', value: 1000 } },
    ];
    const view = buildOutputView(ds, state({ steps }));
    // 1200 psia ≈ 8274 kPa and 980.5 psia ≈ 6760 kPa pass; 14.7 psia ≈ 101 kPa does not.
    expect(Array.from({ length: view.rowCount }, (_, i) => view.rowIdAt(i))).toEqual([0, 3]);
  });

  it('respects the order of select_columns', () => {
    const steps: Step[] = [{ id: 's1', seq: 5, kind: 'select_columns', columnIds: ['c3', 'c0'] }];
    expect(buildOutputView(ds, state({ steps })).schema.columns.map((c) => c.id)).toEqual(['c3', 'c0']);
  });

  it('never shows excluded rows, in either view', () => {
    const excluded = RowSet.of(ds.rowCount, [1]);
    const st = state({ excluded });
    for (const view of [buildWorkingView(ds, st), buildOutputView(ds, st)]) {
      const rows = Array.from({ length: view.rowCount }, (_, i) => view.rowIdAt(i));
      expect(rows).not.toContain(1);
    }
  });

  it('uses an edited value in a filter', () => {
    const overlay = new Overlay();
    overlay.set(2, 'c3', 5000, 9);
    const steps: Step[] = [{ id: 's1', seq: 10, kind: 'filter', predicate: { column: 'c3', op: 'gt', value: 4000 } }];
    const view = buildOutputView(ds, state({ overlay, steps }));
    expect(view.rowCount).toBe(1);
    expect(view.rowIdAt(0)).toBe(2);
  });

  it('applies filters in order, narrowing each time', () => {
    const steps: Step[] = [
      { id: 's1', seq: 5, kind: 'filter', predicate: { column: 'c0', op: 'in', values: ['W-01', 'W-02'] } },
      { id: 's2', seq: 6, kind: 'filter', predicate: { column: 'c3', op: 'not_null' } },
    ];
    const view = buildOutputView(ds, state({ steps }));
    expect(Array.from({ length: view.rowCount }, (_, i) => view.rowIdAt(i))).toEqual([0, 1]);
  });
});

describe('describeStep', () => {
  it('describes each kind of step', () => {
    expect(describeStep({ kind: 'convert_unit', columnId: 'c3', toUnit: 'kPa', mode: 'replace' }, ds.schema)).toMatch(
      /^Convert Pressure from psia to kPa \(×6\.894757\d*, .+\)$/,
    );
    expect(describeStep({ kind: 'filter', predicate: { column: 'c3', op: 'gt', value: 100 } }, ds.schema)).toBe(
      'Keep rows where Pressure > 100',
    );
    expect(
      describeStep(
        { kind: 'filter', predicate: { column: 'c3', op: 'gt', value: 100 }, label: 'High pressure' },
        ds.schema,
      ),
    ).toBe('High pressure');
    expect(describeStep({ kind: 'select_columns', columnIds: ['c0', 'c3'] }, ds.schema)).toBe(
      'Keep columns well_id, Pressure',
    );
  });
});

describe('validateStep and previewStep', () => {
  it('refuses an empty or duplicated column selection', () => {
    expect(validateStep({ kind: 'select_columns', columnIds: [] }, ds.schema).ok).toBe(false);
    expect(validateStep({ kind: 'select_columns', columnIds: ['c0', 'c0'] }, ds.schema).ok).toBe(false);
  });

  it('previews a conversion with before and after values and the method', () => {
    const p = previewStep(ds, state(), { kind: 'convert_unit', columnId: 'c3', toUnit: 'kPa', mode: 'replace' }, 2);
    expect(p.ok).toBe(true);
    expect(p.sample).toHaveLength(2);
    expect(p.sample[0]?.before).toBe(1200);
    expect(p.method?.to).toBe('kPa');
  });

  it('previews a filter with the resulting row count', () => {
    const p = previewStep(ds, state(), { kind: 'filter', predicate: { column: 'c0', op: 'eq', value: 'W-02' } });
    expect(p).toMatchObject({ ok: true, resultingRows: 2 });
  });

  it('returns the error instead of throwing for an invalid step', () => {
    const p = previewStep(ds, state(), { kind: 'filter', predicate: { column: 'c42', op: 'is_null' } });
    expect(p.ok).toBe(false);
    expect(p.error?.message).toMatch(/c42/);
  });
});
