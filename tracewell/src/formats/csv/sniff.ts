/**
 * CSV/TSV sniffing: from the first MiB of a file to the options, detections, header and sample
 * rows of the import preview. Every inferred property is a Detection with its evidence, and a
 * property the user set in the import settings is taken as given (source 'user').
 *
 * Order matters: the delimiter decides how lines split, the split decides where the header is,
 * the header decides where data starts, and only data rows are evidence for number separators.
 */
import { decodeAll, sniffEncoding } from '@tw/io';
import {
  detection,
  PREVIEW_MAX_BYTES,
  type ByteSource,
  type CsvOptions,
  type Detection,
  type ImportNote,
  type JsonValue,
  type RawRow,
  type SniffResult,
  type TextEncodingName,
} from '@tw/model';
import { analyseCandidate, chooseDelimiter, detectSkipLines, type Delimiter, type DelimiterChoice } from './dialect';
import { detectHeaderRows } from './header';
import { throughLastLineBreak } from './lines';
import { collectNumberEvidence, detectDecimal, detectThousands, type NumberEvidence } from './numbers';
import { checkDecimal, checkDelimiter, checkCount, checkSeparatorsDiffer, checkThousands } from './options';
import { detectQuote } from './quote';
import { isBlankRecord } from './shape';
import { recordsAfterSkip, TableAssembler } from './table';
import type { CsvRecord } from './tokenizer';

/** SniffResult.sampleRows holds at most this many rows. */
export const SAMPLE_MAX_ROWS = 1000;

/** Rows from the header on that the header-row detection inspects: header, units row and 50 below. */
const HEADER_SCAN_ROWS = 52;

/** Properties set in the import settings; each replaces its detection. */
export type CsvSniffOverrides = Partial<
  Pick<CsvOptions, 'delimiter' | 'skipLines' | 'headerRows' | 'decimalSeparator' | 'thousandsSeparator'>
>;

export interface CsvSniffInput {
  encoding: TextEncodingName;
  bomLength: number;
  fileName: string;
  /** Structural settings chosen by the user, for a preview that follows an override. */
  overrides?: CsvSniffOverrides;
  /** The text is the start of a longer file, so its last line may be cut off. */
  truncated?: boolean;
}

const OVERRIDE_NAMES: Readonly<Record<keyof CsvSniffOverrides, string>> = {
  delimiter: 'delimiter',
  skipLines: 'number of lines to skip',
  headerRows: 'number of header rows',
  decimalSeparator: 'decimal separator',
  thousandsSeparator: 'thousands separator',
};

/** A value from the import settings. The audit entry that records it sets `overriddenBy` later. */
function fromSettings<T>(value: T, property: keyof CsvSniffOverrides): Detection<T> {
  const evidence = `The ${OVERRIDE_NAMES[property]} is set in the import settings.`;
  return { value, confidence: 'high', assumed: false, source: 'user', method: 'user-override', evidence };
}

function checkOverrides(o: CsvSniffOverrides): void {
  if (o.delimiter !== undefined) checkDelimiter(o.delimiter);
  if (o.skipLines !== undefined) checkCount('skipLines', o.skipLines);
  if (o.headerRows !== undefined) checkCount('headerRows', o.headerRows);
  if (o.decimalSeparator !== undefined) checkDecimal(o.decimalSeparator);
  if (o.thousandsSeparator !== undefined) checkThousands(o.thousandsSeparator);
  if (o.decimalSeparator !== undefined && o.thousandsSeparator !== undefined) {
    checkSeparatorsDiffer(o.decimalSeparator, o.thousandsSeparator);
  }
}

function pickDelimiter(text: string, fileName: string, o: CsvSniffOverrides): DelimiterChoice {
  if (o.delimiter === undefined) return chooseDelimiter(text, fileName);
  return { candidate: analyseCandidate(text, o.delimiter), detection: fromSettings(o.delimiter, 'delimiter') };
}

function headerScanRows(records: readonly CsvRecord[]): string[][] {
  const rows: string[][] = [];
  for (const { fields } of records) {
    if (isBlankRecord(fields)) continue;
    rows.push(fields);
    if (rows.length === HEADER_SCAN_ROWS) break;
  }
  return rows;
}

type Decimal = CsvOptions['decimalSeparator'];
type Thousands = CsvOptions['thousandsSeparator'];

/**
 * A thousands separator set in the settings rules out the same character as the decimal
 * separator, so a detected decimal that clashes with it gives way to the other one.
 */
function decimalFor(numbers: NumberEvidence, delimiter: Delimiter, o: CsvSniffOverrides): Detection<Decimal> {
  if (o.decimalSeparator !== undefined) return fromSettings(o.decimalSeparator, 'decimalSeparator');
  const detected = detectDecimal(numbers, delimiter);
  if (o.thousandsSeparator !== detected.value) return detected;
  const value: Decimal = detected.value === '.' ? ',' : '.';
  const evidence =
    `The thousands separator set in the import settings is ${JSON.stringify(o.thousandsSeparator)}, ` +
    `so the decimal separator is ${JSON.stringify(value)}.`;
  return detection(value, 'high', 'implied-by-settings', evidence);
}

