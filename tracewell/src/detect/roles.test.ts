import { describe, expect, it } from 'vitest';
import type { ColumnPlan } from '@tw/model';
import { columnFields, planFixture, planNamed } from './__fixtures__/sniff';
import { detectLatLonCrs, detectRole, isBelowDetectionLimit } from './index';

describe('detectRole on fixtures', () => {
  it('csv_latlon_swapped_out_of_range.csv: Latitude and Longitude keep their roles despite bad values', () => {
    const { plans } = planFixture('csv_latlon_swapped_out_of_range.csv');
    expect(planNamed(plans, 'Latitude').role.value).toBe('latitude');
    expect(planNamed(plans, 'Longitude').role.value).toBe('longitude');
    expect(planNamed(plans, 'Latitude').role.assumed).toBe(false);
  });

  it('csv_well_daily_golden.csv: id, time and a measure with its unit', () => {
    const { plans } = planFixture('csv_well_daily_golden.csv');
    expect(planNamed(plans, 'well_id').role.value).toBe('id');
    expect(planNamed(plans, 'date').role.value).toBe('time');
    const pressure = planNamed(plans, 'Pressure');
    expect(pressure.role.value).toBe('measure');
    expect(pressure.unit.value).toBe('psia');
    expect(pressure.quantity).toBe('pressure_abs');
    expect(pressure.sourceHeader).toEqual(['Pressure (psia)']);
  });

  it('csv_leading_zero_ids_ndl.csv: <0.5 and ND are below-detection-limit and the column stays numeric', () => {
    const { sniff, plans } = planFixture('csv_leading_zero_ids_ndl.csv');
    const benzene = columnFields(sniff, 'Benzene (ppm)').filter((v): v is string => typeof v === 'string');
    expect(benzene.filter(isBelowDetectionLimit)).toEqual(['<0.5', 'ND', '<0.5']);
    expect(columnFields(sniff, 'H2S (ppm)').filter((v) => typeof v === 'string' && isBelowDetectionLimit(v))).toEqual([
      '<1',
    ]);
    expect(planNamed(plans, 'Benzene').type.value).toBe('number');
    expect(planNamed(plans, 'sample_id').type.value).toBe('string');
  });
});

describe('isBelowDetectionLimit', () => {
  it.each(['<0.5', '< 0.5', '<0,5', '<1 ppm', 'ND', 'nd', 'n.d.', 'N.D.', 'BDL', '<LOD'])('recognises %s', (t) => {
    expect(isBelowDetectionLimit(t)).toBe(true);
  });
  it.each(['0.5', '', 'N/A', 'NDX', '<', '<abc', '> 5', 'North Dakota'])('rejects %s', (t) => {
    expect(isBelowDetectionLimit(t)).toBe(false);
  });
});

describe('detectRole rules', () => {
  it('reads abbreviated axes only with values in range', () => {
    expect(detectRole('lat', 'number', [57.4, -12], null)).toMatchObject({ value: 'latitude', confidence: 'high' });
    expect(detectRole('lat', 'number', [157.4], null)).toMatchObject({
      value: 'latitude',
      confidence: 'medium',
      assumed: true,
    });
    expect(detectRole('lon_dd', 'number', [-179.5], null).value).toBe('longitude');
  });

  it('needs a numeric type for spatial roles', () => {
    expect(detectRole('Latitude', 'string', ['57N'], null).value).toBe('text');
  });

  it('finds easting and northing', () => {
    expect(detectRole('Easting (m)', 'number', [512000], 'm').value).toBe('easting');
    expect(detectRole('UTM northing', 'number', [6400000], 'm').value).toBe('northing');
  });

  it('takes time from the type', () => {
    expect(detectRole('when', 'datetime', [], null).value).toBe('time');
  });

  it('finds identifiers by name, including camel case', () => {
    expect(detectRole('WellID', 'string', ['A'], null).value).toBe('id');
    expect(detectRole('Meter ID', 'integer', [1, 1], null).value).toBe('id');
  });

  it('needs high cardinality for id-like words', () => {
    expect(detectRole('Tag', 'string', ['a', 'b', 'c', 'd', 'e'], null)).toMatchObject({
      value: 'id',
      confidence: 'medium',
    });
    expect(detectRole('Tag', 'string', ['a', 'a', 'a', 'a', 'b'], null).value).toBe('text');
  });

  it('finds unit columns', () => {
    expect(detectRole('UOM', 'string', ['psia'], null).value).toBe('unit');
  });

  it('makes other numbers measures and the rest text', () => {
    expect(detectRole('Choke size', 'integer', [32], null)).toMatchObject({ value: 'measure', assumed: false });
    expect(detectRole('active', 'boolean', [true], null).value).toBe('text');
    expect(detectRole('geometry', 'geometry', [], null).value).toBe('geometry');
  });
});

describe('detectLatLonCrs', () => {
  it('assumes EPSG:4326 for a latitude/longitude pair', () => {
    const { plans } = planFixture('csv_well_daily_golden.csv');
    const crs = detectLatLonCrs(plans);
    expect(crs?.value).toEqual({ code: 'EPSG:4326', source: 'assumed-latlon' });
    expect(crs?.confidence).toBe('medium');
    expect(crs?.assumed).toBe(true);
  });

  it('returns null without both axes', () => {
    const { plans } = planFixture('csv_null_markers.csv');
    expect(detectLatLonCrs(plans)).toBeNull();
    const onlyLat = plans.map((p, i): ColumnPlan => (i === 2 ? { ...p, role: { ...p.role, value: 'latitude' } } : p));
    expect(detectLatLonCrs(onlyLat)).toBeNull();
  });
});
