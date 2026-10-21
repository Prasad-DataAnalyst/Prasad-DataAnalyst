import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BBox, Geometry, Position } from '@tw/model';
import { bboxContains, bboxIntersectsGeometry, geometryBbox } from '@tw/geo';

const square = (west: number, south: number, size: number): Position[] => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];

const point = (lon: number, lat: number): Geometry => ({ type: 'Point', coordinates: [lon, lat] });

describe('geometryBbox', () => {
  it.each<[string, Geometry, BBox | null]>([
    ['Point', point(1.8, 57.5), [1.8, 57.5, 1.8, 57.5]],
    ['Point with an elevation (ignored)', { type: 'Point', coordinates: [1.8, 57.5, -2500] }, [1.8, 57.5, 1.8, 57.5]],
    [
      'MultiPoint',
      {
        type: 'MultiPoint',
        coordinates: [
          [3, -1],
          [-2, 4],
          [0, 0],
        ],
      },
      [-2, -1, 3, 4],
    ],
    [
      'LineString',
      {
        type: 'LineString',
        coordinates: [
          [10, 20],
          [12, 18],
          [11, 25],
        ],
      },
      [10, 18, 12, 25],
    ],
    [
      'MultiLineString',
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [-5, 2],
            [-4, 3],
          ],
        ],
      },
      [-5, 0, 1, 3],
    ],
    ['Polygon with a hole', { type: 'Polygon', coordinates: [square(0, 0, 10), square(2, 2, 2)] }, [0, 0, 10, 10]],
    ['MultiPolygon', { type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(-4, 50, 14)]] }, [-4, 0, 10, 64]],
    [
      'GeometryCollection',
      {
        type: 'GeometryCollection',
        geometries: [
          point(5, 5),
          {
            type: 'LineString',
            coordinates: [
              [-1, 2],
              [0, 3],
            ],
          },
        ],
      },
      [-1, 2, 5, 5],
    ],
    ['empty Point', { type: 'Point', coordinates: [] }, null],
    ['empty Polygon', { type: 'Polygon', coordinates: [] }, null],
    ['empty GeometryCollection', { type: 'GeometryCollection', geometries: [] }, null],
    [
      'LineString with a non-finite position (skipped)',
      {
        type: 'LineString',
        coordinates: [
          [1, 1],
          [NaN, 9],
          [2, 2],
        ],
      },
      [1, 1, 2, 2],
    ],
  ])('%s', (_name, g, expected) => {
    expect(geometryBbox(g)).toEqual(expected);
  });

  it('spans the long way round for a line across the antimeridian', () => {
    const line: Geometry = {
      type: 'LineString',
      coordinates: [
        [179, 0],
        [-179, 1],
      ],
    };
    expect(geometryBbox(line)).toEqual([-179, 0, 179, 1]);
  });

  it('holds every position of random point sets', () => {
    const coordinate = fc.tuple(
      fc.double({ min: -180, max: 180, noNaN: true }),
      fc.double({ min: -90, max: 90, noNaN: true }),
    );
    fc.assert(
      fc.property(fc.array(coordinate, { minLength: 1, maxLength: 50 }), (points) => {
        const g: Geometry = { type: 'MultiPoint', coordinates: points };
        const box = geometryBbox(g);
        expect(box).not.toBeNull();
        if (box === null) return;
        for (const [lon, lat] of points) expect(bboxContains(box, lon, lat)).toBe(true);
        expect(bboxIntersectsGeometry(box, g)).toBe(true);
      }),
    );
  });
});

