/**
 * GeoJSON geometry validation (RFC 7946 section 3.1; rule TW-GEO-001).
 *
 * The input is `unknown` so raw JSON can be checked before anything trusts its shape. Problems
 * that repeat across one list of positions are reported once, pointing at the first, so a broken
 * million-vertex outline gives a short report instead of a million entries.
 */
import type { Geometry } from '@tw/model';
import { MAX_INTERSECTION_VERTICES, ringCorners, ringSelfIntersection } from './intersect';
import type { GeometryProblem, GeometryProblemCode } from './types';

/** Collections nested deeper than this are refused, which also stops runaway recursion on cycles. */
const MAX_NESTING = 32;

const COORDINATE_TYPES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'] as const;
type CoordinateType = (typeof COORDINATE_TYPES)[number];
const GEOMETRY_TYPES: readonly string[] = [...COORDINATE_TYPES, 'GeometryCollection'];

/** Problems that mean the value does not have the Geometry shape at all. */
const SHAPE_PROBLEMS: ReadonlySet<GeometryProblemCode> = new Set(['BAD_STRUCTURE', 'NON_FINITE']);

interface Context {
  problems: GeometryProblem[];
  /** False when only the shape matters (isGeometry), which skips the costly topology tests. */
  topology: boolean;
}

type PositionFault = { code: 'BAD_STRUCTURE' | 'NON_FINITE'; message: string } | null;

