import { describe, expect, it } from 'vitest';
import { bytesSource } from '@tw/io';
import { BATCH_ROWS, EngineError, type ByteSource, type CsvOptions, type FormatOptions } from '@tw/model';
import { generatedCsv, readAll, sampleSource, sniffAndRead } from './__fixtures__/harness';
import { SAMPLE_NAMES, SAMPLES } from './__fixtures__/samples';
import { csvImporter } from './reader';
import { MAX_RAGGED_NOTES } from './table';

const UTF8_COMMA: CsvOptions = {
  encoding: 'utf-8',
  bomLength: 0,
  delimiter: ',',
  quote: '"',
  skipLines: 0,
  headerRows: 1,
  decimalSeparator: '.',
  thousandsSeparator: '',
};

function csvOpts(overrides: Partial<CsvOptions> = {}): FormatOptions {
  return { format: 'csv', csv: { ...UTF8_COMMA, ...overrides } };
}

function textSource(text: string, name = 'test.csv'): ByteSource {
  return bytesSource(new TextEncoder().encode(text), name);
}

async function rowsOf(text: string, overrides: Partial<CsvOptions> = {}) {
  const read = await readAll(textSource(text), csvOpts(overrides));
  return read.batches.flatMap((b) => b.rows);
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('Expected the promise to reject.');
}

describe('csvImporter', () => {
  it('handles the csv and tsv formats', () => {
    expect(csvImporter.formats).toEqual(['csv', 'tsv']);
  });
});

describe('csvImporter.read on csv_quoted_newlines_ragged.csv', () => {
  const { expected } = SAMPLES['csv_quoted_newlines_ragged.csv'];

  it('emits a TW-IMP-001 note with srcLoc for each ragged line', async () => {
    const { read } = await sniffAndRead('csv_quoted_newlines_ragged.csv');
    expect(read.notes.map((n) => [n.code, n.srcLoc])).toEqual(expected.raggedLines.map((line) => ['TW-IMP-001', line]));
    expect(read.notes[0]).toMatchObject({ detail: { expected: 4, found: 3 } });
    expect(read.notes[1]).toMatchObject({ detail: { expected: 4, found: 5, extra: ['unexpected'] } });
    expect(read.notes[1]?.message).toContain('Line 9 has 5 fields');
  });

  it('reads the expected number of records, each at the header width, with physical line locators', async () => {
    const { read } = await sniffAndRead('csv_quoted_newlines_ragged.csv');
    const rows = read.batches.flatMap((b) => b.rows);
    expect(rows).toHaveLength(expected.rowCount);
    expect(rows.map((r) => r.srcLoc)).toEqual(expected.recordLines?.slice(1));
    expect(rows.every((r) => r.fields.length === 4)).toBe(true);
    // The short row is padded with missing values; the long row keeps the header's columns.
    expect(rows[2]?.fields).toEqual(['W-003', 'short, row', '980', null]);
    expect(rows[4]?.fields).toEqual(['W-005', 'extra', '1200', 'active']);
  });
});

describe.each(SAMPLE_NAMES)('csvImporter.read on %s with the sniffed options', (name) => {
  const { expected, bytes } = SAMPLES[name];

  it('reads the expected rows and ragged lines', async () => {
    const { read } = await sniffAndRead(name);
    const rows = read.batches.flatMap((b) => b.rows);
    expect(rows).toHaveLength(expected.rowCount);
    const ragged = read.notes.filter((n) => n.code === 'TW-IMP-001').map((n) => n.srcLoc);
    expect(ragged).toEqual(expected.raggedLines);
  });

  it('gives exactly the rows of the sniff sample, so the preview and the import agree', async () => {
    const { sniff, read } = await sniffAndRead(name);
    expect(read.batches.flatMap((b) => b.rows)).toEqual(sniff.sampleRows);
  });

  it('reports bytes that sum to the file size', async () => {
    const { read } = await sniffAndRead(name);
    expect(read.bytes).toBe(bytes.byteLength);
  });
});

