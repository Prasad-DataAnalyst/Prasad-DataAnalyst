/**
 * Path ordering shared by ZIP writing and checksum files. Paths are compared by Unicode code
 * point, which is also the order of their UTF-8 bytes, so the result agrees with Python's sorted()
 * and with `LC_ALL=C sort` that people use to inspect a package by hand.
 */

const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

/**
 * Plain `<` compares UTF-16 code units, which puts characters above U+FFFF (stored as surrogate
 * pairs, 0xD800-0xDFFF) before U+E000-U+FFFF. Shifting both ranges restores code point order.
 */
function codePointRank(unit: number): number {
  if (unit < SURROGATE_FIRST) return unit;
  if (unit <= SURROGATE_LAST) return unit + 0x2000;
  return unit - 0x800;
}

/** Negative, zero or positive as `a` sorts before, equal to or after `b` in code point order. */
export function comparePaths(a: string, b: string): number {
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codePointRank(x) - codePointRank(y);
  }
  return a.length - b.length;
}
