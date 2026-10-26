import { describe, expect, it } from 'vitest';
import { cellTooltip, formatCell, formatCount } from './format';

describe('formatCell', () => {
  it.each([
    [null, 'number', ''],
    ['W-01', 'string', 'W-01'],
    ['0012', 'string', '0012'],
    [42, 'integer', '42'],
    [1234.5, 'number', '1234.5'],
    [0.1 + 0.2, 'number', '0.3'],
    [-0, 'number', '0'],
    [1e21, 'number', '1e+21'],
    [1.5e-9, 'number', '1.5e-9'],
    [true, 'boolean', 'TRUE'],
    [false, 'boolean', 'FALSE'],
    [{ date: '2026-01-31' }, 'date', '2026-01-31'],
    [{ datetime: '2026-01-31T10:00:00.000Z' }, 'datetime', '2026-01-31T10:00:00Z'],
    [{ datetime: '2026-01-31T10:00:00.250Z' }, 'datetime', '2026-01-31T10:00:00.250Z'],
    [{ geometry: { type: 'Point', coordinates: [1.5, 60.25] } }, 'geometry', 'POINT (1.5 60.25)'],
    [
      {
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
      'geometry',
      'LINESTRING',
    ],
  ] as const)('%j as %s gives %j', (v, type, expected) => {
    expect(formatCell(v as Parameters<typeof formatCell>[0], type)).toBe(expected);
  });

  it('keeps the exact stored value available for a tooltip', () => {
    expect(cellTooltip(0.1 + 0.2)).toContain('0.30000000000000004');
    expect(cellTooltip(null)).toBe('empty');
  });
});

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [12345, '12,345'],
    [1234567, '1,234,567'],
  ])('%i gives %s', (n, expected) => {
    expect(formatCount(n)).toBe(expected);
  });

  it('does not round a non-integer silently', () => {
    expect(formatCount(2.5)).toBe('2.5');
  });
});