describe('bboxContains', () => {
  const northSea: BBox = [-4, 50, 10, 62];

  it.each([
    ['the west edge', -4, 55],
    ['the east edge', 10, 55],
    ['the south edge', 3, 50],
    ['the north edge', 3, 62],
    ['the south-west corner', -4, 50],
    ['the north-east corner', 10, 62],
    ['an inside point', 1.8, 57.5],
  ])('includes %s', (_name, lon, lat) => {
    expect(bboxContains(northSea, lon, lat)).toBe(true);
  });

  it.each([
    ['just west', -4.000001, 55],
    ['just east', 10.000001, 55],
    ['just south', 3, 49.999999],
    ['just north', 3, 62.000001],
    ['NaN longitude', NaN, 55],
    ['infinite latitude', 3, Infinity],
  ])('excludes a point %s', (_name, lon, lat) => {
    expect(bboxContains(northSea, lon, lat)).toBe(false);
  });

  it('contains its only point when the box is a point', () => {
    expect(bboxContains([1, 2, 1, 2], 1, 2)).toBe(true);
    expect(bboxContains([1, 2, 1, 2], 1, 2.0000001)).toBe(false);
  });

  it('reads a box whose west edge is east of its east edge as crossing the antimeridian', () => {
    const fiji: BBox = [177, -20, -178, -15];
    expect(bboxContains(fiji, 178.4, -18.1)).toBe(true);
    expect(bboxContains(fiji, -179.5, -17)).toBe(true);
    expect(bboxContains(fiji, 180, -17)).toBe(true);
    expect(bboxContains(fiji, -180, -17)).toBe(true);
    expect(bboxContains(fiji, 177, -15)).toBe(true);
    expect(bboxContains(fiji, -178, -20)).toBe(true);
    expect(bboxContains(fiji, 0, -17)).toBe(false);
    expect(bboxContains(fiji, 178, -21)).toBe(false);
  });

  it('excludes longitudes beyond ±180 from a box that crosses the antimeridian, as from any other box', () => {
    const fiji: BBox = [177, -20, -178, -15];
    expect(bboxContains(fiji, 200, -17)).toBe(false);
    expect(bboxContains(fiji, -500, -17)).toBe(false);
    expect(bboxContains(fiji, 180.000001, -17)).toBe(false);
    expect(bboxContains(northSea, 200, 55)).toBe(false);
  });
});

