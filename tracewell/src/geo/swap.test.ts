import { describe, expect, it } from 'vitest';
import type { BBox, Geometry } from '@tw/model';
import { geometryInRange, inLonLatRange, likelySwapped } from '@tw/geo';

const NORTH_SEA: BBox = [-4, 50, 10, 62];

describe('likelySwapped', () => {
  it('flags (lon 57.5, lat 1.8) with a North Sea project area: swapped, it lands in the area', () => {
    expect(likelySwapped(57.5, 1.8, { projectArea: NORTH_SEA })).toBe(true);
  });

  it('does not flag (lon 1.8, lat 57.5), which is already in the North Sea area', () => {
    expect(likelySwapped(1.8, 57.5, { projectArea: NORTH_SEA })).toBe(false);
    expect(likelySwapped(1.8, 57.5)).toBe(false);
  });

  it('flags (lon 30, lat 120) by range alone, with or without a project area', () => {
    expect(likelySwapped(30, 120)).toBe(true);
    expect(likelySwapped(30, 120, { projectArea: NORTH_SEA })).toBe(true);
    expect(likelySwapped(30, -120, { projectArea: null })).toBe(true);
  });

  it('does not flag an impossible latitude that swapping cannot repair', () => {
    expect(likelySwapped(100, 120)).toBe(false);
    expect(likelySwapped(30, 500)).toBe(false);
  });

  it('needs a project area for in-range pairs', () => {
    expect(likelySwapped(57.5, 1.8)).toBe(false);
    expect(likelySwapped(57.5, 1.8, {})).toBe(false);
    expect(likelySwapped(57.5, 1.8, { projectArea: null })).toBe(false);
  });

  it('does not flag a point outside the area that stays outside when swapped', () => {
    expect(likelySwapped(30, 40, { projectArea: NORTH_SEA })).toBe(false);
  });

  it('does not flag a point that lies in the area either way round', () => {
    const square: BBox = [0, 0, 20, 20];
    expect(likelySwapped(5, 15, { projectArea: square })).toBe(false);
  });

  it('includes the area edges when testing the swapped point', () => {
    expect(likelySwapped(62, 10, { projectArea: NORTH_SEA })).toBe(true);
    expect(likelySwapped(50, -4, { projectArea: NORTH_SEA })).toBe(true);
  });

  it('honours a project area that crosses the antimeridian', () => {
    const fiji: BBox = [177, -20, -178, -15];
    expect(likelySwapped(-18.1, 178.4, { projectArea: fiji })).toBe(true);
    expect(likelySwapped(178.4, -18.1, { projectArea: fiji })).toBe(false);
  });

  it('reads a crossing project area the antimeridian way when testing an in-range swapped pair', () => {
    // The pair above is flagged by range alone. Here only the area can decide: the area covers
    // longitudes 80 to 180 and -180 to -100, so a swapped longitude of 85 lands in it.
    const wide: BBox = [80, 0, -100, 60];
    expect(likelySwapped(30, 85, { projectArea: wide })).toBe(true);
    // Swapped, (45, 30) falls in the gap between -100 and 80 that the area does not cover.
    expect(likelySwapped(30, 45, { projectArea: wide })).toBe(false);
    // Already inside the western part of the area.
    expect(likelySwapped(-150, 30, { projectArea: wide })).toBe(false);
  });

  it('never flags non-finite values', () => {
    expect(likelySwapped(NaN, 120)).toBe(false);
    expect(likelySwapped(30, Infinity)).toBe(false);
    expect(likelySwapped(NaN, 1.8, { projectArea: NORTH_SEA })).toBe(false);
  });
});

describe('inLonLatRange', () => {
  it.each([
    [0, 0],
    [180, 90],
    [-180, -90],
    [1.8, 57.5],
  ])('accepts (%s, %s)', (lon, lat) => {
    expect(inLonLatRange(lon, lat)).toBe(true);
  });

  it.each([
    [180.000001, 0],
    [-180.000001, 0],
    [0, 90.000001],
    [0, -90.000001],
    [57.5, 120],
    [NaN, 0],
    [0, Infinity],
  ])('refuses (%s, %s)', (lon, lat) => {
    expect(inLonLatRange(lon, lat)).toBe(false);
  });
});

describe('geometryInRange', () => {
  it('accepts a geometry whose positions are all in range', () => {
    const g: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [-180, -90],
          [180, -90],
          [180, 90],
          [-180, -90],
        ],
      ],
    };
    expect(geometryInRange(g)).toBe(true);
  });

  it('refuses a geometry with one position out of range, deep inside a collection', () => {
    const g: Geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1.8, 57.5] },
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, 0],
              [1, 1],
            ],
            [
              [2, 2],
              [190, 3],
            ],
          ],
        },
      ],
    };
    expect(geometryInRange(g)).toBe(false);
  });

  it('refuses a position without a finite longitude and latitude', () => {
    expect(geometryInRange({ type: 'Point', coordinates: [NaN, 0] })).toBe(false);
    expect(geometryInRange({ type: 'MultiPoint', coordinates: [[0, 0], [5]] })).toBe(false);
  });

  it('ignores elevations', () => {
    expect(geometryInRange({ type: 'Point', coordinates: [1.8, 57.5, 8848] })).toBe(true);
  });

  it('accepts an empty geometry, which has no position out of range', () => {
    expect(geometryInRange({ type: 'Polygon', coordinates: [] })).toBe(true);
    expect(geometryInRange({ type: 'Point', coordinates: [] })).toBe(true);
  });
});
