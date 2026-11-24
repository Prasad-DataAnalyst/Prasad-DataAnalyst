/**
 * The Shapefile profile's rules (FR-EXP-04, SAD section 10.1), shared by its plan, its writer and
 * the expectation its read-back is held to: where the shapes come from, which kind of Shapefile
 * they make, the form each geometry takes in it, which columns a .dbf field holds exactly, and the
 * 10-character field names. The native engine (export.rs) follows the same rules.
 *
 * A Shapefile holds one kind of shape: points (Point and MultiPoint, written as multipoints when
 * any is one), lines (LineString, MultiLineString) or polygons (Polygon, MultiPolygon), all with
 * or all without heights. Outer rings are written clockwise and holes anticlockwise, as the format
 * requires; a reader groups each outer ring with the holes after it.
 */
import { isGeometryCell, type CellValue, type ColumnId, type ColumnSchema, type Geometry } from '@tw/model';
import { crsDefinition, isGeometry } from '@tw/geo';
import type { View } from '@tw/table';
import { exportable, textOf } from './values';

/** Shape types of the ESRI Shapefile Technical Description (July 1998). */
export const SHAPE = {
  null: 0,
  point: 1,
  polyline: 3,
  polygon: 5,
  multipoint: 8,
  pointZ: 11,
  polylineZ: 13,
  polygonZ: 15,
  multipointZ: 18,
} as const;

/** The largest file the format can address: offsets are 32-bit counts of 16-bit words. */
export const SHAPEFILE_MAX_BYTES = 2 ** 31 - 1;

/** A .dbf character field holds at most 254 bytes. */
export const DBF_TEXT_MAX = 254;

export type ShapeSource = { geometry: ColumnId } | { x: ColumnId; y: ColumnId };

/** Where the shapes come from: the geometry column, or the coordinate pair of the CRS's kind. */
export function shapeSource(view: View, crsCode: string | null): ShapeSource | null {
  const schema = view.schema;
  if (schema.geometryColumn !== null && view.columnIds().includes(schema.geometryColumn)) {
    return { geometry: schema.geometryColumn };
  }
  const geographic = crsCode === null ? true : (crsDefinition(crsCode)?.kind ?? 'geographic') === 'geographic';
  const numeric = (role: string) =>
    schema.columns.find((c) => c.role.value === role && (c.type.value === 'number' || c.type.value === 'integer'));
  const x = numeric(geographic ? 'longitude' : 'easting');
  const y = numeric(geographic ? 'latitude' : 'northing');
  return x === undefined || y === undefined ? null : { x: x.id, y: y.id };
}

type Family = 'point' | 'multipoint' | 'line' | 'polygon' | 'collection';

const FAMILY: Record<Geometry['type'], Family> = {
  Point: 'point',
  MultiPoint: 'multipoint',
  LineString: 'line',
  MultiLineString: 'line',
  Polygon: 'polygon',
  MultiPolygon: 'polygon',
  GeometryCollection: 'collection',
};

const FAMILY_NAMES: Record<Family, string> = {
  point: 'points',
  multipoint: 'points',
  line: 'lines',
  polygon: 'polygons',
  collection: 'geometry collections',
};

/** The geometry of a row as the source gives it, or null; `bad` when a value has no valid shape. */
export function geometryOfRow(view: View, r: number, source: ShapeSource): { g: Geometry | null; bad: boolean } {
  if ('geometry' in source) {
    const v = view.value(r, source.geometry);
    if (v === null) return { g: null, bad: false };
    return isGeometryCell(v) && isGeometry(v.geometry) ? { g: v.geometry, bad: false } : { g: null, bad: true };
  }
  const x = view.value(r, source.x);
  const y = view.value(r, source.y);
  return typeof x === 'number' && typeof y === 'number'
    ? { g: { type: 'Point', coordinates: [x, y] }, bad: false }
    : { g: null, bad: false };
}

