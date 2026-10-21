/**
 * Differential tests against papaparse, an independent CSV implementation used only as a test
 * oracle: papaparse writes random tables that the tokenizer must read back, and papaparse must
 * read back every table writeCsv writes.
 */
import fc from 'fast-check';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { bytesSource } from '@tw/io';
import { readAll } from './__fixtures__/harness';
import { CsvTokenizer, type CsvDialect } from './tokenizer';
import { writeCsv } from './writer';

/** Characters that stress CSV: every delimiter, the quote, every line break, spaces and non-ASCII. */
const SPECIAL = fc.constantFrom(',', ';', '\t', '|', '"', '\r', '\n', '\r\n', ' ', "'", '=');
const fieldText = fc
  .array(fc.oneof(fc.string({ unit: 'binary', maxLength: 4 }), SPECIAL), { maxLength: 6 })
  .map((parts) => parts.join(''));

/** Rectangular tables of 1-6 columns and 1-12 rows. */
const table = fc
  .tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 12 }))
  .chain(([width, height]) =>
    fc.array(fc.array(fieldText, { minLength: width, maxLength: width }), { minLength: height, maxLength: height }),
  );

/**
 * A last row of one empty field is written by papaparse as nothing after the last line break, which
 * no reader can tell from the end of the file; that ambiguity is papaparse's, so it is left out.
 */
function unambiguous(rows: readonly string[][]): boolean {
  const last = rows[rows.length - 1];
  return !(last !== undefined && last.length === 1 && last[0] === '');
}

const delimiter = fc.constantFrom<CsvDialect['delimiter']>(',', ';', '\t', '|');

/** Pushes `text` to a tokenizer in pieces of `size` characters. */
function tokenize(text: string, d: CsvDialect, size: number): string[][] {
  const tokenizer = new CsvTokenizer(d);
  const records = [];
  for (let i = 0; i < text.length; i += size) records.push(...tokenizer.push(text.slice(i, i + size)));
  records.push(...tokenizer.finish());
  return records.map((r) => r.fields);
}

/** papaparse reads a final line break as the start of one more, empty row; that row is not data. */
function papaRows(text: string): string[][] {
  const result = Papa.parse<string[]>(text, { delimiter: ',', newline: '\r\n', quoteChar: '"' });
  expect(result.errors).toEqual([]);
  const rows = result.data;
  const last = rows[rows.length - 1];
  if (text.endsWith('\r\n') && last?.length === 1 && last[0] === '') rows.pop();
  return rows;
}

describe('papaparse.unparse, then CsvTokenizer', () => {
  it('reads back the original table, for every delimiter and both line endings', () => {
    fc.assert(
      fc.property(
        table.filter(unambiguous),
        delimiter,
        fc.constantFrom('\r\n', '\n'),
        fc.integer({ min: 1, max: 64 }),
        (rows, d, newline, chunk) => {
          const text = Papa.unparse(rows, { delimiter: d, newline, quoteChar: '"' });
          expect(tokenize(text, { delimiter: d, quote: '"' }, chunk)).toEqual(rows);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('reads back a table whose fields are all quoted', () => {
    fc.assert(
      fc.property(table, delimiter, (rows, d) => {
        const text = Papa.unparse(rows, { delimiter: d, quotes: true, quoteChar: '"' });
        expect(tokenize(text, { delimiter: d, quote: '"' }, 1024)).toEqual(rows);
      }),
      { numRuns: 200 },
    );
  });
});

describe('writeCsv, then papaparse.parse', () => {
  it('papaparse reads back the original header and rows', () => {
    fc.assert(
      fc.property(table, (rows) => {
        const [header = [], ...data] = rows;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(writeCsv(header, data));
        expect(papaRows(text)).toEqual(rows);
      }),
      { numRuns: 400 },
    );
  });
});

/**
 * A single-column table headed by an empty name writes its header as a lone `""`, which reads like
 * a blank line and is skipped while looking for the header. Export always names its columns.
 */
function namedHeader(rows: readonly string[][]): boolean {
  const header = rows[0];
  return !(header !== undefined && header.length === 1 && header[0] === '');
}

describe('writeCsv, then csvImporter.read', () => {
  it('the product reader reads back every data row, which export read-back relies on', async () => {
    const opts = {
      format: 'csv' as const,
      csv: {
        encoding: 'utf-8' as const,
        bomLength: 0,
        delimiter: ',' as const,
        quote: '"' as const,
        skipLines: 0,
        headerRows: 1,
        decimalSeparator: '.' as const,
        thousandsSeparator: '' as const,
      },
    };
    await fc.assert(
      fc.asyncProperty(table.filter(namedHeader), async (rows) => {
        const [header = [], ...data] = rows;
        const read = await readAll(bytesSource(writeCsv(header, data), 'export.csv'), opts);
        expect(read.notes).toEqual([]);
        expect(read.batches.flatMap((b) => b.rows.map((r) => r.fields))).toEqual(data);
      }),
      { numRuns: 200 },
    );
  });

  it('keeps the empty values of a single-column table, which are written as ""', async () => {
    const read = await readAll(bytesSource(writeCsv(['name'], [[''], ['A'], ['']]), 'export.csv'), {
      format: 'csv',
      csv: {
        encoding: 'utf-8',
        bomLength: 0,
        delimiter: ',',
        quote: '"',
        skipLines: 0,
        headerRows: 1,
        decimalSeparator: '.',
        thousandsSeparator: '',
      },
    });
    expect(read.batches.flatMap((b) => b.rows.map((r) => r.fields))).toEqual([[''], ['A'], ['']]);
  });
});
