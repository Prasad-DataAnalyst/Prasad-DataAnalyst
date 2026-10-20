import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineError, type TextEncodingName } from '@tw/model';
import { MESSY_READY, messyBytes } from './__fixtures__/messy';
import {
  bytes,
  SAMPLE_ASCII,
  SAMPLE_CP1252,
  SAMPLE_UTF16LE_BOM,
  SAMPLE_UTF8_BOM_CRLF,
  SAMPLE_UTF8_MIXED,
} from './__fixtures__/text-samples';
import { decodeAll, decodeStream, sniffEncoding } from './encoding';

const EURO = String.fromCharCode(0x20ac);
const DEGREE = String.fromCharCode(0xb0);
const BOM_CHAR = String.fromCharCode(0xfeff);

/** Feeds `data` to decodeStream in pieces cut at `cuts` (sorted byte offsets) and joins the text. */
async function decodeInPieces(
  data: Uint8Array,
  cuts: readonly number[],
  encoding: TextEncodingName,
  bomLength: number,
): Promise<string> {
  const bounds = [0, ...cuts, data.length];
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i + 1 < bounds.length; i++) controller.enqueue(data.slice(bounds[i], bounds[i + 1]));
      controller.close();
    },
  });
  let text = '';
  for await (const piece of decodeStream(input, encoding, bomLength)) text += piece;
  return text;
}

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), littleEndian);
  return out;
}

describe('sniffEncoding on the named samples', () => {
  it('detects UTF-8 with a byte-order mark (bomLength 3, high)', () => {
    const d = sniffEncoding(SAMPLE_UTF8_BOM_CRLF);
    expect(d).toMatchObject({ value: 'utf-8', bomLength: 3, confidence: 'high', assumed: false, method: 'bom' });
  });

  it('detects UTF-16LE with a byte-order mark', () => {
    const d = sniffEncoding(SAMPLE_UTF16LE_BOM);
    expect(d).toMatchObject({ value: 'utf-16le', bomLength: 2, confidence: 'high', assumed: false });
  });

  it('detects UTF-16BE with a byte-order mark', () => {
    const d = sniffEncoding(bytes([0xfe, 0xff, 0x00, 0x41]));
    expect(d).toMatchObject({ value: 'utf-16be', bomLength: 2, confidence: 'high' });
  });

  it('assumes windows-1252 with low confidence for bytes that are not UTF-8', () => {
    const d = sniffEncoding(SAMPLE_CP1252);
    expect(d).toMatchObject({ value: 'windows-1252', bomLength: 0, confidence: 'low', assumed: true });
    expect(d.source).toBe('default');
    expect(d.evidence).toContain('0xB0 at offset 10');
  });

  it('decodes windows-1252 bytes 0x80 and 0xB0 as the euro and degree signs', () => {
    const text = decodeAll(SAMPLE_CP1252, 'windows-1252', 0);
    expect(text.startsWith(`Well;Temp ${DEGREE}C;Cost ${EURO}\r\n`)).toBe(true);
  });

  it('detects pure ASCII as UTF-8 with high confidence', () => {
    const d = sniffEncoding(SAMPLE_ASCII);
    expect(d).toMatchObject({ value: 'utf-8', bomLength: 0, confidence: 'high', assumed: false, method: 'ascii' });
  });

  it('detects valid multi-byte UTF-8 without a mark with high confidence', () => {
    const d = sniffEncoding(new TextEncoder().encode(SAMPLE_UTF8_MIXED));
    expect(d).toMatchObject({ value: 'utf-8', bomLength: 0, confidence: 'high', method: 'utf8-valid' });
    expect(d.evidence).toContain('5 multi-byte characters');
  });

  it('treats an empty head as UTF-8', () => {
    expect(sniffEncoding(new Uint8Array(0))).toMatchObject({ value: 'utf-8', confidence: 'high', bomLength: 0 });
  });
});

