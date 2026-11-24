/**
 * A FlatGeobuf 3 writer (flatgeobuf.org): the magic bytes, the header and one feature per row,
 * each a size-prefixed FlatBuffer, without a spatial index so that features keep the order of the
 * rows. Positions are written as x and y (and z when the header says the data has heights) in the
 * file's CRS. A multipolygon or a collection is a geometry of parts; a polygon or multi-line has
 * the running ends of its parts unless it has exactly one. The native engine writes the same bytes.
 */
import type { Geometry, Position } from '@tw/model';
import { FlatBuilder } from './flatbuffers';

/** "fgb", major version 3, "fgb", patch version 1. */
export const FGB_MAGIC: Uint8Array = Uint8Array.of(0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x01);

export const FGB_GEOMETRY = {
  Unknown: 0,
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7,
} as const;

export const FGB_COLUMN = {
  Byte: 0,
  UByte: 1,
  Bool: 2,
  Short: 3,
  UShort: 4,
  Int: 5,
  UInt: 6,
  Long: 7,
  ULong: 8,
  Float: 9,
  Double: 10,
  String: 11,
  Json: 12,
  DateTime: 13,
  Binary: 14,
} as const;

/** The columns this writer writes: whole numbers, numbers, true or false, and text of three kinds. */
export type FgbWriteColumnType =
  | typeof FGB_COLUMN.Bool
  | typeof FGB_COLUMN.Long
  | typeof FGB_COLUMN.Double
  | typeof FGB_COLUMN.String
  | typeof FGB_COLUMN.Json
  | typeof FGB_COLUMN.DateTime;

export interface FgbWriteColumn {
  name: string;
  type: FgbWriteColumnType;
}

export interface FgbCrs {
  /** The defining organisation, "EPSG". */
  org: string;
  code: number;
  name: string | null;
}

export interface FgbWriteHeader {
  name: string;
  /** [min x, min y, max x, max y] of every position, or null when there are none. */
  envelope: readonly [number, number, number, number] | null;
  /** The geometry type every feature has, or Unknown for a mix. */
  geometryType: number;
  hasZ: boolean;
  columns: FgbWriteColumn[];
  featuresCount: number;
  crs: FgbCrs | null;
}

/**
 * A feature's values by column, null for none: a boolean for Bool, a safe integer for Long, a
 * number for Double and text for String, Json and DateTime.
 */
export type FgbWriteValue = boolean | number | string | null;

export interface FgbWriteFeature {
  geometry: Geometry | null;
  properties: FgbWriteValue[];
}

const UTF8 = new TextEncoder();

export function geometryTypeOf(type: Geometry['type']): number {
  return FGB_GEOMETRY[type];
}

export function writeHeader(h: FgbWriteHeader): Uint8Array {
  const b = new FlatBuilder();
  const columns = h.columns.map((c) => {
    const name = b.createString(c.name);
    b.startTable(11);
    b.fieldOffset(0, name);
    b.fieldUint8(1, c.type);
    return b.endTable();
  });
  const columnVector = columns.length > 0 ? b.createOffsetVector(columns) : null;
  const name = b.createString(h.name);
  const envelope = h.envelope === null ? null : b.createFloat64Vector(h.envelope);
  let crs: number | null = null;
  if (h.crs !== null) {
    const org = b.createString(h.crs.org);
    const crsName = h.crs.name === null ? null : b.createString(h.crs.name);
    b.startTable(6);
    b.fieldOffset(0, org);
    b.fieldInt32(1, h.crs.code);
    if (crsName !== null) b.fieldOffset(2, crsName);
    crs = b.endTable();
  }
  b.startTable(14);
  if (h.featuresCount > 0) b.fieldUint64(8, BigInt(h.featuresCount));
  b.fieldOffset(0, name);
  if (envelope !== null) b.fieldOffset(1, envelope);
  if (columnVector !== null) b.fieldOffset(7, columnVector);
  if (crs !== null) b.fieldOffset(10, crs);
  // No spatial index; the field must be written, as its default is 16.
  b.fieldUint16(9, 0);
  if (h.geometryType !== FGB_GEOMETRY.Unknown) b.fieldUint8(2, h.geometryType);
  if (h.hasZ) b.fieldUint8(3, 1);
  return b.finishSizePrefixed(b.endTable());
}

