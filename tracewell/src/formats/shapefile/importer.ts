/**
 * The Shapefile Importer used by ingest: a ZIP archive holding a Shapefile, read in memory.
 *
 * The .shp is the archive's first .shp at the root, else its first .shp anywhere; its .dbf, .prj
 * and .cpg are the entries of the same name with those extensions, in any case. Each record is a
 * row located by its index (0-based): the .dbf fields in order, then the shape beside them as
 * GeoJSON. There are as many rows as the longer of the two files has records.
 *
 * Shapes: points, multipoints, polylines (one part a LineString, more a MultiLineString) and
 * polygons, whose rings are grouped as the format orders them: a clockwise ring starts a polygon
 * and the anticlockwise rings after it are its holes; one polygon is a Polygon, more a
 * MultiPolygon. The Z variants keep their heights; measures are not read; a multipatch has no
 * shape here. A number that is not finite is null (the validity check reports it) and -0 is 0.
 *
 * Fields: character fields as text without their padding, numbers as their text, logical fields
 * as booleans, dates as dates. The text is decoded as the .cpg says, else as the .dbf's language
 * driver says (windows-1252), else as UTF-8 when every text field is valid UTF-8, else as
 * windows-1252. The CRS is the .prj's: the registry CRS whose ESRI WKT it is, else the EPSG code
 * it names, else the registry CRS of its name; recorded, never applied.
 */
import {
  BATCH_ROWS,
  EngineError,
  detection,
  type ByteSource,
  type CrsRef,
  type Detection,
  type FormatOptions,
  type Geometry,
  type Importer,
  type JsonValue,
  type Position,
  type RawBatch,
  type RawField,
  type RawRow,
  type ReadContext,
  type SniffResult,
  type TextEncodingName,
} from '@tw/model';
import { decodeAll, readZip } from '@tw/io';
import { esriWkt, supportedCrs } from '@tw/geo';

/** The largest .shp and .dbf read together. */
export const SHAPEFILE_IMPORT_MAX_BYTES = 1024 ** 3;

/** Rows in a preview sample (SniffResult.sampleRows). */
const SAMPLE_ROWS = 1000;

const PARSE_FIX =
  'Export the layer again as a Shapefile from the GIS tool, zip its files together, then import the archive.';

function parseFailed(why: string): EngineError {
  return new EngineError('PARSE_FAILED', `The Shapefile does not parse: ${why}.`, PARSE_FIX);
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new EngineError('CANCELLED', 'The import was cancelled.', 'Start the import again when you are ready.');
}

function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ---------------------------------------------------------------------------------------------
// The archive

/** The .shp of an archive: the first at the root, else the first anywhere. */
export function shpEntry(paths: string[]): string | null {
  const shp = paths.filter((p) => p.toLowerCase().endsWith('.shp'));
  return shp.find((p) => !p.includes('/')) ?? shp[0] ?? null;
}

interface Parts {
  entry: string;
  shp: Uint8Array;
  dbf: Uint8Array | null;
  prj: Uint8Array | null;
  cpg: Uint8Array | null;
}

const SHP_FILE_CODE = [0x00, 0x00, 0x27, 0x0a];

async function partsOf(src: ByteSource): Promise<Parts> {
  const head = await src.slice(0, 4);
  if (SHP_FILE_CODE.every((b, i) => head[i] === b)) {
    throw new EngineError(
      'FORMAT_UNSUPPORTED',
      'A Shapefile is several files (.shp, .dbf, .prj and others), and this is its .shp alone.',
      'Put the Shapefile’s files in one ZIP archive and import the archive.',
    );
  }
  let zip;
  try {
    zip = readZip(await src.slice(0, src.size));
  } catch {
    throw parseFailed('it is not a valid ZIP archive');
  }
  const paths = zip.paths();
  const entry = shpEntry(paths);
  if (entry === null) throw parseFailed('the ZIP archive holds no .shp file');
  const base = entry.slice(0, -4).toLowerCase();
  const sibling = (ext: string) => paths.find((p) => p.toLowerCase() === `${base}.${ext}`) ?? null;
  const dbf = sibling('dbf');
  const total = zip.size(entry) + (dbf === null ? 0 : zip.size(dbf));
  if (total > SHAPEFILE_IMPORT_MAX_BYTES) {
    throw new EngineError(
      'FORMAT_UNSUPPORTED',
      `The Shapefile's .shp and .dbf are larger than the ${SHAPEFILE_IMPORT_MAX_BYTES / 1024 ** 3} GiB that is read.`,
      'Export the layer as FlatGeobuf, or split it into smaller Shapefiles, then import those.',
    );
  }
  const read = (path: string | null) => {
    if (path === null) return null;
    try {
      return zip.read(path);
    } catch {
      throw parseFailed(`${path} in the ZIP archive is damaged`);
    }
  };
  return {
    entry,
    shp: read(entry) as Uint8Array,
    dbf: read(dbf),
    prj: read(sibling('prj')),
    cpg: read(sibling('cpg')),
  };
}

