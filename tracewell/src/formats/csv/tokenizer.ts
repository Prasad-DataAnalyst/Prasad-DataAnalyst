/**
 * RFC 4180 tokenizer, written as an incremental state machine so the reader can stream files of
 * any size: text may be pushed in chunks cut anywhere, even between the CR and LF of a line break
 * or inside an escaped quote, and the records are the same as for the whole text at once.
 *
 * Beyond RFC 4180 it accepts what real files contain, without losing text:
 * - LF, CR and CRLF line breaks, also mixed in one file;
 * - a quote inside an unquoted field is an ordinary character;
 * - a closing quote followed by more text keeps that quote as text, and the field goes on unquoted;
 * - a quoted field still open at the end of the input ends there.
 *
 * Each record carries the physical line its first character is on, counted across line breaks
 * inside quoted fields, so lineage can point at "line 1042" exactly. A field longer than
 * MAX_FIELD_CHARS stops tokenizing: that only happens when a quote is never closed, and reading on
 * would hold the rest of the file in memory as one field.
 */
import { EngineError } from '@tw/model';
import { formatCount, invalidArgument } from './errors';

export interface CsvRecord {
  fields: string[];
  /** 1-based physical line of the record's first character. */
  line: number;
}

export interface CsvDialect {
  delimiter: ',' | ';' | '\t' | '|';
  quote: '"';
}

export const CSV_DELIMITERS: readonly CsvDialect['delimiter'][] = [',', ';', '\t', '|'];

/** 1 MiB of UTF-16 code units, the unit strings are measured in. */
export const MAX_FIELD_CHARS = 1_048_576;

const LF = 0x0a;
const CR = 0x0d;

const FIELD_START = 0;
const UNQUOTED = 1;
const QUOTED = 2;
/** Just read a quote inside a quoted field: it either escapes a second quote or closes the field. */
const QUOTE_SEEN = 3;
type State = typeof FIELD_START | typeof UNQUOTED | typeof QUOTED | typeof QUOTE_SEEN;

function checkDialect(d: CsvDialect): void {
  if (!CSV_DELIMITERS.includes(d.delimiter)) {
    throw invalidArgument(`The CSV delimiter ${JSON.stringify(d.delimiter)} is not one of , ; tab or |.`, {
      delimiter: String(d.delimiter),
    });
  }
  if (d.quote !== '"') {
    throw invalidArgument(`The CSV quote ${JSON.stringify(d.quote)} is not supported; only " is.`, {
      quote: String(d.quote),
    });
  }
}

export class CsvTokenizer {
  readonly #delimiter: number;
  readonly #quote: number;
  #state: State = FIELD_START;
  #field = '';
  #fields: string[] = [];
  /** Physical line of the current record's first character; 0 while no record is in progress. */
  #recordLine = 0;
  /** Physical line of the next character. */
  #line = 1;
  /** The last character read was a CR, which already counted as a line break; an LF after it does not. */
  #afterCR = false;
  #out: CsvRecord[] = [];

  constructor(d: CsvDialect) {
    checkDialect(d);
    this.#delimiter = d.delimiter.charCodeAt(0);
    this.#quote = d.quote.charCodeAt(0);
  }

  /** Tokenizes the next chunk and returns the records it completed. */
  push(text: string): CsvRecord[] {
    let i = 0;
    while (i < text.length) i = this.#step(text, i);
    return this.#drain();
  }

  /** Ends the input: returns the last record when the text did not end with a line break. */
  finish(): CsvRecord[] {
    if (this.#recordLine !== 0) this.#endRecord();
    this.#afterCR = false;
    return this.#drain();
  }

  #drain(): CsvRecord[] {
    const out = this.#out;
    this.#out = [];
    return out;
  }