function eachPosition(g: Geometry, visit: (p: number[]) => void): void {
  switch (g.type) {
    case 'Point':
      visit(g.coordinates);
      return;
    case 'MultiPoint':
    case 'LineString':
      g.coordinates.forEach(visit);
      return;
    case 'MultiLineString':
    case 'Polygon':
      for (const part of g.coordinates) part.forEach(visit);
      return;
    case 'MultiPolygon':
      for (const polygon of g.coordinates) for (const ring of polygon) ring.forEach(visit);
      return;
    case 'GeometryCollection':
      for (const member of g.geometries) eachPosition(member, visit);
  }
}

/** What the shapes of a view make: the kind of Shapefile, or why they cannot make one. */
export interface ShapeAnalysis {
  /** The shape type every non-null record has. */
  shapeType: number;
  /** True when the shapes have heights. */
  z: boolean;
  /** Rows whose geometry has no valid shape, written as null shapes. */
  bad: number;
  /** Why the shapes cannot be one Shapefile, or null. */
  problem: string | null;
}

export function analyseShapes(view: View, source: ShapeSource): ShapeAnalysis {
  const families = new Set<Family>();
  const dims = new Set<number>();
  let bad = 0;
  for (const r of view.rows()) {
    const { g, bad: isBad } = geometryOfRow(view, r, source);
    if (isBad) bad++;
    if (g === null) continue;
    families.add(FAMILY[g.type]);
    eachPosition(g, (p) => dims.add(p.length));
  }
  const kinds = new Set([...families].map((f) => FAMILY_NAMES[f]));
  let problem: string | null = null;
  if (families.has('collection') || kinds.size > 1) {
    problem = `A Shapefile holds one kind of geometry, and this dataset has ${[...kinds].sort().join(' and ')}.`;
  } else if (dims.size > 1 || [...dims].some((d) => d > 3)) {
    problem = 'A Shapefile holds geometries all with heights or all without, and this dataset has both.';
  }
  const z = dims.has(3) && dims.size === 1;
  const family = families.has('multipoint') ? 'multipoint' : ([...families][0] ?? 'point');
  const base =
    family === 'multipoint'
      ? SHAPE.multipoint
      : family === 'line'
        ? SHAPE.polyline
        : family === 'polygon'
          ? SHAPE.polygon
          : SHAPE.point;
  return { shapeType: z ? zType(base) : base, z, bad, problem };
}

function zType(base: number): number {
  return base === SHAPE.point
    ? SHAPE.pointZ
    : base === SHAPE.multipoint
      ? SHAPE.multipointZ
      : base === SHAPE.polyline
        ? SHAPE.polylineZ
        : SHAPE.polygonZ;
}

/** Twice the signed area of a ring: negative for clockwise, as x grows east and y north. */
export function ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i] as number[];
    const b = ring[i + 1] as number[];
    sum += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return sum;
}

function oriented(ring: number[][], clockwise: boolean): number[][] {
  const area = ringArea(ring);
  const wrong = clockwise ? area > 0 : area < 0;
  return wrong ? [...ring].reverse() : ring;
}

/** The parts and positions one record holds, in the order they are written. */
export interface ShapeRecord {
  parts: number[][][];
}

function trim(p: number[], z: boolean): number[] {
  return z ? [p[0] as number, p[1] as number, p[2] as number] : [p[0] as number, p[1] as number];
}

/**
 * A geometry as a record of the given shape type: points as one part each, lines as parts, and
 * polygon rings oriented, outer rings first in each polygon. Null when there is nothing to write.
 */
