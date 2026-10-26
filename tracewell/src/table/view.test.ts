import { describe, expect, it } from 'vitest';
import { EngineError, type CellValue, type ColumnId, type RowId } from '@tw/model';
import { Overlay, RowSet, View, type DerivedColumn, type ViewSpec } from './index';
import { columnSchema, datasetOf } from './__fixtures__/tables';
import type { Dataset } from './dataset';

const ROWS = 10;

/** c0: 'w0'..'w9'; c1: 0, 10, ..., 90; c2: true/false alternating. */
function dataset(): Dataset {
  const columns = [
    columnSchema('c0', 'string'),
    columnSchema('c1', 'number', { unit: 'psia' }),
    columnSchema('c2', 'boolean'),
  ];
  const rows = Array.from({ length: ROWS }, (_, i) => [`w${i}`, i * 10, i % 2 === 0]);
  return datasetOf(columns, rows);
}

function spec(overrides: Partial<ViewSpec> = {}): ViewSpec {
  return {
    overlay: new Overlay(),
    excluded: new RowSet(ROWS),
    derived: [],
    hidden: [],
    rowFilter: null,
    columnOrder: null,
    ...overrides,
  };
}

/** c1 converted to kPa, as a convert_unit step in add_column mode would. */
function kpa(id: ColumnId = 'c1~kPa'): DerivedColumn {
  return {
    schema: columnSchema(id, 'number', { unit: 'kPa' }),
    compute(get: (c: ColumnId, r: RowId) => CellValue, r: RowId): CellValue {
      const v = get('c1', r);
      return typeof v === 'number' ? v * 6.894757293168361 : null;
    },
  };
}

describe('View value resolution', () => {
  it('lets the overlay win over derived and base values', () => {
    const overlay = new Overlay();
    overlay.set(3, 'c1', 999, 7);
    overlay.set(4, 'c1~kPa', -1, 8);
    const view = new View(dataset(), spec({ overlay, derived: [kpa()] }));
    expect(view.value(3, 'c1')).toBe(999);
    expect(view.baseValue(3, 'c1')).toBe(30);
    expect(view.isEdited(3, 'c1')).toBe(true);
    expect(view.isEdited(2, 'c1')).toBe(false);
    // The derived column reads the edited source value, and its own edit wins over the computation.
    expect(view.value(3, 'c1~kPa')).toBeCloseTo(999 * 6.894757293168361);
    expect(view.value(4, 'c1~kPa')).toBe(-1);
    expect(view.baseValue(4, 'c1~kPa')).toBeCloseTo(40 * 6.894757293168361);
    expect(view.value(2, 'c1~kPa')).toBeCloseTo(20 * 6.894757293168361);
  });

  it('lets a derived column replace a base column in place, computing from the base value', () => {
    const view = new View(dataset(), spec({ derived: [kpa('c1')] }));
    expect(view.columnIds()).toEqual(['c0', 'c1', 'c2']);
    expect(view.value(1, 'c1')).toBeCloseTo(68.94757293168361);
    expect(view.columnSchema('c1').unit.value).toBe('kPa');
    expect(view.raw(1, 'c1')).toBeUndefined();
  });

  it('chains derived columns in step order', () => {
    const doubled: DerivedColumn = {
      schema: columnSchema('c1~x2', 'number'),
      compute: (get, r) => (get('c1~kPa', r) as number) * 2,
    };
    const view = new View(dataset(), spec({ derived: [kpa(), doubled] }));
    expect(view.value(1, 'c1~x2')).toBeCloseTo(2 * 68.94757293168361);
  });

  it('refuses unknown columns', () => {
    const view = new View(dataset(), spec());
    expect(() => view.value(0, 'c9')).toThrow(EngineError);
    expect(() => view.columnSchema('c9')).toThrow(EngineError);
  });
});

describe('View rows', () => {
  it('hides excluded rows', () => {
    const view = new View(dataset(), spec({ excluded: RowSet.of(ROWS, [0, 5]) }));
    expect(view.rowCount).toBe(8);
    expect([...view.rows()]).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
    expect(view.schema.rowCount).toBe(8);
  });

  it('applies the row filter after exclusion', () => {
    const view = new View(
      dataset(),
      spec({ excluded: RowSet.of(ROWS, [2, 3]), rowFilter: RowSet.of(ROWS, [1, 2, 4]) }),
    );
    expect([...view.rows()]).toEqual([1, 4]);
    expect(view.rowIdAt(1)).toBe(4);
  });

  it('gives -1 for the index of an excluded row', () => {
    const view = new View(dataset(), spec({ excluded: RowSet.of(ROWS, [4]) }));
    expect(view.indexOf(4)).toBe(-1);
    expect(view.indexOf(5)).toBe(4);
    expect(view.indexOf(0)).toBe(0);
    expect(view.indexOf(ROWS)).toBe(-1);
    expect(() => view.rowIdAt(9)).toThrow(EngineError);
  });

  it('refuses row sets of the wrong capacity', () => {
    expect(() => new View(dataset(), spec({ excluded: new RowSet(3) }))).toThrow(EngineError);
    expect(() => new View(dataset(), spec({ rowFilter: new RowSet(11) }))).toThrow(EngineError);
  });
});

