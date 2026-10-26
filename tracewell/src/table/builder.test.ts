import { describe, expect, it } from 'vitest';
import { EngineError, type CellValue, type LogicalType } from '@tw/model';
import { buildColumn, TableBuilder, type CellParse } from './index';
import { columnSchema, tableSchema } from './__fixtures__/tables';

const COLUMNS: { id: string; type: LogicalType }[] = [
  { id: 'c0', type: 'string' },
  { id: 'c1', type: 'integer' },
  { id: 'c2', type: 'number' },
  { id: 'c3', type: 'boolean' },
  { id: 'c4', type: 'date' },
  { id: 'c5', type: 'datetime' },
  { id: 'c6', type: 'geometry' },
];

const SCHEMA = tableSchema(COLUMNS.map((c) => columnSchema(c.id, c.type)));

/** A deterministic mixed-type row; every eleventh row is all nulls. */
function rowValues(i: number): CellValue[] {
  if (i % 11 === 0) return COLUMNS.map(() => null);
  const day = (i % 3650) + 1;
  return [
    `well-${i}`,
    i * 3 - 100_000,
    i / 7,
    i % 2 === 0,
    { date: new Date(day * 86_400_000).toISOString().slice(0, 10) },
    { datetime: new Date(1_700_000_000_000 + i * 1234).toISOString() },
    { geometry: { type: 'Point', coordinates: [i / 1000, -i / 2000] } },
  ];
}

function cells(values: CellValue[]): CellParse[] {
  return values.map((value) => ({ ok: true, value }));
}

describe('TableBuilder', () => {
  it('returns the pushed values for 200,000 rows of mixed types', () => {
    const rows = 200_000;
    const builder = new TableBuilder(COLUMNS);
    for (let i = 0; i < rows; i++) builder.pushRow(i + 2, cells(rowValues(i)));
    expect(builder.rowCount).toBe(rows);
    const ds = builder.finish(SCHEMA);
    expect(ds.rowCount).toBe(rows);
    expect(ds.schema.rowCount).toBe(rows);
    for (const i of [0, 1, 2, 11, 65_535, 65_536, 65_537, 131_072, 199_998, 199_999]) {
      const expected = rowValues(i);
      ds.columns().forEach((col, j) => expect(col.get(i)).toEqual(expected[j]));
    }
    // A full sweep of two columns catches chunk-indexing mistakes the samples could miss.
    for (let i = 0; i < rows; i++) {
      expect(ds.column('c1').get(i)).toBe(rowValues(i)[1]);
      expect(ds.column('c3').get(i)).toBe(rowValues(i)[3]);
    }
  });

  it('keeps the raw text of failed parses with parseOk false', () => {
    const builder = new TableBuilder([{ id: 'c0', type: 'number' }]);
    builder.pushRow(2, [{ ok: true, value: 1.5 }]);
    builder.pushRow(3, [{ ok: false, raw: '<0.5' }]);
    const col = builder.finish(tableSchema([columnSchema('c0', 'number')])).column('c0');
    expect(col.get(1)).toBeNull();
    expect(col.raw(1)).toBe('<0.5');
    expect(col.parseOk(1)).toBe(false);
    expect(col.nullMarker(1)).toBeUndefined();
    expect(col.parseOk(0)).toBe(true);
    expect(col.raw(0)).toBeUndefined();
  });

  it('records null markers', () => {
    const col = buildColumn('c0', 'string', [
      { ok: true, value: null, nullMarker: 'N/A' },
      { ok: true, value: 'x' },
      { ok: true, value: null },
    ]);
    expect(col.get(0)).toBeNull();
    expect(col.nullMarker(0)).toBe('N/A');
    expect(col.raw(0)).toBe('N/A');
    expect(col.parseOk(0)).toBe(true);
    expect(col.nullMarker(2)).toBeUndefined();
    expect(col.raw(2)).toBeUndefined();
  });

  it('grows estimatedBytes roughly linearly', () => {
    const builder = new TableBuilder(COLUMNS);
    const samples: number[] = [];
    for (let i = 0; i < 4 * 65_536; i++) {
      builder.pushRow(i, cells(rowValues(i)));
      if ((i + 1) % 65_536 === 0) samples.push(builder.estimatedBytes());
    }
    const [first, , , fourth] = samples as [number, number, number, number];
    expect(first).toBeGreaterThan(65_536 * 50);
    // Four times the rows should cost about four times the memory, give or take a chunk.
    expect(fourth / first).toBeGreaterThan(3.5);
    expect(fourth / first).toBeLessThan(4.5);
    const ds = builder.finish(SCHEMA);
    expect(ds.estimatedBytes()).toBeGreaterThanOrEqual(fourth * 0.9);
  });

  it('keeps srcLoc for every row', () => {
    const builder = new TableBuilder([{ id: 'c0', type: 'string' }]);
    const locs = [2, 3, 7, 4_294_967_295];
    for (const loc of locs) builder.pushRow(loc, [{ ok: true, value: 'v' }]);
    const ds = builder.finish(tableSchema([columnSchema('c0', 'string')]));
    expect(locs.map((_, r) => ds.srcLoc(r))).toEqual(locs);
    expect(() => ds.srcLoc(4)).toThrow(EngineError);
  });

  it('refuses malformed rows without storing any part of them', () => {
    const builder = new TableBuilder([
      { id: 'c0', type: 'string' },
      { id: 'c1', type: 'integer' },
    ]);
    expect(() => builder.pushRow(1, [{ ok: true, value: 'a' }])).toThrow(EngineError);
    expect(() => builder.pushRow(1, cells(['a', 1.5]))).toThrow(/not a valid integer/);
    expect(() => builder.pushRow(1, cells(['a', 'b']))).toThrow(EngineError);
    expect(() => builder.pushRow(-1, cells(['a', 1]))).toThrow(EngineError);
    expect(() =>
      builder.pushRow(1, [
        { ok: true, value: 'a', nullMarker: 'NA' },
        { ok: true, value: 1 },
      ]),
    ).toThrow(EngineError);
    expect(builder.rowCount).toBe(0);
    builder.pushRow(1, cells(['a', 1]));
    const ds = builder.finish(tableSchema([columnSchema('c0', 'string'), columnSchema('c1', 'integer')]));
    expect(ds.column('c0').length).toBe(1);
    expect(() => builder.pushRow(2, cells(['b', 2]))).toThrow(EngineError);
  });

  it('refuses dates and datetimes that name no real day or instant', () => {
    expect(() => buildColumn('c0', 'date', [{ ok: true, value: { date: '2026-02-30' } }])).toThrow(EngineError);
    expect(() => buildColumn('c0', 'datetime', [{ ok: true, value: { datetime: '2026-01-01T00:00:00Z' } }])).toThrow(
      EngineError,
    );
  });

  it('refuses duplicate column IDs and schemas that disagree with the declared types', () => {
    expect(
      () =>
        new TableBuilder([
          { id: 'c0', type: 'string' },
          { id: 'c0', type: 'number' },
        ]),
    ).toThrow(EngineError);
    const builder = new TableBuilder([{ id: 'c0', type: 'string' }]);
    expect(() => builder.finish(tableSchema([columnSchema('c0', 'number')]))).toThrow(EngineError);
  });
});