export function shapeRecord(g: Geometry | null, shapeType: number, z: boolean): ShapeRecord | null {
  if (g === null) return null;
  const pos = (p: number[]) => trim(p, z);
  let parts: number[][][] = [];
  switch (g.type) {
    case 'Point':
      parts = [[pos(g.coordinates)]];
      break;
    case 'MultiPoint':
      parts = [g.coordinates.map(pos)];
      break;
    case 'LineString':
      parts = [g.coordinates.map(pos)];
      break;
    case 'MultiLineString':
      parts = g.coordinates.map((line) => line.map(pos));
      break;
    case 'Polygon':
      parts = g.coordinates.map((ring, i) => oriented(ring.map(pos), i === 0));
      break;
    case 'MultiPolygon':
      parts = g.coordinates.flatMap((polygon) => polygon.map((ring, i) => oriented(ring.map(pos), i === 0)));
      break;
    case 'GeometryCollection':
      return null;
  }
  if (shapeType === SHAPE.multipoint || shapeType === SHAPE.multipointZ) parts = [parts.flat()];
  parts = parts.filter((p) => p.length > 0);
  return parts.length === 0 ? null : { parts };
}

/**
 * The GeoJSON geometry a reader makes of a record: a point, a multipoint, a line or several, and
 * polygons from outer (clockwise) rings each with the holes after it. The read-back compares the
 * geometries read from the file with the view's geometries in this form.
 */
export function geometryOfRecord(rec: ShapeRecord | null, shapeType: number): Geometry | null {
  if (rec === null) return null;
  switch (shapeType) {
    case SHAPE.point:
    case SHAPE.pointZ:
      return { type: 'Point', coordinates: rec.parts[0]?.[0] as number[] };
    case SHAPE.multipoint:
    case SHAPE.multipointZ:
      return { type: 'MultiPoint', coordinates: rec.parts[0] as number[][] };
    case SHAPE.polyline:
    case SHAPE.polylineZ:
      return rec.parts.length === 1
        ? { type: 'LineString', coordinates: rec.parts[0] as number[][] }
        : { type: 'MultiLineString', coordinates: rec.parts };
    default: {
      const polygons: number[][][][] = [];
      for (const ring of rec.parts) {
        const area = ringArea(ring);
        const current = polygons[polygons.length - 1];
        // A clockwise ring starts a polygon; any other ring is a hole of the polygon before it.
        if (area < 0 || current === undefined) polygons.push([ring]);
        else current.push(ring);
      }
      return polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] as number[][][] }
        : { type: 'MultiPolygon', coordinates: polygons };
    }
  }
}

/** Each row's geometry as the Shapefile holds it, in the form a reader makes of it. */
export function* expectedShapes(view: View, source: ShapeSource, a: ShapeAnalysis): IterableIterator<CellValue> {
  for (const r of view.rows()) {
    const g = geometryOfRecord(shapeRecord(geometryOfRow(view, r, source).g, a.shapeType, a.z), a.shapeType);
    yield g === null ? null : { geometry: g };
  }
}

/** Each row's record, as the writer writes it. */
export function* shapeRecords(view: View, source: ShapeSource, a: ShapeAnalysis): IterableIterator<ShapeRecord | null> {
  for (const r of view.rows()) yield shapeRecord(geometryOfRow(view, r, source).g, a.shapeType, a.z);
}

// ---------------------------------------------------------------------------------------------
// Attribute fields

/** A .dbf field: its 10-character name and how its column's values are written. */
export interface DbfField {
  name: string;
  column: ColumnSchema;
  type: 'C' | 'N' | 'L' | 'D';
  width: number;
  decimals: number;
}

const utf8 = new TextEncoder();

/** The text a .dbf field holds for a value, or null for no value. */
export function dbfText(v: CellValue, column: ColumnSchema): string | null {
  const e = exportable(v);
  if (e === null) return null;
  switch (column.type.value) {
    case 'boolean':
      return e === true ? 'T' : 'F';
    case 'date':
      return typeof e === 'object' && 'date' in e ? e.date.replace(/-/g, '') : textOf(e);
    default:
      return textOf(e);
  }
}