function thousandsFor(numbers: NumberEvidence, decimal: Decimal, o: CsvSniffOverrides): Detection<Thousands> {
  if (o.thousandsSeparator !== undefined) return fromSettings(o.thousandsSeparator, 'thousandsSeparator');
  return detectThousands(numbers, decimal);
}

interface SampleTable {
  header: string[][];
  rows: RawRow[];
}

function assemble(records: readonly CsvRecord[], headerRows: number, notes: ImportNote[]): SampleTable {
  // Lines are already absolute, so no offset is added.
  const assembler = new TableAssembler(headerRows, 0, (n) => notes.push(n));
  const rows: RawRow[] = [];
  for (const record of records) {
    const row = assembler.add(record);
    if (row !== null) rows.push(row);
    if (rows.length === SAMPLE_MAX_ROWS) break;
  }
  assembler.finish();
  return { header: assembler.header, rows };
}

interface Layout {
  delimiter: Detection<Delimiter>;
  skipLines: Detection<number>;
  headerRows: Detection<number>;
  /** Records from the first line after the skipped ones, with absolute lines. */
  records: CsvRecord[];
}

/** Where the table is: how lines split, how many lines come before the header, how many header rows. */
function detectLayout(sample: string, o: CsvSniffInput, overrides: CsvSniffOverrides, complete: boolean): Layout {
  const { candidate, detection: delimiter } = pickDelimiter(sample, o.fileName, overrides);
  const skipLines =
    overrides.skipLines === undefined ? detectSkipLines(candidate) : fromSettings(overrides.skipLines, 'skipLines');
  const dialect = { delimiter: delimiter.value, quote: '"' as const };
  const records = recordsAfterSkip(sample, { dialect, skipLines: skipLines.value, headerRows: 0 }, complete);
  const headerRows =
    overrides.headerRows === undefined
      ? detectHeaderRows(headerScanRows(records))
      : fromSettings(overrides.headerRows, 'headerRows');
  return { delimiter, skipLines, headerRows, records };
}

/**
 * Sniffs decoded text. Pass the text whole, or with `truncated` when it is only the start of the
 * file: then the cut-off last line is left out of the sample. Detects everything but the encoding.
 */
export function sniffCsvText(text: string, o: CsvSniffInput): SniffResult {
  checkCount('bomLength', o.bomLength);
  const overrides = o.overrides ?? {};
  checkOverrides(overrides);
  const truncated = o.truncated ?? false;
  const sample = truncated ? throughLastLineBreak(text) : text;

  const { delimiter, skipLines, headerRows, records } = detectLayout(sample, o, overrides, !truncated);
  const notes: ImportNote[] = [];
  const table = assemble(records, headerRows.value, notes);
  const numbers = collectNumberEvidence(table.rows);
  const decimal = decimalFor(numbers, delimiter.value, overrides);
  const thousands = thousandsFor(numbers, decimal.value, overrides);
  const quote = detectQuote(sample, delimiter.value, records);

  const format = delimiter.value === '\t' ? 'tsv' : 'csv';
  const csv: CsvOptions = {
    encoding: o.encoding,
    bomLength: o.bomLength,
    delimiter: delimiter.value,
    quote: '"',
    skipLines: skipLines.value,
    headerRows: headerRows.value,
    decimalSeparator: decimal.value,
    thousandsSeparator: thousands.value,
  };
  const detections: Record<string, Detection<JsonValue>> = {
    delimiter,
    quote,
    skipLines,
    headerRows,
    decimalSeparator: decimal,
    thousandsSeparator: thousands,
  };
  return { format, options: { format, csv }, detections, header: table.header, sampleRows: table.rows, notes };
}

function encodingNote(d: Detection<TextEncodingName>): ImportNote {
  return {
    code: 'TW-IMP-004',
    message:
      `The text encoding ${d.value} is assumed. ${d.evidence} If accented letters or symbols such as the degree ` +
      'sign look wrong in the preview, choose another encoding in the import settings.',
    detail: { encoding: d.value, confidence: d.confidence, method: d.method },
  };
}

/**
 * Sniffs a file from at most its first MiB (PREVIEW_MAX_BYTES), so the first preview is fast for
 * any file size. Adds the encoding detection, and a TW-IMP-004 note when the encoding is assumed.
 */
export async function sniffCsvSource(src: ByteSource): Promise<SniffResult> {
  const head = await src.slice(0, PREVIEW_MAX_BYTES);
  const { bomLength, ...encoding } = sniffEncoding(head);
  const text = decodeAll(head, encoding.value, bomLength);
  const result = sniffCsvText(text, {
    encoding: encoding.value,
    bomLength,
    fileName: src.name,
    truncated: src.size > head.byteLength,
  });
  const notes = encoding.assumed ? [encodingNote(encoding), ...result.notes] : result.notes;
  return { ...result, detections: { encoding, ...result.detections }, notes };
}