describe.skipIf(!MESSY_READY)('sniffEncoding on the messy fixtures', () => {
  it('detects UTF-8 with a byte-order mark on csv_utf8_bom_crlf.csv', () => {
    const d = sniffEncoding(messyBytes('csv_utf8_bom_crlf.csv'));
    expect(d).toMatchObject({ value: 'utf-8', bomLength: 3, confidence: 'high', assumed: false });
  });

  it('detects UTF-16LE with a byte-order mark on tsv_utf16le_bom.tsv', () => {
    const d = sniffEncoding(messyBytes('tsv_utf16le_bom.tsv'));
    expect(d).toMatchObject({ value: 'utf-16le', bomLength: 2, confidence: 'high' });
  });

  it('assumes windows-1252 on csv_semicolon_decimalcomma_cp1252.csv and decodes 0x80 and 0xB0', () => {
    const data = messyBytes('csv_semicolon_decimalcomma_cp1252.csv');
    expect(sniffEncoding(data)).toMatchObject({ value: 'windows-1252', confidence: 'low', assumed: true });
    const text = decodeAll(data, 'windows-1252', 0);
    // windows-1252 is one byte per character, so byte offsets are string offsets.
    expect(data.indexOf(0xb0)).toBeGreaterThanOrEqual(0);
    data.forEach((byte, i) => {
      if (byte === 0xb0) expect(text[i]).toBe(DEGREE);
      if (byte === 0x80) expect(text[i]).toBe(EURO);
    });
  });
});

describe('sniffEncoding edge cases', () => {
  it('accepts a multi-byte character cut off by the end of the head', () => {
    const full = new TextEncoder().encode(`abc${EURO}`);
    const d = sniffEncoding(full.subarray(0, full.length - 1));
    expect(d.value).toBe('utf-8');
  });

  it.each([
    ['an overlong two-byte form', [0xc0, 0x80]],
    ['an overlong three-byte form', [0xe0, 0x80, 0x80]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['an invalid lead byte', [0xf5, 0x80, 0x80, 0x80]],
    ['a lone continuation byte', [0x80]],
    ['a lead byte followed by ASCII', [0xc3, 0x41]],
  ])('rejects %s as UTF-8 and assumes windows-1252', (_label, invalid) => {
    const d = sniffEncoding(bytes('ok ', invalid, ' tail'));
    expect(d).toMatchObject({ value: 'windows-1252', confidence: 'low', assumed: true });
    expect(d.evidence).toContain('offset 3');
  });

  it('detects UTF-16LE without a mark from its zero-byte pattern, as an assumption', () => {
    const d = sniffEncoding(utf16('well,rate\r\nA-1,42\r\n', true));
    expect(d).toMatchObject({ value: 'utf-16le', bomLength: 0, confidence: 'medium', assumed: true });
  });

  it('detects UTF-16BE without a mark from its zero-byte pattern, as an assumption', () => {
    const d = sniffEncoding(utf16('well,rate\r\nA-1,42\r\n', false));
    expect(d).toMatchObject({ value: 'utf-16be', bomLength: 0, confidence: 'medium', assumed: true });
  });

  it('does not mistake text with a few NUL bytes for UTF-16', () => {
    expect(sniffEncoding(bytes('abcdefghij', [0], 'klmnopqrst')).value).toBe('utf-8');
  });
});

describe('decodeAll', () => {
  it('skips the byte-order mark it is told about', () => {
    expect(decodeAll(SAMPLE_UTF8_BOM_CRLF, 'utf-8', 3)).toBe(`well,date,temp [${DEGREE}C]\r\nA-1,2026-01-01,12.5\r\n`);
    expect(decodeAll(SAMPLE_UTF16LE_BOM, 'utf-16le', 2)).toBe('well\trate\r\nA-1\t42\r\n');
  });

  it('keeps a byte-order mark when bomLength is 0', () => {
    expect(decodeAll(SAMPLE_UTF8_BOM_CRLF, 'utf-8', 0).startsWith(`${BOM_CHAR}well`)).toBe(true);
  });

  it('decodes UTF-16BE', () => {
    expect(decodeAll(utf16(SAMPLE_UTF8_MIXED, false), 'utf-16be', 0)).toBe(SAMPLE_UTF8_MIXED);
  });

  it('replaces invalid UTF-8 with U+FFFD rather than failing', () => {
    expect(decodeAll(bytes('a', [0xff], 'b'), 'utf-8', 0)).toBe('a\ufffdb');
  });

  it('decodes every windows-1252 byte as the WHATWG Encoding Standard specifies', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = decodeAll(all, 'windows-1252', 0);
    expect(text.length).toBe(256);
    const special: Record<number, number> = {
      0x80: 0x20ac,
      0x81: 0x81,
      0x82: 0x201a,
      0x83: 0x192,
      0x84: 0x201e,
      0x85: 0x2026,
      0x86: 0x2020,
      0x87: 0x2021,
      0x88: 0x2c6,
      0x89: 0x2030,
      0x8a: 0x160,
      0x8b: 0x2039,
      0x8c: 0x152,
      0x8d: 0x8d,
      0x8e: 0x17d,
      0x8f: 0x8f,
      0x90: 0x90,
      0x91: 0x2018,
      0x92: 0x2019,
      0x93: 0x201c,
      0x94: 0x201d,
      0x95: 0x2022,
      0x96: 0x2013,
      0x97: 0x2014,
      0x98: 0x2dc,
      0x99: 0x2122,
      0x9a: 0x161,
      0x9b: 0x203a,
      0x9c: 0x153,
      0x9d: 0x9d,
      0x9e: 0x17e,
      0x9f: 0x178,
    };
    for (let b = 0; b < 256; b++) expect(text.charCodeAt(b), `byte 0x${b.toString(16)}`).toBe(special[b] ?? b);
  });

  it('decodes long windows-1252 input in one piece', () => {
    const long = new Uint8Array(100_000).fill(0x80);
    expect(decodeAll(long, 'windows-1252', 0)).toBe(EURO.repeat(100_000));
  });

  it.each([-1, 1.5, Number.NaN])('refuses the byte-order mark length %s', (bomLength) => {
    expect(() => decodeAll(SAMPLE_ASCII, 'utf-8', bomLength)).toThrow(EngineError);
  });
});

