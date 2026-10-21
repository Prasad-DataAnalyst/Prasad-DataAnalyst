/**
 * GeoJSON geometry validation (RFC 7946 section 3.1; rule TW-GEO-001).
 *
 * The input is `unknown` so raw JSON can be checked before anything trusts its shape. Problems
 * that repeat across one list of positions are reported once, pointing at the first, so a broken
 * million-vertex outline gives a short report instead of a million entries.
 */
import type { Geometry } from '@tw/model';
import { distinctCornerCount, MAX_INTERSECTION_VERTICES, ringCorners, ringSelfIntersection } from './intersect';
import type { GeometryProblem, GeometryProblemCode } from './types';

/** Collections nested deeper than this are refused (RFC 7946 advises against nesting them at all). */
const MAX_NESTING = 32;

const COORDINATE_TYPES = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'] as const;
type CoordinateType = (typeof COORDINATE_TYPES)[number];
const GEOMETRY_TYPES: readonly string[] = [...COORDINATE_TYPES, 'GeometryCollection'];

/** Problems that mean the value does not have the Geometry shape at all. */
const SHAPE_PROBLEMS: ReadonlySet<GeometryProblemCode> = new Set(['BAD_STRUCTURE', 'NON_FINITE']);

/** The levels a collection has been walked at so far, and whether its own members array was checked. */
interface CollectionWalks {
  shallowest: number;
  deepest: number;
  membersChecked: boolean;
}

interface Context {
  problems: GeometryProblem[];
  /** False when only the shape matters (isGeometry), which skips the costly topology tests. */
  topology: boolean;
  /** The collections being walked, outermost first: meeting one again means it contains itself. */
  open: Set<object>;
  /** Geometry objects other than collections already checked. */
  checked: Set<object>;
  collections: Map<object, CollectionWalks>;
}