/** The positions of a geometry without parts, and the running ends of its rings or lines. */
function flat(g: Exclude<Geometry, { type: 'MultiPolygon' | 'GeometryCollection' }>): {
  positions: Position[];
  ends: number[] | null;
} {
  switch (g.type) {
    case 'Point':
      return { positions: g.coordinates.length === 0 ? [] : [g.coordinates], ends: null };
    case 'MultiPoint':
    case 'LineString':
      return { positions: g.coordinates, ends: null };
    case 'MultiLineString':
    case 'Polygon': {
      let end = 0;
      const ends = g.coordinates.map((part) => (end += part.length));
      return { positions: g.coordinates.flat(), ends: ends.length === 1 ? null : ends };
    }
  }
}

function buildGeometry(b: FlatBuilder, g: Geometry, hasZ: boolean): number {
  if (g.type === 'MultiPolygon' || g.type === 'GeometryCollection') {
    const parts =
      g.type === 'MultiPolygon'
        ? g.coordinates.map((rings) => buildGeometry(b, { type: 'Polygon', coordinates: rings }, hasZ))
        : g.geometries.map((member) => buildGeometry(b, member, hasZ));
    const vector = b.createOffsetVector(parts);
    b.startTable(8);
    b.fieldOffset(7, vector);
    b.fieldUint8(6, geometryTypeOf(g.type));
    return b.endTable();
  }
  const { positions, ends } = flat(g);
  const xy: number[] = [];
  for (const p of positions) xy.push(p[0] as number, p[1] as number);
  const xyVector = b.createFloat64Vector(xy);
  const zVector = hasZ ? b.createFloat64Vector(positions.map((p) => p[2] as number)) : null;
  const endsVector = ends === null ? null : b.createUint32Vector(ends);
  b.startTable(8);
  if (endsVector !== null) b.fieldOffset(0, endsVector);
  b.fieldOffset(1, xyVector);
  if (zVector !== null) b.fieldOffset(2, zVector);
  b.fieldUint8(6, geometryTypeOf(g.type));
  return b.endTable();
}

/** The values of a feature: each present one as its column's index, then the value. */
export function encodeProperties(columns: readonly FgbWriteColumn[], values: readonly FgbWriteValue[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    size += bytes.length;
  };
  columns.forEach((column, i) => {
    const v = values[i] ?? null;
    if (v === null) return;
    const head = new DataView(new ArrayBuffer(2));
    head.setUint16(0, i, true);
    push(new Uint8Array(head.buffer));
    switch (column.type) {
      case FGB_COLUMN.Bool:
        push(Uint8Array.of(v === true ? 1 : 0));
        break;
      case FGB_COLUMN.Long: {
        const d = new DataView(new ArrayBuffer(8));
        d.setBigInt64(0, BigInt(v as number), true);
        push(new Uint8Array(d.buffer));
        break;
      }
      case FGB_COLUMN.Double: {
        const d = new DataView(new ArrayBuffer(8));
        d.setFloat64(0, v as number, true);
        push(new Uint8Array(d.buffer));
        break;
      }
      default: {
        const text = UTF8.encode(v as string);
        const d = new DataView(new ArrayBuffer(4));
        d.setUint32(0, text.length, true);
        push(new Uint8Array(d.buffer));
        push(text);
      }
    }
  });
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function writeFeature(columns: readonly FgbWriteColumn[], f: FgbWriteFeature, hasZ: boolean): Uint8Array {
  const b = new FlatBuilder();
  const properties = encodeProperties(columns, f.properties);
  const propertyVector = properties.length > 0 ? b.createBytes(properties) : null;
  const geometry = f.geometry === null ? null : buildGeometry(b, f.geometry, hasZ);
  b.startTable(3);
  if (geometry !== null) b.fieldOffset(0, geometry);
  if (propertyVector !== null) b.fieldOffset(1, propertyVector);
  return b.finishSizePrefixed(b.endTable());
}

/** The whole file: magic bytes, header, then the features in order. */
export function writeFlatGeobuf(header: FgbWriteHeader, features: Iterable<FgbWriteFeature>): Uint8Array {
  const chunks: Uint8Array[] = [FGB_MAGIC, writeHeader(header)];
  for (const f of features) chunks.push(writeFeature(header.columns, f, header.hasZ));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
