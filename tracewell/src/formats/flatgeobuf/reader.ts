/**
 * A FlatGeobuf 3 reader: the header (name, envelope, geometry type, dimensions, columns, feature
 * count, index node size and CRS) and every feature's geometry as GeoJSON and values by column.
 * A spatial index, when the file has one, is skipped. Every offset is checked against the buffer
 * it points into, so a damaged file is refused with a reason rather than read wrongly.
 */
import type { Geometry, Position } from '@tw/model';
import { FlatReader } from './flatbuffers';

export class FlatGeobufFormatError extends Error {}

export interface FgbReadColumn {
  name: string;
  type: number;
  nullable: boolean;
}

export interface FgbReadCrs {
  org: string | null;
  code: number;
  name: string | null;
  codeString: string | null;
  wkt: string | null;
}

export interface FgbReadHeader {
  name: string | null;
  envelope: number[] | null;
  geometryType: number;
  hasZ: boolean;
  hasM: boolean;
  hasT: boolean;
  hasTM: boolean;
  columns: FgbReadColumn[];
  featuresCount: bigint;
  indexNodeSize: number;
  crs: FgbReadCrs | null;
}

/** A value as the file holds it: a whole number past 2^53 stays a bigint, binary stays bytes. */
export type FgbReadValue = boolean | number | bigint | string | Uint8Array | null;

export interface FgbReadFeature {
  geometry: Geometry | null;
  /** By column index; null for a column the feature has no value for. */
  properties: FgbReadValue[];
}

export interface FgbDocument {
  /** The major and patch versions of the magic bytes. */
  version: [number, number];
  header: FgbReadHeader;
  /** The bytes of the spatial index, which this reader skips. */
  indexBytes: number;
  features: FgbReadFeature[];
}

const MAGIC = [0x66, 0x67, 0x62];

/** The size of a packed Hilbert R-tree of `items` leaves: 40 bytes a node; node size 0 is no index. */
export function indexSize(items: number, nodeSize: number): number {
  if (nodeSize === 0 || items === 0) return 0;
  const fanout = Math.max(nodeSize, 2);
  let count = items;
  let total = items;
  do {
    count = Math.ceil(count / fanout);
    total += count;
  } while (count !== 1);
  return total * 40;
}

function fail(why: string): never {
  throw new FlatGeobufFormatError(why);
}

/** The size-prefixed FlatBuffer at `at`: a reader over its bytes and where its root table is. */
function sizePrefixed(bytes: Uint8Array, at: number, what: string): { r: FlatReader; root: number; end: number } {
  if (at + 4 > bytes.length) fail(`the ${what} is cut short`);
  const size = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
  const end = at + 4 + size;
  if (size < 4 || end > bytes.length) fail(`the ${what} is cut short`);
  const r = new FlatReader(bytes.subarray(at + 4, end));
  return { r, root: r.uint32(0), end };
}

function doubles(r: FlatReader, table: number, slot: number): number[] | null {
  const v = r.vector(table, slot);
  if (v === null) return null;
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = r.float64(v.start + 8 * i);
  return out;
}

function readHeader(r: FlatReader, t: number): FgbReadHeader {
  const flag = (slot: number) => {
    const at = r.field(t, slot);
    return at !== null && r.uint8(at) !== 0;
  };
  const columns: FgbReadColumn[] = [];
  const cv = r.vector(t, 7);
  for (let i = 0; i < (cv?.length ?? 0); i++) {
    const c = r.indirect((cv as { start: number }).start + 4 * i);
    const name = r.string(c, 0);
    if (name === null) fail(`column ${i + 1} has no name`);
    const type = r.field(c, 1);
    const nullable = r.field(c, 7);
    columns.push({
      name,
      type: type === null ? 0 : r.uint8(type),
      nullable: nullable === null ? true : r.uint8(nullable) !== 0,
    });
  }
  const crsAt = r.field(t, 10);
  let crs: FgbReadCrs | null = null;
  if (crsAt !== null) {
    const c = r.indirect(crsAt);
    const code = r.field(c, 1);
    crs = {
      org: r.string(c, 0),
      code: code === null ? 0 : r.int32(code),
      name: r.string(c, 2),
      codeString: r.string(c, 5),
      wkt: r.string(c, 4),
    };
  }
  const geometryType = r.field(t, 2);
  const count = r.field(t, 8);
  const nodeSize = r.field(t, 9);
  return {
    name: r.string(t, 0),
    envelope: doubles(r, t, 1),
    geometryType: geometryType === null ? 0 : r.uint8(geometryType),
    hasZ: flag(3),
    hasM: flag(4),
    hasT: flag(5),
    hasTM: flag(6),
    columns,
    featuresCount: count === null ? 0n : r.uint64(count),
    indexNodeSize: nodeSize === null ? 16 : r.uint16(nodeSize),
    crs,
  };
}

