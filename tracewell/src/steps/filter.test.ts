import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnSchema, Predicate } from '@tw/model';
import { dataset, ROWS } from './__fixtures__/dataset';
import { compilePredicate, describePredicate } from './index';

const CASES = JSON.parse(readFileSync(new URL('./__fixtures__/predicates.json', import.meta.url), 'utf8')) as {
  name: string;
  p: Predicate;
  rows: number[];
}[];

const ds = dataset();

function matches(p: Predicate): number[] {
  const test = compilePredicate(p, ds.schema);
  const out: number[] = [];
  for (let r = 0; r < ds.rowCount; r++) if (test((c) => ds.column(c).get(r))) out.push(r);
  return out;
}

describe('compilePredicate', () => {
  it.each(CASES)('$name', ({ p, rows }) => {
    expect(matches(p)).toEqual(rows);
  });

  it('treats every comparison with null as false', () => {
    const ops = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const;
    for (const op of ops) expect(matches({ column: 'c3', op, value: 0 }).includes(2), op).toBe(false);
  });

  it('refuses an unknown column and a value of the wrong type', () => {
    expect(() => compilePredicate({ column: 'c99', op: 'is_null' }, ds.schema)).toThrow(/c99/);
    expect(() => compilePredicate({ column: 'c3', op: 'eq', value: 'high' }, ds.schema)).toThrow(/cannot be compared/);
    expect(() => compilePredicate({ column: 'c3', op: 'contains', text: '1' }, ds.schema)).toThrow(/text columns/);
    expect(() => compilePredicate({ bbox: [0, 0, 1, 1], geometry: 'c3' }, ds.schema)).toThrow(/geometries/);
  });

  it('keeps what has the shape of a geometry and meets the box, and nothing else', () => {
    const first = ds.schema.columns[0] as ColumnSchema;
    const shape: ColumnSchema = { ...first, id: 'g', name: 'shape', type: { ...first.type, value: 'geometry' } };
    const schema = { ...ds.schema, columns: [...ds.schema.columns, shape] };
    const test = compilePredicate({ bbox: [0, 50, 10, 60], geometry: 'g' }, schema);
    const meets = (geometry: unknown) => test(() => (geometry === null ? null : ({ geometry } as CellValue)));
    expect(meets({ type: 'Point', coordinates: [2, 58] })).toBe(true);
    expect(meets({ type: 'Point', coordinates: [20, 58] })).toBe(false);
    expect(meets(null)).toBe(false);
    // An unclosed ring is not valid, but it has a place.
    const open = [
      [1, 51],
      [2, 52],
      [2, 51],
    ];
    expect(meets({ type: 'Polygon', coordinates: [open] })).toBe(true);
    // These have none: the wrong nesting, a missing array, an unknown type, a missing coordinate.
    for (const broken of [
      { type: 'LineString', coordinates: 5 },
      { type: 'Polygon', coordinates: [[2, 58]] },
      { type: 'MultiPoint' },
      { type: 'Circle', coordinates: [2, 58], radius: 5 },
      { type: 'GeometryCollection' },
      { type: 'Point', coordinates: [null, 58] },
    ]) {
      expect(meets(broken), JSON.stringify(broken)).toBe(false);
    }
  });

  it('describes predicates in plain language', () => {
    expect(describePredicate({ column: 'c3', op: 'between', low: 10, high: 20 }, ds.schema)).toBe(
      'Pressure is between 10 and 20',
    );
    expect(describePredicate({ not: { column: 'c0', op: 'eq', value: 'W-01' } }, ds.schema)).toBe(
      'not (well_id = "W-01")',
    );
  });
});

describe('not(p)', () => {
  it('selects exactly the complement of p where the column is not null', () => {
    const numericRows = ROWS.map((r, i) => ({ r: i, v: r[3] })).filter((x) => typeof x.v === 'number');
    fc.assert(
      fc.property(
        fc.constantFrom('eq', 'ne', 'lt', 'le', 'gt', 'ge'),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        (op, value) => {
          const p = { column: 'c3', op, value } as Predicate;
          const yes = new Set(matches(p));
          const no = new Set(matches({ not: p }));
          for (const { r } of numericRows) expect(yes.has(r) !== no.has(r)).toBe(true);
        },
      ),
    );
  });
});

export type { CellValue };
