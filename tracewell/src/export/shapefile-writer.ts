/**
 * The Shapefile writer: .shp and .shx after the ESRI Shapefile Technical Description (July 1998),
 * and .dbf as dBASE III with UTF-8 text, which the .cpg file declares. Everything a reader needs
 * is in these bytes; nothing depends on the platform. The native engine writes the same bytes.
 */
import type { CellValue } from '@tw/model';
import { SHAPE, dbfText, type DbfField, type ShapeRecord } from './shapefile';

export interface ShapefileWriteInput {
  shapeType: number;
  z: boolean;
  /** One per row, in row order: the record, or null for a null shape. */
  records: Iterable<ShapeRecord | null>;
  fields: DbfField[];
  /** One per row, in row order: the value of each field's column. */
  rows: Iterable<CellValue[]>;
  /** The export's time, which the .dbf header records as its last update. */
  at: string;
}

export interface ShapefileBytes {
  shp: Uint8Array;
  shx: Uint8Array;
  dbf: Uint8Array;
}

/** "No data" for a measure: any value below -10^38 (Technical Description, page 2). */
const NO_MEASURE = -1e39;

class Bytes {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private room(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  int32be(n: number): void {
    this.room(4);
    this.view.setInt32(this.length, n, false);
    this.length += 4;
  }

  int32le(n: number): void {
    this.room(4);
    this.view.setInt32(this.length, n, true);
    this.length += 4;
  }

  uint16le(n: number): void {
    this.room(2);
    this.view.setUint16(this.length, n, true);
    this.length += 2;
  }

  uint32le(n: number): void {
    this.room(4);
    this.view.setUint32(this.length, n, true);
    this.length += 4;
  }

  float64le(x: number): void {
    this.room(8);
    this.view.setFloat64(this.length, x, true);
    this.length += 8;
  }

  bytes(b: Uint8Array | number[]): void {
    this.room(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  setInt32be(at: number, n: number): void {
    this.view.setInt32(at, n, false);
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

type Box = [number, number, number, number];

function boxOf(points: number[][]): Box {
  let box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const [x, y] = p as [number, number];
    box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  }
  return box;
}

function zRange(points: number[][]): [number, number] {
  let range: [number, number] = [Infinity, -Infinity];
  for (const p of points) range = [Math.min(range[0], p[2] as number), Math.max(range[1], p[2] as number)];
  return range;
}

function writeContent(out: Bytes, rec: ShapeRecord | null, shapeType: number): void {
  if (rec === null) {
    out.int32le(SHAPE.null);
    return;
  }
  out.int32le(shapeType);
  const points = rec.parts.flat();
  if (shapeType === SHAPE.point || shapeType === SHAPE.pointZ) {
    const p = points[0] as number[];
    out.float64le(p[0] as number);
    out.float64le(p[1] as number);
    if (shapeType === SHAPE.pointZ) {
      out.float64le(p[2] as number);
      out.float64le(NO_MEASURE);
    }
    return;
  }
  for (const v of boxOf(points)) out.float64le(v);
  const multipoint = shapeType === SHAPE.multipoint || shapeType === SHAPE.multipointZ;
  if (!multipoint) out.int32le(rec.parts.length);
  out.int32le(points.length);
  if (!multipoint) {
    let start = 0;
    for (const part of rec.parts) {
      out.int32le(start);
      start += part.length;
    }
  }
  for (const p of points) {
    out.float64le(p[0] as number);
    out.float64le(p[1] as number);
  }
  if (shapeType === SHAPE.multipointZ || shapeType === SHAPE.polylineZ || shapeType === SHAPE.polygonZ) {
    for (const v of zRange(points)) out.float64le(v);
    for (const p of points) out.float64le(p[2] as number);
  }
}

function mainHeader(out: Bytes, words: number, shapeType: number, box: Box | null, z: [number, number] | null): void {
  out.int32be(9994);
  for (let i = 0; i < 5; i++) out.int32be(0);
  out.int32be(words);
  out.int32le(1000);
  out.int32le(shapeType);
  for (const v of box ?? [0, 0, 0, 0]) out.float64le(v);
  for (const v of z ?? [0, 0]) out.float64le(v);
  out.float64le(0);
  out.float64le(0);
}

const encoder = new TextEncoder();

function pad(text: string, width: number, right: boolean): Uint8Array {
  const bytes = encoder.encode(text);
  const out = new Uint8Array(width).fill(0x20);
  out.set(bytes.subarray(0, width), right ? width - Math.min(width, bytes.length) : 0);
  return out;
}

function writeDbf(input: ShapefileWriteInput): Uint8Array {
  const out = new Bytes();
  const rows = [...input.rows];
  const recordLength = 1 + input.fields.reduce((n, f) => n + f.width, 0);
  const at = new Date(input.at);
  out.bytes([0x03, at.getUTCFullYear() - 1900, at.getUTCMonth() + 1, at.getUTCDate()]);
  out.uint32le(rows.length);
  out.uint16le(32 + 32 * input.fields.length + 1);
  out.uint16le(recordLength);
  out.bytes(new Uint8Array(20));
  for (const f of input.fields) {
    const name = new Uint8Array(11);
    name.set(encoder.encode(f.name));
    out.bytes(name);
    out.bytes([f.type.charCodeAt(0), 0, 0, 0, 0, f.width, f.decimals]);
    out.bytes(new Uint8Array(14));
  }
  out.bytes([0x0d]);
  for (const row of rows) {
    out.bytes([0x20]);
    input.fields.forEach((f, j) => {
      const text = dbfText(row[j] ?? null, f.column);
      if (f.type === 'L') out.bytes(encoder.encode(text ?? '?'));
      else out.bytes(pad(text ?? '', f.width, f.type === 'N'));
    });
  }
  out.bytes([0x1a]);
  return out.done();
}

export function writeShapefile(input: ShapefileWriteInput): ShapefileBytes {
  const records = [...input.records];
  const all = records.flatMap((r) => (r === null ? [] : r.parts.flat()));
  const box = all.length === 0 ? null : boxOf(all);
  const z = input.z && all.length > 0 ? zRange(all) : null;
  const body = new Bytes();
  const index = new Bytes();
  records.forEach((rec, i) => {
    const content = new Bytes();
    writeContent(content, rec, input.shapeType);
    const bytes = content.done();
    index.int32be((100 + body.length) / 2);
    index.int32be(bytes.length / 2);
    body.int32be(i + 1);
    body.int32be(bytes.length / 2);
    body.bytes(bytes);
  });
  const shp = new Bytes();
  mainHeader(shp, (100 + body.length) / 2, input.shapeType, box, z);
  shp.bytes(body.done());
  const shx = new Bytes();
  mainHeader(shx, (100 + index.length) / 2, input.shapeType, box, z);
  shx.bytes(index.done());
  return { shp: shp.done(), shx: shx.done(), dbf: writeDbf(input) };
}
