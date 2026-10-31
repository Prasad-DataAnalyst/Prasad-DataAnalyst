/**
 * The Parquet Importer used by ingest. The footer gives the columns (the top-level fields, in file
 * order) and the row count; rows are read one row group at a time through ranged reads, so memory
 * is bounded by the largest row group, never by the file.
 *
 * Values keep their stored types: numbers, booleans and text as they are, dates as date cells.
 * A timestamp marked as adjusted to UTC is an instant, so it is passed on as ISO text ending in 'Z'
 * and detection sees its zone; one that is not (a local time) is a date-time cell without a zone,
 * whose time zone is then assumed, as for spreadsheets. What no cell holds exactly stays visible as
 * text rather than rounded: an INT64 beyond 2^53, a timestamp finer than a millisecond, a NaN.
 * Nested fields (lists, maps, structs) become JSON text and binary values hexadecimal text,
 * prefixed '0x'.
 */
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import type { AsyncBuffer, FileMetaData } from 'hyparquet';
import {
  BATCH_ROWS,
  EngineError,
  detection,
  type ByteSource,
  type FormatOptions,
  type Importer,
  type RawBatch,
  type RawField,
  type RawRow,
  type ReadContext,
  type SniffResult,
} from '@tw/model';

/** Rows in a preview sample (SniffResult.sampleRows). */
const SAMPLE_ROWS = 1000;

const OPTIONS: FormatOptions = { format: 'parquet', parquet: { nested: 'json-text' } };

const DAY_MS = 86_400_000;

function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function cancelled(): EngineError {
  return new EngineError('CANCELLED', 'The operation was cancelled.', 'Start the operation again when you are ready.');
}

function notParquet(reason: string): EngineError {
  return new EngineError(
    'PARSE_FAILED',
    `The file could not be read as Parquet: ${reason}`,
    'Check that the file is a complete Parquet file (it ends with the PAR1 marker), or write it again from the system that produced it.',
    { reason },
  );
}

