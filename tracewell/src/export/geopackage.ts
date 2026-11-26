/**
 * The GeoPackage profile's rules (SAD section 10.1), shared by its plan, its writer and the
 * expectation its read-back is held to. One feature table, "data", holds a feature per row in row
 * order (fid 1, 2, 3…), the geometry in column "geom" and every other column as a typed field
 * named "Name [unit]"; gpkg_contents names the layer after the dataset. The CRS is recorded by its
 * EPSG code and its OGC WKT, so only the systems of the registry can be written. Unlike FlatGeobuf,
 * a GeoPackage geometry has heights or not on its own: a geometry is written with heights when
 * every position has one. A position keeps at most three numbers. geopackage.rs in the native
 * engine follows the same rules.
 */
import {
  GPKG_UNDEFINED_SRS,
  gpkgTypeName,
  sqlUpper,
  type GpkgSrs,
  type GpkgWriteColumn,
  type GpkgWriteFeature,
  type SqlValue,
} from '@tw/formats-geopackage';
import {
  EngineError,
  type CellValue,
  type ColumnSchema,
  type Geometry,
  type LogicalType,
  type Position,
} from '@tw/model';
import { crsDefinition, ogcWkt } from '@tw/geo';
import type { View } from '@tw/table';
import { headerFor } from './profiles';
import { geometryOfRow, type ShapeSource } from './shapefile';
import { exportable, textOf } from './values';

/** The feature table every GeoPackage of the profile holds. */
export const GPKG_TABLE = 'data';

/** The row gpkg_spatial_ref_sys holds for a CRS of the registry; OGC:CRS84 is EPSG:4326. */
export function gpkgSrs(code: string): GpkgSrs | null {
  const epsg = code === 'OGC:CRS84' ? 'EPSG:4326' : code;
  const definition = ogcWkt(epsg);
  const n = Number(/^EPSG:(\d+)$/.exec(epsg)?.[1] ?? NaN);
  if (definition === null || !Number.isSafeInteger(n)) return null;
  return n === 4326
    ? {
        id: 4326,
        name: 'WGS 84 geodetic',
        organization: 'EPSG',
        code: 4326,
        definition,
        description: 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid',
      }
    : { id: n, name: crsDefinition(epsg)?.name ?? epsg, organization: 'EPSG', code: n, definition, description: null };
}

/** Every row of gpkg_spatial_ref_sys: the undefined systems, WGS 84 and the system of the data. */
export function gpkgSrsRows(data: GpkgSrs): GpkgSrs[] {
  const rows = [...GPKG_UNDEFINED_SRS, gpkgSrs('EPSG:4326') as GpkgSrs];
  if (data.id !== 4326) rows.push(data);
  return rows.sort((a, b) => a.id - b.id);
}

/** The attribute columns: every column of the view but the geometry column the places come from. */
export function gpkgAttributes(view: View, source: ShapeSource): ColumnSchema[] {
  return view
    .columnIds()
    .filter((id) => !('geometry' in source && id === source.geometry))
    .map((id) => view.columnSchema(id));
}

/** The type a column of this logical type is declared with. */
export function gpkgColumnType(type: LogicalType): string {
  switch (type) {
    case 'integer':
      return 'INTEGER';
    case 'number':
      return 'REAL';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'DATETIME';
    case 'geometry':
    case 'string':
      return 'TEXT';
  }
}

export function gpkgColumns(columns: ColumnSchema[]): GpkgWriteColumn[] {
  return columns.map((c) => ({ name: headerFor(c), type: gpkgColumnType(c.type.value) }));
}

/** A name of our own that no column has, as SQLite compares names: ASCII letters in either case. */
function freeName(base: string, headers: readonly string[]): string {
  const taken = new Set(headers.map(sqlUpper));
  let name = base;
  for (let i = 1; taken.has(sqlUpper(name)); i++) name = `${base}_${i}`;
  return name;
}

/** The fid and geometry columns, named "fid" and "geom" unless a column of the data is. */
export function gpkgOwnColumns(headers: readonly string[]): { fid: string; geom: string } {
  const fid = freeName('fid', headers);
  return { fid, geom: freeName('geom', [...headers, fid]) };
}

/** Why the columns cannot be fields of one table, or null: two names SQLite takes as one, or a NUL. */
export function gpkgNameProblem(headers: readonly string[]): string | null {
  const seen = new Map<string, string>();
  for (const h of headers) {
    if (h.includes('\u0000'))
      return `The column name ${JSON.stringify(h)} holds a NUL character, which a GeoPackage field name cannot hold.`;
    const key = sqlUpper(h);
    const other = seen.get(key);
    if (other !== undefined) {
      return `A GeoPackage field name is unique whatever the case of its letters, and the columns "${other}" and "${h}" differ only in case.`;
    }
    seen.set(key, h);
  }
  return null;
}

