import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Geometry, Position } from '@tw/model';
import { geometryProblems, isGeometry, type GeometryProblemCode } from '@tw/geo';
import { MAX_INTERSECTION_VERTICES } from './intersect';

interface ExpectedProblem {
  code: GeometryProblemCode;
  path: string;
  message?: string;
}

interface FixtureCase {
  name: string;
  geometry: unknown;
  problems: ExpectedProblem[];
}

const SPECIAL_NUMBERS: Record<string, number> = { NaN, Infinity, '-Infinity': -Infinity };

/** JSON has no NaN or Infinity; the fixture writes them as {"$number": "NaN"}. */
function revive(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const tag = (value as Record<string, unknown>)['$number'];
    if (typeof tag === 'string' && tag in SPECIAL_NUMBERS) return SPECIAL_NUMBERS[tag];
  }
  return value;
}

const FIXTURE = JSON.parse(
  readFileSync(new URL('./__fixtures__/geometries.json', import.meta.url), 'utf8'),
  revive,
) as { cases: FixtureCase[] };

const CASES = FIXTURE.cases.map((c) => [c.name, c] as const);
const SHAPE_CODES: GeometryProblemCode[] = ['BAD_STRUCTURE', 'NON_FINITE'];

function codes(g: unknown): GeometryProblemCode[] {
  return geometryProblems(g).map((p) => p.code);
}

function polygon(...rings: Position[][]): Geometry {
  return { type: 'Polygon', coordinates: rings };
}

/** A closed ring of `corners` corners round a circle. */
function circle(corners: number, radius = 1): Position[] {
  const ring: Position[] = [];
  for (let i = 0; i < corners; i++) {
    const angle = (2 * Math.PI * i) / corners;
    ring.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  ring.push([...(ring[0] ?? [])]);
  return ring;
}

function close(corners: Position[]): Position[] {
  return [...corners, [...(corners[0] ?? [])]];
}

/** A two-entry position with no longitude at all: a hole, not even undefined. */
function sparsePosition(lat: number): number[] {
  const position: number[] = [];
  position[1] = lat;
  return position;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('geometryProblems on the named fixtures (src/geo/__fixtures__/geometries.json)', () => {
  it('holds every case the build plan names', () => {
    const names = FIXTURE.cases.map((c) => c.name);
    for (const required of [
      'valid Point',
      'valid LineString',
      'valid Polygon with a hole',
      'valid MultiPolygon',
      'unclosed ring',
      '3-position ring',
      'bow-tie polygon',
      'NaN ordinate',
      'null ordinate',
      'empty coordinates array',
      'Circle',
    ]) {
      expect(names).toContain(required);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(CASES)('%s', (_name, c) => {
    const problems = geometryProblems(c.geometry);
    expect(problems.map(({ code, path }) => ({ code, path }))).toEqual(
      c.problems.map(({ code, path }) => ({ code, path })),
    );
    for (const [i, expected] of c.problems.entries()) {
      const message = problems[i]?.message ?? '';
      expect(message.trim().length).toBeGreaterThan(10);
      if (expected.message !== undefined) expect(message).toContain(expected.message);
    }
  });

  it.each(CASES)('isGeometry agrees with the shape problems: %s', (_name, c) => {
    const shapeless = c.problems.some((p) => SHAPE_CODES.includes(p.code));
    expect(isGeometry(c.geometry)).toBe(!shapeless);
  });

  it('does not change the geometry it checks', () => {
    for (const c of FIXTURE.cases) {
      const frozen = deepFreeze(structuredClone(c.geometry));
      expect(() => geometryProblems(frozen)).not.toThrow();
      expect(frozen).toEqual(c.geometry);
    }
  });
});

describe('geometryProblems beyond the fixtures', () => {
  it('reports a hole in a sparse position array as not finite', () => {
    expect(codes({ type: 'Point', coordinates: sparsePosition(5) })).toEqual(['NON_FINITE']);
  });

  it('reports a repeated problem once per list, pointing at the first', () => {
    const line: unknown[] = [[0, 0]];
    for (let i = 0; i < 1000; i++) line.push([NaN, i]);
    const problems = geometryProblems({ type: 'LineString', coordinates: line });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: 'NON_FINITE', path: 'coordinates[1]' });
    expect(problems[0]?.message).toContain('1000 entries in this list');
  });

  it('reports both kinds of position fault in one list', () => {
    const problems = geometryProblems({ type: 'MultiPoint', coordinates: [[0, 0], 'x', [NaN, 1], [1]] });
    expect(problems.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'BAD_STRUCTURE', path: 'coordinates[1]' },
      { code: 'NON_FINITE', path: 'coordinates[2]' },
    ]);
    expect(problems[0]?.message).toContain('2 entries in this list');
  });

  it.each<[string, unknown, string]>([
    ['a boolean where a position belongs', { type: 'MultiPoint', coordinates: [true] }, 'found the value true.'],
    ['an object where a ring belongs', { type: 'Polygon', coordinates: [{}] }, 'Expected a ring'],
    ['text where a geometry belongs', 'POINT (1 2)', 'found the text "POINT (1 2)".'],
    ['nothing where a member belongs', { type: 'GeometryCollection', geometries: [undefined] }, 'found nothing.'],
    ['a sparse ordinate', { type: 'Point', coordinates: sparsePosition(2) }, 'The position [empty, 2]'],
    ['a long position', { type: 'Point', coordinates: [1, 2, 3, 4, NaN] }, '[1, 2, 3, 4, …]'],
    ['a number type name', { type: 7, coordinates: [1, 2] }, 'no type name'],
    [
      'a very long type name',
      { type: 'x'.repeat(100), coordinates: [1, 2] },
      `"${'x'.repeat(40)}…" is not a GeoJSON geometry type`,
    ],
  ])('describes %s in plain words', (_name, g, text) => {
    const messages = geometryProblems(g).map((p) => p.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(text);
  });

  it('reports lines that are not arrays once, pointing at the first', () => {
    const problems = geometryProblems({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        'x',
        'y',
      ],
    });
    expect(problems.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'BAD_STRUCTURE', path: 'coordinates[1]' },
    ]);
    expect(problems[0]?.message).toContain('Expected a line');
    expect(problems[0]?.message).toContain('2 entries in this list');
  });

  it('accepts collections nested up to the limit and refuses deeper ones', () => {
    const nest = (levels: number): unknown => {
      let g: unknown = { type: 'Point', coordinates: [0, 0] };
      for (let i = 0; i < levels; i++) g = { type: 'GeometryCollection', geometries: [g] };
      return g;
    };
    expect(geometryProblems(nest(32))).toEqual([]);
    const deep = geometryProblems(nest(40));
    expect(deep.map((p) => p.code)).toEqual(['BAD_STRUCTURE']);
    expect(deep[0]?.path).toBe(Array.from({ length: 32 }, () => 'geometries[0]').join('.'));
    expect(isGeometry(nest(40))).toBe(false);
  });

  it('stops on a collection that contains itself', () => {
    const cyclic: { type: string; geometries: unknown[] } = { type: 'GeometryCollection', geometries: [] };
    cyclic.geometries.push(cyclic);
    expect(codes(cyclic)).toEqual(['BAD_STRUCTURE']);
  });

  it('treats -0 and 0 as the same value when closing a ring', () => {
    expect(
      geometryProblems(
        polygon([
          [0, 0],
          [1, 0],
          [1, 1],
          [-0, 0],
        ]),
      ),
    ).toEqual([]);
  });

  it('ignores foreign members, which RFC 7946 allows', () => {
    expect(geometryProblems({ type: 'Point', coordinates: [1, 2], bbox: [1, 2, 1, 2], title: 'Well A' })).toEqual([]);
  });

  it('finds a crossing far from the first edges of a long ring', () => {
    const ring = circle(2000).slice(0, -1);
    // Swapping two neighbouring corners makes the edges on either side cross.
    [ring[1000], ring[1001]] = [ring[1001] as Position, ring[1000] as Position];
    expect(codes(polygon(close(ring)))).toEqual(['SELF_INTERSECTION']);
  });
});