// ---------------------------------------------------------------------------------------------
// Shapes (.shp)

function settled(x: number): number | null {
  return Number.isFinite(x) ? x + 0 : null;
}

/** Twice the signed area of a ring: negative for clockwise, as x grows east and y north. */
function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i] as number[];
    const b = ring[i + 1] as number[];
    sum += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return sum;
}

const Z_TYPES = new Set([11, 13, 15, 18]);

/** The shape of one record's content, or null; `n` names the record (1-based) in messages. */
function shapeOf(content: Uint8Array, n: number): Geometry | null {
  const v = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const need = (end: number) => {
    if (end > content.length) throw parseFailed(`record ${n} of the .shp file is damaged`);
  };
  if (content.length < 4) return null;
  const type = v.getInt32(0, true);
  const z = Z_TYPES.has(type);
  const at = (i: number, zAt: number | null): Position => {
    const p = [settled(v.getFloat64(i, true)), settled(v.getFloat64(i + 8, true))];
    if (zAt !== null) p.push(settled(v.getFloat64(zAt, true)));
    return p as Position;
  };
  switch (type) {
    case 0:
    case 31:
      return null;
    case 1:
    case 11:
    case 21:
      need(type === 11 ? 28 : 20);
      return { type: 'Point', coordinates: at(4, type === 11 ? 20 : null) };
    case 8:
    case 18:
    case 28: {
      need(40);
      const count = v.getInt32(36, true);
      if (count < 0) throw parseFailed(`record ${n} of the .shp file is damaged`);
      const zStart = 40 + 16 * count + 16;
      need(40 + 16 * count + (z ? 16 + 8 * count : 0));
      return {
        type: 'MultiPoint',
        coordinates: Array.from({ length: count }, (_, i) => at(40 + 16 * i, z ? zStart + 8 * i : null)),
      };
    }
    case 3:
    case 13:
    case 23:
    case 5:
    case 15:
    case 25: {
      need(44);
      const parts = v.getInt32(36, true);
      const count = v.getInt32(40, true);
      if (parts < 0 || count < 0) throw parseFailed(`record ${n} of the .shp file is damaged`);
      const pointsAt = 44 + 4 * parts;
      const zStart = pointsAt + 16 * count + 16;
      need(pointsAt + 16 * count + (z ? 16 + 8 * count : 0));
      const starts = Array.from({ length: parts }, (_, i) => v.getInt32(44 + 4 * i, true));
      const rings = starts.map((s, i) => {
        const end = i + 1 < parts ? (starts[i + 1] as number) : count;
        if (s < 0 || end < s || end > count) throw parseFailed(`record ${n} of the .shp file is damaged`);
        return Array.from({ length: end - s }, (_, k) => at(pointsAt + 16 * (s + k), z ? zStart + 8 * (s + k) : null));
      });
      if (type === 3 || type === 13 || type === 23) {
        return rings.length === 1
          ? { type: 'LineString', coordinates: rings[0] as Position[] }
          : { type: 'MultiLineString', coordinates: rings };
      }
      const polygons: Position[][][] = [];
      for (const ring of rings) {
        const current = polygons[polygons.length - 1];
        // A clockwise ring starts a polygon; any other ring is a hole of the polygon before it.
        if (ringArea(ring) < 0 || current === undefined) polygons.push([ring]);
        else current.push(ring);
      }
      return polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] as Position[][] }
        : { type: 'MultiPolygon', coordinates: polygons };
    }
    default:
      throw parseFailed(`record ${n} of the .shp file has the unknown shape type ${type}`);
  }
}