describe('View columns', () => {
  it('removes hidden columns and respects the column order', () => {
    const view = new View(dataset(), spec({ derived: [kpa()], hidden: ['c1'], columnOrder: ['c2', 'c1~kPa', 'c1'] }));
    // c0 is not in the order, so it follows the ordered columns.
    expect(view.columnIds()).toEqual(['c2', 'c1~kPa', 'c0']);
    expect(view.schema.columns.map((c) => c.id)).toEqual(['c2', 'c1~kPa', 'c0']);
    // A hidden column can still be read, which is what derived columns and rules rely on.
    expect(view.value(1, 'c1')).toBe(10);
  });

  it('appends derived columns after the base columns by default', () => {
    expect(new View(dataset(), spec({ derived: [kpa()] })).columnIds()).toEqual(['c0', 'c1', 'c2', 'c1~kPa']);
  });

  it('refuses unknown and repeated columns in the order', () => {
    expect(() => new View(dataset(), spec({ columnOrder: ['c9'] }))).toThrow(EngineError);
    expect(() => new View(dataset(), spec({ columnOrder: ['c0', 'c0'] }))).toThrow(EngineError);
  });
});

describe('View.window', () => {
  const view = new View(dataset(), spec({ excluded: RowSet.of(ROWS, [0]) }));

  it('pages from the start', () => {
    const page = view.window(0, 3);
    expect(page.rowIds).toEqual([1, 2, 3]);
    expect(page.values).toEqual([
      ['w1', 10, false],
      ['w2', 20, true],
      ['w3', 30, false],
    ]);
  });

  it('stops at the last row and returns nothing past it', () => {
    expect(view.window(7, 5).rowIds).toEqual([8, 9]);
    expect(view.window(8, 1).rowIds).toEqual([9]);
    expect(view.window(9, 5)).toEqual({ rowIds: [], values: [] });
    expect(view.window(50, 5)).toEqual({ rowIds: [], values: [] });
    expect(view.window(0, 0)).toEqual({ rowIds: [], values: [] });
  });

  it('returns only the requested columns, in the requested order', () => {
    expect(view.window(0, 2, ['c2', 'c0']).values).toEqual([
      [false, 'w1'],
      [true, 'w2'],
    ]);
  });

  it('refuses negative or fractional bounds', () => {
    expect(() => view.window(-1, 3)).toThrow(EngineError);
    expect(() => view.window(0, 1.5)).toThrow(EngineError);
    expect(() => view.window(0, 2, ['c9'])).toThrow(EngineError);
  });

  it('exposes raw text of base columns', () => {
    const v = new View(dataset(), spec());
    expect(v.raw(0, 'c0')).toBeUndefined();
    expect(() => v.raw(0, 'c9')).toThrow(EngineError);
  });
});

describe('Overlay', () => {
  it('stores edits with their audit seq and lists them in row, column order', () => {
    const o = new Overlay();
    o.set(5, 'c1', 1, 3);
    o.set(2, 'c2', 'x', 4);
    o.set(2, 'c1', null, 5);
    o.set(5, 'c1', 2, 6);
    expect(o.get(5, 'c1')).toEqual({ value: 2, seq: 6 });
    expect([...o.entries()]).toEqual([
      { rowId: 2, columnId: 'c1', value: null, seq: 5 },
      { rowId: 2, columnId: 'c2', value: 'x', seq: 4 },
      { rowId: 5, columnId: 'c1', value: 2, seq: 6 },
    ]);
    const copy = o.clone();
    o.delete(2, 'c2');
    expect(o.has(2, 'c2')).toBe(false);
    expect(copy.has(2, 'c2')).toBe(true);
    expect(() => o.set(-1, 'c1', 1, 1)).toThrow(EngineError);
    expect(() => o.set(1, 'c1', 1, 0)).toThrow(EngineError);
  });
});