function report(ctx: Context, code: GeometryProblemCode, path: string, message: string): void {
  ctx.problems.push({ code, message, path });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCoordinateType(type: string): type is CoordinateType {
  return (COORDINATE_TYPES as readonly string[]).includes(type);
}

function member(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------------------------
// Describing values in messages

function quote(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'nothing';
  if (Array.isArray(v)) return 'an array';
  switch (typeof v) {
    case 'number':
      return `the number ${String(v)}`;
    case 'string':
      return `the text ${quote(v)}`;
    case 'boolean':
      return `the value ${String(v)}`;
    case 'object':
      return 'an object';
    default:
      return `a ${typeof v}`;
  }
}

/** Only called for positions without nested arrays or objects, so every ordinate is a primitive. */
function describeOrdinate(v: unknown): string {
  if (v === undefined) return 'empty';
  return typeof v === 'string' ? quote(v) : String(v);
}

function describePosition(p: readonly unknown[]): string {
  const shown = Array.from(p.slice(0, 4), describeOrdinate);
  return `[${shown.join(', ')}${p.length > 4 ? ', …' : ''}]`;
}

/** A computed point, rounded so the message stays readable. toFixed is locale-independent. */
function describePoint([x, y]: readonly [number, number]): string {
  return `[${String(Number(x.toFixed(7)))}, ${String(Number(y.toFixed(7)))}]`;
}

// ---------------------------------------------------------------------------------------------
// Positions

function positionFault(p: unknown): PositionFault {
  if (!Array.isArray(p)) {
    const hint = typeof p === 'number' ? '; the coordinates may be nested one level too shallow' : '';
    return {
      code: 'BAD_STRUCTURE',
      message: `Expected a position (an array of numbers) but found ${describeValue(p)}${hint}.`,
    };
  }
  if (p.some((v) => typeof v === 'object' && v !== null)) {
    return {
      code: 'BAD_STRUCTURE',
      message:
        'Expected a position (an array of numbers) but found an array holding arrays or objects; ' +
        'the coordinates may be nested one level too deep.',
    };
  }
  if (p.length < 2) {
    return {
      code: 'BAD_STRUCTURE',
      message: `A position needs at least a longitude and a latitude, but this one has ${plural(p.length, 'value')}.`,
    };
  }
  // An index loop, not some(): some() skips the holes of a sparse array.
  for (let i = 0; i < p.length; i++) {
    const v: unknown = p[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {
        code: 'NON_FINITE',
        message: `The position ${describePosition(p)} has a coordinate that is not a finite number.`,
      };
    }
  }
  return null;
}

/** The first fault of one kind in a list, and how many entries share that kind. */
interface Tally {
  index: number;
  message: string;
  count: number;
}

function reportTally(ctx: Context, code: GeometryProblemCode, path: string, tally: Tally | undefined): void {
  if (tally === undefined) return;
  const shared =
    tally.count > 1 ? ` ${tally.count} entries in this list have this problem; the path points to the first.` : '';
  report(ctx, code, `${path}[${tally.index}]`, tally.message + shared);
}

/**
 * Checks every entry of an array that should hold positions. Returns true when all are valid
 * positions; faults are reported once per kind.
 */
function checkPositions(ctx: Context, list: readonly unknown[], path: string): boolean {
  const tallies = new Map<'BAD_STRUCTURE' | 'NON_FINITE', Tally>();
  for (let i = 0; i < list.length; i++) {
    const fault = positionFault(list[i]);
    if (fault === null) continue;
    const tally = tallies.get(fault.code);
    if (tally === undefined) tallies.set(fault.code, { index: i, message: fault.message, count: 1 });
    else tally.count++;
  }
  reportTally(ctx, 'BAD_STRUCTURE', path, tallies.get('BAD_STRUCTURE'));
  reportTally(ctx, 'NON_FINITE', path, tallies.get('NON_FINITE'));
  return tallies.size === 0;
}

/**
 * Calls `check` on each entry of `parts` that is an array; entries that are not arrays are
 * reported once, as BAD_STRUCTURE, naming what was expected.
 */
function eachArrayPart(
  ctx: Context,
  parts: readonly unknown[],
  path: string,
  expected: string,
  check: (part: unknown[], partPath: string) => void,
): void {
  let bad: Tally | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part: unknown = parts[i];
    if (Array.isArray(part)) {
      check(part, `${path}[${i}]`);
    } else if (bad === undefined) {
      bad = { index: i, message: `Expected ${expected} but found ${describeValue(part)}.`, count: 1 };
    } else {
      bad.count++;
    }
  }
  reportTally(ctx, 'BAD_STRUCTURE', path, bad);
}

// ---------------------------------------------------------------------------------------------
// Lines and rings

function checkLine(ctx: Context, line: readonly unknown[], path: string): void {
  checkPositions(ctx, line, path);
  if (line.length < 2) {
    report(ctx, 'TOO_FEW_POSITIONS', path, `A line needs at least 2 positions, but this one has ${line.length}.`);
  }
}

/** Positions already known to be valid: closed when first and last hold identical values. */
function isClosed(ring: readonly unknown[][]): boolean {
  const first = ring[0] ?? [];
  const last = ring.at(-1) ?? [];
  return first.length === last.length && first.every((v, i) => v === last[i]);
}

function checkRing(ctx: Context, ring: readonly unknown[], path: string): void {
  const valid = checkPositions(ctx, ring, path);
  if (ring.length < 4) {
    report(
      ctx,
      'TOO_FEW_POSITIONS',
      path,
      'A polygon ring needs at least 4 positions (3 corners and a closing position equal to the first), ' +
        `but this one has ${ring.length}.`,
    );
  }
  if (!valid || ring.length < 2) return;
  const positions = ring as unknown[][];
  if (!isClosed(positions)) {
    const first = describePosition(positions[0] ?? []);
    const last = describePosition(positions.at(-1) ?? []);
    report(
      ctx,
      'RING_NOT_CLOSED',
      path,
      `The ring is not closed: its last position ${last} differs from its first ${first}.`,
    );
    return;
  }
  if (ring.length >= 4 && ctx.topology) checkRingTopology(ctx, positions as number[][], path);
}

function checkRingTopology(ctx: Context, ring: readonly number[][], path: string): void {
  const corners = ringCorners(ring);
  if (corners.length < 3) {
    report(
      ctx,
      'TOO_FEW_POSITIONS',
      path,
      `The ring has only ${plural(corners.length, 'distinct corner')}, so it encloses no area.`,
    );
    return;
  }
  if (corners.length > MAX_INTERSECTION_VERTICES) {
    report(
      ctx,
      'SKIPPED_TOO_LARGE',
      path,
      `Self-intersection was not checked: the ring has ${corners.length} corners, and the check runs on rings ` +
        `of up to ${MAX_INTERSECTION_VERTICES} corners. The other checks were made.`,
    );
    return;
  }
  const hit = ringSelfIntersection(corners);
  if (hit !== null) {
    report(
      ctx,
      'SELF_INTERSECTION',
      path,
      `The ring crosses, touches or doubles back on itself at ${describePoint(hit)}.`,
    );
  }
}

function checkPolygon(ctx: Context, rings: readonly unknown[], path: string): void {
  eachArrayPart(ctx, rings, path, 'a ring (an array of positions)', (ring, ringPath) => checkRing(ctx, ring, ringPath));
}

// ---------------------------------------------------------------------------------------------
// Geometry objects

function checkCoordinates(ctx: Context, type: CoordinateType, coords: unknown[], path: string): void {
  switch (type) {
    case 'Point': {
      const fault = positionFault(coords);
      if (fault !== null) report(ctx, fault.code, path, fault.message);
      return;
    }
    case 'MultiPoint':
      checkPositions(ctx, coords, path);
      return;
    case 'LineString':
      checkLine(ctx, coords, path);
      return;
    case 'MultiLineString':
      eachArrayPart(ctx, coords, path, 'a line (an array of positions)', (line, p) => checkLine(ctx, line, p));
      return;
    case 'Polygon':
      checkPolygon(ctx, coords, path);
      return;
    case 'MultiPolygon':
      eachArrayPart(ctx, coords, path, 'a polygon (an array of rings)', (rings, p) => {
        if (rings.length === 0) report(ctx, 'EMPTY', p, 'This polygon has no rings.');
        else checkPolygon(ctx, rings, p);
      });
      return;
  }
}

function unknownTypeMessage(type: string): string {
  if (type === 'Feature' || type === 'FeatureCollection') {
    return `${quote(type)} is a GeoJSON object but not a geometry; check the geometry it holds instead.`;
  }
  const likely = GEOMETRY_TYPES.find((t) => t.toLowerCase() === type.toLowerCase());
  if (likely !== undefined) {
    return `${quote(type)} is not a GeoJSON geometry type. Type names are case-sensitive: use ${quote(likely)}.`;
  }
  return (
    `${quote(type)} is not a GeoJSON geometry type. The types are Point, MultiPoint, LineString, ` +
    'MultiLineString, Polygon, MultiPolygon and GeometryCollection.'
  );
}

function checkCollection(ctx: Context, g: Record<string, unknown>, path: string, depth: number): void {
  if (depth >= MAX_NESTING) {
    report(ctx, 'BAD_STRUCTURE', path, `Geometry collections are nested more than ${MAX_NESTING} levels deep.`);
    return;
  }
  const members = g['geometries'];
  const membersPath = member(path, 'geometries');
  if (!Array.isArray(members)) {
    report(ctx, 'BAD_STRUCTURE', membersPath, 'The GeometryCollection has no geometries array.');
    return;
  }
  if (members.length === 0) {
    report(ctx, 'EMPTY', membersPath, 'The GeometryCollection has no member geometries.');
    return;
  }
  for (let i = 0; i < members.length; i++) checkGeometry(ctx, members[i], `${membersPath}[${i}]`, depth + 1);
}

function checkGeometry(ctx: Context, g: unknown, path: string, depth: number): void {
  if (!isRecord(g)) {
    report(ctx, 'BAD_STRUCTURE', path, `Expected a GeoJSON geometry object but found ${describeValue(g)}.`);
    return;
  }
  const type = g['type'];
  if (typeof type !== 'string') {
    report(ctx, 'BAD_STRUCTURE', member(path, 'type'), 'The object has no type name, so it is not a GeoJSON geometry.');
    return;
  }
  if (type === 'GeometryCollection') {
    checkCollection(ctx, g, path, depth);
    return;
  }
  if (!isCoordinateType(type)) {
    report(ctx, 'BAD_STRUCTURE', member(path, 'type'), unknownTypeMessage(type));
    return;
  }
  const coords = g['coordinates'];
  const coordsPath = member(path, 'coordinates');
  if (!Array.isArray(coords)) report(ctx, 'BAD_STRUCTURE', coordsPath, `The ${type} has no coordinates array.`);
  else if (coords.length === 0) report(ctx, 'EMPTY', coordsPath, `The ${type} has no coordinates.`);
  else checkCoordinates(ctx, type, coords, coordsPath);
}

// ---------------------------------------------------------------------------------------------
// Public functions

/**
 * Every problem found in a GeoJSON geometry, in document order; [] for a valid geometry.
 * SKIPPED_TOO_LARGE is a note that one test was not run, not a defect.
 */
export function geometryProblems(g: unknown): GeometryProblem[] {
  const ctx: Context = { problems: [], topology: true };
  checkGeometry(ctx, g, '', 0);
  return ctx.problems;
}

/**
 * Whether a value has the shape of a Geometry: a known type, the right array nesting, and finite
 * numbers in every position. Validity problems (empty, too few positions, unclosed or
 * self-intersecting rings) do not count, because an invalid geometry is still a geometry: it is
 * imported and flagged (TW-GEO-001), not dropped. Use geometryProblems for validity.
 */
export function isGeometry(g: unknown): g is Geometry {
  const ctx: Context = { problems: [], topology: false };
  checkGeometry(ctx, g, '', 0);
  return !ctx.problems.some((p) => SHAPE_PROBLEMS.has(p.code));
}
