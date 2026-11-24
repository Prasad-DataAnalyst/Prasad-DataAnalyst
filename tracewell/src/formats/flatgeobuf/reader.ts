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

/** A failure inside a FlatBuffer: a reason the format gives, or an offset or text that is broken. */
function inside(what: string, e: unknown): never {
  if (e instanceof FlatGeobufFormatError) throw new FlatGeobufFormatError(`${what}: ${e.message}`);
  fail(`${what} does not parse (${e instanceof Error ? e.message : String(e)})`);
}

/** The header of a FlatGeobuf file from the bytes of its FlatBuffer (after the size prefix). */
export function parseHeader(buffer: Uint8Array): FgbReadHeader {
  try {
    const r = new FlatReader(buffer);
    return readHeader(r, r.uint32(0));
  } catch (e) {
    if (e instanceof FlatGeobufFormatError) throw e;
    fail(`the header does not parse (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Feature `n` (1-based) from the bytes of its FlatBuffer (after the size prefix). */
export function parseFeature(buffer: Uint8Array, header: FgbReadHeader, n: number): FgbReadFeature {
  try {
    const r = new FlatReader(buffer);
    const root = r.uint32(0);
    const g = r.field(root, 0);
    const pv = r.vector(root, 1);
    return {
      geometry: g === null ? null : readGeometry(r, r.indirect(g), header.geometryType, header.hasZ),
      properties:
        pv === null ? header.columns.map(() => null) : readProperties(r.bytesAt(pv.start, pv.length), header.columns),
    };
  } catch (e) {
    return inside(`feature ${n}`, e);
  }
}

/**
 * Reads a FlatGeobuf file from its bytes as they arrive, in chunks of any size: the magic bytes,
 * the header, the spatial index (skipped) and then each feature as soon as all of it is there.
 */
export class FgbStreamReader {
  private buf = new Uint8Array(1 << 16);
  private start = 0;
  private end = 0;
  private skip = 0;
  private stage: 'magic' | 'header' | 'index' | 'features' = 'magic';
  version: [number, number] = [0, 0];
  header: FgbReadHeader | null = null;
  indexBytes = 0;
  /** Where the header ends in the file, once it has been read: the index or the features follow. */
  headerEnd = 0;
  /** Features read so far. */
  count = 0;

  /**
   * Goes straight to the features, for a caller that reads the bytes after the spatial index
   * itself rather than passing the index through.
   */
  skipIndex(): void {
    if (this.stage !== 'index') return;
    this.start = 0;
    this.end = 0;
    this.skip = 0;
    this.stage = 'features';
  }

  /** Adds bytes; returns the features they complete. */
  push(chunk: Uint8Array): FgbReadFeature[] {
    this.append(chunk);
    const out: FgbReadFeature[] = [];
    for (;;) {
      const available = this.end - this.start;
      if (this.stage === 'magic') {
        if (available < 8) return out;
        const b = this.buf.subarray(this.start, this.start + 8);
        if (MAGIC.some((m, i) => b[i] !== m || b[i + 4] !== m))
          fail('it does not start with the FlatGeobuf magic bytes');
        this.version = [b[3] as number, b[7] as number];
        if (this.version[0] !== 3) fail(`it is FlatGeobuf version ${this.version[0]}, not 3`);
        this.start += 8;
        this.stage = 'header';
      } else if (this.stage === 'index') {
        const n = Math.min(this.skip, available);
        this.start += n;
        this.skip -= n;
        if (this.skip > 0) return out;
        this.stage = 'features';
      } else {
        const buffer = this.next();
        if (buffer === null) return out;
        if (this.stage === 'header') {
          const header = parseHeader(buffer);
          this.header = header;
          this.headerEnd = 12 + buffer.length;
          const count = header.featuresCount;
          this.indexBytes =
            count > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : indexSize(Number(count), header.indexNodeSize);
          this.skip = this.indexBytes;
          this.stage = 'index';
        } else {
          this.count++;
          out.push(parseFeature(buffer, this.header as FgbReadHeader, this.count));
        }
      }
    }
  }

  /** Checks that the file ended where a feature ends. */
  finish(): void {
    const left = this.end - this.start;
    if (this.stage === 'magic') fail('it does not start with the FlatGeobuf magic bytes');
    if (this.stage === 'header') fail('the header is cut short');
    if (this.stage === 'index') fail('the spatial index is cut short');
    if (left > 0) fail(`feature ${this.count + 1} is cut short`);
  }

  /** The next whole size-prefixed buffer, or null until all of it has arrived. */
  private next(): Uint8Array | null {
    const available = this.end - this.start;
    if (available < 4) return null;
    const size = new DataView(this.buf.buffer, this.buf.byteOffset + this.start, 4).getUint32(0, true);
    const what = this.stage === 'header' ? 'the header' : `feature ${this.count + 1}`;
    if (size < 4) fail(`${what} is cut short`);
    if (available < 4 + size) return null;
    const out = this.buf.slice(this.start + 4, this.start + 4 + size);
    this.start += 4 + size;
    return out;
  }

  private append(chunk: Uint8Array): void {
    if (this.end + chunk.length > this.buf.length) {
      const kept = this.end - this.start;
      const size = Math.max(this.buf.length, (kept + chunk.length) * 2);
      const next = size > this.buf.length ? new Uint8Array(size) : this.buf;
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = next;
      this.start = 0;
      this.end = kept;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }
}

/** A whole FlatGeobuf file. */
export function readFlatGeobuf(bytes: Uint8Array): FgbDocument {
  const reader = new FgbStreamReader();
  const features = reader.push(bytes);
  reader.finish();
  return { version: reader.version, header: reader.header as FgbReadHeader, indexBytes: reader.indexBytes, features };
}
