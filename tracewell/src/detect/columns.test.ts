import { describe, expect, it } from 'vitest';
import { detection, type RawRow } from '@tw/model';
import { planFixture, planNamed } from './__fixtures__/sniff';
import { collectAssumptions, detectColumns, flattenHeader, type DetectOptions } from './index';

const DOT: DetectOptions = { decimalSeparator: '.', thousandsSeparator: '' };

function rows(...fields: (string | number | null)[][]): RawRow[] {
  return fields.map((f, i) => ({ srcLoc: i + 2, fields: f }));
}

describe('flattenHeader', () => {
  it('joins non-empty parts top to bottom with " / "', () => {
    expect(
      flattenHeader([
        ['Pressure', '', 'Well'],
        ['psia', 'degF', ''],
      ]),
    ).toEqual(['Pressure / psia', 'degF', 'Well']);
  });

  it('collapses a vertically merged cell repeated in both rows', () => {
    expect(flattenHeader([['Gas'], ['Gas']])).toEqual(['Gas']);
  });

  it('de-duplicates names with (2), (3)', () => {
    expect(flattenHeader([['Pressure', 'Pressure', 'Pressure']])).toEqual(['Pressure', 'Pressure (2)', 'Pressure (3)']);
  });

  it('names empty headers by position and handles ragged rows', () => {
    expect(flattenHeader([['a'], ['', '  ']])).toEqual(['a', 'Column 2']);
  });
});

describe('detectColumns', () => {
  it('numbers columns c0..cN by position and keeps the source header cells', () => {
    const plans = detectColumns(
      [
        ['Pressure', 'Well'],
        ['psia', ''],
      ],
      rows(['1.5', 'A']),
      DOT,
    );
    expect(plans.map((p) => [p.id, p.name, p.sourceIndex])).toEqual([
      ['c0', 'Pressure', 0],
      ['c1', 'Well', 1],
    ]);
    expect(plans[0]?.sourceHeader).toEqual(['Pressure', 'psia']);
    expect(plans[0]?.unit.value).toBe('psia');
  });

  it('keeps names unique after units are split off', () => {
    const plans = detectColumns([['Pressure (psia)', 'Pressure (kPa)']], rows(['1', '2']), DOT);
    expect(plans.map((p) => p.name)).toEqual(['Pressure', 'Pressure (2)']);
  });

  it('plans as many columns as the widest sample row when there is no header', () => {
    const plans = detectColumns([], rows(['1'], ['2', 'x']), DOT);
    expect(plans.map((p) => p.name)).toEqual(['Column 1', 'Column 2']);
  });

  it('reads short rows as missing values', () => {
    const plans = detectColumns([['a', 'b']], rows(['1'], ['2', '3']), DOT);
    expect(plans[1]?.type.value).toBe('integer');
  });

  it('samples at most 10,000 rows', () => {
    const sample = rows(...Array.from({ length: 10_000 }, () => ['1']), ['x'], ['y'], ['z']);
    expect(detectColumns([['n']], sample, DOT)[0]?.type).toMatchObject({ value: 'integer', confidence: 'high' });
  });

  it('adds a final geometry column for GeoJSON', () => {
    const { plans } = planFixture('geojson_wells_points_wgs84.geojson');
    const geometry = plans[plans.length - 1];
    expect(geometry).toMatchObject({ id: 'c6', name: 'geometry', sourceIndex: 6, quantity: null });
    expect(geometry?.type.value).toBe('geometry');
    expect(geometry?.role.value).toBe('geometry');
  });

  it('gives numeric columns the file decimal separator', () => {
    const { plans } = planFixture('csv_semicolon_decimalcomma_cp1252.csv');
    expect(planNamed(plans, 'Gas').decimalSeparator?.value).toBe(',');
    expect(planNamed(plans, 'Bemerkung').decimalSeparator).toBeUndefined();
  });

  it('adopts numeric sentinels before typing, so they do not count as values', () => {
    const plans = detectColumns([['when']], rows(['2026-01-01'], ['-9999'], ['-9999'], ['2026-01-04']), DOT);
    expect(plans[0]?.type).toMatchObject({ value: 'date', confidence: 'high' });
    expect(plans[0]?.nullMarkers.value).toEqual(['-9999']);
  });
});

describe('collectAssumptions', () => {
  it('lists dataset-level assumptions first, then each column’s assumed detections', () => {
    const { plans } = planFixture('csv_dates_ambiguous_and_mixed.csv');
    const extra = {
      encoding: detection('utf-8', 'high', 'bom', 'UTF-8 BOM.'),
      crs: detection({ code: 'EPSG:4326', source: 'assumed-latlon' }, 'medium', 'latlon-columns', 'Assumed.'),
    };
    const list = collectAssumptions('d1', plans, extra);
    expect(list.map((a) => [a.columnId, a.property, a.value])).toEqual([
      [null, 'crs', { code: 'EPSG:4326', source: 'assumed-latlon' }],
      ['c1', 'dateFormat', 'dmy'],
      ['c3', 'type', 'date'],
      ['c5', 'timezone', 'naive-assumed-utc'],
    ]);
    expect(list[1]).toMatchObject({ datasetId: 'd1', confidence: 'low' });
    expect(list.every((a) => a.evidence.length > 0)).toBe(true);
  });

  it('is empty when nothing is assumed', () => {
    const { plans } = planFixture('csv_pipe_delimited.csv');
    expect(collectAssumptions('d2', plans, {})).toEqual([]);
  });
});