describe('decodeStream', () => {
  const cases: [TextEncodingName, Uint8Array, number][] = [
    ['utf-8', new TextEncoder().encode(SAMPLE_UTF8_MIXED), 0],
    ['utf-8', SAMPLE_UTF8_BOM_CRLF, 3],
    ['utf-16le', utf16(SAMPLE_UTF8_MIXED, true), 0],
    ['utf-16le', SAMPLE_UTF16LE_BOM, 2],
    ['utf-16be', utf16(SAMPLE_UTF8_MIXED, false), 0],
    ['windows-1252', SAMPLE_CP1252, 0],
  ];

  it.each(cases)('gives the decodeAll text for %s at every single split point', async (encoding, data, bomLength) => {
    const expected = decodeAll(data, encoding, bomLength);
    for (let cut = 0; cut <= data.length; cut++) {
      expect(await decodeInPieces(data, [cut], encoding, bomLength)).toBe(expected);
    }
  });

  it.each(cases)('gives the decodeAll text for %s fed one byte at a time', async (encoding, data, bomLength) => {
    const cuts = Array.from({ length: Math.max(0, data.length - 1) }, (_, i) => i + 1);
    expect(await decodeInPieces(data, cuts, encoding, bomLength)).toBe(decodeAll(data, encoding, bomLength));
  });

  it('flushes an incomplete trailing sequence as U+FFFD, like decodeAll', async () => {
    const data = new TextEncoder().encode(`ab${EURO}`).subarray(0, 4);
    expect(await decodeInPieces(data, [3], 'utf-8', 0)).toBe(decodeAll(data, 'utf-8', 0));
    expect(decodeAll(data, 'utf-8', 0)).toBe('ab\ufffd');
  });

  it('round-trips arbitrary text split at arbitrary points (UTF-8 and UTF-16LE)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'grapheme', maxLength: 60 }),
        fc.array(fc.nat(), { maxLength: 6 }),
        async (text, rawCuts) => {
          for (const [encoding, data] of [
            ['utf-8', new TextEncoder().encode(text)],
            ['utf-16le', utf16(text, true)],
          ] as const) {
            const cuts = [...new Set(rawCuts.map((c) => c % (data.length + 1)))].sort((a, b) => a - b);
            expect(await decodeInPieces(data, cuts, encoding, 0)).toBe(text);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
