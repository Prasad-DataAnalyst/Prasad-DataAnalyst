/**
 * Ring self-intersection (internal to the geo module).
 *
 * Every pair of ring edges is a candidate, so the test is O(n²) in the worst case. Sorting the
 * edges by their west end and stopping once a candidate starts east of the current edge prunes
 * most pairs in real outlines; rings above MAX_INTERSECTION_VERTICES corners are not tested at all
 * (SKIPPED_TOO_LARGE), which bounds the worst case.
 */
import type { Position } from '@tw/model';
import { foldsBack, lonLat, segmentsMeet, type XY } from './planar';

/** The largest ring, in distinct corners, that the self-intersection test runs on. */
export const MAX_INTERSECTION_VERTICES = 10_000;

interface Edge {
  /** The edge runs from corner `index` to corner `index + 1` (wrapping round). */
  index: number;
  from: XY;
  to: XY;
  west: number;
  east: number;
  south: number;
  north: number;
}

function samePoint(a: XY, b: XY): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * The corners of a closed ring: its longitude/latitude pairs without consecutive repeats and
 * without the closing position. Repeated positions are legal GeoJSON, but left in they would
 * make zero-length edges whose neighbours touch without being adjacent.
 */
export function ringCorners(ring: readonly Position[]): XY[] {
  const corners: XY[] = [];
  for (const position of ring) {
    const point = lonLat(position);
    if (point === null) continue;
    const last = corners.at(-1);
    if (last === undefined || !samePoint(last, point)) corners.push(point);
  }
  const first = corners[0];
  const last = corners.at(-1);
  if (corners.length > 1 && first !== undefined && last !== undefined && samePoint(first, last)) corners.pop();
  return corners;
}

function edgesOf(corners: readonly XY[]): Edge[] {
  const edges: Edge[] = [];
  for (const [index, from] of corners.entries()) {
    const to = corners[(index + 1) % corners.length] ?? from;
    edges.push({
      index,
      from,
      to,
      west: Math.min(from[0], to[0]),
      east: Math.max(from[0], to[0]),
      south: Math.min(from[1], to[1]),
      north: Math.max(from[1], to[1]),
    });
  }
  return edges;
}

/**
 * Where two edges of the same ring meet, beyond the corner that consecutive edges share.
 * Consecutive edges always share a corner, so for them only a fold back along the same line counts.
 */
function edgesMeet(a: Edge, b: Edge, cornerCount: number): XY | null {
  if (b.index === (a.index + 1) % cornerCount) return foldsBack(a.from, a.to, b.to) ? a.to : null;
  if (a.index === (b.index + 1) % cornerCount) return foldsBack(b.from, b.to, a.to) ? b.to : null;
  return segmentsMeet(a.from, a.to, b.from, b.to);
}

/** How many different points the corners hold, counting no further than `limit`. */
export function distinctCornerCount(corners: readonly XY[], limit: number): number {
  const found: XY[] = [];
  for (const corner of corners) {
    if (found.length >= limit) break;
    if (!found.some((p) => samePoint(p, corner))) found.push(corner);
  }
  return found.length;
}

/*
 * The orientation test multiplies coordinate differences, which overflows beyond about 1e154 and
 * underflows to zero below about 1e-154, giving wrong verdicts and NaN crossing points. Scaling
 * every coordinate by one power of two is exact and changes no verdict, so a ring outside the safe
 * band is first scaled into it: a large ring down to about 2^500, keeping its smallest values
 * clear of underflow, and a tiny ring up to about unit size.
 */
const SAFE_MAGNITUDE = 500;

/** v × 2^exponent, exactly; split in two factors so that neither overflows on its own. */
function timesPowerOfTwo(v: number, exponent: number): number {
  const half = Math.trunc(exponent / 2);
  return v * 2 ** half * 2 ** (exponent - half);
}

function rescalingExponent(corners: readonly XY[]): number {
  let largest = 0;
  for (const [x, y] of corners) largest = Math.max(largest, Math.abs(x), Math.abs(y));
  if (largest === 0) return 0;
  const magnitude = Math.floor(Math.log2(largest));
  if (magnitude > SAFE_MAGNITUDE) return SAFE_MAGNITUDE - magnitude;
  if (magnitude < -SAFE_MAGNITUDE) return -magnitude;
  return 0;
}

function rescaled(point: XY, exponent: number): XY {
  return [timesPowerOfTwo(point[0], exponent), timesPowerOfTwo(point[1], exponent)];
}

/**
 * The first point found where a ring crosses, touches or folds back on itself, or null when the
 * ring is simple. `corners` comes from ringCorners and holds at least 3 corners.
 */
export function ringSelfIntersection(corners: readonly XY[]): XY | null {
  const exponent = rescalingExponent(corners);
  if (exponent === 0) return firstMeeting(corners);
  const hit = firstMeeting(corners.map((corner) => rescaled(corner, exponent)));
  return hit === null ? null : rescaled(hit, -exponent);
}

function firstMeeting(corners: readonly XY[]): XY | null {
  const edges = edgesOf(corners).sort((a, b) => a.west - b.west);
  for (const [k, a] of edges.entries()) {
    for (let next = k + 1; next < edges.length; next++) {
      const b = edges[next];
      if (b === undefined || b.west > a.east) break;
      if (b.south > a.north || b.north < a.south) continue;
      const hit = edgesMeet(a, b, corners.length);
      if (hit !== null) return hit;
    }
  }
  return null;
}