  /** Consumes at least one character from `text` at `i` and returns the next index. */
  #step(text: string, i: number): number {
    const c = text.charCodeAt(i);
    if (this.#afterCR) {
      this.#afterCR = false;
      if (c === LF) {
        // Inside quotes the LF of a CRLF is field text; outside, its CR already ended the record.
        if (this.#state === QUOTED) this.#append('\n');
        return i + 1;
      }
    }
    switch (this.#state) {
      case FIELD_START:
        return this.#fieldStart(text, i, c);
      case UNQUOTED:
        return this.#unquoted(text, i);
      case QUOTED:
        return this.#quoted(text, i);
      case QUOTE_SEEN:
        return this.#quoteSeen(i, c);
    }
  }

  #fieldStart(text: string, i: number, c: number): number {
    if (this.#recordLine === 0) this.#recordLine = this.#line;
    if (c === this.#quote) {
      this.#state = QUOTED;
      return i + 1;
    }
    if (c === this.#delimiter) {
      this.#endField();
      return i + 1;
    }
    if (c === LF || c === CR) {
      this.#endRecord();
      this.#lineBreak(c);
      return i + 1;
    }
    this.#state = UNQUOTED;
    return this.#unquoted(text, i);
  }

  #unquoted(text: string, i: number): number {
    const d = this.#delimiter;
    let j = i;
    for (; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (c === d || c === LF || c === CR) break;
    }
    if (j > i) this.#append(text.slice(i, j));
    if (j === text.length) return j;
    const c = text.charCodeAt(j);
    if (c === d) {
      this.#endField();
    } else {
      this.#endRecord();
      this.#lineBreak(c);
    }
    return j + 1;
  }

  #quoted(text: string, i: number): number {
    const q = this.#quote;
    let j = i;
    for (; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (c === q || c === LF || c === CR) break;
    }
    if (j > i) this.#append(text.slice(i, j));
    if (j === text.length) return j;
    const c = text.charCodeAt(j);
    if (c === q) {
      this.#state = QUOTE_SEEN;
    } else {
      // A line break inside quotes is field text, but it is still a physical line for locators.
      this.#append(c === CR ? '\r' : '\n');
      this.#lineBreak(c);
    }
    return j + 1;
  }

  #quoteSeen(i: number, c: number): number {
    if (c === this.#quote) {
      this.#append('"');
      this.#state = QUOTED;
      return i + 1;
    }
    if (c === this.#delimiter) {
      this.#endField();
      return i + 1;
    }
    if (c === LF || c === CR) {
      this.#endRecord();
      this.#lineBreak(c);
      return i + 1;
    }
    // Text right after a closing quote: keep the quote rather than drop a character of the file,
    // and read on unquoted so one stray quote cannot swallow the rest of the file.
    this.#append('"');
    this.#state = UNQUOTED;
    return i;
  }

  #append(text: string): void {
    if (this.#field.length + text.length > MAX_FIELD_CHARS) throw this.#fieldTooLong();
    this.#field += text;
  }

  #endField(): void {
    this.#fields.push(this.#field);
    this.#field = '';
    this.#state = FIELD_START;
  }

  #endRecord(): void {
    this.#fields.push(this.#field);
    this.#out.push({ fields: this.#fields, line: this.#recordLine });
    this.#fields = [];
    this.#field = '';
    this.#state = FIELD_START;
    this.#recordLine = 0;
  }

  #lineBreak(c: number): void {
    this.#line++;
    this.#afterCR = c === CR;
  }

  #fieldTooLong(): EngineError {
    const field = this.#fields.length + 1;
    const line = formatCount(this.#recordLine);
    return new EngineError(
      'PARSE_FAILED',
      `Field ${field} of the record that starts on line ${line} is longer than ` +
        `${formatCount(MAX_FIELD_CHARS)} characters, so the file cannot be read as CSV.`,
      `This usually means a quote is not closed. Check the quotes on and after line ${line}, ` +
        'or choose a different delimiter in the import settings.',
      { line: this.#recordLine, field, maxFieldChars: MAX_FIELD_CHARS },
    );
  }
}

/** All records of a complete text; the same as one push() of the text followed by finish(). */
export function tokenizeAll(text: string, d: CsvDialect): CsvRecord[] {
  const tokenizer = new CsvTokenizer(d);
  const records = tokenizer.push(text);
  for (const record of tokenizer.finish()) records.push(record);
  return records;
}
