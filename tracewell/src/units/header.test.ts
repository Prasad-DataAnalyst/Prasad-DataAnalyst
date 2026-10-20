import { readFileSync } from 'node:fs';
import type { Confidence } from '@tw/model';
import { describe, expect, it } from 'vitest';
import { parseHeaderUnit, splitValueUnit } from './index';

interface HeaderCase {
  header: string;
  name: string;
  unit: string | null;
  confidence?: Confidence;
  method?: string;
}

interface CellCase {
  text: string;
  value: string | null;
  unit: string | null;
}

const FIXTURE = JSON.parse(readFileSync(new URL('./__fixtures__/headers.json', import.meta.url), 'utf8')) as {
  headers: HeaderCase[];
  cells: CellCase[];
};

describe('parseHeaderUnit', () => {
  it.each(FIXTURE.headers)('$header', (c) => {
    const { name, unit } = parseHeaderUnit(c.header);
    expect(name).toBe(c.name);
    if (c.unit === null) {
      expect(unit).toBeNull();
      return;
    }
    expect(unit).toMatchObject({ value: c.unit, confidence: c.confidence, method: c.method, source: 'detected' });
  });

  it('marks every detection below high confidence as assumed', () => {
    for (const c of FIXTURE.headers) {
      const { unit } = parseHeaderUnit(c.header);
      if (unit !== null) expect(unit.assumed).toBe(unit.confidence !== 'high');
    }
  });

  it('explains each detection with the header text', () => {
    const { unit } = parseHeaderUnit('T [°F]');
    expect(unit?.evidence).toBe('The header "T [°F]" gives the unit "°F" (degF) in brackets.');
    expect(parseHeaderUnit('Depth ft').unit?.evidence).toBe('The header "Depth ft" ends with "ft", read as its unit.');
    expect(parseHeaderUnit('Temp C').unit?.evidence).toContain('A single letter is often not a unit');
    expect(parseHeaderUnit('WHP psig avg').unit?.evidence).toContain('contains the word "psig"');
  });

  it('covers the plan cases', () => {
    expect(parseHeaderUnit('Pressure (psia)')).toMatchObject({
      name: 'Pressure',
      unit: { value: 'psia', confidence: 'high' },
    });
    expect(parseHeaderUnit('T [°F]')).toMatchObject({ name: 'T', unit: { value: 'degF', confidence: 'high' } });
    expect(parseHeaderUnit('rate_kg_h')).toMatchObject({ name: 'rate', unit: { value: 'kg/h', confidence: 'medium' } });
    expect(parseHeaderUnit('Depth ft')).toMatchObject({ name: 'Depth', unit: { value: 'ft', confidence: 'medium' } });
    expect(parseHeaderUnit('Comments')).toEqual({ name: 'Comments', unit: null });
  });
});

describe('splitValueUnit', () => {
  it.each(FIXTURE.cells)('"$text"', (c) => {
    const result = splitValueUnit(c.text);
    if (c.unit === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result?.value).toBe(c.value);
    expect(result?.unit.code).toBe(c.unit);
  });

  it('splits the plan cases', () => {
    expect(splitValueUnit('12.5 psi')).toMatchObject({
      value: '12.5',
      unit: { code: 'psi', quantity: 'pressure_abs' },
    });
    expect(splitValueUnit('83 kPa')).toMatchObject({ value: '83', unit: { code: 'kPa', quantity: 'pressure_abs' } });
  });

  it('keeps grouping spaces such as the no-break space in the value text', () => {
    const nbsp = String.fromCharCode(0x00a0);
    expect(splitValueUnit(`1${nbsp}234 kPa`)).toMatchObject({ value: `1${nbsp}234`, unit: { code: 'kPa' } });
  });
});