describe('the self-intersection size limit', () => {
  it(`checks a ring of exactly ${MAX_INTERSECTION_VERTICES} corners`, () => {
    expect(geometryProblems(polygon(circle(MAX_INTERSECTION_VERTICES)))).toEqual([]);
    const crossed = circle(MAX_INTERSECTION_VERTICES).slice(0, -1);
    [crossed[5000], crossed[5001]] = [crossed[5001] as Position, crossed[5000] as Position];
    expect(codes(polygon(close(crossed)))).toEqual(['SELF_INTERSECTION']);
  });

  it('skips larger rings with a note and still runs the other checks', () => {
    const big = circle(MAX_INTERSECTION_VERTICES + 1);
    const problems = geometryProblems(polygon(big));
    expect(problems.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'SKIPPED_TOO_LARGE', path: 'coordinates[0]' },
    ]);
    expect(problems[0]?.message).toContain(String(MAX_INTERSECTION_VERTICES + 1));
    expect(isGeometry(polygon(big))).toBe(true);
    expect(codes(polygon(big.slice(0, -1)))).toEqual(['RING_NOT_CLOSED']);
  });

  it('counts distinct corners, so repeated positions do not push a ring over the limit', () => {
    const corners = circle(MAX_INTERSECTION_VERTICES).slice(0, -1);
    const doubled = corners.flatMap((p) => [p, [...p]]);
    expect(geometryProblems(polygon(close(doubled)))).toEqual([]);
  });

  it('handles a worst-case zigzag ring of the maximum size', () => {
    // Every tooth spans the full width, so the longitude sweep prunes no pair at all.
    const teeth = MAX_INTERSECTION_VERTICES / 2 - 1;
    const ring: Position[] = [];
    for (let i = 0; i < teeth; i++) ring.push([0, i / 100], [100, (i + 0.5) / 100]);
    ring.push([-1, teeth / 100], [-1, 0], [0, 0]);
    expect(ring.length - 1).toBe(MAX_INTERSECTION_VERTICES);
    expect(geometryProblems(polygon(ring))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests

type Pt = [number, number];

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Pt, b: Pt, p: Pt): boolean {
  return (
    orient(a, b, p) === 0 &&
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsTouch(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const s1 = Math.sign(orient(c, d, a)) * Math.sign(orient(c, d, b));
  const s2 = Math.sign(orient(a, b, c)) * Math.sign(orient(a, b, d));
  if (s1 < 0 && s2 < 0) return true;
  return onSegment(c, d, a) || onSegment(c, d, b) || onSegment(a, b, c) || onSegment(a, b, d);
}

/** An independent all-pairs reference: does a ring of distinct consecutive corners meet itself? */
function bruteForceSelfIntersects(corners: Pt[]): boolean {
  const n = corners.length;
  const at = (i: number): Pt => corners[i % n] as Pt;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [a, b, c, d] = [at(i), at(i + 1), at(j), at(j + 1)];
      if (j === i + 1) {
        // Consecutive edges a-b and b-d: only a fold back along one line counts.
        if (orient(a, b, d) === 0 && (a[0] - b[0]) * (d[0] - b[0]) + (a[1] - b[1]) * (d[1] - b[1]) > 0) return true;
      } else if (i === 0 && j === n - 1) {
        // Edges c-a and a-b share the first corner.
        if (orient(c, a, b) === 0 && (c[0] - a[0]) * (b[0] - a[0]) + (c[1] - a[1]) * (b[1] - a[1]) > 0) return true;
      } else if (segmentsTouch(a, b, c, d)) {
        return true;
      }
    }
  }
  return false;
}

function withoutRepeats(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0]?.[0] === out.at(-1)?.[0] && out[0]?.[1] === out.at(-1)?.[1]) out.pop();
  return out;
}

