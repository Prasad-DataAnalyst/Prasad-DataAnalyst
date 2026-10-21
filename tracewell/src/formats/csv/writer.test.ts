import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bytesSource, sha256Hex, sniffEncoding } from '@tw/io';
import { EngineError } from '@tw/model';
import { csvImporter } from './reader';
import { csvEscape, writeCsv } from './writer';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

const BOM = String.fromCharCode(0xfeff);

describe('csvEscape', () => {
  it('leaves plain fields as they are', () => {
    expect(csvEscape('plain text', ',')).toBe('plain text');
    expect(csvEscape('', ',')).toBe('');
    expect(csvEscape(' padded ', ',')).toBe(' padded ');
    expect(csvEscape("it's", ',')).toBe("it's");
  });

  it('quotes a field holding the delimiter, a quote, CR or LF, and doubles its quotes', () => {
    expect(csvEscape('a,b', ',')).toBe('"a,b"');
    expect(csvEscape('5" pipe', ',')).toBe('"5"" pipe"');
    expect(csvEscape('line\nbreak', ',')).toBe('"line\nbreak"');
    expect(csvEscape('cr\ronly', ',')).toBe('"cr\ronly"');
    expect(csvEscape('a;b', ';')).toBe('"a;b"');
    expect(csvEscape('a;b', ',')).toBe('a;b');
    expect(csvEscape('"', ',')).toBe('""""');
  });

  it('refuses a delimiter that cannot separate fields', () => {
    for (const d of ['', ',,', '"', '\n', '\r']) {
      expect(() => csvEscape('x', d)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }) as EngineError);
    }
  });
});

describe('writeCsv', () => {
  it('writes RFC 4180 records: comma-separated, quoted only when needed, CRLF after every record', () => {
    const out = writeCsv(
      ['Well', 'Comment', 'Rate [bbl/d]'],
      [
        ['W-1', 'Choke 32/64, stable', '1250.5'],
        ['W-2', 'He said "shut in"', '0'],
        ['W-3', 'two\nlines', ''],
      ],
    );
    expect(text(out)).toBe(
      'Well,Comment,Rate [bbl/d]\r\n' +
        'W-1,"Choke 32/64, stable",1250.5\r\n' +
        'W-2,"He said ""shut in""",0\r\n' +
        'W-3,"two\nlines",\r\n',
    );
  });

  it('uses CRLF by default and LF when asked', () => {
    expect(text(writeCsv(['a'], [['1']]))).toBe('a\r\n1\r\n');
    expect(text(writeCsv(['a'], [['1']], { lineEnding: '\n' }))).toBe('a\n1\n');
    expect(text(writeCsv(['a'], [['1']], { lineEnding: '\r\n' }))).toBe('a\r\n1\r\n');
  });

  it('writes no BOM by default, and one when asked', () => {
    const plain = writeCsv(['a'], []);
    expect(Array.from(plain.slice(0, 3))).toEqual([0x61, 0x0d, 0x0a]);
    const marked = writeCsv(['a'], [], { bom: true });
    expect(Array.from(marked.slice(0, 4))).toEqual([0xef, 0xbb, 0xbf, 0x61]);
  });

  it('encodes non-ASCII text as UTF-8', () => {
    const out = writeCsv(['T [\u00b0C]', 'Note'], [['12.5', '\u6cb9 \u{1f6e2}']]);
    expect(Array.from(out.slice(3, 5))).toEqual([0xc2, 0xb0]);
    expect(text(out)).toBe('T [\u00b0C],Note\r\n12.5,\u6cb9 \u{1f6e2}\r\n');
  });

  it('always gives valid UTF-8, even for strings with lone surrogates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ unit: 'binary' }), { minLength: 2, maxLength: 2 }), { maxLength: 10 }),
        (rows) => {
          const out = writeCsv(['a', 'b'], rows);
          expect(() => decoder.decode(out)).not.toThrow();
        },
      ),
    );
    const lone = writeCsv(['a'], [[String.fromCharCode(0xd800)]]);
    expect(text(lone)).toBe('a\r\n\ufffd\r\n');
  });

  it('writes a row of one empty field as "" so it is not a blank line', () => {
    expect(text(writeCsv(['name'], [['A'], [''], ['B']]))).toBe('name\r\nA\r\n""\r\nB\r\n');
    expect(text(writeCsv(['a', 'b'], [['', '']]))).toBe('a,b\r\n,\r\n');
  });

  it('quotes a leading U+FEFF in the first field so readers do not drop it as a byte-order mark', async () => {
    const out = writeCsv([`${BOM}id`, 'v'], [['1', '2']]);
    expect(text(out)).toBe(`"${BOM}id",v\r\n1,2\r\n`);
    expect(sniffEncoding(out).bomLength).toBe(0);
    const sniff = await csvImporter.sniff(bytesSource(out, 'x.csv'));
    expect(sniff.header).toEqual([[`${BOM}id`, 'v']]);
  });

  it('accepts any iterable of rows, such as a generator', () => {
    function* rows(): Generator<string[]> {
      for (let i = 0; i < 3; i++) yield [String(i)];
    }
    expect(text(writeCsv(['n'], rows()))).toBe('n\r\n0\r\n1\r\n2\r\n');
  });

  it('gives the same bytes for the same table, also when the output spans several encoded chunks', () => {
    const rows = Array.from({ length: 60_000 }, (_, i) => [`W-${i}`, `comment ${i}, with a comma`, String(i / 4)]);
    const a = writeCsv(['well', 'comment', 'rate'], rows);
    const b = writeCsv(['well', 'comment', 'rate'], rows);
    expect(a.byteLength).toBeGreaterThan(2 * (1 << 20));
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    const decoded = text(a);
    expect(decoded.startsWith('well,comment,rate\r\nW-0,"comment 0, with a comma",0\r\n')).toBe(true);
    expect(decoded.endsWith('W-59999,"comment 59999, with a comma",14999.75\r\n')).toBe(true);
  });

  it('refuses rows whose width differs from the header, naming the row', () => {
    let error: unknown;
    try {
      writeCsv(['a', 'b'], [['1', '2'], ['3']]);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'INVALID_INPUT', detail: { row: 2, expected: 2, found: 1 } });
    expect((error as EngineError).message).toBe('Row 2 has 1 fields, but the CSV has 2 columns.');
  });

  it('refuses an empty header and unsupported options', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_INPUT' }) as EngineError;
    expect(() => writeCsv([], [])).toThrow(invalid);
    expect(() => writeCsv(['a'], [], { delimiter: ';' as ',' })).toThrow(invalid);
    expect(() => writeCsv(['a'], [], { lineEnding: '\r' as '\n' })).toThrow(invalid);
  });
});
