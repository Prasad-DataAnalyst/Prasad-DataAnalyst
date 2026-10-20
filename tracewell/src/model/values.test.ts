import { describe, expect, it } from 'vitest';
import { isDateCell, isDateTimeCell, isGeometryCell, rawToText, type RawField } from './values';

describe('cell guards', () => {
  const date = { date: '2026-03-01' };
  const datetime = { datetime: '2026-03-01T06:30:00.000Z' };
  const geometry = { geometry: { type: 'Point', coordinates: [1, 2] } };

  it('recognise each object cell and nothing else', () => {
    expect([isDateCell(date), isDateTimeCell(date), isGeometryCell(date)]).toEqual([true, false, false]);
    expect([isDateCell(datetime), isDateTimeCell(datetime), isGeometryCell(datetime)]).toEqual([false, true, false]);
    expect([isDateCell(geometry), isDateTimeCell(geometry), isGeometryCell(geometry)]).toEqual([false, false, true]);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', '2026-03-01'],
    ['a number', 46082],
    ['an array', ['2026-03-01']],
    ['a date with a numeric value', { date: 46082 }],
    ['a datetime with a Date value', { datetime: new Date(0) }],
    ['a geometry without a type', { geometry: { coordinates: [1, 2] } }],
    ['a geometry that is a string', { geometry: 'POINT (1 2)' }],
    ['an object that is both a date and a datetime', { date: '2026-03-01', datetime: '2026-03-01T06:30:00.000Z' }],
    ['a date with another member', { date: '2026-03-01', note: 'estimated' }],
    ['a datetime with another member', { datetime: '2026-03-01T06:30:00.000Z', zone: 'Europe/London' }],
    ['a geometry with another member', { geometry: { type: 'Point', coordinates: [1, 2] }, crs: 'EPSG:27700' }],
  ])('reject %s', (_name, value) => {
    expect(isDateCell(value) || isDateTimeCell(value) || isGeometryCell(value)).toBe(false);
  });

  it('accept object cells without a prototype, as structuredClone and parsers may produce', () => {
    const bare = Object.assign(Object.create(null) as object, { date: '2026-03-01' });
    expect(isDateCell(bare)).toBe(true);
  });
});

describe('rawToText', () => {
  it.each<[string, RawField, string]>([
    ['an empty field', null, ''],
    ['text as written', ' 0012 ', ' 0012 '],
    ['an empty string', '', ''],
    ['a number in canonical form', 1520.5, '1520.5'],
    ['negative zero', -0, '0'],
    ['a large number', 1e21, '1e+21'],
    ['true', true, 'true'],
    ['false', false, 'false'],
    ['a native date', { date: '2026-03-01' }, '2026-03-01'],
    ['a native datetime', { datetime: '2026-03-01T06:30:00.000Z' }, '2026-03-01T06:30:00.000Z'],
    ['a spreadsheet error cell', { error: '#DIV/0!' }, '#DIV/0!'],
  ])('gives %s', (_name, field, text) => {
    expect(rawToText(field)).toBe(text);
  });
});