describe('self-intersection properties', () => {
  const smallGrid = fc.array(fc.tuple(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 6 })), {
    minLength: 3,
    maxLength: 12,
  });

  it('agrees with an all-pairs reference on random small rings (many touching cases)', () => {
    fc.assert(
      fc.property(smallGrid, (points) => {
        const corners = withoutRepeats(points as Pt[]);
        fc.pre(corners.length >= 3);
        const found = codes(polygon(close(corners))).includes('SELF_INTERSECTION');
        expect(found).toBe(bruteForceSelfIntersects(corners));
      }),
      { numRuns: 3000 },
    );
  });

  it('finds star-shaped rings simple, whatever corner the ring starts at and in either direction', () => {
    const star = fc
      .uniqueArray(fc.integer({ min: 0, max: 3599 }), { minLength: 3, maxLength: 60 })
      .chain((angles) =>
        fc.tuple(
          fc.constant([...angles].sort((a, b) => a - b)),
          fc.array(fc.double({ min: 1, max: 2, noNaN: true }), { minLength: angles.length, maxLength: angles.length }),
          fc.nat({ max: angles.length - 1 }),
          fc.boolean(),
        ),
      );
    fc.assert(
      fc.property(star, ([angles, radii, start, reverse]) => {
        let corners: Position[] = angles.map((tenths, i) => {
          const angle = (tenths / 1800) * Math.PI;
          const r = radii[i] ?? 1;
          return [5 + r * Math.cos(angle), 50 + r * Math.sin(angle)];
        });
        // A star whose corners all lie within half a turn is not star-shaped round its centre.
        const gaps = angles.map((a, i) => ((angles[(i + 1) % angles.length] ?? 0) - a + 3600) % 3600 || 3600);
        fc.pre(Math.max(...gaps) < 1800);
        corners = [...corners.slice(start), ...corners.slice(0, start)];
        if (reverse) corners.reverse();
        expect(geometryProblems(polygon(close(corners)))).toEqual([]);
      }),
      { numRuns: 500 },
    );
  });

  it('gives the same verdict whatever corner a ring starts at', () => {
    fc.assert(
      fc.property(smallGrid, fc.nat(), (points, shift) => {
        const corners = withoutRepeats(points as Pt[]);
        fc.pre(corners.length >= 3);
        const k = shift % corners.length;
        const rotated = [...corners.slice(k), ...corners.slice(0, k)];
        expect(codes(polygon(close(rotated)))).toEqual(codes(polygon(close(corners))));
      }),
      { numRuns: 1000 },
    );
  });
});