describe('bboxIntersectsGeometry', () => {
  const box: BBox = [0, 0, 10, 10];

  it.each<[string, Geometry, boolean]>([
    ['a point inside', point(5, 5), true],
    ['a point on an edge', point(10, 3), true],
    ['a point outside', point(11, 3), false],
    [
      'a MultiPoint with one point inside',
      {
        type: 'MultiPoint',
        coordinates: [
          [20, 20],
          [9, 9],
        ],
      },
      true,
    ],
    [
      'a line crossing the box with no vertex inside',
      {
        type: 'LineString',
        coordinates: [
          [-5, 5],
          [15, 5],
        ],
      },
      true,
    ],
    [
      'a line crossing a corner diagonally',
      {
        type: 'LineString',
        coordinates: [
          [-1, 11],
          [1, 9],
        ],
      },
      true,
    ],
    [
      'a line touching a corner',
      {
        type: 'LineString',
        coordinates: [
          [10, 12],
          [12, 10],
          [10, 10],
        ],
      },
      true,
    ],
    [
      'a line passing by',
      {
        type: 'LineString',
        coordinates: [
          [-5, 11],
          [15, 11],
        ],
      },
      false,
    ],
    [
      'a line passing a corner diagonally without touching',
      {
        type: 'LineString',
        coordinates: [
          [9, 12],
          [12, 9.5],
        ],
      },
      false,
    ],
    [
      'a MultiLineString with one crossing line',
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [20, 20],
            [30, 30],
          ],
          [
            [5, -5],
            [5, 15],
          ],
        ],
      },
      true,
    ],
    ['a polygon that encloses the box', { type: 'Polygon', coordinates: [square(-10, -10, 40)] }, true],
    ['a polygon inside the box', { type: 'Polygon', coordinates: [square(2, 2, 3)] }, true],
    ['a polygon overlapping one corner', { type: 'Polygon', coordinates: [square(8, 8, 5)] }, true],
    ['a polygon touching one edge', { type: 'Polygon', coordinates: [square(10, 2, 5)] }, true],
    ['a polygon beside the box', { type: 'Polygon', coordinates: [square(11, 2, 5)] }, false],
    [
      'a polygon whose hole holds the whole box',
      { type: 'Polygon', coordinates: [square(-20, -20, 50), square(-5, -5, 20)] },
      false,
    ],
    [
      'a polygon whose hole holds part of the box',
      { type: 'Polygon', coordinates: [square(-20, -20, 50), square(-5, -5, 12)] },
      true,
    ],
    [
      'a MultiPolygon with one polygon enclosing the box',
      { type: 'MultiPolygon', coordinates: [[square(50, 50, 1)], [square(-1, -1, 12)]] },
      true,
    ],
    [
      'a GeometryCollection with one member inside',
      { type: 'GeometryCollection', geometries: [point(50, 50), point(1, 1)] },
      true,
    ],
    ['an empty GeometryCollection', { type: 'GeometryCollection', geometries: [] }, false],
    ['an empty Point', { type: 'Point', coordinates: [] }, false],
    ['a point with a non-finite longitude', point(NaN, 5), false],
  ])('%s: %s', (_name, g, expected) => {
    expect(bboxIntersectsGeometry(box, g)).toBe(expected);
  });

  it('finds a point box inside a polygon', () => {
    expect(bboxIntersectsGeometry([3, 3, 3, 3], { type: 'Polygon', coordinates: [square(0, 0, 10)] })).toBe(true);
    expect(
      bboxIntersectsGeometry([3, 3, 3, 3], { type: 'Polygon', coordinates: [square(0, 0, 10), square(2, 2, 2)] }),
    ).toBe(false);
  });

  it('treats a polygon ring as closed even when its closing position is missing', () => {
    const open: Geometry = {
      type: 'Polygon',
      coordinates: [
        [
          [-5, 5],
          [5, 20],
          [15, 5],
        ],
      ],
    };
    // Only the missing closing edge, from [15, 5] back to [-5, 5], crosses the box.
    expect(bboxIntersectsGeometry([0, 0, 10, 6], open)).toBe(true);
  });

  it('handles a box that crosses the antimeridian', () => {
    const fiji: BBox = [177, -20, -178, -15];
    expect(bboxIntersectsGeometry(fiji, point(178.4, -18.1))).toBe(true);
    expect(bboxIntersectsGeometry(fiji, point(-179, -18))).toBe(true);
    expect(bboxIntersectsGeometry(fiji, point(0, -18))).toBe(false);
    const line: Geometry = {
      type: 'LineString',
      coordinates: [
        [170, -17],
        [175, -17],
      ],
    };
    expect(bboxIntersectsGeometry(fiji, line)).toBe(false);
    const longer: Geometry = {
      type: 'LineString',
      coordinates: [
        [170, -17],
        [179, -17],
      ],
    };
    expect(bboxIntersectsGeometry(fiji, longer)).toBe(true);
  });

  it('agrees with bboxContains for random points', () => {
    const coordinate = fc.double({ min: -20, max: 20, noNaN: true });
    fc.assert(
      fc.property(coordinate, coordinate, (lon, lat) => {
        expect(bboxIntersectsGeometry(box, point(lon, lat))).toBe(bboxContains(box, lon, lat));
      }),
    );
  });

  it('agrees with bboxContains for random points and a box that crosses the antimeridian', () => {
    const fiji: BBox = [177, -20, -178, -15];
    const lon = fc.oneof(fc.double({ min: -400, max: 400, noNaN: true }), fc.constantFrom(-180, 180, 177, -178, 200));
    const lat = fc.double({ min: -25, max: -10, noNaN: true });
    fc.assert(
      fc.property(lon, lat, (x, y) => {
        expect(bboxIntersectsGeometry(fiji, point(x, y))).toBe(bboxContains(fiji, x, y));
      }),
    );
  });
});
