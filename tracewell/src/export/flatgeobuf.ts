/**
 * The FlatGeobuf profile's rules (SAD section 10.1), shared by its plan, its writer and the
 * expectation its read-back is held to: where the geometries come from, what the header says of
 * them, how each column is typed, the CRS by its EPSG code, and the form each geometry takes once
 * read back. Unlike a Shapefile, a FlatGeobuf file holds any mix of geometry kinds, columns of
 * any length under their full names, and files of any size; its geometries are all with heights
 * or all without. A position keeps at most three numbers. The native engine (flatgeobuf.rs)
 * follows the same rules.
 */
import {
  FGB_COLUMN,
  FGB_GEOMETRY,
  geometryTypeOf,
  type FgbCrs,
  type FgbWriteColumn,
  type FgbWriteFeature,
  type FgbWriteValue,
} from '@tw/formats-flatgeobuf';
import { EngineError, type CellValue, type ColumnSchema, type Geometry, type Position } from '@tw/model';
import { crsDefinition } from '@tw/geo';
import type { View } from '@tw/table';
import { headerFor } from './profiles';
import { geometryOfRow, type ShapeSource } from './shapefile';
import { exportable, textOf } from './values';

/** The CRS as the header records it: EPSG and its code. OGC:CRS84 is EPSG:4326 in x, y order. */
export function fgbCrs(code: string): FgbCrs | null {
  const epsg = code === 'OGC:CRS84' ? 4326 : Number(/^EPSG:(\d{1,9})$/.exec(code)?.[1] ?? NaN);
  if (!Number.isSafeInteger(epsg) || epsg <= 0) return null;
  return { org: 'EPSG', code: epsg, name: crsDefinition(`EPSG:${epsg}`)?.name ?? null };
}

/** The attribute columns: every column of the view but the geometry column the places come from. */
export function fgbAttributes(view: View, source: ShapeSource): ColumnSchema[] {
  return view
    .columnIds()
    .filter((id) => !('geometry' in source && id === source.geometry))
    .map((id) => view.columnSchema(id));
}

/** Each column under its header, "Name [unit]", typed as its logical type is. */
export function fgbColumns(columns: ColumnSchema[]): FgbWriteColumn[] {
  return columns.map((c) => ({ name: headerFor(c), type: columnType(c) }));
}

function columnType(c: ColumnSchema): FgbWriteColumn['type'] {
  switch (c.type.value) {
    case 'integer':
      return FGB_COLUMN.Long;
    case 'number':
      return FGB_COLUMN.Double;
    case 'boolean':
      return FGB_COLUMN.Bool;
    case 'date':
    case 'datetime':
      return FGB_COLUMN.DateTime;
    case 'geometry':
      return FGB_COLUMN.Json;
    case 'string':
      return FGB_COLUMN.String;
  }
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

/** What the geometries of a view make of a FlatGeobuf header, and what they cannot keep. */
export interface FgbAnalysis {
  /** The type every geometry has, or Unknown for a mix or none. */
  geometryType: number;
  hasZ: boolean;
  /** True when some positions have heights and others do not. */
  mixed: boolean;
  /** [min x, min y, max x, max y] of every position, or null when there are none. */
  envelope: [number, number, number, number] | null;
  /** Rows whose geometry has no valid shape; their features have none. */
  bad: number;
  /** Geometries with positions of more than three numbers. */
  long: number;
}

export function analyseFgb(view: View, source: ShapeSource): FgbAnalysis {
  const types = new Set<Geometry['type']>();
  const dims = new Set<number>();
  let envelope: [number, number, number, number] | null = null;
  let bad = 0;
  let long = 0;
  for (const r of view.rows()) {
    const { g, bad: isBad } = geometryOfRow(view, r, source);
    if (isBad) bad++;
    if (g === null) continue;
    types.add(g.type);
    let longest = 0;
    eachPosition(g, (p) => {
      longest = Math.max(longest, p.length);
      dims.add(Math.min(p.length, 3));
      const x = p[0] as number;
      const y = p[1] as number;
      envelope =
        envelope === null
          ? [x, y, x, y]
          : [Math.min(envelope[0], x), Math.min(envelope[1], y), Math.max(envelope[2], x), Math.max(envelope[3], y)];
    });
    if (longest > 3) long++;
  }
  const only = types.size === 1 ? [...types][0] : undefined;
  return {
    geometryType: only === undefined ? FGB_GEOMETRY.Unknown : geometryTypeOf(only),
    hasZ: dims.size === 1 && dims.has(3),
    mixed: dims.size > 1,
    envelope,
    bad,
    long,
  };
}

function mismatch(column: ColumnSchema, v: CellValue): EngineError {
  return new EngineError(
    'INTERNAL',
    `The value ${JSON.stringify(v)} in column "${column.name}" is not a ${column.type.value} value, so it cannot be written to FlatGeobuf.`,
    'Report this problem; the export was not written.',
  );
}

/** A cell as its column's FlatGeobuf value; empty text is no value, as in the other formats. */
export function fgbValue(v: CellValue, column: ColumnSchema): FgbWriteValue {
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
      if (typeof e === 'number' && Number.isSafeInteger(e)) return e;
      break;
    case 'boolean':
      if (typeof e === 'boolean') return e;
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

/** A geometry as the file holds it and a reader takes it back: each position with at most three numbers. */
export function fgbForm(g: Geometry): Geometry {
  const p = (x: Position): Position => (x.length > 3 ? x.slice(0, 3) : x);
  switch (g.type) {
    case 'Point':
      return { type: 'Point', coordinates: p(g.coordinates) };
    case 'MultiPoint':
    case 'LineString':
      return { type: g.type, coordinates: g.coordinates.map(p) } as Geometry;
    case 'MultiLineString':
    case 'Polygon':
      return { type: g.type, coordinates: g.coordinates.map((part) => part.map(p)) } as Geometry;
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: g.coordinates.map((rings) => rings.map((ring) => ring.map(p))) };
    case 'GeometryCollection':
      return { type: 'GeometryCollection', geometries: g.geometries.map(fgbForm) };
  }
}

/** Each row as a feature: its geometry and its values by column. */
export function* fgbFeatures(
  view: View,
  source: ShapeSource,
  columns: ColumnSchema[],
): IterableIterator<FgbWriteFeature> {
  for (const r of view.rows()) {
    const { g } = geometryOfRow(view, r, source);
    yield {
      geometry: g === null ? null : fgbForm(g),
      properties: columns.map((c) => fgbValue(view.value(r, c.id), c)),
    };
  }
}

/** Each row's geometry in the form a reader takes back. */
export function* expectedFgbGeometries(view: View, source: ShapeSource): IterableIterator<CellValue> {
  for (const r of view.rows()) {
    const { g } = geometryOfRow(view, r, source);
    yield g === null ? null : { geometry: fgbForm(g) };
  }
}
