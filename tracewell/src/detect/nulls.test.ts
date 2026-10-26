import { describe, expect, it } from 'vitest';
import { columnFields, planFixture, planNamed, sniffFixture } from './__fixtures__/sniff';
import { DEFAULT_NULL_MARKERS, detectNullMarkers } from './index';

describe('detectNullMarkers', () => {
  it('lists the spec defaults', () => {
    expect(DEFAULT_NULL_MARKERS).toEqual(['', 'NA', 'N/A', '#N/A', 'NULL', 'null', '-', '-999.25', '-9999']);
  });

  it('csv_null_markers.csv: Pressure uses -999.25, N/A and empty text, with -999.25 assumed', () => {
    const sniff = sniffFixture('csv_null_markers.csv');
    const d = detectNullMarkers(columnFields(sniff, 'Pressure (psia)'));
    expect(d.value).toEqual(['-999.25', 'N/A', '']);
    expect(d.assumed).toBe(true);
    expect(d.confidence).toBe('medium');
    expect(d.evidence).toContain('-999.25');
  });

  it('csv_null_markers.csv: a single -9999 in Oil is not adopted', () => {
    const sniff = sniffFixture('csv_null_markers.csv');
    const d = detectNullMarkers(columnFields(sniff, 'Oil (bbl/d)'));
    expect(d.value).toEqual([]);
    expect(d.assumed).toBe(false);
  });

  it('does not adopt one -9999 but adopts two', () => {
    expect(detectNullMarkers(['1', '-9999', '2']).value).toEqual([]);
    expect(detectNullMarkers(['1', '-9999', '-9999']).value).toEqual(['-9999']);
  });

  it('adopts text markers on sight, with high confidence', () => {
    const d = detectNullMarkers(['NULL', '5', '#N/A']);
    expect(d.value).toEqual(['NULL', '#N/A']);
    expect(d.confidence).toBe('high');
  });

  it('matches sentinels written differently, including native numbers', () => {
    expect(detectNullMarkers([-999.25, '-999.250', '-999,25']).value).toEqual(['-999.25']);
  });

  it('does not count missing fields (null) as a marker', () => {
    expect(detectNullMarkers([null, null, '3']).value).toEqual([]);
  });

  it('csv_null_markers.csv: only the Pressure plan assumes its null markers', () => {
    const { plans } = planFixture('csv_null_markers.csv');
    expect(planNamed(plans, 'Pressure').nullMarkers.assumed).toBe(true);
    expect(plans.filter((p) => p.nullMarkers.assumed).map((p) => p.name)).toEqual(['Pressure']);
  });
});