function eachPosition(g: Geometry, visit: (p: Position) => void): void {
  switch (g.type) {
    case 'Point':
      if (g.coordinates.length > 0) visit(g.coordinates);
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

/** How many positions a geometry has, how many with heights, and the most numbers one holds. */
function heights(g: Geometry): { positions: number; withZ: number; longest: number } {
  let positions = 0;
  let withZ = 0;
  let longest = 0;
  eachPosition(g, (p) => {
    positions++;
    if (p.length >= 3) withZ++;
    longest = Math.max(longest, p.length);
  });
  return { positions, withZ, longest };
}

/** What the geometries of a view make of a GeoPackage, and what they cannot keep. */
export interface GpkgAnalysis {
  /** POINT, LINESTRING… when every geometry is of that type, else GEOMETRY. */
  geometryType: string;
  /** 0: no geometry has heights; 1: every geometry with positions has them; 2: some do. */
  z: 0 | 1 | 2;
  /** [min x, min y, max x, max y] of every position, or null when there are none. */
  extent: [number, number, number, number] | null;
  /** Rows whose geometry has no valid shape; their features have none. */
  bad: number;
  /** Geometries with positions of more than three numbers. */
  long: number;
  /** Geometries with some positions with heights and some without. */
  uneven: number;
}

export function analyseGpkg(view: View, source: ShapeSource): GpkgAnalysis {
  const types = new Set<Geometry['type']>();
  let extent: [number, number, number, number] | null = null;
  let bad = 0;
  let long = 0;
  let uneven = 0;
  let withZ = 0;
  let withoutZ = 0;
  for (const r of view.rows()) {
    const { g, bad: isBad } = geometryOfRow(view, r, source);
    if (isBad) bad++;
    if (g === null) continue;
    types.add(g.type);
    const h = heights(g);
    if (h.longest > 3) long++;
    if (h.positions === 0) continue;
    if (h.withZ === h.positions) withZ++;
    else withoutZ++;
    if (h.withZ > 0 && h.withZ < h.positions) uneven++;
    eachPosition(g, (p) => {
      const x = p[0] as number;
      const y = p[1] as number;
      extent =
        extent === null
          ? [x, y, x, y]
          : [Math.min(extent[0], x), Math.min(extent[1], y), Math.max(extent[2], x), Math.max(extent[3], y)];
    });
  }
  const only = types.size === 1 ? [...types][0] : undefined;
  return {
    geometryType: only === undefined ? 'GEOMETRY' : gpkgTypeName(only),
    z: withZ === 0 ? 0 : withoutZ === 0 ? 1 : 2,
    extent,
    bad,
    long,
    uneven,
  };
}

/** Whether a geometry is written with heights: when every position has one, or, empty, as the column. */
export function gpkgHasZ(g: Geometry, z: GpkgAnalysis['z']): boolean {
  const h = heights(g);
  return h.positions === 0 ? z === 1 : h.withZ === h.positions;
}

/** A geometry as the file holds it and a reader takes it back: each position with x, y and a height when it has one. */
export function gpkgForm(g: Geometry, hasZ: boolean): Geometry {
  const p = (x: Position): Position => x.slice(0, hasZ ? 3 : 2);
  switch (g.type) {
    case 'Point':
      return { type: 'Point', coordinates: g.coordinates.length === 0 ? [] : p(g.coordinates) };
    case 'MultiPoint':
    case 'LineString':
      return { type: g.type, coordinates: g.coordinates.map(p) } as Geometry;
    case 'MultiLineString':
    case 'Polygon':
      return { type: g.type, coordinates: g.coordinates.map((part) => part.map(p)) } as Geometry;
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: g.coordinates.map((rings) => rings.map((ring) => ring.map(p))) };
    case 'GeometryCollection':
      return { type: 'GeometryCollection', geometries: g.geometries.map((m) => gpkgForm(m, hasZ)) };
  }
}

function mismatch(column: ColumnSchema, v: CellValue): EngineError {
  return new EngineError(
    'INTERNAL',
    `The value ${JSON.stringify(v)} in column "${column.name}" is not a ${column.type.value} value, so it cannot be written to a GeoPackage.`,
    'Report this problem; the export was not written.',
  );
}

/** A cell as its field's value; empty text is no value, as in the other formats. */
export function gpkgValue(v: CellValue, column: ColumnSchema): SqlValue {
  const e = exportable(v);
  if (e === null) return null;
  switch (column.type.value) {
    case 'string':
      if (typeof e === 'string') return e;
      break;
    case 'number':
      if (typeof e === 'number') return e;
      break;
    case 'integer':
      if (typeof e === 'number' && Number.isSafeInteger(e)) return BigInt(e);
      break;
    case 'boolean':
      if (typeof e === 'boolean') return e ? 1n : 0n;
      break;
    case 'date':
      if (typeof e === 'object' && 'date' in e) return e.date;
      break;
    case 'datetime':
      if (typeof e === 'object' && 'datetime' in e) return e.datetime;
      break;
    case 'geometry':
      if (typeof e === 'object' && 'geometry' in e) return textOf(e);
      break;
  }
  throw mismatch(column, e);
}

/** Each row as a feature: its geometry, whether it has heights, and its values by column. */
export function* gpkgFeatures(
  view: View,
  source: ShapeSource,
  columns: ColumnSchema[],
  z: GpkgAnalysis['z'],
): IterableIterator<GpkgWriteFeature> {
  for (const r of view.rows()) {
    const { g } = geometryOfRow(view, r, source);
    const hasZ = g !== null && gpkgHasZ(g, z);
    yield {
      geometry: g === null ? null : gpkgForm(g, hasZ),
      z: hasZ,
      values: columns.map((c) => gpkgValue(view.value(r, c.id), c)),
    };
  }
}

/** Each row's geometry in the form a reader takes back. */
export function* expectedGpkgGeometries(
  view: View,
  source: ShapeSource,
  z: GpkgAnalysis['z'],
): IterableIterator<CellValue> {
  for (const r of view.rows()) {
    const { g } = geometryOfRow(view, r, source);
    yield g === null ? null : { geometry: gpkgForm(g, gpkgHasZ(g, z)) };
  }
}
