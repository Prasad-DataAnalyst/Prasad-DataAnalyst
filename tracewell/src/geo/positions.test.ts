import { describe, expect, it } from 'vitest';
import { EngineError, type Geometry } from '@tw/model';
import { isGeometry, pointFromLatLon, positionsOf } from '@tw/geo';

describe('positionsOf', () => {
  it('yields every position in document order, collections included', () => {
    const g: Geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [1, 1] },
        {
          type: 'MultiPoint',
          coordinates: [
            [2, 2],
            [3, 3],
          ],
        },
        {
          type: 'LineString',
          coordinates: [
            [4, 4],
            [5, 5],
          ],
        },
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [6, 6],
              [7, 7],
            ],
            [
              [8, 8],
              [9, 9],
            ],
          ],
        },
        {
          type: 'Polygon',
          coordinates: [
            [
              [10, 10],
              [11, 10],
              [11, 11],
              [10, 10],
            ],
          ],
        },
        {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [12, 12],
                [13, 12],
                [13, 13],
                [12, 12],
              ],
            ],
          ],
        },
        { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [14, 14] }] },
      ],
    };
    expect([...positionsOf(g)].map((p) => p[0])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 10, 12, 13, 13, 12, 14,
    ]);
  });

  it('yields the geometry’s own position arrays', () => {
    const position = [1.8, 57.5, 10];
    const g: Geometry = { type: 'Point', coordinates: position };
    expect([...positionsOf(g)][0]).toBe(position);
  });

  it('yields nothing for an empty geometry', () => {
    expect([...positionsOf({ type: 'Point', coordinates: [] })]).toEqual([]);
    expect([...positionsOf({ type: 'MultiPolygon', coordinates: [] })]).toEqual([]);
    expect([...positionsOf({ type: 'GeometryCollection', geometries: [] })]).toEqual([]);
  });

  it('can be iterated more than once when called again', () => {
    const g: Geometry = {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    };
    expect([...positionsOf(g)]).toHaveLength(2);
    expect([...positionsOf(g)]).toHaveLength(2);
  });
});

describe('pointFromLatLon', () => {
  it('puts longitude first, as RFC 7946 requires', () => {
    expect(pointFromLatLon(57.5, 1.8)).toEqual({ type: 'Point', coordinates: [1.8, 57.5] });
  });

  it('builds a valid geometry', () => {
    expect(isGeometry(pointFromLatLon(-33.9, 151.2))).toBe(true);
  });

  it('keeps out-of-range values for the range and swap checks to report', () => {
    expect(pointFromLatLon(120, 30)).toEqual({ type: 'Point', coordinates: [30, 120] });
  });

  it.each([
    [NaN, 1.8],
    [57.5, Infinity],
    [-Infinity, 0],
  ])('refuses latitude %s and longitude %s with INVALID_INPUT and a fix', (lat, lon) => {
    let caught: unknown;
    try {
      pointFromLatLon(lat, lon);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineError);
    const error = caught as EngineError;
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('finite latitude and longitude');
    expect(error.fix.length).toBeGreaterThan(10);
  });
});
