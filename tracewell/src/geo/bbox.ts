/**
 * Bounding boxes in RFC 7946 order [west, south, east, north]. A box whose west edge lies east of
 * its east edge crosses the antimeridian (RFC 7946 section 5.2); the tests here honour that.
 */
import type { BBox, Geometry, Position } from '@tw/model';
import { inPlainBox, insideRings, lonLat, segmentMeetsPlainBox, type XY } from './planar';
import { positionsOf } from './positions';

/**
 * The smallest box holding every position with a finite longitude and latitude, or null when
 * there is none (an empty geometry). It never crosses the antimeridian: a geometry on both sides
 * of it gets a box spanning the globe the long way round, as most GIS software computes it.
 */
export function geometryBbox(g: Geometry): BBox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const position of positionsOf(g)) {
    const point = lonLat(position);
    if (point === null) continue;
    const [x, y] = point;
    west = Math.min(west, x);
    south = Math.min(south, y);
    east = Math.max(east, x);
    north = Math.max(north, y);
  }
  return west === Infinity ? null : [west, south, east, north];
}

/** Whether the point lies in the box, edges included. */
export function bboxContains(b: BBox, lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  const [west, south, east, north] = b;
  if (lat < south || lat > north) return false;
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

/** The box as one or two boxes that do not cross the antimeridian. */
function plainBoxes(b: BBox): BBox[] {
  const [west, south, east, north] = b;
  return west <= east
    ? [b]
    : [
        [west, south, 180, north],
        [-180, south, east, north],
      ];
}

function pointMeets(box: BBox, p: Position): boolean {
  const point = lonLat(p);
  return point !== null && inPlainBox(box, point[0], point[1]);
}

/**
 * Whether a chain of positions meets the box. A ring is closed implicitly. Positions without a
 * finite longitude and latitude break the chain; a lone position is tested as a point.
 */
function chainMeets(box: BBox, chain: readonly Position[], closed: boolean): boolean {
  let previous: XY | null = closed ? lonLat(chain.at(-1)) : null;
  for (const position of chain) {
    const point = lonLat(position);
    if (point !== null) {
      const hit = previous === null ? inPlainBox(box, point[0], point[1]) : segmentMeetsPlainBox(box, previous, point);
      if (hit) return true;
    }
    previous = point;
  }
  return false;
}

/**
 * A polygon meets the box when its boundary does, or when the box lies wholly inside it; then any
 * one box corner is inside (and not inside a hole).
 */
function polygonMeets(box: BBox, rings: readonly Position[][]): boolean {
  if (rings.some((ring) => chainMeets(box, ring, true))) return true;
  const [west, south] = box;
  return insideRings(rings, west, south);
}

function geometryMeets(box: BBox, g: Geometry): boolean {
  switch (g.type) {
    case 'Point':
      return pointMeets(box, g.coordinates);
    case 'MultiPoint':
      return g.coordinates.some((p) => pointMeets(box, p));
    case 'LineString':
      return chainMeets(box, g.coordinates, false);
    case 'MultiLineString':
      return g.coordinates.some((line) => chainMeets(box, line, false));
    case 'Polygon':
      return polygonMeets(box, g.coordinates);
    case 'MultiPolygon':
      return g.coordinates.some((polygon) => polygonMeets(box, polygon));
    case 'GeometryCollection':
      return g.geometries.some((member) => geometryMeets(box, member));
  }
}

/**
 * Whether the geometry and the box share at least one point, edges included: a point in the box,
 * a line crossing it (even with no vertex inside), a polygon overlapping or enclosing it. A box
 * wholly inside a polygon's hole does not meet the polygon. Edges are straight in longitude and
 * latitude, as RFC 7946 reads them.
 */
export function bboxIntersectsGeometry(b: BBox, g: Geometry): boolean {
  return plainBoxes(b).some((box) => geometryMeets(box, g));
}
