/**
 * Quote character detection. Only the double quote is supported (RFC 4180), so the value is
 * always '"'; what this adds is evidence, and a warning when the fields look single-quoted,
 * because then the quotes stay in the text and delimiters inside them split the field.
 */
import { detection, type Detection } from '@tw/model';
import { plural } from './errors';
import type { CsvRecord } from './tokenizer';

const LF = 0x0a;
const CR = 0x0d;
const DOUBLE_QUOTE = 0x22;

/**
 * Fields that open with a double quote. A quote opens a field when it follows the start of the
 * text, a line break or a delimiter outside quotes; tracking whether a quote is open keeps line
 * breaks and delimiters inside quoted fields from counting. Exact for well-formed files, which is
 * all evidence text needs.
 */
function doubleQuotedFields(text: string, delimiter: string): number {
  const d = delimiter.charCodeAt(0);
  let count = 0;
  let open = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== DOUBLE_QUOTE) continue;
    const before = i === 0 ? LF : text.charCodeAt(i - 1);
    if (!open && (before === d || before === LF || before === CR)) count++;
    // An escaped quote ("") toggles twice and leaves the field open.
    open = !open;
  }
  return count;
}

function isSingleQuoted(field: string): boolean {
  return field.length >= 2 && field.startsWith("'") && field.endsWith("'");
}

export function detectQuote(text: string, delimiter: string, records: readonly CsvRecord[]): Detection<'"'> {
  const double = doubleQuotedFields(text, delimiter);
  let single = 0;
  let example = '';
  for (const { fields } of records) {
    for (const field of fields) {
      if (!isSingleQuoted(field)) continue;
      single++;
      example ||= field;
    }
  }
  if (single > double) {
    const evidence =
      `${plural(single, 'field')} such as ${JSON.stringify(example)} ${single === 1 ? 'is' : 'are'} enclosed in ` +
      'single quotes. Only the double quote is a CSV quote, so single quotes stay part of the text.';
    return detection('"', 'medium', 'single-quotes-seen', evidence);
  }
  if (double > 0) {
    const evidence = `${plural(double, 'field')} in the sample ${double === 1 ? 'is' : 'are'} enclosed in double quotes.`;
    return detection('"', 'high', 'quoted-fields', evidence);
  }
  return detection('"', 'high', 'no-quotes', 'No field in the sample is quoted, so the standard double quote is used.');
}
