/**
 * Planar predicates on longitude/latitude pairs (internal to the geo module).
 *
 * Coordinates are treated as plane coordinates, as RFC 7946 section 3.1.1 does for line and ring
 * edges ("a straight line in a Cartesian coordinate system"). No CRS transformation takes place.
 */
import type { BBox, Position } from '@tw/model';

export type XY = readonly [x: number, y: number];

/** The longitude and latitude of a position, or null when either is missing or not finite. */
export function lonLat(p: Position | undefined): XY | null {
  if (p === undefined) return null;
  const [x, y] = p;
  return Number.isFinite(x) && Number.isFinite(y) ? [x as number, y as number] : null;
}

/**
 * Twice the signed area of the triangle abc: positive when c lies left of the directed line ab,
 * negative when right, zero when the three points are collinear.
 */
export function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** For a point r already known to be collinear with p and q: whether it lies on the segment pq. */
export function withinSegment(px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean {
  return Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
}

function oppositeSigns(a: number, b: number): boolean {
  return (a > 0 && b < 0) || (a < 0 && b > 0);
}

/**
 * Where the closed segments ab and cd meet, or null when they do not. Touching counts: an endpoint
 * on the other segment is returned as the meeting point. For a proper crossing the crossing
 * point is returned.
 */
export function segmentsMeet(a: XY, b: XY, c: XY, d: XY): XY | null {
  const [ax, ay] = a;
  const [bx, by] = b;
  const [cx, cy] = c;
  const [dx, dy] = d;
  const da = orient(cx, cy, dx, dy, ax, ay);
  const db = orient(cx, cy, dx, dy, bx, by);
  const dc = orient(ax, ay, bx, by, cx, cy);
  const dd = orient(ax, ay, bx, by, dx, dy);
  if (oppositeSigns(da, db) && oppositeSigns(dc, dd)) {
    const t = da / (da - db);
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  }
  if (da === 0 && withinSegment(cx, cy, dx, dy, ax, ay)) return a;
  if (db === 0 && withinSegment(cx, cy, dx, dy, bx, by)) return b;
  if (dc === 0 && withinSegment(ax, ay, bx, by, cx, cy)) return c;
  if (dd === 0 && withinSegment(ax, ay, bx, by, dx, dy)) return d;
  return null;
}

/**
 * Whether two segments that share the vertex s (p-s and s-q) overlap along more than s: they do
 * exactly when p and q lie on the same ray from s, which is how a ring doubles back on itself.
 */
export function foldsBack(p: XY, s: XY, q: XY): boolean {
  const [px, py] = p;
  const [sx, sy] = s;
  const [qx, qy] = q;
  if (orient(px, py, sx, sy, qx, qy) !== 0) return false;
  return (px - sx) * (qx - sx) + (py - sy) * (qy - sy) > 0;
}

/** Whether a point lies in a box that does not cross the antimeridian (edges included). */
export function inPlainBox(box: BBox, x: number, y: number): boolean {
  const [west, south, east, north] = box;
  return x >= west && x <= east && y >= south && y <= north;
}

/**
 * Whether the closed segment ab meets a box that does not cross the antimeridian, edges included.
 * Liang-Barsky clipping: the segment is a + t(b - a) for t in [0, 1], and each box edge narrows
 * the range of t; the segment meets the box when the range stays non-empty.
 */
export function segmentMeetsPlainBox(box: BBox, a: XY, b: XY): boolean {
  const [west, south, east, north] = box;
  const [ax, ay] = a;
  const dx = b[0] - ax;
  const dy = b[1] - ay;
  let low = 0;
  let high = 1;
  const limits: [number, number][] = [
    [-dx, ax - west],
    [dx, east - ax],
    [-dy, ay - south],
    [dy, north - ay],
  ];
  for (const [p, q] of limits) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > high) return false;
      low = Math.max(low, t);
    } else {
      if (t < low) return false;
      high = Math.min(high, t);
    }
  }
  return true;
}

/**
 * Even-odd point-in-polygon over all rings of one polygon, so a point inside a hole is outside.
 * A ring is closed implicitly; edges with a non-finite end are ignored. Points exactly on the
 * boundary may go either way; callers that care test the boundary first.
 */
export function insideRings(rings: readonly (readonly Position[])[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = lonLat(ring[i]);
      const b = lonLat(ring[j]);
      if (a === null || b === null) continue;
      // Half-open in y, so a vertex exactly at the point's latitude is counted once, not twice.
      if (a[1] > y !== b[1] > y) {
        const crossX = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        if (x < crossX) inside = !inside;
      }
    }
  }
  return inside;
}
