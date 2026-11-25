/**
 * The KML and KMZ Importer used by ingest.
 *
 * A KMZ is a ZIP archive whose KML document is its first .kml entry at the root (or else its first
 * .kml entry anywhere), conventionally doc.kml; it is read in memory. A KML file is streamed.
 * Either document is decoded as its byte-order mark or XML declaration says: UTF-8 by default,
 * UTF-16, or ISO-8859-1 and windows-1252 (read as windows-1252); other encodings are refused.
 *
 * Each Placemark, at any depth, is a row located by its index (0-based). Its fields are keys in
 * first-seen order over the file, as for GeoJSON: `folder` (the names of the Folders around it,
 * outermost first, joined by " / "), `name`, `description`, `timestamp` (TimeStamp/when), `begin`
 * and `end` (TimeSpan), and every ExtendedData Data value and SchemaData SimpleData by its name.
 * Values are text exactly as the file holds it. The first geometry is carried beside the fields:
 * Point, LineString, Polygon (outer boundary first), a LinearRing on its own as a LineString, and
 * MultiGeometry as a multi-part geometry when its members are all of one kind, otherwise as a
 * GeometryCollection. Positions are longitude,latitude[,altitude] on WGS 84, as the KML
 * specification fixes it; a coordinate that is not a number, or not finite, is null (the validity
 * check reports it) and -0 is 0. Other geometries (tracks, models) are not read.
 */
import { SaxesParser } from 'saxes';
import {
  BATCH_ROWS,
  EngineError,
  detection,
  PREVIEW_MAX_BYTES,
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
import { decodeAll, decodeStream, readZip } from '@tw/io';
import { multiGeometry } from './reader';

/** The largest KML document read, plain or inside a KMZ. */
export const KML_MAX_BYTES = 512 * 1024 ** 2;

/** Rows in a preview sample (SniffResult.sampleRows). */
const SAMPLE_ROWS = 1000;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const PARSE_FIX = 'Open the file in Google Earth or a GIS tool and save it again as KML, then import the new copy.';

function parseFailed(why: string): EngineError {
  return new EngineError('PARSE_FAILED', `The KML file does not parse: ${why}.`, PARSE_FIX);
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new EngineError('CANCELLED', 'The import was cancelled.', 'Start the import again when you are ready.');
}

function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ---------------------------------------------------------------------------------------------
// The document: a KML file, or the KML entry of a KMZ archive

/** The KML entry of a KMZ: the first .kml at the root, else the first .kml anywhere. */
export function kmlEntry(paths: string[]): string | null {
  const kml = paths.filter((p) => p.toLowerCase().endsWith('.kml'));
  return kml.find((p) => !p.includes('/')) ?? kml[0] ?? null;
}

function isZip(head: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => head[i] === b);
}

/** The KML document's bytes and its entry, reading a KMZ in memory. */
async function documentOf(src: ByteSource): Promise<{ bytes: Uint8Array | null; entry: string | null }> {
  const head = await src.slice(0, 4);
  if (!isZip(head)) {
    if (src.size > KML_MAX_BYTES) throw tooLarge();
    return { bytes: null, entry: null };
  }
  let zip;
  try {
    zip = readZip(await src.slice(0, src.size));
  } catch {
    throw parseFailed('it is not a valid ZIP archive (KMZ)');
  }
  const entry = kmlEntry(zip.paths());
  if (entry === null) throw parseFailed('the KMZ archive holds no KML document');
  if (zip.size(entry) > KML_MAX_BYTES) throw tooLarge();
  try {
    return { bytes: zip.read(entry), entry };
  } catch {
    throw parseFailed(`the KML document ${entry} in the KMZ archive is damaged`);
  }
}

function tooLarge(): EngineError {
  return new EngineError(
    'FORMAT_UNSUPPORTED',
    `The KML document is larger than the ${KML_MAX_BYTES / 1024 ** 2} MiB that is read.`,
    'Split the layer into smaller files, or export it as FlatGeobuf, then import those.',
  );
}

// ---------------------------------------------------------------------------------------------
// Encoding

export interface KmlEncoding {
  value: TextEncodingName;
  bomLength: number;
  detection: Detection<JsonValue>;
}

const LATIN = new Set(['iso-8859-1', 'iso8859-1', 'latin1', 'latin-1', 'windows-1252', 'cp1252']);

