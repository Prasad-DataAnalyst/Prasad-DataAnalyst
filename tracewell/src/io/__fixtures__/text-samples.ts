/**
 * Small named byte samples for the encoding tests. They reproduce, in miniature, what the messy
 * fixtures of the same name break, so the behaviour is covered even without the library. Special
 * bytes are written as numbers so the source stays plain ASCII and nothing is lost to an editor.
 */

/** Concatenates ASCII text and raw byte values. */
export function bytes(...parts: (string | readonly number[])[]): Uint8Array {
  const values: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i++) values.push(part.charCodeAt(i) & 0xff);
    } else {
      values.push(...part);
    }
  }
  return Uint8Array.from(values);
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF8_DEGREE = [0xc2, 0xb0];

/** Like csv_utf8_bom_crlf.csv: UTF-8 with a byte-order mark, CRLF line ends and a degree sign. */
export const SAMPLE_UTF8_BOM_CRLF = bytes(UTF8_BOM, 'well,date,temp [', UTF8_DEGREE, 'C]\r\nA-1,2026-01-01,12.5\r\n');

/** Like tsv_utf16le_bom.tsv: UTF-16 little-endian with a byte-order mark. */
export const SAMPLE_UTF16LE_BOM = (() => {
  const text = 'well\trate\r\nA-1\t42\r\n';
  const out = new Uint8Array(2 + text.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) out[2 + i * 2] = text.charCodeAt(i);
  return out;
})();

/** Like csv_semicolon_decimalcomma_cp1252.csv: windows-1252 with a euro sign (0x80) and a degree sign (0xB0). */
export const SAMPLE_CP1252 = bytes('Well;Temp ', [0xb0], 'C;Cost ', [0x80], '\r\nA-1;12,5;1.234,50\r\n');

export const SAMPLE_ASCII = bytes('well,date,rate\nA-1,2026-01-01,42\n');

/** UTF-8 text with two-, three- and four-byte characters: e-acute, euro sign, a CJK ideograph and an emoji. */
export const SAMPLE_UTF8_MIXED = String.fromCodePoint(
  ...[0x41, 0xe9, 0x2c, 0x20ac, 0x2c, 0x6cb9, 0x2c, 0x1f6e2, 0x0a, 0x42, 0xb0, 0x43, 0x0a],
);
