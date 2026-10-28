/**
 * The import preview: sniff at most PREVIEW_MAX_BYTES, plan the columns, parse up to 200 rows and
 * list every assumption, so the user sees what the import will do before it runs.
 */
import { decodeAll } from '@tw/io';
import { collectAssumptions, detectColumns, detectLatLonCrs } from '@tw/detect';
import { sniffCsvText } from '@tw/formats-csv';
import {
  EngineError,
  PREVIEW_MAX_BYTES,
  type ByteSource,
  type CellValue,
  type ColumnOverride,
  type CrsRef,
  type Detection,
  type FormatOptions,
  type ImportPreview,
  type JsonValue,
  type RawRow,
  type SniffResult,
} from '@tw/model';
import { FORMAT_SNIFF_BYTES, detectFormat, importerFor } from './format';
import { detectOptionsFor, rowParser } from './options';
import { applyOverrides } from './overrides';
import { datasetNameFor, type ImportSpec } from './spec';

export const PREVIEW_ROWS = 200;
const SAMPLE_ROWS = 1000;

function userDetection<T extends JsonValue>(value: T, evidence: string): Detection<JsonValue> {
  return { value, confidence: 'high', assumed: false, source: 'user', method: 'user-override', evidence };
}

function sameOptions(a: FormatOptions, b: FormatOptions): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Re-sniffs a CSV/TSV head with the user's settings; the encoding is taken as given. */
async function resniffCsv(src: ByteSource, options: Extract<FormatOptions, { csv: unknown }>, base: SniffResult) {
  const head = await src.slice(0, Math.min(src.size, PREVIEW_MAX_BYTES));
  const { csv } = options;
  const text = decodeAll(head, csv.encoding, csv.bomLength);
  const result = sniffCsvText(text, {
    encoding: csv.encoding,
    bomLength: csv.bomLength,
    fileName: src.name,
    truncated: src.size > head.byteLength,
    overrides: {
      delimiter: csv.delimiter,
      skipLines: csv.skipLines,
      headerRows: csv.headerRows,
      decimalSeparator: csv.decimalSeparator,
      thousandsSeparator: csv.thousandsSeparator,
    },
  });
  const encoding =
    base.detections['encoding']?.value === csv.encoding
      ? base.detections['encoding']
      : userDetection(csv.encoding, 'Chosen by the user in the import settings.');
  return {
    ...result,
    format: options.format,
    options,
    detections: { ...(encoding === undefined ? {} : { encoding }), ...result.detections },
    notes: result.notes,
  } satisfies SniffResult;
}

/**
 * Re-reads a workbook or GeoJSON file with the user's options. The header comes from reading the
 * header rows as data, so it always matches what the full import will see.
 */
async function resniffByReading(src: ByteSource, options: FormatOptions, base: SniffResult): Promise<SniffResult> {
  const importer = importerFor(options.format);
  const ctl = new AbortController();
  const ctx = { signal: ctl.signal, onBytes: () => undefined, note: () => undefined };
  const take = async (opts: FormatOptions, n: number): Promise<RawRow[]> => {
    const rows: RawRow[] = [];
    for await (const batch of importer.read(src, opts, ctx)) {
      for (const r of batch.rows) {
        if (rows.length >= n) break;
        rows.push(r);
      }
      if (rows.length >= n) break;
    }
    return rows;
  };
  let header = base.header;
  if (options.format === 'xlsx') {
    const { headerRowStart, headerRowEnd } = options.xlsx;
    const headerRows = await take(
      { ...options, xlsx: { ...options.xlsx, dataStartRow: headerRowStart } },
      headerRowEnd - headerRowStart + 1,
    );
    header = headerRows.map((r) =>
      r.fields.map((f) => (f === null ? '' : typeof f === 'object' ? JSON.stringify(f) : String(f))),
    );
  }
  const sampleRows = await take(options, SAMPLE_ROWS);
  return { ...base, options, header, sampleRows };
}