describe('Dataset.withColumn', () => {
  it('replaces a column in place and appends a new one, sharing the others', () => {
    const builder = new TableBuilder([
      { id: 'c0', type: 'string' },
      { id: 'c1', type: 'string' },
    ]);
    builder.pushRow(2, cells(['a', '1']));
    builder.pushRow(3, cells(['b', 'x']));
    const ds = builder.finish(tableSchema([columnSchema('c0', 'string'), columnSchema('c1', 'string')]));

    const reparsed = buildColumn('c1', 'number', [
      { ok: true, value: 1 },
      { ok: false, raw: 'x' },
    ]);
    const replaced = ds.withColumn(reparsed, columnSchema('c1', 'number'));
    expect(replaced.columns().map((c) => c.id)).toEqual(['c0', 'c1']);
    expect(replaced.column('c1').get(0)).toBe(1);
    expect(replaced.column('c0')).toBe(ds.column('c0'));
    expect(ds.column('c1').get(0)).toBe('1');
    expect(replaced.srcLoc(1)).toBe(3);

    const added = replaced.withColumn(buildColumn('c1~kPa', 'number', cells([1, 2])), columnSchema('c1~kPa', 'number'));
    expect(added.schema.columns.map((c) => c.id)).toEqual(['c0', 'c1', 'c1~kPa']);
    expect(() => added.withColumn(buildColumn('c2', 'number', cells([1])), columnSchema('c2', 'number'))).toThrow(
      EngineError,
    );
    expect(() => ds.column('nope')).toThrow(EngineError);
  });
});
