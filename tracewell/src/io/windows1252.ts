/**
 * windows-1252 decoding, implemented here rather than through TextDecoder: Node 22's TextDecoder
 * decodes the 'windows-1252' label as ISO-8859-1 (byte 0x80 becomes U+0080 instead of '€'), and an
 * import must decode identically in the browser worker and in Node.
 *
 * Bytes 0x00-0x7F and 0xA0-0xFF map to the same code points; 0x80-0x9F follow the WHATWG Encoding
 * Standard's index-windows-1252, where the five unassigned bytes map to the C1 controls.
 */

const HIGH_CONTROL_RANGE: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

const CODE_UNITS: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let b = 0; b < 256; b++) table[b] = b >= 0x80 && b < 0xa0 ? (HIGH_CONTROL_RANGE[b - 0x80] ?? b) : b;
  return table;
})();

/** Keeps String.fromCharCode's argument list well below engine limits. */
const PIECE = 8192;

export function decodeWindows1252(bytes: Uint8Array): string {
  const units = new Uint16Array(Math.min(bytes.length, PIECE));
  let text = '';
  for (let start = 0; start < bytes.length; start += PIECE) {
    const end = Math.min(start + PIECE, bytes.length);
    for (let i = start; i < end; i++) units[i - start] = CODE_UNITS[bytes[i] ?? 0] ?? 0;
    text += String.fromCharCode(...units.subarray(0, end - start));
  }
  return text;
}