async function sniffSource(src: ByteSource, options: FormatOptions | undefined): Promise<SniffResult> {
  const head = await src.slice(0, Math.min(src.size, FORMAT_SNIFF_BYTES));
  const format = options?.format ?? detectFormat(head, src.name).value;
  const importer = importerFor(format);
  let sniff = await importer.sniff(src);
  if (format === 'csv' || format === 'tsv') sniff = { ...sniff, format };
  if (options === undefined || sameOptions(options, sniff.options)) return sniff;
  if (options.format === 'csv' || options.format === 'tsv') return resniffCsv(src, options, sniff);
  if (options.format !== sniff.options.format) {
    throw new EngineError(
      'FORMAT_UNSUPPORTED',
      `The file was recognised as ${sniff.options.format.toUpperCase()}, so ${options.format.toUpperCase()} settings cannot be applied.`,
      'Choose settings for the detected format, or check that the right file was selected.',
      { detected: sniff.options.format, requested: options.format },
    );
  }
  return resniffByReading(src, options, sniff);
}

function crsFor(sniff: SniffResult, plans: ImportSpec['columns']): Detection<CrsRef> | null {
  const fromFile = sniff.detections['crs'];
  if (fromFile !== undefined && fromFile.value !== null) return fromFile as unknown as Detection<CrsRef>;
  return detectLatLonCrs(plans);
}

function estimateRows(src: ByteSource, sniff: SniffResult): number | null {
  const n = sniff.sampleRows.length;
  if (src.size <= PREVIEW_MAX_BYTES && n < SAMPLE_ROWS) return n;
  if (sniff.format === 'xlsx') {
    const sheet = sniff.sheets?.find((s) => sniff.options.format === 'xlsx' && s.name === sniff.options.xlsx.sheet);
    const last = /(\d+)$/.exec(sheet?.dimension ?? '')?.[1];
    if (last !== undefined && sniff.options.format === 'xlsx') {
      return Math.max(0, Number(last) - sniff.options.xlsx.dataStartRow);
    }
    return null;
  }
  if (sniff.format === 'parquet') {
    // The footer states the row count exactly.
    const rows = sniff.detections['rowCount']?.value;
    return typeof rows === 'number' ? rows : null;
  }
  if (sniff.format === 'geojson' || sniff.format === 'json' || n === 0) return null;
  const avg =
    sniff.sampleRows.reduce(
      (sum, r) => sum + r.fields.reduce<number>((s, f) => s + (f === null ? 0 : String(f).length + 1), 1),
      0,
    ) / n;
  return avg > 0 ? Math.round(src.size / avg) : null;
}

/** Rough in-memory size of a parsed cell, used only for the preview's budget warning. */
const BYTES_PER_CELL = 16;
const DEFAULT_PREVIEW_BUDGET = 1.5 * 1024 ** 3;

export async function previewSource(
  src: ByteSource,
  o: { options?: FormatOptions; columnOverrides?: ColumnOverride[]; memoryBudgetBytes?: number } = {},
): Promise<ImportPreview & { spec: Omit<ImportSpec, 'fileId'> }> {
  const sniff = await sniffSource(src, o.options);
  const planned = detectColumns(sniff.header, sniff.sampleRows, detectOptionsFor(sniff.options));
  const base: Omit<ImportSpec, 'fileId'> = {
    fileName: src.name,
    size: src.size,
    options: sniff.options,
    columns: planned,
    detections: sniff.detections,
    crs: null,
    datasetName: datasetNameFor(src.name),
  };
  const withOverrides = applyOverrides(base, o.columnOverrides ?? []);
  const spec = { ...withOverrides, crs: crsFor(sniff, withOverrides.columns) };

  const parse = rowParser(spec.columns, spec.options);
  const rows: CellValue[][] = sniff.sampleRows
    .slice(0, PREVIEW_ROWS)
    .map((r) => parse(r).map((c) => (c.ok ? c.value : null)));
  const extra =
    spec.crs === null ? spec.detections : { ...spec.detections, crs: spec.crs as unknown as Detection<JsonValue> };
  const estimatedRows = estimateRows(src, sniff);
  const budget = o.memoryBudgetBytes ?? DEFAULT_PREVIEW_BUDGET;
  return {
    previewId: `pv_${src.size}_${spec.columns.length}`,
    fileName: src.name,
    size: src.size,
    sniff,
    columns: spec.columns,
    rows,
    crs: spec.crs,
    assumptions: collectAssumptions('preview', spec.columns, extra),
    estimatedRows,
    exceedsBudget: estimatedRows !== null && estimatedRows * spec.columns.length * BYTES_PER_CELL > budget,
    spec,
  };
}
