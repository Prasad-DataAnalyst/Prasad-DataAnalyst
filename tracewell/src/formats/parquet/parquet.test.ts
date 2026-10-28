import { describe, expect, it } from 'vitest';
import type { CellValue } from '@tw/model';
import { readParquet, writeParquet, type ParquetColumnIn } from './index';

const COLUMNS: ParquetColumnIn[] = [
  { name: 'text', type: 'string', values: ['a', null, 'ü "q"'] },
  { name: 'number', type: 'number', values: [0.1 + 0.2, -0, 1e21] },
  { name: 'integer', type: 'integer', values: [Number.MAX_SAFE_INTEGER, null, -3] },
  { name: 'flag', type: 'boolean', values: [true, false, null] },
  { name: 'day', type: 'date', values: [{ date: '1969-12-31' }, { date: '2026-02-28' }, null] },
  {
    name: 'at',
    type: 'datetime',
    values: [{ datetime: '2026-01-01T06:00:00.123Z' }, null, { datetime: '1900-01-01T00:00:00.000Z' }],
  },
  { name: 'shape', type: 'geometry', values: [{ geometry: { type: 'Point', coordinates: [1.5, 57] } }, null, null] },
];

describe('Parquet writer and reader', () => {
  it('round-trips every logical type exactly, nulls included', async () => {
    const read = await readParquet(writeParquet(COLUMNS, { 'tracewell.export': 'test' }));
    expect(read.rowCount).toBe(3);
    expect(read.columns.map((c) => c.name)).toEqual(COLUMNS.map((c) => c.name));
    expect(read.values).toEqual(COLUMNS.map((c) => c.values));
    expect(Object.is(read.values[1]?.[1], -0)).toBe(true);
    expect(read.kvMetadata['tracewell.export']).toBe('test');
  });

  it('writes a file with columns and no rows', async () => {
    const read = await readParquet(writeParquet([{ name: 'x', type: 'number', values: [] }]));
    expect(read).toMatchObject({ rowCount: 0, columns: [{ name: 'x', physical: 'DOUBLE' }] });
  });

  it('refuses a value of the wrong type rather than writing something else', () => {
    const bad: CellValue[] = ['1.5'];
    expect(() => writeParquet([{ name: 'n', type: 'number', values: bad }])).toThrow(/not a number value/);
    expect(() => writeParquet([{ name: 'i', type: 'integer', values: [2 ** 53] }])).toThrow(/not a integer value/);
    expect(() => writeParquet([])).toThrow(/at least one column/);
  });
});
