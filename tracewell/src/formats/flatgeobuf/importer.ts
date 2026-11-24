/**
 * The FlatGeobuf Importer used by ingest.
 *
 * sniff() reads the header (the columns, the CRS, the geometry type and the feature count) and
 * the features in the first MiB after the spatial index, which it skips, as the sample. The CRS is
 * the one the header records by EPSG code; it is recorded, never applied.
 *
 * read() streams the whole file. Each row's source locator is its feature index (0-based) and its
 * fields are the header's columns in order: numbers and booleans as they are typed, text as text,
 * JSON values as JSON text, a whole number beyond 2^53 as its exact digits and binary values as
 * hexadecimal text. The geometry is carried beside the fields, kept as the file has it, except
 * that a number that is not finite becomes null (the validity check then reports the position)
 * and -0 becomes 0, as the GeoJSON reader does. Measures and times are not read.
 */
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
  type RawBatch,
  type RawField,
  type RawRow,
  type ReadContext,
  type SniffResult,
} from '@tw/model';
import {
  FgbStreamReader,
  FlatGeobufFormatError,
  type FgbReadFeature,
  type FgbReadHeader,
  type FgbReadValue,
} from './reader';

/** Rows in a preview sample (SniffResult.sampleRows). */
const SAMPLE_ROWS = 1000;

const OPTIONS: FormatOptions = { format: 'flatgeobuf', flatgeobuf: { nested: 'json-text' } };

const GEOMETRY_NAMES = [
  'Unknown',
  'Point',
  'LineString',
  'Polygon',
  'MultiPoint',
  'MultiLineString',
  'MultiPolygon',
  'GeometryCollection',
];

function parseFailed(e: unknown): EngineError {
  if (e instanceof EngineError) return e;
  const why = e instanceof Error ? e.message : String(e);
  return new EngineError(
    'PARSE_FAILED',
    `The FlatGeobuf file does not parse: ${why}.`,
    'Export the layer again as FlatGeobuf from the GIS tool, then import the new copy.',
  );
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new EngineError('CANCELLED', 'The import was cancelled.', 'Start the import again when you are ready.');
}

function formatCount(n: number | bigint): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ---------------------------------------------------------------------------------------------
// Rows

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fieldOf(v: FgbReadValue): RawField {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return v.toString();
  return hex(v);
}

/** A number of a position as it is kept: -0 as 0, and what is not finite as null. */
function settled(x: number): number | null {
  return Number.isFinite(x) ? x + 0 : null;
}

function settle(c: unknown): unknown {
  if (typeof c === 'number') return settled(c);
  return Array.isArray(c) ? c.map(settle) : c;
}

function settleGeometry(g: Geometry): Geometry {
  if (g.type === 'GeometryCollection')
    return { type: 'GeometryCollection', geometries: g.geometries.map(settleGeometry) };
  return { type: g.type, coordinates: settle(g.coordinates) } as Geometry;
}

function rowOf(f: FgbReadFeature, index: number): RawRow {
  return {
    srcLoc: index,
    fields: f.properties.map(fieldOf),
    geometry: f.geometry === null ? null : settleGeometry(f.geometry),
  };
}

// ---------------------------------------------------------------------------------------------
// Detections

function crsDetection(h: FgbReadHeader): Detection<CrsRef> {
  const crs = h.crs;
  const found = (code: CrsRef['code'], evidence: string) =>
    detection<CrsRef>({ code, source: 'flatgeobuf-header' }, 'high', 'flatgeobuf-header', evidence);
  const unknown = (evidence: string) =>
    detection<CrsRef>({ code: 'unknown', source: 'flatgeobuf-header' }, 'low', 'flatgeobuf-header', evidence);
  if (crs === null) return unknown('The FlatGeobuf header records no coordinate reference system.');
  const org = (crs.org ?? 'EPSG').toUpperCase();
  const named = crs.name === null ? '' : ` (${crs.name})`;
  if (org === 'EPSG' && crs.code > 0) {
    return found(
      `EPSG:${crs.code}`,
      `The FlatGeobuf header records the coordinate reference system EPSG:${crs.code}${named}.`,
    );
  }
  if (org === 'OGC' && (crs.codeString ?? '').toUpperCase() === 'CRS84') {
    return found('OGC:CRS84', 'The FlatGeobuf header records the coordinate reference system OGC:CRS84.');
  }
  const what = [crs.org, crs.code > 0 ? String(crs.code) : crs.codeString].filter((x) => x !== null).join(':');
  return unknown(
    `The FlatGeobuf header records the coordinate reference system ${what === '' ? 'without a code' : what}${named}, which is not an EPSG code.`,
  );
}