const TYPE_NAMES = [
  'Unknown',
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
] as const;

function readGeometry(r: FlatReader, t: number, fallback: number, hasZ: boolean): Geometry {
  const typeAt = r.field(t, 6);
  const type = typeAt === null || r.uint8(typeAt) === 0 ? fallback : r.uint8(typeAt);
  const name = TYPE_NAMES[type];
  if (name === undefined || name === 'Unknown') fail(`a geometry is of unknown type ${type}`);
  const pv = r.vector(t, 7);
  if (name === 'MultiPolygon' || name === 'GeometryCollection') {
    const parts: Geometry[] = [];
    for (let i = 0; i < (pv?.length ?? 0); i++) {
      const part = r.indirect((pv as { start: number }).start + 4 * i);
      parts.push(readGeometry(r, part, name === 'MultiPolygon' ? 3 : 0, hasZ));
    }
    if (name === 'GeometryCollection') return { type: 'GeometryCollection', geometries: parts };
    return {
      type: 'MultiPolygon',
      coordinates: parts.map((p) =>
        p.type === 'Polygon' ? p.coordinates : fail(`a part of a multipolygon is a ${p.type}`),
      ),
    };
  }
  if (pv !== null) fail(`a ${name} has parts`);
  const xy = doubles(r, t, 1) ?? [];
  if (xy.length % 2 !== 0) fail(`a ${name} has an odd number of x and y values`);
  const n = xy.length / 2;
  const z = hasZ ? (doubles(r, t, 2) ?? []) : null;
  if (z !== null && z.length !== n) fail(`a ${name} has ${z.length} heights for ${n} positions`);
  const positions: Position[] = [];
  for (let i = 0; i < n; i++) {
    positions.push(
      z === null
        ? [xy[2 * i] as number, xy[2 * i + 1] as number]
        : [xy[2 * i] as number, xy[2 * i + 1] as number, z[i] as number],
    );
  }
  const ev = r.vector(t, 0);
  let parts: Position[][];
  if (ev === null) parts = [positions];
  else {
    parts = [];
    let start = 0;
    for (let i = 0; i < ev.length; i++) {
      const end = r.uint32(ev.start + 4 * i);
      if (end < start || end > n) fail(`the ends of a ${name} do not fit its ${n} positions`);
      parts.push(positions.slice(start, end));
      start = end;
    }
    if (start !== n) fail(`the ends of a ${name} do not cover its ${n} positions`);
  }
  switch (name) {
    case 'Point':
      if (n > 1) fail(`a Point has ${n} positions`);
      return { type: 'Point', coordinates: positions[0] ?? [] };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: positions };
    case 'LineString':
      return { type: 'LineString', coordinates: positions };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: parts };
    case 'Polygon':
      return { type: 'Polygon', coordinates: parts };
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function readProperties(bytes: Uint8Array, columns: FgbReadColumn[]): FgbReadValue[] {
  const out: FgbReadValue[] = columns.map(() => null);
  const seen = new Set<number>();
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.length) fail('a feature’s values are cut short');
  };
  while (at < bytes.length) {
    need(2);
    const i = d.getUint16(at, true);
    at += 2;
    const column = columns[i];
    if (column === undefined) fail(`a feature has a value for column ${i}, which the header does not list`);
    if (seen.has(i)) fail(`a feature has two values for the column ${column.name}`);
    seen.add(i);
    const fixed = (size: number, read: () => FgbReadValue): FgbReadValue => {
      need(size);
      const v = read();
      at += size;
      return v;
    };
    const whole = (v: bigint): number | bigint =>
      v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    switch (column.type) {
      case 0:
        out[i] = fixed(1, () => d.getInt8(at));
        break;
      case 1:
        out[i] = fixed(1, () => d.getUint8(at));
        break;
      case 2:
        out[i] = fixed(1, () => d.getUint8(at) !== 0);
        break;
      case 3:
        out[i] = fixed(2, () => d.getInt16(at, true));
        break;
      case 4:
        out[i] = fixed(2, () => d.getUint16(at, true));
        break;
      case 5:
        out[i] = fixed(4, () => d.getInt32(at, true));
        break;
      case 6:
        out[i] = fixed(4, () => d.getUint32(at, true));
        break;
      case 7:
        out[i] = fixed(8, () => whole(d.getBigInt64(at, true)));
        break;
      case 8:
        out[i] = fixed(8, () => whole(d.getBigUint64(at, true)));
        break;
      case 9:
        out[i] = fixed(4, () => d.getFloat32(at, true));
        break;
      case 10:
        out[i] = fixed(8, () => d.getFloat64(at, true));
        break;
      case 11:
      case 12:
      case 13:
      case 14: {
        need(4);
        const length = d.getUint32(at, true);
        at += 4;
        need(length);
        const raw = bytes.subarray(at, at + length);
        at += length;
        if (column.type === 14) out[i] = raw.slice();
        else {
          try {
            out[i] = UTF8.decode(raw);
          } catch {
            fail(`a value of the column ${column.name} is not UTF-8 text`);
          }
        }
        break;
      }
      default:
        fail(`the column ${column.name} is of unknown type ${column.type}`);
    }
  }
  return out;
}

