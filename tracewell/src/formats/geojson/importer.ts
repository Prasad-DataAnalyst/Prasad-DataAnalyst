/**
 * The GeoJSON Importer used by ingest.
 *
 * sniff() reads at most the first MiB and reports the property keys seen there (as the single header
 * row), the geometry types, the nested properties that become JSON text, and the CRS: a legacy
 * `crs` member if there is one, else the RFC 7946 default, OGC:CRS84.
 *
 * read() streams the whole file. Each row's source locator is its feature index (0-based); its
 * fields follow the property keys in first-seen order, which extends the sniffed header when a key
 * first appears after the first MiB. A row is as long as the keys seen up to and including its own
 * feature, so a shorter row lacks only keys that appeared later.
 */
import {
  BATCH_ROWS,
  detection,
  PREVIEW_MAX_BYTES,
  type ByteSource,
  type CrsRef,
  type Detection,
  type FormatOptions,
  type Importer,
  type JsonValue,
  type RawBatch,
  type RawRow,
  type ReadContext,
  type SniffResult,
} from '@tw/model';
import { decodeAll, decodeStream, sniffEncoding } from '@tw/io';
import { crsDetectionOf, defaultCrsDetection } from './crs';
import { formatCount, invalidArgument, throwIfAborted } from './errors';
import { GeoJsonTextParser } from './parser';
import { PropertyColumns } from './rows';

/** Rows in a preview sample (SniffResult.sampleRows). */
const SAMPLE_ROWS = 1000;

const OPTIONS: FormatOptions = { format: 'geojson', geojson: { nested: 'json-text' } };

function geojsonOptions(opts: FormatOptions): void {
  if (opts.format !== 'geojson') {
    throw invalidArgument(`The GeoJSON reader was given options for the "${opts.format}" format.`, {
      format: opts.format,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Detections

function asJson(d: Detection<CrsRef>): Detection<JsonValue> {
  return { ...d, value: { code: d.value.code, source: d.value.source } };
}

interface HeadScan {
  parser: GeoJsonTextParser;
  columns: PropertyColumns;
  complete: boolean;
  bytes: number;
}

function scope(scan: HeadScan): string {
  const features = `${formatCount(scan.parser.features)} features`;
  return scan.complete
    ? `all ${features} in the file`
    : `the ${features} in the first ${formatCount(scan.bytes)} bytes`;
}

function confidenceOf(scan: HeadScan): 'high' | 'medium' {
  return scan.complete ? 'high' : 'medium';
}

function crsDetection(scan: HeadScan): Detection<CrsRef> {
  const crs = scan.parser.crs;
  if (crs.present) return crsDetectionOf(crs.value);
  const where = scan.complete ? 'The file' : `The first ${formatCount(scan.bytes)} bytes of the file`;
  const evidence = `${where} hold no "crs" member, so RFC 7946 applies: longitude and latitude on WGS84 (OGC:CRS84).`;
  // A legacy member normally precedes the features, so once they have started its absence is settled.
  if (scan.complete || scan.parser.inFeatures) return defaultCrsDetection(evidence);
  return { ...defaultCrsDetection(evidence), confidence: 'medium', assumed: true };
}

function keysDetection(scan: HeadScan): Detection<JsonValue> {
  const keys = [...scan.columns.keys];
  const evidence = `The union of property keys in first-seen order over ${scope(scan)}: ${keys.length} keys.`;
  return detection(keys, confidenceOf(scan), 'property-key-union', evidence);
}

function geometryTypesDetection(scan: HeadScan): Detection<JsonValue> {
  const types = [...scan.columns.geometryTypes];
  const missing = scan.columns.featuresWithoutGeometry;
  const listed = types.length === 0 ? 'no geometry types' : `geometry types ${types.join(', ')}`;
  const evidence = `Found ${listed} over ${scope(scan)}; ${formatCount(missing)} features have no geometry.`;
  return detection(types, confidenceOf(scan), 'geometry-types', evidence);
}

function nestedDetection(nested: string[]): Detection<JsonValue> {
  const evidence =
    `The properties ${nested.map((k) => `"${k}"`).join(', ')} hold objects or arrays; ` +
    'they are kept as JSON text in text columns.';
  return detection(nested, 'medium', 'json-text', evidence);
}

function detectionsOf(scan: HeadScan, encoding: Detection<JsonValue>): Record<string, Detection<JsonValue>> {
  const detections: Record<string, Detection<JsonValue>> = {
    encoding,
    crs: asJson(crsDetection(scan)),
    propertyKeys: keysDetection(scan),
    geometryTypes: geometryTypesDetection(scan),
  };
  const nested = scan.columns.nested;
  if (nested.length > 0) detections['nestedProperties'] = nestedDetection(nested);
  return detections;
}

// ---------------------------------------------------------------------------------------------
// Sniff

async function sniff(src: ByteSource): Promise<SniffResult> {
  const head = await src.slice(0, PREVIEW_MAX_BYTES);
  const { bomLength, ...encoding } = sniffEncoding(head);
  const columns = new PropertyColumns();
  const sampleRows: RawRow[] = [];
  const parser = new GeoJsonTextParser((f) => {
    const row = columns.toRow(f);
    if (sampleRows.length < SAMPLE_ROWS) sampleRows.push(row);
  });
  const complete = head.byteLength >= src.size;
  parser.write(decodeAll(head, encoding.value, bomLength));
  // A cut-off head ends mid-document by design; only a whole file must be a complete document.
  if (complete) parser.finish();
  const scan: HeadScan = { parser, columns, complete, bytes: head.byteLength };
  return {
    format: 'geojson',
    options: OPTIONS,
    detections: detectionsOf(scan, encoding),
    header: [[...columns.keys]],
    sampleRows,
    notes: [],
  };
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

function* batches(pending: RawRow[], all: boolean): Generator<RawBatch> {
  while (pending.length >= BATCH_ROWS || (all && pending.length > 0)) {
    yield { rows: pending.splice(0, BATCH_ROWS) };
  }
}

async function* read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  geojsonOptions(opts);
  throwIfAborted(ctx.signal);
  // The same head as sniff(), so both decide the same encoding for the same bytes.
  const encoding = sniffEncoding(await src.slice(0, PREVIEW_MAX_BYTES));
  const columns = new PropertyColumns();
  const pending: RawRow[] = [];
  const parser = new GeoJsonTextParser((f) => pending.push(columns.toRow(f)));
  const reader = decodeStream(countingStream(src, ctx), encoding.value, encoding.bomLength).getReader();
  let done = false;
  try {
    for (;;) {
      throwIfAborted(ctx.signal);
      const next = await reader.read();
      if (next.done) break;
      parser.write(next.value);
      yield* batches(pending, false);
    }
    done = true;
    parser.finish();
    yield* batches(pending, true);
  } finally {
    // Stops the file read when the consumer quits early, a parse fails or the import is cancelled.
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const geojsonImporter: Importer = {
  formats: ['geojson'],
  sniff,
  read,
};
