import { describe, expect, it } from 'vitest';
import { detection, type ColumnPlan, type LogicalType } from '@tw/model';
import { makeParser, parseDate, parseDateTime, parseNumber, type DetectOptions } from './index';

const DOT: DetectOptions = { decimalSeparator: '.', thousandsSeparator: '' };
const COMMA: DetectOptions = { decimalSeparator: ',', thousandsSeparator: '.' };

function plan(type: LogicalType, extra: Partial<ColumnPlan> = {}): ColumnPlan {
  return {
    id: 'c0',
    name: 'x',
    sourceHeader: ['x'],
    sourceIndex: 0,
    type: detection(type, 'high', 'test', ''),
    role: detection('measure', 'high', 'test', ''),
    unit: detection<string | null>(null, 'high', 'test', ''),
    quantity: null,
    nullMarkers: detection<string[]>(['-999.25', 'N/A', ''], 'medium', 'test', ''),
    ...extra,
  };
}

describe('makeParser', () => {
  it("returns { ok: false, raw } for 'not-measured' in a number column", () => {
    expect(makeParser(plan('number'), DOT)('not-measured')).toEqual({ ok: false, raw: 'not-measured' });
  });

  it("returns the null marker for '-999.25'", () => {
    const parse = makeParser(plan('number'), DOT);
    expect(parse('-999.25')).toEqual({ ok: true, value: null, nullMarker: '-999.25' });
    expect(parse(-999.25)).toEqual({ ok: true, value: null, nullMarker: '-999.25' });
    expect(parse(' N/A ')).toEqual({ ok: true, value: null, nullMarker: 'N/A' });
  });

  it('reads empty fields as plain nulls, naming no marker', () => {
    const parse = makeParser(plan('number'), DOT);
    expect(parse('')).toEqual({ ok: true, value: null });
    expect(parse(null)).toEqual({ ok: true, value: null });
  });

  it("reads '1.234,5' as 1234.5 under a ',' decimal separator", () => {
    expect(makeParser(plan('number'), COMMA)('1.234,5')).toEqual({ ok: true, value: 1234.5 });
  });

  it('keeps below-detection-limit text as raw, never zero', () => {
    expect(makeParser(plan('number'), DOT)('<0.5')).toEqual({ ok: false, raw: '<0.5' });
  });

  it('refuses fractions in an integer column but accepts integral values', () => {
    const parse = makeParser(plan('integer'), DOT);
    expect(parse('12')).toEqual({ ok: true, value: 12 });
    expect(parse('12.0')).toEqual({ ok: true, value: 12 });
    expect(parse('12.5')).toEqual({ ok: false, raw: '12.5' });
  });

  it('keeps text as written in string columns and refuses error cells', () => {
    const parse = makeParser(plan('string'), DOT);
    expect(parse(' 0012 ')).toEqual({ ok: true, value: ' 0012 ' });
    expect(parse(42)).toEqual({ ok: true, value: '42' });
    expect(parse({ error: '#DIV/0!' })).toEqual({ ok: false, raw: '#DIV/0!' });
  });

  it('reads booleans from words, 1/0 and native values', () => {
    const parse = makeParser(plan('boolean'), DOT);
    expect(parse('TRUE')).toEqual({ ok: true, value: true });
    expect(parse('no')).toEqual({ ok: true, value: false });
    expect(parse(1)).toEqual({ ok: true, value: true });
    expect(parse('maybe')).toEqual({ ok: false, raw: 'maybe' });
  });

  it('reads dates in the planned format, native cells and Excel serials', () => {
    const dmy = makeParser(plan('date', { dateFormat: detection('dmy', 'low', 'test', '') }), DOT);
    expect(dmy('03/04/2026')).toEqual({ ok: true, value: { date: '2026-04-03' } });
    expect(dmy({ date: '2026-01-02' })).toEqual({ ok: true, value: { date: '2026-01-02' } });
    expect(dmy('3 Feb 2026')).toEqual({ ok: false, raw: '3 Feb 2026' });
    const serial = makeParser(plan('date', { dateFormat: detection('excel-serial', 'high', 'test', '') }), DOT);
    expect(serial(45292)).toEqual({ ok: true, value: { date: '2024-01-01' } });
    expect(serial('45292')).toEqual({ ok: true, value: { date: '2024-01-01' } });
  });

  it('reads datetimes with their zone, and naive ones as UTC', () => {
    const parse = makeParser(
      plan('datetime', {
        dateFormat: detection('iso', 'high', 'test', ''),
        timezone: detection('utc', 'high', 'test', ''),
      }),
      DOT,
    );
    expect(parse('2026-01-31T10:00:00Z')).toEqual({ ok: true, value: { datetime: '2026-01-31T10:00:00.000Z' } });
    expect(parse('2026-01-31T10:00:00')).toEqual({ ok: true, value: { datetime: '2026-01-31T10:00:00.000Z' } });
    expect(parse({ date: '2026-01-31' })).toEqual({ ok: true, value: { datetime: '2026-01-31T00:00:00.000Z' } });
  });

  it('refuses fields in a geometry column, which reads RawRow.geometry instead', () => {
    expect(makeParser(plan('geometry'), DOT)('POINT (1 2)')).toEqual({ ok: false, raw: 'POINT (1 2)' });
  });
});

