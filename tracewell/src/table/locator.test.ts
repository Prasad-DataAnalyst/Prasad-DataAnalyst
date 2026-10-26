import { describe, expect, it } from 'vitest';
import type { TableSchema } from '@tw/model';
import { locator } from './index';
import { columnLetters } from './locator';
import { columnSchema, tableSchema } from './__fixtures__/tables';

function schema(...args: Parameters<typeof tableSchema>): TableSchema {
  return { ...tableSchema(...args), rowCount: 0 };
}

describe('locator', () => {
  it('formats CSV and TSV lines and fields', () => {
    const csv = schema([], 'csv');
    expect(locator(csv, 1042)).toBe('line 1042');
    expect(locator(csv, 1042, columnSchema('c2', 'number', { sourceIndex: 2 }))).toBe('line 1042, field 3');
    expect(locator(schema([], 'tsv'), 7, columnSchema('c0', 'string'))).toBe('line 7, field 1');
  });

  it('formats XLSX cells with column letters', () => {
    const xlsx = schema([], 'xlsx', { source: { fileId: 'f', fileName: 'a.xlsx', format: 'xlsx', sheet: 'Sheet1' } });
    const at = (i: number): string => locator(xlsx, 17, columnSchema('c', 'string', { sourceIndex: i }));
    expect(at(0)).toBe('Sheet1!A17');
    expect(at(2)).toBe('Sheet1!C17');
    expect(at(25)).toBe('Sheet1!Z17');
    expect(at(26)).toBe('Sheet1!AA17');
    expect(at(51)).toBe('Sheet1!AZ17');
    expect(locator(xlsx, 17)).toBe('Sheet1 row 17');
    expect(columnLetters(701)).toBe('ZZ');
    expect(columnLetters(702)).toBe('AAA');
  });

  it('quotes sheet names that are not plain words', () => {
    const xlsx = schema([], 'xlsx', {
      source: { fileId: 'f', fileName: 'a.xlsx', format: 'xlsx', sheet: "Q1 Well's" },
    });
    expect(locator(xlsx, 3, columnSchema('c1', 'string', { sourceIndex: 1 }))).toBe("'Q1 Well''s'!B3");
  });

  it('formats GeoJSON features, properties and the geometry', () => {
    const geo = schema([], 'geojson', { geometryColumn: 'cg' });
    expect(locator(geo, 12)).toBe('feature 12');
    expect(locator(geo, 12, columnSchema('c1', 'number', { header: 'rate' }))).toBe('feature 12, property "rate"');
    expect(locator(geo, 12, columnSchema('cg', 'geometry'))).toBe('feature 12, geometry');
  });
});