export function readFlatGeobuf(bytes: Uint8Array): FgbDocument {
  if (bytes.length < 8 || MAGIC.some((m, i) => bytes[i] !== m || bytes[i + 4] !== m)) {
    fail('it does not start with the FlatGeobuf magic bytes');
  }
  const version: [number, number] = [bytes[3] as number, bytes[7] as number];
  if (version[0] !== 3) fail(`it is FlatGeobuf version ${version[0]}, not 3`);
  let header: FgbReadHeader;
  let at: number;
  try {
    const h = sizePrefixed(bytes, 8, 'header');
    header = readHeader(h.r, h.root);
    at = h.end;
  } catch (e) {
    if (e instanceof FlatGeobufFormatError) throw e;
    fail(`the header does not parse (${e instanceof Error ? e.message : String(e)})`);
  }
  const count = header.featuresCount;
  const index = count > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : indexSize(Number(count), header.indexNodeSize);
  at += index;
  if (at > bytes.length) fail('the spatial index is cut short');
  const features: FgbReadFeature[] = [];
  while (at < bytes.length) {
    const n = features.length + 1;
    try {
      const f = sizePrefixed(bytes, at, `feature ${n}`);
      const g = f.r.field(f.root, 0);
      const pv = f.r.vector(f.root, 1);
      features.push({
        geometry: g === null ? null : readGeometry(f.r, f.r.indirect(g), header.geometryType, header.hasZ),
        properties:
          pv === null
            ? header.columns.map(() => null)
            : readProperties(f.r.bytesAt(pv.start, pv.length), header.columns),
      });
      at = f.end;
    } catch (e) {
      if (e instanceof FlatGeobufFormatError) throw new FlatGeobufFormatError(`feature ${n}: ${e.message}`);
      fail(`feature ${n} does not parse (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { version, header, indexBytes: index, features };
}
