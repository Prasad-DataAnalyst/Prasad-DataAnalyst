import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureBytes, fixtureExpectation } from '@tw/fixtures';
import { detectFormat } from './index';

describe('detectFormat', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    expect(detectFormat(fixtureBytes(name), name).value).toBe(fixtureExpectation(name).format);
  });

  it('reads a .txt CSV as csv with medium confidence', () => {
    const d = detectFormat(new TextEncoder().encode('a,b,c\n1,2,3\n'), 'export.txt');
    expect(d).toMatchObject({ value: 'csv', confidence: 'medium', assumed: true });
  });

  it('reads tab-separated text without an extension as tsv', () => {
    expect(detectFormat(new TextEncoder().encode('a\tb\tc\n1\t2\t3\n'), 'export').value).toBe('tsv');
  });

  it('reads JSON with an unexpected extension as GeoJSON with medium confidence', () => {
    expect(detectFormat(new TextEncoder().encode('  {"type":"FeatureCollection"}'), 'wells.dat')).toMatchObject({
      value: 'geojson',
      confidence: 'medium',
    });
  });

  it('does not trust a .csv extension on a ZIP archive', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectFormat(zip, 'renamed.csv')).toMatchObject({ value: 'xlsx', confidence: 'low' });
  });

  it('handles an empty file', () => {
    expect(detectFormat(new Uint8Array(0), 'empty.csv').value).toBe('csv');
  });
});