/** Whether a value's text fits its field exactly: a reader trims spaces and stops at a NUL. */
function fits(text: string, column: ColumnSchema): boolean {
  switch (column.type.value) {
    case 'integer':
      return text.length <= 18;
    case 'number':
      return text.length <= 24;
    case 'date':
      return /^\d{8}$/.test(text);
    case 'boolean':
      return true;
    default:
      return (
        utf8.encode(text).length <= DBF_TEXT_MAX && !text.startsWith(' ') && !text.endsWith(' ') && !text.includes('\0')
      );
  }
}

/** Attribute columns whose values a .dbf field cannot hold exactly; they go to a CSV beside it. */
export function unfitColumns(view: View, columns: ColumnSchema[]): ColumnId[] {
  const out: ColumnId[] = [];
  for (const c of columns) {
    for (const r of view.rows()) {
      const text = dbfText(view.value(r, c.id), c);
      if (text !== null && !fits(text, c)) {
        out.push(c.id);
        break;
      }
    }
  }
  return out;
}

/**
 * Field names of at most 10 characters: letters, digits and underscores, starting with a letter,
 * each unique whatever its case, a clash taking a number (Pressure_1).
 */
export function fieldNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let base = Array.from(name, (ch) => (/^[A-Za-z0-9_]$/.test(ch) ? ch : '_')).join('');
    if (!/^[A-Za-z]/.test(base)) base = `F${base}`;
    base = base.slice(0, 10);
    let candidate = base;
    for (let n = 1; taken.has(candidate.toUpperCase()); n++) {
      const suffix = `_${n}`;
      candidate = `${base.slice(0, 10 - suffix.length)}${suffix}`;
    }
    taken.add(candidate.toUpperCase());
    return candidate;
  });
}

/** The fields of the attribute columns: widths that hold every value, as the type needs. */
export function dbfFields(view: View, columns: ColumnSchema[]): DbfField[] {
  const names = fieldNames(columns.map((c) => c.name));
  return columns.map((column, i) => {
    const name = names[i] as string;
    switch (column.type.value) {
      case 'integer':
        return { name, column, type: 'N', width: 18, decimals: 0 };
      case 'number':
        return { name, column, type: 'N', width: 24, decimals: 15 };
      case 'boolean':
        return { name, column, type: 'L', width: 1, decimals: 0 };
      case 'date':
        return { name, column, type: 'D', width: 8, decimals: 0 };
      default: {
        let width = 1;
        for (const r of view.rows()) {
          const text = dbfText(view.value(r, column.id), column);
          if (text !== null) width = Math.max(width, utf8.encode(text).length);
        }
        return { name, column, type: 'C', width, decimals: 0 };
      }
    }
  });
}

/** The size in bytes of the .dbf and the .shp the writer would write. */
export function shapefileSizes(
  view: View,
  source: ShapeSource,
  a: ShapeAnalysis,
  fields: DbfField[],
): { dbf: number; shp: number } {
  const record = 1 + fields.reduce((n, f) => n + f.width, 0);
  const dbf = 32 + 32 * fields.length + 1 + view.rowCount * record + 1;
  let shp = 100;
  for (const rec of shapeRecords(view, source, a)) shp += 8 + recordContentBytes(rec, a.shapeType);
  return { dbf, shp };
}

/** The bytes of a record's content (after its 8-byte header). */
export function recordContentBytes(rec: ShapeRecord | null, shapeType: number): number {
  if (rec === null) return 4;
  const points = rec.parts.reduce((n, p) => n + p.length, 0);
  switch (shapeType) {
    case SHAPE.point:
      return 20;
    case SHAPE.pointZ:
      return 36;
    case SHAPE.multipoint:
      return 40 + 16 * points;
    case SHAPE.multipointZ:
      return 40 + 16 * points + 16 + 8 * points;
    case SHAPE.polyline:
    case SHAPE.polygon:
      return 44 + 4 * rec.parts.length + 16 * points;
    default:
      return 44 + 4 * rec.parts.length + 16 * points + 16 + 8 * points;
  }
}
