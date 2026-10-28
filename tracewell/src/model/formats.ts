/**
 * Format adapter contracts: implemented by the formats-* modules and consumed by ingest. Readers
 * sniff at most 1 MiB, then stream raw rows with exact source locators.
 */
import type { Detection } from './detection';
import type { JsonValue, Sha256Hex } from './ids';
import type { SourceFormat } from './schema';
import type { Geometry, RawField } from './values';

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface CsvOptions {
  encoding: TextEncodingName;
  /** Bytes of byte-order mark to skip (0 when there is none). */
  bomLength: number;
  delimiter: ',' | ';' | '\t' | '|';
  quote: '"';
  /** Physical lines before the header, such as title rows. */
  skipLines: number;
  headerRows: number;
  decimalSeparator: '.' | ',';
  thousandsSeparator: '' | ',' | '.' | ' ';
}

/** Rows and columns are 0-based. */
export interface XlsxOptions {
  sheet: string;
  tableIndex: number;
  headerRowStart: number;
  headerRowEnd: number;
  dataStartRow: number;
  firstCol: number;
  lastCol: number;
}

export interface GeoJsonOptions {
  /** Nested property objects and arrays become JSON text columns. */
  nested: 'json-text';
}

/**
 * How a JSON file holds its records: 'array', an array of objects; 'lines', one object per line
 * (JSON Lines, NDJSON); 'member', an object whose member `member` is an array of objects.
 */
export type JsonLayout = 'array' | 'lines' | 'member';

export interface JsonOptions {
  layout: JsonLayout;
  /** The top-level member holding the records when the layout is 'member'; '' otherwise. */
  member: string;
  /** Nested objects and arrays become JSON text columns. */
  nested: 'json-text';
}

export interface ParquetOptions {
  /** Lists, maps and structs become JSON text columns. */
  nested: 'json-text';
}

export type FormatOptions =
  | { format: 'csv' | 'tsv'; csv: CsvOptions }
  | { format: 'xlsx'; xlsx: XlsxOptions }
  | { format: 'geojson'; geojson: GeoJsonOptions }
  | { format: 'json'; json: JsonOptions }
  | { format: 'parquet'; parquet: ParquetOptions };

export interface RawRow {
  /**
   * CSV physical line (1-based) | sheet row (1-based) | feature index (0-based) | JSON record
   * index (0-based) or, for JSON Lines, line (1-based) | Parquet row index (0-based).
   */
  srcLoc: number;
  fields: RawField[];
  geometry?: Geometry | null;
}

export interface RawBatch {
  rows: RawRow[];
}

export type ImportNoteCode = 'TW-IMP-001' | 'TW-IMP-002' | 'TW-IMP-003' | 'TW-IMP-004';

/** Something a reader noticed while reading; ingest turns notes into system issues. */
export interface ImportNote {
  code: ImportNoteCode;
  message: string;
  srcLoc?: number;
  detail?: JsonValue;
}

export interface SheetInfo {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  /** The sheet's used range, e.g. 'A1:F120'. */
  dimension: string;
  tables: { range: string; headerRows: number }[];
}

export interface SniffResult {
  format: SourceFormat;
  options: FormatOptions;
  detections: Record<string, Detection<JsonValue>>;
  header: string[][];
  /** At most 1,000 rows. */
  sampleRows: RawRow[];
  sheets?: SheetInfo[];
  notes: ImportNote[];
}

/** Random-access bytes: a Blob in the browser, a Uint8Array or a file in Node. */
export interface ByteSource {
  readonly name: string;
  readonly size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
  stream(): ReadableStream<Uint8Array>;
}

export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<{ size: number; sha256: Sha256Hex }>;
}

export interface ReadContext {
  signal: AbortSignal;
  onBytes(n: number): void;
  note(n: ImportNote): void;
}

export interface Importer {
  readonly formats: SourceFormat[];
  sniff(src: ByteSource): Promise<SniffResult>;
  read(src: ByteSource, opts: FormatOptions, ctx: ReadContext): AsyncIterable<RawBatch>;
}

/** Files are passed by reference so their bytes never cross the UI boundary on desktop. */
export type FileInput =
  | { kind: 'blob'; blob: Blob; name: string }
  | { kind: 'bytes'; bytes: Uint8Array; name: string }
  | { kind: 'path'; path: string };

export type FileTarget = { kind: 'return-bytes' } | { kind: 'path'; path: string };