describe('parseNumber', () => {
  it.each([
    ['1.5', '.', '', 1.5],
    ['1,5', ',', '', 1.5],
    ['-3', '.', '', -3],
    ['+3', '.', '', 3],
    ['−2.5', '.', '', -2.5],
    ['.5', '.', '', 0.5],
    ['1e3', '.', '', 1000],
    ['1,234,567.5', '.', ',', 1234567.5],
    ['1.234,5', ',', '.', 1234.5],
    ['1 234,5', ',', ' ', 1234.5],
    ['1 234,5', ',', ' ', 1234.5],
    ['-0', '.', '', 0],
  ] as const)('%s with decimal %s and thousands %s is %d', (text, decimal, thousands, expected) => {
    expect(parseNumber(text, decimal, thousands)).toBe(expected);
  });

  it.each([
    ['1.5', ',', ''],
    ['1,5', '.', ','],
    ['1,23', '.', ','],
    ['12,34,567', '.', ','],
    ['abc', '.', ''],
    ['', '.', ''],
    ['.', '.', ''],
    ['1.2.3', '.', ''],
    ['Infinity', '.', ''],
    ['1e999', '.', ''],
    ['0x10', '.', ''],
  ] as const)('refuses %s with decimal %s and thousands %s', (text, decimal, thousands) => {
    expect(parseNumber(text, decimal, thousands)).toBeNull();
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-01-31', 'iso', '2026-01-31'],
    ['2026-1-5', 'iso', '2026-01-05'],
    ['03/04/2026', 'dmy', '2026-04-03'],
    ['03/04/2026', 'mdy', '2026-03-04'],
    ['06.01.2026', 'dmy', '2026-01-06'],
    ['2026/02/13', 'ymd-slash', '2026-02-13'],
    ['2026-01-31 00:00', 'iso', '2026-01-31'],
    ['45292', 'excel-serial', '2024-01-01'],
    ['59', 'excel-serial', '1900-02-28'],
    ['61', 'excel-serial', '1900-03-01'],
    ['2024-02-29', 'iso', '2024-02-29'],
  ] as const)('%s as %s is %s', (text, f, expected) => {
    expect(parseDate(text, f)).toEqual({ date: expected });
  });

  it.each([
    ['2026-02-30', 'iso'],
    ['2025-02-29', 'iso'],
    ['25/04/2026', 'mdy'],
    ['2026-01-31', 'dmy'],
    ['2026-01-31 10:00', 'iso'],
    ['60', 'excel-serial'],
    ['45292.5', 'excel-serial'],
    ['0000-01-01', 'iso'],
    ['yesterday', 'iso'],
  ] as const)('refuses %s as %s', (text, f) => {
    expect(parseDate(text, f)).toBeNull();
  });
});

describe('parseDateTime', () => {
  it.each([
    ['2026-01-31T10:00:00Z', 'iso', '2026-01-31T10:00:00.000Z'],
    ['2026-01-31T10:00:00', 'iso', '2026-01-31T10:00:00.000Z'],
    ['2026-01-31 10:00', 'iso', '2026-01-31T10:00:00.000Z'],
    ['2026-01-31T10:00:00.1234+01:00', 'iso', '2026-01-31T09:00:00.123Z'],
    ['2026-01-31T10:00:00-0330', 'iso', '2026-01-31T13:30:00.000Z'],
    ['2026-01-31T23:30:00-01', 'iso', '2026-02-01T00:30:00.000Z'],
    ['2026-01-31 10:00 UTC', 'iso', '2026-01-31T10:00:00.000Z'],
    ['31/01/2026 2:05 PM', 'dmy', '2026-01-31T14:05:00.000Z'],
    ['01/31/2026 12:00 am', 'mdy', '2026-01-31T00:00:00.000Z'],
    ['2026/01/31 10:00:05', 'ymd-slash', '2026-01-31T10:00:05.000Z'],
    ['2026-01-31', 'iso', '2026-01-31T00:00:00.000Z'],
    ['45292.25', 'excel-serial', '2024-01-01T06:00:00.000Z'],
    ['0099-03-01T00:00:00Z', 'iso', '0099-03-01T00:00:00.000Z'],
  ] as const)('%s as %s is %s', (text, f, expected) => {
    expect(parseDateTime(text, f, 'naive-assumed-utc')).toEqual({ datetime: expected });
  });

  it.each([
    ['2026-01-31T24:00:00Z', 'iso'],
    ['2026-01-31T10:60:00Z', 'iso'],
    ['2026-01-31T10:00:60Z', 'iso'],
    ['2026-01-31T10:00:00+15:00', 'iso'],
    ['2026-01-31T13:00 PM', 'iso'],
    ['2026-01-31T10:00:00 nonsense', 'iso'],
  ] as const)('refuses %s as %s', (text, f) => {
    expect(parseDateTime(text, f, 'utc')).toBeNull();
  });

  it('reads naive values as UTC in every timezone mode', () => {
    for (const tz of ['utc', 'offset', 'naive-assumed-utc'] as const)
      expect(parseDateTime('2026-01-31T10:00', 'iso', tz)).toEqual({ datetime: '2026-01-31T10:00:00.000Z' });
  });
});
