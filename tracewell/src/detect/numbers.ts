/**
 * Locale-aware number parsing. Parsing is strict on purpose: thousands groups must have exactly
 * three digits, so '1.5' under a ',' decimal separator is refused instead of silently read as 15.
 */

/** Longer text is never a plain number; the bound keeps every pattern below linear. */
const MAX_NUMBER_TEXT = 64;

const DIGITS = /^\d*$/;
const EXPONENT = /[eE][+-]?\d{1,4}$/;

/** Spaces that spreadsheets and European locales use to group thousands. */
const SPACE_GROUPING = /[ \u00a0\u202f]/g;

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The integer digits with grouping removed, or null when the grouping is malformed. */
function stripThousands(intPart: string, thousands: string): string | null {
  if (DIGITS.test(intPart)) return intPart;
  if (thousands === '') return null;
  const normalized = thousands === ' ' ? intPart.replace(SPACE_GROUPING, ' ') : intPart;
  const sep = escapeForRegExp(thousands);
  const grouped = new RegExp(`^\\d{1,3}(?:${sep}\\d{3})+$`, 'u');
  return grouped.test(normalized) ? normalized.split(thousands).join('') : null;
}

/** Splits off a leading sign; U+2212 (minus sign) is what typeset reports often contain. */
function splitSign(text: string): { sign: '' | '-'; body: string } {
  const first = text.charAt(0);
  if (first === '-' || first === '\u2212') return { sign: '-', body: text.slice(1) };
  if (first === '+') return { sign: '', body: text.slice(1) };
  return { sign: '', body: text };
}

/**
 * Reads `text` as a finite number with the given decimal and thousands separators, or null.
 * Accepts an optional sign, grouped integer digits, a fraction and an exponent ('1.2e3').
 */
export function parseNumber(text: string, decimal: '.' | ',', thousands: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > MAX_NUMBER_TEXT) return null;
  const { sign, body: signless } = splitSign(trimmed);
  const exponent = EXPONENT.exec(signless)?.[0] ?? '';
  const body = signless.slice(0, signless.length - exponent.length);
  const parts = body.split(decimal);
  if (parts.length > 2) return null;
  const intDigits = stripThousands(parts[0] ?? '', thousands);
  const fraction = parts[1] ?? '';
  if (intDigits === null || !DIGITS.test(fraction) || (intDigits === '' && fraction === '')) return null;
  const value = Number(
    `${sign}${intDigits === '' ? '0' : intDigits}${fraction === '' ? '' : `.${fraction}`}${exponent}`,
  );
  if (!Number.isFinite(value)) return null;
  // -0 and 0 are the same value in every engine's numeric type; keep one canonical form.
  return value === 0 ? 0 : value;
}

/**
 * True when the text is written as a whole number: no decimal separator and no exponent. '12.0'
 * is a number column's value even though it is integral, which is how the author wrote it.
 */
export function isIntegerText(text: string, decimal: '.' | ','): boolean {
  const trimmed = text.trim();
  return !trimmed.includes(decimal) && !/[eE]/.test(trimmed);
}

/** Text with a leading zero before further digits ('0012', '-007.5'): identifiers, kept as text. */
export function hasLeadingZero(text: string, decimal: '.' | ','): boolean {
  const trimmed = text.trim().replace(/^[+-]/, '');
  const intPart = trimmed.split(decimal)[0] ?? '';
  return /^0\d/.test(intPart);
}
