import { describe, expect, it } from 'vitest';
import type { Geometry } from '@tw/model';
import { geometryBytes } from './memory';

describe('geometryBytes', () => {
  it('grows with the number of positions', () => {
    const point: Geometry = { type: 'Point', coordinates: [1, 2] };
    const line: Geometry = {
      type: 'LineString',
      coordinates: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    };
    expect(geometryBytes(line)).toBeGreaterThan(geometryBytes(point));
  });

  it('never throws on malformed coordinates that the geometry rules must still see', () => {
    const cases = [
      { type: 'Point', coordinates: [null, 57.1] },
      { type: 'MultiPolygon', coordinates: [] },
      { type: 'Polygon', coordinates: [1, [2, 3]] },
      { type: 'Circle', coordinates: [1.8, 57.5] },
      { type: 'Point' },
      { type: 'GeometryCollection' },
    ] as unknown as Geometry[];
    for (const g of cases) expect(geometryBytes(g)).toBeGreaterThan(0);
  });
});