function geometryTypesDetection(h: FgbReadHeader, features: FgbReadFeature[], complete: boolean): Detection<JsonValue> {
  if (h.geometryType !== 0) {
    const name = GEOMETRY_NAMES[h.geometryType] ?? `type ${h.geometryType}`;
    return detection(
      [name],
      'high',
      'flatgeobuf-header',
      `The FlatGeobuf header states that every geometry is a ${name}.`,
    );
  }
  const types: string[] = [];
  for (const f of features) {
    if (f.geometry !== null && !types.includes(f.geometry.type)) types.push(f.geometry.type);
  }
  const scope = complete
    ? `all ${formatCount(features.length)} features`
    : `the first ${formatCount(features.length)} features`;
  return detection(
    types,
    complete ? 'high' : 'medium',
    'geometry-types',
    `The header states no single geometry type; found ${types.length === 0 ? 'no geometry types' : `geometry types ${types.join(', ')}`} over ${scope}.`,
  );
}

function detectionsOf(
  h: FgbReadHeader,
  features: FgbReadFeature[],
  complete: boolean,
): Record<string, Detection<JsonValue>> {
  const crs = crsDetection(h);
  const detections: Record<string, Detection<JsonValue>> = {
    crs: { ...crs, value: { code: crs.value.code, source: crs.value.source } },
    columns: detection(
      h.columns.map((c) => c.name),
      'high',
      'flatgeobuf-header',
      `The FlatGeobuf header lists ${h.columns.length} columns.`,
    ),
    geometryTypes: geometryTypesDetection(h, features, complete),
  };
  if (h.featuresCount > 0n && h.featuresCount <= BigInt(Number.MAX_SAFE_INTEGER)) {
    detections['rowCount'] = detection(
      Number(h.featuresCount),
      'high',
      'flatgeobuf-header',
      `The FlatGeobuf header counts ${formatCount(h.featuresCount)} features.`,
    );
  }
  return detections;
}

// ---------------------------------------------------------------------------------------------
// Sniff

async function sniff(src: ByteSource): Promise<SniffResult> {
  try {
    const reader = new FgbStreamReader();
    const features: FgbReadFeature[] = [];
    let at = 0;
    const take = async (end: number) => {
      features.push(...reader.push(await src.slice(at, end)));
      at = end;
    };
    // The header first, however long it is.
    while (reader.header === null && at < src.size) await take(Math.min(src.size, at + PREVIEW_MAX_BYTES));
    if (reader.header === null) reader.finish();
    const header = reader.header as FgbReadHeader;
    // A spatial index the first MiB does not hold is not read through: the features follow it.
    const first = reader.headerEnd + reader.indexBytes;
    if (at < first) {
      reader.skipIndex();
      at = Math.min(first, src.size);
    }
    // Then the features of at most a MiB, or the first one, however long it is.
    const limit = Math.min(src.size, first + PREVIEW_MAX_BYTES);
    while (features.length < SAMPLE_ROWS && (at < limit || (features.length === 0 && at < src.size))) {
      await take(Math.min(src.size, at + PREVIEW_MAX_BYTES));
    }
    const complete = at >= src.size;
    if (complete) reader.finish();
    const sample = features.slice(0, SAMPLE_ROWS);
    return {
      format: 'flatgeobuf',
      options: OPTIONS,
      detections: detectionsOf(header, sample, complete && features.length <= SAMPLE_ROWS),
      header: [header.columns.map((c) => c.name)],
      sampleRows: sample.map(rowOf),
      notes: [],
    };
  } catch (e) {
    throw e instanceof FlatGeobufFormatError ? parseFailed(e) : e;
  }
}

// ---------------------------------------------------------------------------------------------
// Read

function countingStream(src: ByteSource, ctx: ReadContext): ReadableStream<Uint8Array> {
  return src.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        ctx.onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
}

async function* read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  if (opts.format !== 'flatgeobuf') {
    throw new EngineError(
      'INVALID_INPUT',
      `The FlatGeobuf reader was given options for the "${opts.format}" format.`,
      'Correct the value passed to the function; this is a defect in the calling code, not in the data.',
    );
  }
  aborted(ctx.signal);
  const parser = new FgbStreamReader();
  const reader = countingStream(src, ctx).getReader();
  let pending: RawRow[] = [];
  let index = 0;
  let done = false;
  try {
    for (;;) {
      aborted(ctx.signal);
      const next = await reader.read();
      if (next.done) break;
      let features: FgbReadFeature[];
      try {
        features = parser.push(next.value);
      } catch (e) {
        throw parseFailed(e);
      }
      for (const f of features) pending.push(rowOf(f, index++));
      while (pending.length >= BATCH_ROWS) {
        yield { rows: pending.slice(0, BATCH_ROWS) };
        pending = pending.slice(BATCH_ROWS);
      }
    }
    done = true;
    try {
      parser.finish();
    } catch (e) {
      throw parseFailed(e);
    }
    if (pending.length > 0) yield { rows: pending };
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const flatgeobufImporter: Importer = {
  formats: ['flatgeobuf'],
  sniff,
  read,
};
