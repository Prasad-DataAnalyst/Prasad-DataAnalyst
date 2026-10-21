/**
 * From text to table rows: skip the title lines, tokenize, take the header rows, then shape every
 * later record into a row of the header's width. The sniff sample and the streaming reader both go
 * through this one path, so the preview and the import agree row for row and line for line.
 */
import type { ImportNote, RawRow } from '@tw/model';
import { formatCount, plural } from './errors';
import { LineSkipper } from './lines';
import { DataRowShaper, fitHeaderRow, isBlankRecord, tableWidth, type TableWidth } from './shape';
import { CsvTokenizer, type CsvDialect, type CsvRecord } from './tokenizer';

/**
 * Ragged rows listed one note each; the rest are counted in one closing note. Ingest needs each
 * row's line to build the issue, but a badly broken file must not hold millions of notes.
 */
export const MAX_RAGGED_NOTES = 10_000;

export interface TableLayout {
  dialect: CsvDialect;
  skipLines: number;
  headerRows: number;
}

/** "line 4", "lines 4 and 5", "lines 4, 5 and 7". */
function linesText(lines: readonly number[]): string {
  const names = lines.map(formatCount);
  if (names.length <= 1) return `line ${names.join('')}`;
  return `lines ${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

function multiRowHeaderNote(lines: readonly number[]): ImportNote {
  const note: ImportNote = {
    code: 'TW-IMP-003',
    message:
      `The header is ${plural(lines.length, 'row')}, on ${linesText(lines)}; ` +
      'they are combined into one name per column.',
    detail: { headerRows: lines.length, lines: [...lines] },
  };
  if (lines[0] !== undefined) note.srcLoc = lines[0];
  return note;
}

/**
 * Turns records into the header and data rows. Blank lines before and inside the header are not
 * header rows; with no header rows, the first record with text sets the table's width.
 */
export class TableAssembler {
  readonly #headerRows: number;
  readonly #lineOffset: number;
  readonly #note: (n: ImportNote) => void;
  readonly #header: CsvRecord[] = [];
  #shaper: DataRowShaper | null = null;
  #width = 0;

  /** `lineOffset` is added to every record's line: the physical lines skipped before tokenizing. */
  constructor(headerRows: number, lineOffset: number, note: (n: ImportNote) => void) {
    this.#headerRows = headerRows;
    this.#lineOffset = lineOffset;
    this.#note = note;
  }

  /** The header rows found so far, each at the table's width. */
  get header(): string[][] {
    const width = this.#shaper === null ? tableWidth(this.#header.map((r) => r.fields)).width : this.#width;
    return this.#header.map((r) => fitHeaderRow(r.fields, width));
  }

  /** The data row for `record`, or null when the record is a header row or a blank line. */
  add(record: CsvRecord): RawRow | null {
    const line = record.line + this.#lineOffset;
    if (this.#shaper !== null) return this.#shaper.row(record.fields, line);
    if (isBlankRecord(record.fields)) return null;
    if (this.#headerRows === 0) {
      const width = record.fields.length;
      return this.#start({ width, required: width }).row(record.fields, line);
    }
    this.#header.push({ fields: record.fields, line });
    if (this.#header.length === this.#headerRows) this.#startAfterHeader();
    return null;
  }

  /** Ends the table; reports the ragged rows that were not listed one by one. */
  finish(): void {
    this.#shaper?.finish();
  }

  #startAfterHeader(): void {
    this.#start(tableWidth(this.#header.map((r) => r.fields)));
    if (this.#header.length > 1) this.#note(multiRowHeaderNote(this.#header.map((r) => r.line)));
  }

  #start(shape: TableWidth): DataRowShaper {
    this.#width = shape.width;
    this.#shaper = new DataRowShaper(shape, this.#note, MAX_RAGGED_NOTES);
    return this.#shaper;
  }
}

/**
 * Records of `text` after skipping `skipLines` physical lines, with lines counted from the start
 * of `text`. Text that is the start of a longer file ends with an incomplete record only when a
 * quoted field is still open; `complete: false` drops that record.
 */
export function recordsAfterSkip(text: string, layout: TableLayout, complete: boolean): CsvRecord[] {
  const rest = new LineSkipper(layout.skipLines).take(text);
  const tokenizer = new CsvTokenizer(layout.dialect);
  const records = tokenizer.push(rest);
  if (complete) records.push(...tokenizer.finish());
  return records.map((r) => ({ fields: r.fields, line: r.line + layout.skipLines }));
}

/** The streaming form of recordsAfterSkip plus TableAssembler, for text pushed in chunks. */
export class TableStream {
  readonly #skipper: LineSkipper;
  readonly #tokenizer: CsvTokenizer;
  readonly #assembler: TableAssembler;

  constructor(layout: TableLayout, note: (n: ImportNote) => void) {
    this.#skipper = new LineSkipper(layout.skipLines);
    this.#tokenizer = new CsvTokenizer(layout.dialect);
    this.#assembler = new TableAssembler(layout.headerRows, layout.skipLines, note);
  }

  get header(): string[][] {
    return this.#assembler.header;
  }

  /** The data rows completed by the next chunk of text. */
  push(text: string): RawRow[] {
    const rest = this.#skipper.take(text);
    return rest === '' ? [] : this.#rows(this.#tokenizer.push(rest));
  }

  /** The last data row, when the text did not end with a line break, and the closing notes. */
  finish(): RawRow[] {
    const rows = this.#rows(this.#tokenizer.finish());
    this.#assembler.finish();
    return rows;
  }

  #rows(records: readonly CsvRecord[]): RawRow[] {
    const rows: RawRow[] = [];
    for (const record of records) {
      const row = this.#assembler.add(record);
      if (row !== null) rows.push(row);
    }
    return rows;
  }
}
