/**
 * Turns tokenized records into rows of the header's width, the same way for the sniff sample and
 * for the full read, so the preview and the import never disagree about a row.
 *
 * Ragged rows (TW-IMP-001) are kept and reported, never dropped: a short row is padded with
 * missing (null) fields, and a long row keeps the header's columns while its extra fields are
 * listed in the note. Extra fields that are all empty come from trailing delimiters and hold no
 * data, so they are trimmed without a note. Blank lines are not rows, except in a single-column
 * file, where a blank line is the only way to write an empty value.
 */
import type { ImportNote, RawField, RawRow } from '@tw/model';
import { formatCount, plural } from './errors';

/** Extra fields quoted in one note, and the characters quoted of each; the line locator leads to the rest. */
const NOTE_EXTRA_FIELDS = 20;
const NOTE_EXTRA_CHARS = 200;

export function isBlankRecord(fields: readonly string[]): boolean {
  return fields.length === 1 && fields[0] === '';
}

/** Index after the last non-empty field. */
function trimmedLength(fields: readonly string[]): number {
  let n = fields.length;
  while (n > 0 && fields[n - 1] === '') n--;
  return n;
}

/**
 * Column count of a table with these header rows: the first row's full width, or more when a
 * later header row (such as a units row) has text further right.
 */
export function headerWidth(rows: readonly (readonly string[])[]): number {
  const first = rows[0];
  if (first === undefined) return 0;
  return Math.max(first.length, namedWidth(rows));
}

/**
 * Columns up to the last one with a name or unit. A row that stops after them is not ragged: the
 * columns it lacks are unnamed ones, typically from a trailing delimiter on the header line.
 */
export function namedWidth(rows: readonly (readonly string[])[]): number {
  return rows.reduce((width, row) => Math.max(width, trimmedLength(row)), 0);
}

/** A header row at the table's width: padded with empty names, or cut where only empty cells follow. */
export function fitHeaderRow(row: readonly string[], width: number): string[] {
  const out = row.slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

function quoteExtra(extra: readonly string[]): string[] {
  return extra
    .slice(0, NOTE_EXTRA_FIELDS)
    .map((f) => (f.length > NOTE_EXTRA_CHARS ? `${f.slice(0, NOTE_EXTRA_CHARS)}...` : f));
}

export function raggedNote(line: number, width: number, found: number, extra: readonly string[]): ImportNote {
  const where = `Line ${formatCount(line)} has ${plural(found, 'field')}, but the header has ${formatCount(width)}`;
  if (found < width) {
    return {
      code: 'TW-IMP-001',
      message: `${where}; the missing ${plural(width - found, 'field')} ${width - found === 1 ? 'is' : 'are'} left empty.`,
      srcLoc: line,
      detail: { expected: width, found },
    };
  }
  return {
    code: 'TW-IMP-001',
    message:
      `${where}; the ${plural(found - width, 'extra field')} ${found - width === 1 ? 'is' : 'are'} ` +
      'not imported and listed in this note.',
    srcLoc: line,
    detail: { expected: width, found, extra: quoteExtra(extra) },
  };
}

function unlistedNote(count: number): ImportNote {
  return {
    code: 'TW-IMP-001',
    message:
      `A further ${plural(count, 'ragged row')} ${count === 1 ? 'was' : 'were'} found but not listed one by one, ` +
      'to keep the list readable.',
    detail: { unlisted: count },
  };
}

export interface TableWidth {
  /** Fields in every row. */
  width: number;
  /** Fields a row must have not to be ragged; see namedWidth. */
  required: number;
}

export function tableWidth(header: readonly (readonly string[])[]): TableWidth {
  return { width: headerWidth(header), required: namedWidth(header) };
}

/** Shapes the data rows of one table and reports ragged ones, up to `maxNotes` individual notes. */
export class DataRowShaper {
  readonly #width: number;
  readonly #required: number;
  readonly #note: (n: ImportNote) => void;
  readonly #maxNotes: number;
  #ragged = 0;

  constructor(shape: TableWidth, note: (n: ImportNote) => void, maxNotes: number) {
    this.#width = shape.width;
    this.#required = Math.min(shape.required, shape.width);
    this.#note = note;
    this.#maxNotes = maxNotes;
  }

  /** Rows found ragged so far, listed or not. */
  get raggedRows(): number {
    return this.#ragged;
  }

  /** The row for a record that starts on physical line `line`, or null for a blank line that is not a row. */
  row(fields: string[], line: number): RawRow | null {
    const width = this.#width;
    if (width > 1 && isBlankRecord(fields)) return null;
    if (fields.length === width) return { srcLoc: line, fields };
    if (fields.length < width) {
      if (fields.length < this.#required) this.#report(line, fields.length, []);
      const padded: RawField[] = fields.slice();
      while (padded.length < width) padded.push(null);
      return { srcLoc: line, fields: padded };
    }
    const extra = fields.slice(width);
    if (extra.some((f) => f !== '')) this.#report(line, fields.length, extra);
    return { srcLoc: line, fields: fields.slice(0, width) };
  }

  /** Reports the ragged rows that were not listed individually. */
  finish(): void {
    const unlisted = this.#ragged - this.#maxNotes;
    if (unlisted > 0) this.#note(unlistedNote(unlisted));
  }

  #report(line: number, found: number, extra: readonly string[]): void {
    this.#ragged++;
    if (this.#ragged <= this.#maxNotes) this.#note(raggedNote(line, this.#width, found, extra));
  }
}