function asyncBuffer(src: ByteSource, onBytes?: (n: number) => void): AsyncBuffer {
  return {
    byteLength: src.size,
    slice: async (start: number, end?: number): Promise<ArrayBuffer> => {
      const bytes = await src.slice(start, end ?? src.size);
      onBytes?.(bytes.byteLength);
      return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Values

/** The largest distance from the epoch a JavaScript Date holds, in milliseconds. */
const MAX_DATE_MS = 8.64e15;

/**
 * A timestamp stored as `value` units, `perMs` to the millisecond: a date-time cell when it is a
 * whole millisecond, else ISO text keeping every stored digit of the fraction.
 */
function timestamp(value: bigint, perMs: bigint, digits: number): RawField {
  const v = BigInt(value);
  const perSecond = perMs * 1000n;
  let seconds = v / perSecond;
  let rest = v % perSecond;
  if (rest < 0n) {
    seconds -= 1n;
    rest += perSecond;
  }
  if (Math.abs(Number(seconds)) * 1000 > MAX_DATE_MS) return String(v);
  if (rest % perMs === 0n) return { datetime: new Date(Number(v / perMs)).toISOString() };
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${String(rest).padStart(digits, '0')}Z`;
}

function date(days: number): RawField {
  return Math.abs(days * DAY_MS) > MAX_DATE_MS
    ? String(days)
    : { date: new Date(days * DAY_MS).toISOString().slice(0, 10) };
}

const PARSERS = {
  dateFromDays: date,
  timestampFromMilliseconds: (ms: bigint): RawField => timestamp(ms, 1n, 3),
  timestampFromMicroseconds: (us: bigint): RawField => timestamp(us, 1000n, 6),
  timestampFromNanoseconds: (ns: bigint): RawField => timestamp(ns, 1_000_000n, 9),
};

function hex(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function jsonText(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'bigint'
      ? Number.isSafeInteger(Number(x))
        ? Number(x)
        : String(x)
      : x instanceof Uint8Array
        ? hex(x)
        : x,
  );
}

function fieldOf(v: unknown): RawField {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint': {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : String(v);
    }
    case 'object':
      if (v instanceof Uint8Array) return hex(v);
      if (v instanceof Date) return { datetime: v.toISOString() };
      if (('date' in v || 'datetime' in v) && Object.keys(v).length === 1) return v as RawField;
      return jsonText(v);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Sniff and read

async function metadataOf(file: AsyncBuffer): Promise<FileMetaData> {
  try {
    return await parquetMetadataAsync(file);
  } catch (e) {
    throw notParquet(e instanceof Error ? e.message : String(e));
  }
}

function columnNames(metadata: FileMetaData): string[] {
  return parquetSchema(metadata).children.map((c) => c.element.name);
}

/**
 * The zone of each top-level timestamp column, null for other columns: the legacy
 * TIMESTAMP_MILLIS and _MICROS annotations always hold UTC instants; the TIMESTAMP logical type
 * says so in isAdjustedToUTC.
 */
function timestampZones(metadata: FileMetaData): ('utc' | 'local' | null)[] {
  return parquetSchema(metadata).children.map(({ element: e }) => {
    if (e.converted_type === 'TIMESTAMP_MILLIS' || e.converted_type === 'TIMESTAMP_MICROS') return 'utc';
    const l = e.logical_type;
    if (l?.type !== 'TIMESTAMP') return null;
    return l.isAdjustedToUTC ? 'utc' : 'local';
  });
}

/** A timestamp field as the column's zone makes it: ISO text with 'Z' for instants, else no zone. */
function zoned(f: RawField, utc: boolean): RawField {
  if (typeof f === 'object' && f !== null && 'datetime' in f) return utc ? f.datetime : f;
  // Finer than a millisecond: the text keeps its 'Z' only when the column holds instants.
  if (!utc && typeof f === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(f)) return f.slice(0, -1);
  return f;
}

async function rowsOf(
  file: AsyncBuffer,
  metadata: FileMetaData,
  names: string[],
  rowStart: number,
  rowEnd: number,
): Promise<RawRow[]> {
  let objects: Record<string, unknown>[];
  try {
    objects = await parquetReadObjects({
      file,
      metadata,
      rowStart,
      rowEnd,
      parsers: PARSERS as never,
      geoparquet: false,
    });
  } catch (e) {
    throw notParquet(
      `rows ${formatCount(rowStart)} to ${formatCount(rowEnd - 1)}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const zones = timestampZones(metadata);
  return objects.map((o, i) => ({
    srcLoc: rowStart + i,
    fields: names.map((n, j) => {
      const zone = zones[j] ?? null;
      return zone === null ? fieldOf(o[n]) : zoned(fieldOf(o[n]), zone === 'utc');
    }),
  }));
}

async function sniff(src: ByteSource): Promise<SniffResult> {
  const file = asyncBuffer(src);
  const metadata = await metadataOf(file);
  const names = columnNames(metadata);
  const rows = Number(metadata.num_rows);
  const sampleRows = await rowsOf(file, metadata, names, 0, Math.min(rows, SAMPLE_ROWS));
  const nested = parquetSchema(metadata)
    .children.filter((c) => c.children.length > 0)
    .map((c) => c.element.name);
  const detections: SniffResult['detections'] = {
    columns: detection(names, 'high', 'parquet-schema', `The file's schema lists ${names.length} columns.`),
    rowCount: detection(
      rows,
      'high',
      'parquet-footer',
      `The file's footer states ${formatCount(rows)} rows in ${formatCount(metadata.row_groups.length)} row groups.`,
    ),
  };
  if (nested.length > 0) {
    detections['nestedColumns'] = detection(
      nested,
      'high',
      'json-text',
      `The columns ${nested.map((k) => `"${k}"`).join(', ')} hold lists, maps or structs; they are kept as JSON text in text columns.`,
    );
  }
  return { format: 'parquet', options: OPTIONS, detections, header: [names], sampleRows, notes: [] };
}

async function* read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncGenerator<RawBatch> {
  if (opts.format !== 'parquet') {
    throw new EngineError(
      'INVALID_INPUT',
      `The Parquet reader was given options for the "${opts.format}" format.`,
      'Correct the value passed to the function; this is a defect in the calling code, not in the data.',
    );
  }
  const file = asyncBuffer(src, (n) => ctx.onBytes(n));
  const metadata = await metadataOf(file);
  const names = columnNames(metadata);
  let start = 0;
  for (const group of metadata.row_groups) {
    if (ctx.signal.aborted) throw cancelled();
    const end = start + Number(group.num_rows);
    const rows = await rowsOf(file, metadata, names, start, end);
    for (let i = 0; i < rows.length; i += BATCH_ROWS) yield { rows: rows.slice(i, i + BATCH_ROWS) };
    start = end;
  }
}

export const parquetImporter: Importer = {
  formats: ['parquet'],
  sniff,
  read,
};