describe('csvImporter.read', () => {
  it('reports a two-row header with TW-IMP-003 and starts the data after it', async () => {
    const { read } = await sniffAndRead('csv_title_rows_units_in_header.csv');
    expect(read.notes).toEqual([expect.objectContaining({ code: 'TW-IMP-003', srcLoc: 4 })]);
    expect(read.batches[0]?.rows[0]?.srcLoc).toBe(6);
  });

  it('decodes windows-1252 and keeps the raw text of every field', async () => {
    const { read } = await sniffAndRead('csv_semicolon_decimalcomma_cp1252.csv');
    expect(read.batches[0]?.rows[0]?.fields).toEqual([
      'A-01',
      '01.03.2026',
      '12,5',
      '101,3',
      '1.234,50',
      'M\u00fcller',
    ]);
  });

  it('skips the BOM of UTF-16 and UTF-8 files', async () => {
    const tsv = await sniffAndRead('tsv_utf16le_bom.tsv');
    expect(tsv.read.batches[0]?.rows[0]?.fields[0]).toBe('W-1');
    const csv = await sniffAndRead('csv_utf8_bom_crlf.csv');
    expect(csv.read.batches[0]?.rows[0]?.fields).toEqual(['A-1', '2026-01-01', '12.5', '101.3', 'Ok, stable']);
  });

  it('hands out full batches of BATCH_ROWS rows and the rest in a last batch', async () => {
    const total = BATCH_ROWS * 2 + 7;
    const read = await readAll(bytesSource(generatedCsv(total), 'big.csv'), csvOpts());
    expect(read.batches.map((b) => b.rows.length)).toEqual([BATCH_ROWS, BATCH_ROWS, 7]);
    const last = read.batches[2]?.rows[6];
    expect(last).toEqual({ srcLoc: total + 1, fields: [String(total), `row ${total}`, (total * 0.25).toFixed(2)] });
  });

  it('counts physical lines from the top of the file when lines are skipped', async () => {
    const rows = await rowsOf('title\r\n\r\nh1,h2\r\n"a\r\nb",1\r\n2,3\r\n', { skipLines: 2 });
    expect(rows).toEqual([
      { srcLoc: 4, fields: ['a\r\nb', '1'] },
      { srcLoc: 6, fields: ['2', '3'] },
    ]);
  });

  it('skips a title line with an unclosed quote without letting it swallow the table', async () => {
    const rows = await rowsOf('"Daily report\nh1,h2\n1,2\n', { skipLines: 1 });
    expect(rows).toEqual([{ srcLoc: 3, fields: ['1', '2'] }]);
  });

  it('reads with no header row, taking the width from the first line', async () => {
    const rows = await rowsOf('1,2\n3,4\n', { headerRows: 0 });
    expect(rows.map((r) => r.fields)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps blank lines as empty values in a single-column file only', async () => {
    expect((await rowsOf('name\nA\n\nB\n')).map((r) => r.fields)).toEqual([['A'], [''], ['B']]);
    expect((await rowsOf('a,b\n1,2\n\n3,4\n')).map((r) => r.fields)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('trims empty fields from trailing delimiters without a note', async () => {
    const read = await readAll(textSource('a,b\n1,2,\n3,4,,\n'), csvOpts());
    expect(read.notes).toEqual([]);
    expect(read.batches[0]?.rows.map((r) => r.fields)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('lists at most MAX_RAGGED_NOTES ragged rows and counts the rest in one note', async () => {
    const extra = 5;
    const lines = ['a,b,c'];
    for (let i = 0; i < MAX_RAGGED_NOTES + extra; i++) lines.push('1,2');
    const read = await readAll(textSource(`${lines.join('\n')}\n`), csvOpts());
    expect(read.notes).toHaveLength(MAX_RAGGED_NOTES + 1);
    expect(read.notes[MAX_RAGGED_NOTES]).toMatchObject({ code: 'TW-IMP-001', detail: { unlisted: extra } });
    expect(read.notes[MAX_RAGGED_NOTES]?.srcLoc).toBeUndefined();
  });

  it('reads an empty file as no rows', async () => {
    const read = await readAll(textSource(''), csvOpts());
    expect(read.batches).toEqual([]);
    expect(read.bytes).toBe(0);
  });

  describe('cancellation', () => {
    it('an aborted signal stops reading with CANCELLED before anything is read', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await errorOf(readAll(sampleSource('csv_pipe_delimited.csv'), csvOpts(), controller.signal));
      expect(error).toBeInstanceOf(EngineError);
      expect(error).toMatchObject({ code: 'CANCELLED' });
    });

    it('aborting between batches stops with CANCELLED and releases the file', async () => {
      const controller = new AbortController();
      let cancelled = false;
      const inner = bytesSource(generatedCsv(BATCH_ROWS * 3), 'big.csv');
      const src: ByteSource = {
        ...inner,
        stream: () => {
          const reader = inner.stream().getReader();
          return new ReadableStream<Uint8Array>({
            pull: async (c) => {
              const { done, value } = await reader.read();
              if (done) c.close();
              else c.enqueue(value);
            },
            cancel: () => {
              cancelled = true;
            },
          });
        },
      };
      const ctx = { signal: controller.signal, onBytes: () => {}, note: () => {} };
      const iterator = csvImporter.read(src, csvOpts(), ctx)[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      controller.abort();
      const error = await errorOf(iterator.next());
      expect(error).toMatchObject({ code: 'CANCELLED' });
      expect(cancelled).toBe(true);
    });

    it('aborting while a read waits on a slow source stops at once', async () => {
      const controller = new AbortController();
      const src: ByteSource = {
        name: 'slow.csv',
        size: 100,
        slice: () => Promise.resolve(new Uint8Array(0)),
        // A source that never delivers: only the cancel can end the wait.
        stream: () => new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }),
      };
      const pending = readAll(src, csvOpts(), controller.signal);
      setTimeout(() => controller.abort(), 10);
      expect(await errorOf(pending)).toMatchObject({ code: 'CANCELLED' });
    });

    it('stopping early releases the file', async () => {
      let cancelled = false;
      const inner = bytesSource(generatedCsv(BATCH_ROWS * 2), 'big.csv');
      const src: ByteSource = {
        ...inner,
        stream: () => {
          const reader = inner.stream().getReader();
          return new ReadableStream<Uint8Array>({
            pull: async (c) => {
              const { done, value } = await reader.read();
              if (done) c.close();
              else c.enqueue(value);
            },
            cancel: () => {
              cancelled = true;
            },
          });
        },
      };
      const ctx = { signal: new AbortController().signal, onBytes: () => {}, note: () => {} };
      for await (const batch of csvImporter.read(src, csvOpts(), ctx)) {
        expect(batch.rows).toHaveLength(BATCH_ROWS);
        break;
      }
      expect(cancelled).toBe(true);
    });
  });

  describe('invalid options', () => {
    const cases: [string, FormatOptions][] = [
      ['another format', { format: 'geojson', geojson: { nested: 'json-text' } }],
      ['an unknown delimiter', csvOpts({ delimiter: ':' as ',' })],
      ['a negative skipLines', csvOpts({ skipLines: -1 })],
      ['a fractional headerRows', csvOpts({ headerRows: 0.5 })],
      ['equal separators', csvOpts({ decimalSeparator: ',', thousandsSeparator: ',' })],
      ['a negative BOM length', csvOpts({ bomLength: -1 })],
    ];

    it.each(cases)('refuses %s with INVALID_INPUT', async (_label, opts) => {
      const error = await errorOf(readAll(textSource('a,b\n1,2\n'), opts));
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  it('propagates PARSE_FAILED for a field that never ends', async () => {
    const huge = new Uint8Array(1_100_000).fill(0x78);
    huge[0] = 0x22;
    const src = bytesSource(new Uint8Array([...new TextEncoder().encode('h\n'), ...huge]), 'broken.csv');
    const error = await errorOf(readAll(src, csvOpts()));
    expect(error).toMatchObject({ code: 'PARSE_FAILED', detail: { line: 2 } });
  });
});
