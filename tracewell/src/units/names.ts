/**
 * Unit text normalisation. Files write one unit in many ways ('m³/d', 'm3/day', 'M3 / D', 'm3 per
 * day'), so every registry code and alias, and every text searched for, is reduced to a lookup key
 * before it is compared.
 */

/**
 * Names whose letter case carries meaning, matched case-sensitively: every single letter (m and M,
 * K and k), 'mm' because 'MM' usually means million in oilfield text, and 'Pa' because 'PA' often
 * means plugged and abandoned.
 */
const CASE_SENSITIVE: ReadonlySet<string> = new Set(['mm', 'pa']);

/** Spelled-out time denominators reduce to their symbols, so 'bbl/day' and 'bbl/d' share a key. */
const TIME_DENOMINATORS: readonly (readonly [RegExp, string])[] = [
  [/\/(?:days?)$/iu, '/d'],
  [/\/(?:hrs?|hours?)$/iu, '/h'],
  [/\/(?:secs?|seconds?)$/iu, '/s'],
  [/\/(?:mins|minutes?)$/iu, '/min'],
];

/**
 * The case-preserving normal form of a unit text:
 * - look-alike degree signs (º U+00BA, ˚ U+02DA) become '°', before NFKC would turn them into 'o';
 * - NFKC turns superscripts into digits (m³ → m3) and ℃ into °C;
 * - look-alike slashes (U+2215, U+2044) become '/';
 * - the word 'per' becomes '/';
 * - whitespace, underscores, dots, '^', '*' and the middle dots U+00B7 and U+22C5 are removed
 *   (m^3, kW·h, deg. F);
 * - spelled-out time denominators become symbols (/day → /d).
 */
export function normalizeUnitText(text: string): string {
  let key = text
    .replace(/[\u00ba\u02da]/gu, '\u00b0')
    .normalize('NFKC')
    .replace(/[\u2215\u2044]/gu, '/')
    .replace(/(^|[\s_])per(?=[\s_]|$)/giu, '$1/')
    .replace(/[\s_.^*\u00b7\u22c5]/gu, '');
  for (const [pattern, symbol] of TIME_DENOMINATORS) key = key.replace(pattern, symbol);
  return key;
}

function isCaseSensitive(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return lower.length === 1 || CASE_SENSITIVE.has(lower);
}

/** The key under which a unit name is indexed and looked up: the normal form, lower-cased unless case matters. */
export function lookupKey(text: string): string {
  const normalized = normalizeUnitText(text);
  return isCaseSensitive(normalized) ? normalized : normalized.toLowerCase();
}
