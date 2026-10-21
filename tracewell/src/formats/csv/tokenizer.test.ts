import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineError } from '@tw/model';
import { SAMPLES, sampleText } from './__fixtures__/samples';
import { CsvTokenizer, MAX_FIELD_CHARS, tokenizeAll, type CsvDialect } from './tokenizer';

const COMMA: CsvDialect = { delimiter: ',', quote: '"' };

function fields(text: string, d: CsvDialect = COMMA): string[][] {
  return tokenizeAll(text, d).map((r) => r.fields);
}

function lines(text: string, d: CsvDialect = COMMA): number[] {
  return tokenizeAll(text, d).map((r) => r.line);
}

/** Tokenizes `text` pushed in pieces cut at `cuts` (offsets in any order). */
function inPieces(text: string, cuts: readonly number[], d: CsvDialect = COMMA) {
  const bounds = [0, ...[...cuts].sort((a, b) => a - b), text.length];
  const tokenizer = new CsvTokenizer(d);
  const records = [];
  for (let i = 0; i + 1 < bounds.length; i++) records.push(...tokenizer.push(text.slice(bounds[i], bounds[i + 1])));
  records.push(...tokenizer.finish());
  return records;
}

describe('CsvTokenizer', () => {
  it('keeps delimiters inside quoted fields', () => {
    expect(fields('a,"b,c",d\n')).toEqual([['a', 'b,c', 'd']]);
    expect(fields('a;"b;c";d\n', { delimiter: ';', quote: '"' })).toEqual([['a', 'b;c', 'd']]);
    expect(fields('a\t"b\tc"\n', { delimiter: '\t', quote: '"' })).toEqual([['a', 'b\tc']]);
    expect(fields('a|"b|c"\n', { delimiter: '|', quote: '"' })).toEqual([['a', 'b|c']]);
  });

  it('reads doubled quotes inside a quoted field as one quote', () => {
    expect(fields('"He said ""shut in""",x\n')).toEqual([['He said "shut in"', 'x']]);
    expect(fields('""""\n')).toEqual([['"']]);
    expect(fields('"",""""""\n')).toEqual([['', '""']]);
  });

  it('keeps quoted LF and CRLF line breaks and points each record at the line it starts on', () => {
    const text = 'h1,h2\n"a\nb",1\n"c\r\nd\r\ne",2\r\nlast,3\n';
    const records = tokenizeAll(text, COMMA);
    expect(records).toEqual([
      { fields: ['h1', 'h2'], line: 1 },
      { fields: ['a\nb', '1'], line: 2 },
      { fields: ['c\r\nd\r\ne', '2'], line: 4 },
      { fields: ['last', '3'], line: 7 },
    ]);
  });

  it('gives the record lines of csv_quoted_newlines_ragged.csv listed in its expectation', () => {
    const { expected } = SAMPLES['csv_quoted_newlines_ragged.csv'];
    expect(lines(sampleText('csv_quoted_newlines_ragged.csv'))).toEqual(expected.recordLines);
  });

  it('reads the fields of csv_quoted_newlines_ragged.csv exactly', () => {
    const records = fields(sampleText('csv_quoted_newlines_ragged.csv'));
    expect(records[1]).toEqual(['W-001', 'Choke changed\nafter test', '1250.5', 'active']);
    expect(records[2]).toEqual(['W-002', 'He said "shut in"', '0', 'shut-in']);
    expect(records[3]).toEqual(['W-003', 'short, row', '980']);
    expect(records[4]).toEqual(['W-004', 'multi\r\nline\r\ncomment', '1100', 'active']);
    expect(records[5]).toEqual(['W-005', 'extra', '1200', 'active', 'unexpected']);
    expect(records[6]).toEqual(['W-006', '', '1300', 'active']);
    expect(records[7]).toEqual(['W-007', 'trailing\n', '1400', '']);
    expect(records[11]).toEqual(['W-011', 'a\rb', '1530', 'active']);
    expect(records[12]).toEqual(['W-012', 'last', '1540', 'active']);
  });

  it('accepts CR-only line endings, inside and outside quotes', () => {
    expect(tokenizeAll('a,b\r1,2\r"x\ry",3\r4,5', COMMA)).toEqual([
      { fields: ['a', 'b'], line: 1 },
      { fields: ['1', '2'], line: 2 },
      { fields: ['x\ry', '3'], line: 3 },
      { fields: ['4', '5'], line: 5 },
    ]);
  });

  it('accepts mixed line endings in one file', () => {
    expect(lines('a\nb\r\nc\rd\n')).toEqual([1, 2, 3, 4]);
    expect(fields('a\nb\r\nc\rd\n')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('gives the same records with or without a final line break', () => {
    const records = [
      ['a', 'b'],
      ['1', '2'],
    ];
    expect(fields('a,b\n1,2')).toEqual(records);
    expect(fields('a,b\n1,2\n')).toEqual(records);
    expect(fields('a,b\r\n1,2\r\n')).toEqual(records);
    expect(fields('a,b\r1,2\r')).toEqual(records);
  });

  it('reads an empty final field, with or without a final line break', () => {
    expect(fields('a,b,\n')).toEqual([['a', 'b', '']]);
    expect(fields('a,b,')).toEqual([['a', 'b', '']]);
    expect(fields('a,""')).toEqual([['a', '']]);
    expect(fields(',')).toEqual([['', '']]);
  });

  it('reads a blank line as a record of one empty field and an empty text as no records', () => {
    expect(tokenizeAll('a\n\nb\n', COMMA)).toEqual([
      { fields: ['a'], line: 1 },
      { fields: [''], line: 2 },
      { fields: ['b'], line: 3 },
    ]);
    expect(tokenizeAll('', COMMA)).toEqual([]);
    expect(tokenizeAll('\n', COMMA)).toEqual([{ fields: [''], line: 1 }]);
  });

  it('keeps ragged rows as they are; shaping them into rows happens later', () => {
    expect(fields('a,b,c\n1,2\n1,2,3,4\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('never drops a character of malformed quoting', () => {
    // A quote inside an unquoted field is text.
    expect(fields('5" pipe,x\n')).toEqual([['5" pipe', 'x']]);
    // Text after a closing quote keeps the quote and goes on unquoted.
    expect(fields('"a"b,c\n')).toEqual([['a"b', 'c']]);
    // A quote never closed ends with the input.
    expect(fields('x,"open\nstill open')).toEqual([['x', 'open\nstill open']]);
  });

  it('stops with PARSE_FAILED, naming the line, when a field exceeds 1 MiB', () => {
    const text = `h\nok\n"${'x'.repeat(MAX_FIELD_CHARS + 1)}`;
    let error: unknown;
    try {
      tokenizeAll(text, COMMA);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: 'PARSE_FAILED', detail: { line: 3, field: 1 } });
    expect((error as EngineError).message).toContain('line 3');
    expect((error as EngineError).fix).toContain('quote');
  });

  it('accepts a field of exactly 1 MiB', () => {
    const records = fields(`"${'y'.repeat(MAX_FIELD_CHARS)}"\n`);
    expect(records[0]?.[0]).toHaveLength(MAX_FIELD_CHARS);
  });

  it('refuses an unsupported dialect', () => {
    expect(() => new CsvTokenizer({ delimiter: ':' as ',', quote: '"' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }) as EngineError,
    );
    expect(() => new CsvTokenizer({ delimiter: ',', quote: "'" as '"' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }) as EngineError,
    );
  });

  it('push returns only completed records, and finish the last one', () => {
    const tokenizer = new CsvTokenizer(COMMA);
    expect(tokenizer.push('a,b\n1,')).toEqual([{ fields: ['a', 'b'], line: 1 }]);
    expect(tokenizer.push('2')).toEqual([]);
    expect(tokenizer.finish()).toEqual([{ fields: ['1', '2'], line: 2 }]);
    expect(tokenizer.finish()).toEqual([]);
  });

  it('handles chunk boundaries between CR and LF and inside an escaped quote', () => {
    const text = 'a,"x""y"\r\nb,c\r\n';
    for (let cut = 0; cut <= text.length; cut++) {
      expect(inPieces(text, [cut])).toEqual(tokenizeAll(text, COMMA));
    }
  });

  describe('chunk-boundary fuzz', () => {
    const alphabet = fc.constantFrom('a', 'b', ',', ';', '\t', '|', '"', '\r', '\n', ' ', '\u00e9', '\u{1f600}');
    const csvLike = fc.array(alphabet, { maxLength: 200 }).map((chars) => chars.join(''));
    const delimiter = fc.constantFrom<CsvDialect['delimiter']>(',', ';', '\t', '|');

    it('gives the same records as tokenizeAll however the input is split', () => {
      fc.assert(
        fc.property(csvLike, fc.array(fc.nat(), { maxLength: 12 }), delimiter, (text, cuts, d) => {
          const dialect: CsvDialect = { delimiter: d, quote: '"' };
          const offsets = cuts.map((c) => c % (text.length + 1));
          expect(inPieces(text, offsets, dialect)).toEqual(tokenizeAll(text, dialect));
        }),
        { numRuns: 500 },
      );
    });

    it('also for the named fixture, split at every pair of points', () => {
      const text = sampleText('csv_quoted_newlines_ragged.csv');
      const whole = tokenizeAll(text, COMMA);
      fc.assert(
        fc.property(fc.nat(text.length), fc.nat(text.length), (x, y) => {
          expect(inPieces(text, [x, y])).toEqual(whole);
        }),
        { numRuns: 300 },
      );
    });

    it('also when the input arrives one character at a time', () => {
      const text = sampleText('csv_quoted_newlines_ragged.csv');
      const cuts = Array.from({ length: text.length - 1 }, (_, i) => i + 1);
      expect(inPieces(text, cuts)).toEqual(tokenizeAll(text, COMMA));
    });
  });
});
