import { describe, expect, it } from 'vitest';
import { detection, type ColumnSchema, type LogicalType, type TableSchema } from '@tw/model';
import { buildPredicate, opsFor, predicateFromForm, type FilterFormState } from './filter-form';

function col(
  id: string,
  name: string,
  type: LogicalType,
  role: ColumnSchema['role']['value'] = 'measure',
): ColumnSchema {
  return {
    id,
    name,
    sourceHeader: [name],
    sourceIndex: Number(id.slice(1)),
    type: detection(type, 'high', 'test', 'test'),
    role: detection(role, 'high', 'test', 'test'),
    unit: detection<string | null>(null, 'high', 'test', 'test'),
    quantity: null,
    nullMarkers: detection<string[]>([], 'high', 'test', 'test'),
  };
}

const SCHEMA: TableSchema = {
  datasetId: 'd1',
  name: 'wells',
  source: { fileId: 'f', fileName: 'wells.csv', format: 'csv' },
  rowCount: 10,
  columns: [
    col('c0', 'well_id', 'string', 'id'),
    col('c1', 'date', 'datetime', 'time'),
    col('c2', 'Pressure', 'number'),
    col('c3', 'lat', 'number', 'latitude'),
    col('c4', 'lon', 'number', 'longitude'),
    col('c5', 'day', 'date', 'time'),
  ],
  crs: null,
  geometryColumn: null,
  partial: false,
};

function form(conditions: FilterFormState['conditions'], extra: Partial<FilterFormState> = {}): FilterFormState {
  return { combinator: 'all', conditions, ...extra };
}

describe('predicateFromForm', () => {
  it('builds a number comparison', () => {
    expect(predicateFromForm(form([{ columnId: 'c2', op: 'gt', value: '1,500.5' }]), SCHEMA)).toEqual({
      column: 'c2',
      op: 'gt',
      value: 1500.5,
    });
  });

  it('builds a date range over a datetime column that covers the whole last day', () => {
    expect(
      predicateFromForm(form([{ columnId: 'c1', op: 'between', value: '2026-01-01', value2: '2026-01-31' }]), SCHEMA),
    ).toEqual({
      column: 'c1',
      op: 'between',
      low: { datetime: '2026-01-01T00:00:00.000Z' },
      high: { datetime: '2026-01-31T23:59:59.999Z' },
    });
    expect(predicateFromForm(form([{ columnId: 'c5', op: 'ge', value: '2026-02-01' }]), SCHEMA)).toEqual({
      column: 'c5',
      op: 'ge',
      value: { date: '2026-02-01' },
    });
  });

  it("builds an in-list from 'a, b'", () => {
    expect(predicateFromForm(form([{ columnId: 'c0', op: 'in', values: 'NS-A01, NS-A02' }]), SCHEMA)).toEqual({
      column: 'c0',
      op: 'in',
      values: ['NS-A01', 'NS-A02'],
    });
  });

  it('builds a contains test and combines conditions with any', () => {
    const p = predicateFromForm(
      form(
        [
          { columnId: 'c0', op: 'contains', value: 'A0' },
          { columnId: 'c2', op: 'is_null' },
        ],
        { combinator: 'any' },
      ),
      SCHEMA,
    );
    expect(p).toEqual({
      any: [
        { column: 'c0', op: 'contains', text: 'A0', caseSensitive: false },
        { column: 'c2', op: 'is_null' },
      ],
    });
  });

  it('builds a bbox test on the latitude and longitude columns', () => {
    const p = predicateFromForm(
      form([], { bbox: { minLon: '1.5', minLat: '57.3', maxLon: '2.0', maxLat: '57.7' } }),
      SCHEMA,
    );
    expect(p).toEqual({ bbox: [1.5, 57.3, 2, 57.7], lat: 'c3', lon: 'c4' });
  });

  it('gives a validation message instead of a predicate for invalid numeric input', () => {
    const result = buildPredicate(form([{ columnId: 'c2', op: 'gt', value: '12abc' }]), SCHEMA);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('not a number'), field: '0.value' });
    expect(() => predicateFromForm(form([{ columnId: 'c2', op: 'gt', value: 'abc' }]), SCHEMA)).toThrow('not a number');
  });

  it('rejects impossible dates, missing values and out-of-range boxes', () => {
    expect(buildPredicate(form([{ columnId: 'c5', op: 'eq', value: '2026-02-30' }]), SCHEMA).ok).toBe(false);
    expect(buildPredicate(form([{ columnId: 'c2', op: 'eq', value: '' }]), SCHEMA).ok).toBe(false);
    expect(
      buildPredicate(form([], { bbox: { minLon: '1', minLat: '95', maxLon: '2', maxLat: '96' } }), SCHEMA).ok,
    ).toBe(false);
    expect(buildPredicate(form([]), SCHEMA)).toMatchObject({ ok: false, message: 'Add at least one condition.' });
  });

  it('offers only the operators that suit the column type', () => {
    expect(opsFor(SCHEMA.columns[0] as ColumnSchema)).toContain('contains');
    expect(opsFor(SCHEMA.columns[2] as ColumnSchema)).not.toContain('contains');
    expect(opsFor(SCHEMA.columns[1] as ColumnSchema)[0]).toBe('between');
  });
});