function newContext(topology: boolean): Context {
  return { problems: [], topology, open: new Set(), checked: new Set(), collections: new Map() };
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

const MAX_QUOTED_CHARACTERS = 40;

function quote(text: string): string {
  // Cut by code point: cutting by UTF-16 unit could split an emoji into a lone surrogate, which
  // JSON.stringify would then write as an escape such as \ud83d.
  const head = Array.from(text.slice(0, 2 * MAX_QUOTED_CHARACTERS + 1))
    .slice(0, MAX_QUOTED_CHARACTERS)
    .join('');
  return JSON.stringify(head.length < text.length ? `${head}…` : text);
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

/** For positions already known to be valid: whether they hold identical values. */
function samePosition(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isClosed(ring: readonly unknown[][]): boolean {
  return samePosition(ring[0] ?? [], ring.at(-1) ?? []);
}

/**
 * Every ordinate counts, so a vertical well path (one place, several depths) keeps its length;
 * only a line whose positions are identical in full has none.
 */
function allSame(line: readonly unknown[][]): boolean {
  const first = line[0] ?? [];
  return line.every((p) => samePosition(first, p));
}

function checkLine(ctx: Context, line: readonly unknown[], path: string): void {
  const valid = checkPositions(ctx, line, path);
  if (line.length < 2) {
    report(ctx, 'TOO_FEW_POSITIONS', path, `A line needs at least 2 positions, but this one has ${line.length}.`);
  } else if (valid && allSame(line as unknown[][])) {
    report(
      ctx,
      'TOO_FEW_POSITIONS',
      path,
      `A line needs at least 2 distinct positions, but all ${line.length} positions of this one are the same, ` +
        'so it has no length.',
    );
  }
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
  // Distinct points, not just consecutive ones: a ring running back and forth between two places
  // encloses no area either.
  const distinct = distinctCornerCount(corners, 3);
  if (distinct < 3) {
    report(
      ctx,
      'TOO_FEW_POSITIONS',
      path,
      `The ring has only ${plural(distinct, 'distinct corner')}, so it encloses no area.`,
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

/** A type name without case, spaces or invisible format characters (such as a byte order mark). */
function looseName(name: string): string {
  return name.replace(/[\s\p{Cf}]/gu, '').toLowerCase();
}

function unknownTypeMessage(type: string): string {
  const loose = looseName(type);
  if (loose === 'feature' || loose === 'featurecollection') {
    return `${quote(type)} is a GeoJSON object but not a geometry; check the geometry it holds instead.`;
  }
  const likely = GEOMETRY_TYPES.find((t) => t.toLowerCase() === loose);
  if (likely !== undefined) {
    const why =
      likely.toLowerCase() === type.toLowerCase()
        ? 'Type names are case-sensitive'
        : 'The name holds spaces or invisible characters';
    return `${quote(type)} is not a GeoJSON geometry type. ${why}: use ${quote(likely)}.`;
  }
  return (
    `${quote(type)} is not a GeoJSON geometry type. The types are Point, MultiPoint, LineString, ` +
    'MultiLineString, Polygon, MultiPolygon and GeometryCollection.'
  );
}

/*
 * Objects shared by reference (structured clone keeps sharing; JSON never has it). Each one is
 * checked where it first appears, and its problems point there. A collection's problems depend on
 * its depth only through the nesting limit: a deeper walk may meet the limit where an earlier one
 * did not, and a shallower walk reaches members an earlier walk stopped short of at the limit. So a
 * shared collection is walked again only at a new shallowest or deepest level, at most
 * 2 × MAX_NESTING + 1 times in all, where shared members could otherwise make the walk exponential.
 */

/** The walks record of a collection when this visit can find something new, otherwise null. */
function walksToMake(ctx: Context, g: object, depth: number): CollectionWalks | null {
  const walks = ctx.collections.get(g);
  if (walks === undefined) {
    const first = { shallowest: depth, deepest: depth, membersChecked: false };
    ctx.collections.set(g, first);
    return first;
  }
  if (depth < walks.shallowest) walks.shallowest = depth;
  else if (depth > walks.deepest) walks.deepest = depth;
  else return null;
  return walks;
}

/** The members of a collection, after reporting (once per collection) a missing or empty array. */
function membersOf(ctx: Context, g: Record<string, unknown>, path: string, walks: CollectionWalks): unknown[] {
  const members = g['geometries'];
  const firstLook = !walks.membersChecked;
  walks.membersChecked = true;
  if (!Array.isArray(members)) {
    if (firstLook) report(ctx, 'BAD_STRUCTURE', path, 'The GeometryCollection has no geometries array.');
    return [];
  }
  if (members.length === 0 && firstLook) report(ctx, 'EMPTY', path, 'The GeometryCollection has no member geometries.');
  return members;
}

function checkCollection(ctx: Context, g: Record<string, unknown>, path: string, depth: number): void {
  if (ctx.open.has(g)) {
    report(ctx, 'BAD_STRUCTURE', path, 'This member is a GeometryCollection that contains itself, so it never ends.');
    return;
  }
  const walks = walksToMake(ctx, g, depth);
  if (walks === null) return;
  if (depth >= MAX_NESTING) {
    report(ctx, 'BAD_STRUCTURE', path, `Geometry collections are nested more than ${MAX_NESTING} levels deep.`);
    return;
  }
  const membersPath = member(path, 'geometries');
  const members = membersOf(ctx, g, membersPath, walks);
  ctx.open.add(g);
  for (let i = 0; i < members.length; i++) checkGeometry(ctx, members[i], `${membersPath}[${i}]`, depth + 1);
  ctx.open.delete(g);
}

function checkGeometry(ctx: Context, g: unknown, path: string, depth: number): void {
  if (!isRecord(g)) {
    report(ctx, 'BAD_STRUCTURE', path, `Expected a GeoJSON geometry object but found ${describeValue(g)}.`);
    return;
  }
  const type = g['type'];
  if (type === 'GeometryCollection') {
    checkCollection(ctx, g, path, depth);
    return;
  }
  if (ctx.checked.has(g)) return;
  ctx.checked.add(g);
  if (typeof type !== 'string') {
    report(ctx, 'BAD_STRUCTURE', member(path, 'type'), 'The object has no type name, so it is not a GeoJSON geometry.');
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
  const ctx = newContext(true);
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
  const ctx = newContext(false);
  checkGeometry(ctx, g, '', 0);
  return !ctx.problems.some((p) => SHAPE_PROBLEMS.has(p.code));
}
