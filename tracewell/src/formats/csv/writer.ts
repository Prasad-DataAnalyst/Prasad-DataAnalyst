/**
 * RFC 4180 CSV writer, UTF-8 encoded, as the CSV export profile requires: comma, CRLF and no
 * byte-order mark by default. Output is a pure function of its input, so the same table always
 * gives the same bytes.
 *
 * Two cases are quoted beyond what csvEscape requires, because readers would otherwise lose data:
 * a row of one empty field (a blank line, which many readers skip) and a leading U+FEFF in the
 * first field (which readers take for a byte-order mark and drop).
 */
import { invalidArgument } from './errors';

export interface CsvWriteOptions {
  delimiter?: ',';
  lineEnding?: '\r\n' | '\n';
  bom?: boolean;
}

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const BOM_CHAR = '\ufeff';
/** Text is encoded in pieces of about this many characters, so no single huge string is built. */
const CHUNK_CHARS = 1 << 20;

function checkDelimiter(delimiter: string): void {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw invalidArgument(`${JSON.stringify(delimiter)} cannot be a CSV delimiter: it must be one character.`, {
      delimiter,
    });
  }
}

function quoted(field: string): string {
  return `"${field.replaceAll('"', '""')}"`;
}

function escapeField(field: string, delimiter: string): string {
  const needsQuotes = field.includes(delimiter) || field.includes('"') || field.includes('\r') || field.includes('\n');
  return needsQuotes ? quoted(field) : field;
}

/** The field as RFC 4180 writes it: quoted, with quotes doubled, when it holds the delimiter, a quote, CR or LF. */
export function csvEscape(field: string, delimiter: string): string {
  checkDelimiter(delimiter);
  return escapeField(field, delimiter);
}

function checkOptions(o: CsvWriteOptions): void {
  if (o.delimiter !== undefined && o.delimiter !== ',') {
    throw invalidArgument(`The CSV writer only writes commas, not ${JSON.stringify(o.delimiter)}.`, {
      delimiter: String(o.delimiter),
    });
  }
  if (o.lineEnding !== undefined && o.lineEnding !== '\r\n' && o.lineEnding !== '\n') {
    throw invalidArgument('The CSV line ending must be CRLF or LF.', { lineEnding: String(o.lineEnding) });
  }
}

class RecordWriter {
  readonly #delimiter: string;
  readonly #eol: string;
  readonly #width: number;
  readonly #encoder = new TextEncoder();
  readonly #chunks: Uint8Array[] = [];
  #text = '';
  #first = true;

  constructor(width: number, delimiter: string, eol: string, bom: boolean) {
    this.#width = width;
    this.#delimiter = delimiter;
    this.#eol = eol;
    if (bom) this.#chunks.push(UTF8_BOM);
  }

  /** `index` is the row's position for error messages: 0 for the header, then 1, 2, ... */
  write(fields: readonly string[], index: number): void {
    if (fields.length !== this.#width) throw this.#widthError(fields.length, index);
    const cells = fields.map((f) => escapeField(f, this.#delimiter));
    if (fields.length === 1 && fields[0] === '') cells[0] = '""';
    if (this.#first && fields[0]?.startsWith(BOM_CHAR) === true) cells[0] = quoted(fields[0]);
    this.#first = false;
    this.#text += cells.join(this.#delimiter) + this.#eol;
    if (this.#text.length >= CHUNK_CHARS) this.#flush();
  }

  bytes(): Uint8Array {
    this.#flush();
    const size = this.#chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  #flush(): void {
    if (this.#text === '') return;
    // Lone surrogates have no UTF-8 form; TextEncoder writes U+FFFD for them, so output stays valid UTF-8.
    this.#chunks.push(this.#encoder.encode(this.#text));
    this.#text = '';
  }

  #widthError(found: number, index: number): Error {
    const what = index === 0 ? 'The header' : `Row ${index}`;
    return invalidArgument(`${what} has ${found} fields, but the CSV has ${this.#width} columns.`, {
      row: index,
      expected: this.#width,
      found,
    });
  }
}

/** The header and rows as UTF-8 CSV. Every row must have the header's number of fields. */
export function writeCsv(header: string[], rows: Iterable<string[]>, o: CsvWriteOptions = {}): Uint8Array {
  checkOptions(o);
  if (header.length === 0) {
    throw invalidArgument('A CSV needs at least one column, but the header is empty.');
  }
  const writer = new RecordWriter(header.length, o.delimiter ?? ',', o.lineEnding ?? '\r\n', o.bom ?? false);
  writer.write(header, 0);
  let index = 0;
  for (const row of rows) writer.write(row, ++index);
  return writer.bytes();
}