/** The encoding of a KML document from its byte-order mark, else its XML declaration. */
export function kmlEncoding(head: Uint8Array): KmlEncoding {
  const bom = (value: TextEncodingName, length: number, name: string): KmlEncoding => ({
    value,
    bomLength: length,
    detection: detection(value, 'high', 'bom', `The document starts with a ${name} byte-order mark.`),
  });
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return bom('utf-8', 3, 'UTF-8');
  if (head[0] === 0xff && head[1] === 0xfe) return bom('utf-16le', 2, 'UTF-16 LE');
  if (head[0] === 0xfe && head[1] === 0xff) return bom('utf-16be', 2, 'UTF-16 BE');
  let start = '';
  for (let i = 0; i < Math.min(head.length, 1024); i++) start += String.fromCharCode(head[i] as number);
  const declared = /^<\?xml[^>]*?[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*["']([A-Za-z0-9._-]+)["']/.exec(start)?.[1];
  if (declared === undefined) {
    return {
      value: 'utf-8',
      bomLength: 0,
      detection: detection(
        'utf-8',
        'high',
        'xml-default',
        'The XML declaration names no encoding, so the document is UTF-8.',
      ),
    };
  }
  const name = declared.toLowerCase();
  const value: TextEncodingName | null =
    name === 'utf-8' || name === 'utf8' || name === 'us-ascii' || name === 'ascii'
      ? 'utf-8'
      : LATIN.has(name)
        ? 'windows-1252'
        : null;
  if (value === null) {
    throw new EngineError(
      'FORMAT_UNSUPPORTED',
      `The KML file declares the encoding "${declared}", which is not read.`,
      'Save the file again as UTF-8 KML, then import the new copy.',
    );
  }
  return {
    value,
    bomLength: 0,
    detection: detection(value, 'high', 'xml-declaration', `The XML declaration names the encoding "${declared}".`),
  };
}

// ---------------------------------------------------------------------------------------------
// Placemarks as rows

/** "lon,lat[,alt]" tuples apart by XML white space; a coordinate that is not a number is null. */
export function kmlPositions(text: string): Position[] {
  const tuples = text.split(/[ \t\r\n]+/).filter((t) => t !== '');
  return tuples.map((t) =>
    t.split(',').map((x) => {
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(x)) return null as unknown as number;
      const n = Number(x);
      return (Number.isFinite(n) ? n + 0 : null) as number;
    }),
  );
}

type Building =
  | { kind: 'Point' | 'LineString' | 'LinearRing'; positions: Position[] }
  | { kind: 'Polygon'; rings: Position[][]; outer: boolean }
  | { kind: 'MultiGeometry'; members: Geometry[] };

const GEOMETRY = new Set(['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiGeometry']);

const KEY_NAMES: Record<string, string> = {
  '#folder': 'folder',
  '#name': 'name',
  '#description': 'description',
  '#timestamp': 'timestamp',
  '#begin': 'begin',
  '#end': 'end',
};

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

/** Reads KML text as it arrives and hands each finished placemark on as a row. */
export class KmlRows {
  private readonly index = new Map<string, number>();
  private readonly keyList: string[] = [];
  private readonly typeList: string[] = [];
  private readonly sax = new SaxesParser<{ xmlns: false; position: false }>({ xmlns: false, position: false });
  private readonly path: string[] = [];
  private readonly folders: (string | null)[] = [];
  private values: RawField[] | null = null;
  private geometry: Geometry | null = null;
  private readonly building: Building[] = [];
  private buffer: string | null = null;
  private target = '';
  private depth = 0;
  private dataName = '';
  private count = 0;

  constructor(private readonly onRow: (row: RawRow) => void) {
    this.sax.on('error', () => {
      throw parseFailed('it is not well-formed XML');
    });
    this.sax.on('doctype', () => {
      throw parseFailed('it declares a document type, which KML never needs');
    });
    this.sax.on('opentag', (tag) => this.openTag(localName(tag.name), tag.attributes as Record<string, string>));
    const text = (t: string) => {
      if (this.buffer !== null) this.buffer += t;
    };
    this.sax.on('text', text);
    this.sax.on('cdata', text);
    this.sax.on('closetag', (tag) => this.closeTag(localName(tag.name)));
  }

  /** Header texts of the keys in first-seen order. */
  get header(): string[] {
    return this.keyList.map((k) => KEY_NAMES[k] ?? k.slice('data:'.length));
  }

  get geometryTypes(): readonly string[] {
    return this.typeList;
  }

  write(text: string): void {
    this.sax.write(text);
  }

  /** Ends the document: it must be complete. */
  close(): void {
    this.sax.close();
  }

  private set(key: string, value: string): void {
    if (this.values === null) return;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.keyList.length;
      this.index.set(key, i);
      this.keyList.push(key);
    }
    this.values[i] = value;
  }

  private collect(target: string): void {
    if (this.buffer !== null) return;
    this.buffer = '';
    this.target = target;
    this.depth = this.path.length;
  }

  private openTag(name: string, attrs: Record<string, string>): void {
    if (this.path.length === 0 && name !== 'kml') throw parseFailed(`its root element is ${name}, not kml`);
    const parent = this.path[this.path.length - 1];
    this.path.push(name);
    if (name === 'Folder') {
      this.folders.push(null);
      return;
    }
    if (name === 'Placemark') {
      this.values = [];
      this.geometry = null;
      this.building.length = 0;
      const folder = this.folders.filter((f): f is string => f !== null && f !== '').join(' / ');
      if (folder !== '') this.set('#folder', folder);
      return;
    }
    if (this.values === null) {
      if (name === 'name' && parent === 'Folder') this.collect('folder-name');
      return;
    }
    if (GEOMETRY.has(name)) {
      this.building.push(
        name === 'Polygon'
          ? { kind: 'Polygon', rings: [], outer: false }
          : name === 'MultiGeometry'
            ? { kind: 'MultiGeometry', members: [] }
            : { kind: name as 'Point' | 'LineString' | 'LinearRing', positions: [] },
      );
      return;
    }
    switch (name) {
      case 'name':
      case 'description':
        if (parent === 'Placemark') this.collect(`#${name}`);
        break;
      case 'when':
        if (parent === 'TimeStamp') this.collect('#timestamp');
        break;
      case 'begin':
      case 'end':
        if (parent === 'TimeSpan') this.collect(`#${name}`);
        break;
      case 'Data':
        this.dataName = attrs['name'] ?? '';
        break;
      case 'value':
        if (parent === 'Data') this.collect(`data:${this.dataName}`);
        break;
      case 'SimpleData':
        if (parent === 'SchemaData') this.collect(`data:${attrs['name'] ?? ''}`);
        break;
      case 'coordinates':
        if (this.building.length > 0) this.collect('coordinates');
        break;
      case 'outerBoundaryIs': {
        const g = this.building[this.building.length - 1];
        if (g?.kind === 'Polygon') g.outer = true;
        break;
      }
    }
  }

  private finish(g: Geometry): void {
    const parent = this.building[this.building.length - 1];
    if (parent?.kind === 'MultiGeometry') parent.members.push(g);
    else if (this.geometry === null) {
      this.geometry = g;
      if (!this.typeList.includes(g.type)) this.typeList.push(g.type);
    }
  }

  private closeTag(name: string): void {
    if (this.buffer !== null && this.path.length === this.depth) {
      const text = this.buffer;
      this.buffer = null;
      if (this.target === 'folder-name') this.folders[this.folders.length - 1] = text;
      else if (this.target === 'coordinates') {
        const g = this.building[this.building.length - 1];
        if (g !== undefined && 'positions' in g) g.positions = kmlPositions(text);
      } else this.set(this.target, text);
    }
    this.path.pop();
    if (name === 'Folder') {
      this.folders.pop();
      return;
    }
    if (this.values === null) return;
    if (name === 'Placemark') {
      const values = this.values;
      this.values = null;
      this.onRow({
        srcLoc: this.count++,
        fields: Array.from({ length: this.keyList.length }, (_, i) => values[i] ?? null),
        geometry: this.geometry,
      });
      return;
    }
    if (!GEOMETRY.has(name)) return;
    const g = this.building.pop();
    if (g === undefined) return;
    switch (g.kind) {
      case 'Point':
        this.finish({ type: 'Point', coordinates: g.positions[0] ?? [] });
        break;
      case 'LineString':
        this.finish({ type: 'LineString', coordinates: g.positions });
        break;
      case 'LinearRing': {
        const polygon = this.building[this.building.length - 1];
        if (polygon?.kind === 'Polygon') {
          // The outer boundary comes first, however the file orders it.
          if (polygon.outer) polygon.rings.unshift(g.positions);
          else polygon.rings.push(g.positions);
          polygon.outer = false;
        } else this.finish({ type: 'LineString', coordinates: g.positions });
        break;
      }
      case 'Polygon':
        this.finish({ type: 'Polygon', coordinates: g.rings });
        break;
      case 'MultiGeometry':
        this.finish(multiGeometry(g.members));
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Sniff

function crsDetection(): Detection<CrsRef> {
  return detection<CrsRef>(
    { code: 'OGC:CRS84', source: 'kml-specification' },
    'high',
    'kml-specification',
    'KML holds longitude and latitude on WGS 84, as the KML 2.2 specification fixes it.',
  );
}

async function sniff(src: ByteSource): Promise<SniffResult> {
  const doc = await documentOf(src);
  const head = doc.bytes === null ? await src.slice(0, PREVIEW_MAX_BYTES) : doc.bytes.subarray(0, PREVIEW_MAX_BYTES);
  const complete = doc.bytes === null ? head.length >= src.size : doc.bytes.length <= PREVIEW_MAX_BYTES;
  const encoding = kmlEncoding(head);
  const sampleRows: RawRow[] = [];
  let rows = 0;
  const reader = new KmlRows((r) => {
    rows++;
    if (sampleRows.length < SAMPLE_ROWS) sampleRows.push(r);
  });
  // A cut-off head ends mid-document by design; only a whole document must be complete.
  reader.write(decodeAll(head, encoding.value, encoding.bomLength));
  if (complete) reader.close();
  const crs = crsDetection();
  const scope = complete
    ? `all ${formatCount(rows)} placemarks in the document`
    : `the ${formatCount(rows)} placemarks in the first ${formatCount(head.length)} bytes`;
  const types = reader.geometryTypes;
  const detections: Record<string, Detection<JsonValue>> = {
    encoding: encoding.detection,
    crs: { ...crs, value: { code: crs.value.code, source: crs.value.source } },
    propertyKeys: detection(
      reader.header,
      complete ? 'high' : 'medium',
      'placemark-field-union',
      `The union of placemark fields in first-seen order over ${scope}: ${reader.header.length} fields.`,
    ),
    geometryTypes: detection(
      [...types],
      complete ? 'high' : 'medium',
      'geometry-types',
      `Found ${types.length === 0 ? 'no geometry types' : `geometry types ${types.join(', ')}`} over ${scope}.`,
    ),
  };
  return {
    format: 'kml',
    options: { format: 'kml', kml: { entry: doc.entry } },
    detections,
    header: [reader.header],
    sampleRows,
    notes: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Read

async function* read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  if (opts.format !== 'kml') {
    throw new EngineError(
      'INVALID_INPUT',
      `The KML reader was given options for the "${opts.format}" format.`,
      'Correct the value passed to the function; this is a defect in the calling code, not in the data.',
    );
  }
  aborted(ctx.signal);
  const doc = await documentOf(src);
  let pending: RawRow[] = [];
  const reader = new KmlRows((r) => pending.push(r));
  const take = function* () {
    while (pending.length >= BATCH_ROWS) {
      yield { rows: pending.slice(0, BATCH_ROWS) };
      pending = pending.slice(BATCH_ROWS);
    }
  };
  if (doc.bytes !== null) {
    ctx.onBytes(src.size);
    const encoding = kmlEncoding(doc.bytes.subarray(0, 1024));
    reader.write(decodeAll(doc.bytes, encoding.value, encoding.bomLength));
    reader.close();
    yield* take();
    if (pending.length > 0) yield { rows: pending };
    return;
  }
  const encoding = kmlEncoding(await src.slice(0, 1024));
  const counted = src.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        ctx.onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
  const text = decodeStream(counted, encoding.value, encoding.bomLength).getReader();
  let done = false;
  try {
    for (;;) {
      aborted(ctx.signal);
      const next = await text.read();
      if (next.done) break;
      reader.write(next.value);
      yield* take();
    }
    done = true;
    reader.close();
    yield* take();
    if (pending.length > 0) yield { rows: pending };
  } finally {
    if (!done) await text.cancel().catch(() => undefined);
    text.releaseLock();
  }
}

export const kmlImporter: Importer = {
  formats: ['kml'],
  sniff,
  read,
};
