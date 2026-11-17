/**
 * A Shapefile reader for the export read-back (SAD section 10.3): it parses .shp, .shx and .dbf
 * from their bytes, on a code path apart from the writer, and reports what it finds. Text fields
 * are trimmed of spaces at both ends, as the common readers (GDAL's shapelib) trim them.
 */
import type { ShapeRecord } from './shapefile';

export interface ShpRecord {
  number: number;
  /** The record's offset in 16-bit words and its content length in words. */
  offset: number;
  words: number;
  shapeType: number;
  record: ShapeRecord | null;
  /** The bounding box the record states, for types that carry one. */
  box: [number, number, number, number] | null;
  zRange: [number, number] | null;
}

export interface ShpFile {
  fileCode: number;
  words: number;
  version: number;
  shapeType: number;
  box: [number, number, number, number];
  zRange: [number, number];
  records: ShpRecord[];
}

export class ShapefileFormatError extends Error {}

function fail(message: string): never {
  throw new ShapefileFormatError(message);
}

function header(view: DataView): Omit<ShpFile, 'records'> {
  if (view.byteLength < 100) fail('it is shorter than its 100-byte header');
  return {
    fileCode: view.getInt32(0, false),
    words: view.getInt32(24, false),
    version: view.getInt32(28, true),
    shapeType: view.getInt32(32, true),
    box: [view.getFloat64(36, true), view.getFloat64(44, true), view.getFloat64(52, true), view.getFloat64(60, true)],
    zRange: [view.getFloat64(68, true), view.getFloat64(76, true)],
  };
}

function content(view: DataView, at: number, words: number): Omit<ShpRecord, 'number' | 'offset' | 'words'> {
  const end = at + words * 2;
  if (end > view.byteLength || words < 2) fail(`a record at byte ${at - 8} runs past the end of the file`);
  const type = view.getInt32(at, true);
  if (type === 0) return { shapeType: 0, record: null, box: null, zRange: null };
  const f64 = (o: number) => {
    if (o + 8 > end) fail(`a record at byte ${at - 8} is shorter than its shape needs`);
    return view.getFloat64(o, true);
  };
  const i32 = (o: number) => {
    if (o + 4 > end) fail(`a record at byte ${at - 8} is shorter than its shape needs`);
    return view.getInt32(o, true);
  };
  if (type === 1 || type === 11) {
    const p = type === 11 ? [f64(at + 4), f64(at + 12), f64(at + 20)] : [f64(at + 4), f64(at + 12)];
    return { shapeType: type, record: { parts: [[p]] }, box: null, zRange: null };
  }
  if (![3, 5, 8, 13, 15, 18].includes(type)) fail(`a record has shape type ${type}, which this reader does not know`);
  const box: [number, number, number, number] = [f64(at + 4), f64(at + 12), f64(at + 20), f64(at + 28)];
  const multipoint = type === 8 || type === 18;
  const hasZ = type === 13 || type === 15 || type === 18;
  const numParts = multipoint ? 1 : i32(at + 36);
  const numPoints = i32(multipoint ? at + 36 : at + 40);
  if (numParts < 0 || numPoints < 0) fail('a record has a negative count');
  const partsAt = multipoint ? at + 40 : at + 44;
  const starts = multipoint ? [0] : Array.from({ length: numParts }, (_, i) => i32(partsAt + 4 * i));
  const pointsAt = partsAt + (multipoint ? 0 : 4 * numParts);
  const xy = Array.from({ length: numPoints }, (_, i) => [f64(pointsAt + 16 * i), f64(pointsAt + 16 * i + 8)]);
  let zRange: [number, number] | null = null;
  if (hasZ) {
    const zAt = pointsAt + 16 * numPoints;
    zRange = [f64(zAt), f64(zAt + 8)];
    xy.forEach((p, i) => p.push(f64(zAt + 16 + 8 * i)));
  }
  const parts = starts.map((s, i) => {
    const e = i + 1 < starts.length ? (starts[i + 1] as number) : numPoints;
    if (s < 0 || e < s || e > numPoints) fail('a record has parts that do not divide its points');
    return xy.slice(s, e);
  });
  return { shapeType: type, record: { parts }, box, zRange };
}

export function readShp(bytes: Uint8Array): ShpFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = header(view);
  const records: ShpRecord[] = [];
  let at = 100;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) fail(`a record header at byte ${at} is cut off`);
    const number = view.getInt32(at, false);
    const words = view.getInt32(at + 4, false);
    records.push({ number, offset: at / 2, words, ...content(view, at + 8, words) });
    at += 8 + words * 2;
  }
  return { ...head, records };
}

export interface ShxFile {
  fileCode: number;
  words: number;
  shapeType: number;
  entries: { offset: number; words: number }[];
}

export function readShx(bytes: Uint8Array): ShxFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = header(view);
  if ((bytes.length - 100) % 8 !== 0) fail('its index is not a whole number of 8-byte entries');
  const entries = Array.from({ length: (bytes.length - 100) / 8 }, (_, i) => ({
    offset: view.getInt32(100 + 8 * i, false),
    words: view.getInt32(104 + 8 * i, false),
  }));
  return { fileCode: head.fileCode, words: head.words, shapeType: head.shapeType, entries };
}

export interface DbfFile {
  version: number;
  records: number;
  fields: { name: string; type: string; width: number; decimals: number }[];
  /** Each record's field texts, trimmed; null for a field of nothing but spaces. */
  rows: (string | null)[][];
  deleted: number;
  endMarker: boolean;
}

export function readDbf(bytes: Uint8Array): DbfFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33) fail('it is shorter than a dBASE header');
  const records = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const ascii = new TextDecoder('latin1');
  const fields: DbfFile['fields'] = [];
  for (let at = 32; at < headerLength - 1; at += 32) {
    if (bytes[at] === 0x0d) break;
    const raw = bytes.subarray(at, at + 11);
    const end = raw.indexOf(0);
    fields.push({
      name: ascii.decode(raw.subarray(0, end < 0 ? 11 : end)),
      type: String.fromCharCode(bytes[at + 11] as number),
      width: bytes[at + 16] as number,
      decimals: bytes[at + 17] as number,
    });
  }
  if (bytes[headerLength - 1] !== 0x0d) fail('its field list does not end with the 0x0D terminator');
  const width = 1 + fields.reduce((n, f) => n + f.width, 0);
  if (width !== recordLength) fail(`its fields add up to ${width} bytes per record, not the ${recordLength} it states`);
  if (headerLength + records * recordLength > bytes.length) fail('it holds fewer records than its header states');
  const rows: DbfFile['rows'] = [];
  let deleted = 0;
  for (let r = 0; r < records; r++) {
    let at = headerLength + r * recordLength;
    if (bytes[at] === 0x2a) deleted++;
    at++;
    const row: (string | null)[] = [];
    for (const f of fields) {
      const text = decoder.decode(bytes.subarray(at, at + f.width)).replace(/^ +| +$/g, '');
      row.push(text === '' ? null : text);
      at += f.width;
    }
    rows.push(row);
  }
  return {
    version: bytes[0] as number,
    records,
    fields,
    rows,
    deleted,
    endMarker: bytes[headerLength + records * recordLength] === 0x1a,
  };
}