/** Every record's shape, in order. */
export function readShapes(shp: Uint8Array): (Geometry | null)[] {
  const v = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  if (shp.length < 100 || v.getInt32(0, false) !== 9994) {
    throw parseFailed('the .shp file does not start with the Shapefile file code');
  }
  const out: (Geometry | null)[] = [];
  let at = 100;
  while (at + 8 <= shp.length) {
    const n = out.length + 1;
    const words = v.getInt32(at + 4, false);
    const end = at + 8 + 2 * words;
    if (words < 0 || end > shp.length) throw parseFailed(`record ${n} of the .shp file is cut short`);
    out.push(shapeOf(shp.subarray(at + 8, end), n));
    at = end;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Attributes (.dbf)

interface DbfField {
  name: string;
  type: string;
  offset: number;
  length: number;
}

interface Dbf {
  fields: DbfField[];
  records: Uint8Array[];
}

/** The .dbf's field descriptors and records, as bytes. */
function readDbf(dbf: Uint8Array): Dbf {
  const v = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
  if (dbf.length < 32) throw parseFailed('the .dbf file is cut short');
  const count = v.getUint32(4, true);
  const headerLength = v.getUint16(8, true);
  const recordLength = v.getUint16(10, true);
  const fields: DbfField[] = [];
  let offset = 1;
  for (let at = 32; at + 32 <= headerLength && at < dbf.length && dbf[at] !== 0x0d; at += 32) {
    const raw = dbf.subarray(at, at + 11);
    const end = raw.indexOf(0);
    const length = dbf[at + 16] as number;
    fields.push({
      name: String.fromCharCode(...raw.subarray(0, end < 0 ? 11 : end)),
      type: String.fromCharCode(dbf[at + 11] as number),
      offset,
      length,
    });
    offset += length;
  }
  if (headerLength + count * recordLength > dbf.length || recordLength < offset) {
    throw parseFailed('the .dbf file is cut short');
  }
  const records = Array.from({ length: count }, (_, i) =>
    dbf.subarray(headerLength + i * recordLength, headerLength + (i + 1) * recordLength),
  );
  return { fields, records };
}

/** Whether bytes are valid UTF-8. */
function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const CPG_UTF8 = new Set(['utf-8', 'utf8', '65001']);
const CPG_LATIN = new Set([
  '1252',
  'windows-1252',
  'cp1252',
  'ansi 1252',
  'iso-8859-1',
  'iso8859-1',
  '88591',
  '8859_1',
  'iso88591',
  'latin1',
]);

/** The encoding of the .dbf text and how it was found. */
function dbfEncoding(dbf: Uint8Array, d: Dbf, cpg: Uint8Array | null): Detection<JsonValue> {
  if (cpg !== null) {
    const name = String.fromCharCode(...cpg).trim();
    const lower = name.toLowerCase();
    const value: TextEncodingName | null = CPG_UTF8.has(lower) ? 'utf-8' : CPG_LATIN.has(lower) ? 'windows-1252' : null;
    if (value === null) {
      throw new EngineError(
        'FORMAT_UNSUPPORTED',
        `The Shapefile's .cpg names the encoding "${name}", which is not read.`,
        'Export the layer again with its attributes in UTF-8, then import it.',
      );
    }
    return detection(value, 'high', 'cpg', `The .cpg file names the encoding "${name}".`);
  }
  const driver = dbf[29] ?? 0;
  if (driver === 0x03 || driver === 0x57) {
    return detection(
      'windows-1252',
      'high',
      'dbf-language-driver',
      `The .dbf language driver ${driver} is the Windows ANSI code page (windows-1252).`,
    );
  }
  const text = d.records.every((r) =>
    d.fields.every((f) => f.type !== 'C' || isUtf8(r.subarray(f.offset, f.offset + f.length))),
  );
  return text
    ? detection('utf-8', 'medium', 'utf8-valid', 'There is no .cpg file and every text field is valid UTF-8.')
    : detection(
        'windows-1252',
        'low',
        'fallback',
        'There is no .cpg file and some text is not UTF-8, so it is read as windows-1252.',
      );
}

/** Spaces and NULs at the end of a field, which pad it. */
function trimEnd(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end--;
  return bytes.subarray(0, end);
}

function trimBoth(bytes: Uint8Array): Uint8Array {
  let start = 0;
  const t = trimEnd(bytes);
  while (start < t.length && t[start] === 0x20) start++;
  return t.subarray(start);
}

/** A field's value: text without padding, numbers as text, logical as boolean, dates as dates. */
function valueOf(bytes: Uint8Array, f: DbfField, encoding: TextEncodingName): RawField {
  switch (f.type) {
    case 'L': {
      const c = String.fromCharCode(trimBoth(bytes)[0] ?? 0x3f);
      return 'TtYy'.includes(c) ? true : 'FfNn'.includes(c) ? false : null;
    }
    case 'D': {
      const t = String.fromCharCode(...trimBoth(bytes));
      if (t === '') return null;
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
      return m === null ? t : { date: `${m[1]}-${m[2]}-${m[3]}` };
    }
    case 'N':
    case 'F': {
      const t = String.fromCharCode(...trimBoth(bytes));
      return t === '' || /^[*?]+$/.test(t) ? null : t;
    }
    default: {
      const t = trimEnd(bytes);
      return t.length === 0 ? null : decodeAll(t, encoding, 0);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The CRS (.prj)

function crsDetection(prj: Uint8Array | null): Detection<CrsRef> {
  const unknown = (evidence: string) =>
    detection<CrsRef>({ code: 'unknown', source: 'shapefile-prj' }, 'low', 'shapefile-prj', evidence);
  if (prj === null) {
    return unknown(
      'The archive holds no .prj file beside the .shp file, so the coordinate reference system is not known.',
    );
  }
  const text = String.fromCharCode(...prj).trim();
  const known = supportedCrs();
  for (const c of known) {
    if (esriWkt(c.code) === text) {
      return detection<CrsRef>(
        { code: c.code as CrsRef['code'], source: 'shapefile-prj' },
        'high',
        'shapefile-prj',
        `The .prj file is the ESRI WKT of ${c.code} (${c.name}).`,
      );
    }
  }
  const authority = /AUTHORITY\["EPSG",[ ]*"?(\d{1,9})"?\]\][ \t\r\n]*$/.exec(text)?.[1];
  if (authority !== undefined) {
    const code = `EPSG:${Number(authority)}` as CrsRef['code'];
    return detection<CrsRef>(
      { code, source: 'shapefile-prj' },
      'high',
      'shapefile-prj',
      `The .prj file names ${code}.`,
    );
  }
  const name = /^(?:PROJCS|GEOGCS)\["([^"]*)"/.exec(text)?.[1];
  if (name === undefined)
    return unknown('The .prj file does not describe a coordinate reference system that can be read.');
  for (const c of known) {
    if (/^(?:PROJCS|GEOGCS)\["([^"]*)"/.exec(esriWkt(c.code) ?? '')?.[1] === name) {
      return detection<CrsRef>(
        { code: c.code as CrsRef['code'], source: 'shapefile-prj' },
        'medium',
        'shapefile-prj-name',
        `The .prj file names "${name}", the ESRI name of ${c.code} (${c.name}); its parameters differ from the registry's.`,
      );
    }
  }
  return unknown(`The .prj file describes "${name}", which is not a coordinate reference system in the registry.`);
}

// ---------------------------------------------------------------------------------------------
// The importer

interface Read {
  entry: string;
  header: string[];
  rows: RawRow[];
  detections: Record<string, Detection<JsonValue>>;
}

const OPTIONS = (entry: string): FormatOptions => ({ format: 'shapefile', shapefile: { entry } });

function readAll(parts: Parts): Read {
  const shapes = readShapes(parts.shp);
  const dbf = parts.dbf === null ? null : readDbf(parts.dbf);
  const encoding = dbf === null || parts.dbf === null ? null : dbfEncoding(parts.dbf, dbf, parts.cpg);
  const fields = dbf?.fields ?? [];
  const decodeName = (f: DbfField) =>
    encoding === null
      ? f.name
      : decodeAll(
          Uint8Array.from(f.name, (c) => c.charCodeAt(0)),
          encoding.value as TextEncodingName,
          0,
        );
  const rows: RawRow[] = [];
  const count = Math.max(shapes.length, dbf?.records.length ?? 0);
  for (let i = 0; i < count; i++) {
    const record = dbf?.records[i];
    rows.push({
      srcLoc: i,
      fields: fields.map((f) =>
        record === undefined
          ? null
          : valueOf(record.subarray(f.offset, f.offset + f.length), f, encoding?.value as TextEncodingName),
      ),
      geometry: shapes[i] ?? null,
    });
  }
  const types: string[] = [];
  for (const r of rows) if (r.geometry != null && !types.includes(r.geometry.type)) types.push(r.geometry.type);
  const crs = crsDetection(parts.prj);
  const detections: Record<string, Detection<JsonValue>> = {
    ...(encoding === null ? {} : { encoding }),
    crs: { ...crs, value: { code: crs.value.code, source: crs.value.source } },
    geometryTypes: detection(
      types,
      'high',
      'geometry-types',
      `Found ${types.length === 0 ? 'no geometry types' : `geometry types ${types.join(', ')}`} over all ${formatCount(shapes.length)} shapes.`,
    ),
    rowCount: detection(
      count,
      'high',
      'shapefile-records',
      `The .shp and .dbf files hold ${formatCount(count)} records.`,
    ),
  };
  return { entry: parts.entry, header: fields.map(decodeName), rows, detections };
}

async function sniff(src: ByteSource): Promise<SniffResult> {
  const r = readAll(await partsOf(src));
  return {
    format: 'shapefile',
    options: OPTIONS(r.entry),
    detections: r.detections,
    header: [r.header],
    sampleRows: r.rows.slice(0, SAMPLE_ROWS),
    notes: [],
  };
}

async function* read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  if (opts.format !== 'shapefile') {
    throw new EngineError(
      'INVALID_INPUT',
      `The Shapefile reader was given options for the "${opts.format}" format.`,
      'Correct the value passed to the function; this is a defect in the calling code, not in the data.',
    );
  }
  aborted(ctx.signal);
  const r = readAll(await partsOf(src));
  ctx.onBytes(src.size);
  for (let i = 0; i < r.rows.length; i += BATCH_ROWS) {
    aborted(ctx.signal);
    yield { rows: r.rows.slice(i, i + BATCH_ROWS) };
  }
}

export const shapefileImporter: Importer = {
  formats: ['shapefile'],
  sniff,
  read,
};
