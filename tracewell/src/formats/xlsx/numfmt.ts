/**
 * Number formats: which ones show a number as a date or time, and the codes of the built-in formats
 * a workbook may refer to by ID alone (ECMA-376 Part 1, 18.8.30).
 */

/** Built-in formats; General (0) has no code here because this module reports it as null. */
const BUILT_IN_CODES: ReadonlyMap<number, string> = new Map([
  [1, '0'],
  [2, '0.00'],
  [3, '#,##0'],
  [4, '#,##0.00'],
  [9, '0%'],
  [10, '0.00%'],
  [11, '0.00E+00'],
  [12, '# ?/?'],
  [13, '# ??/??'],
  [14, 'mm-dd-yy'],
  [15, 'd-mmm-yy'],
  [16, 'd-mmm'],
  [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'],
  [19, 'h:mm:ss AM/PM'],
  [20, 'h:mm'],
  [21, 'h:mm:ss'],
  [22, 'm/d/yy h:mm'],
  [37, '#,##0 ;(#,##0)'],
  [38, '#,##0 ;[Red](#,##0)'],
  [39, '#,##0.00;(#,##0.00)'],
  [40, '#,##0.00;[Red](#,##0.00)'],
  [45, 'mm:ss'],
  [46, '[h]:mm:ss'],
  [47, 'mmss.0'],
  [48, '##0.0E+0'],
  [49, '@'],
]);

export function builtInFormatCode(numFmtId: number): string | null {
  return BUILT_IN_CODES.get(numFmtId) ?? null;
}

/** IDs 14 to 22 and 45 to 47 are the built-in date and time formats. */
function isBuiltInDate(numFmtId: number): boolean {
  return (numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47);
}

/**
 * The part of a format code that formats a number: quoted text, [bracketed] colours, conditions and
 * locales, backslash-escaped characters, and the characters after '_' (a space as wide as it) and
 * '*' (repeat to fill) are removed, as none of them can stand for a date or time part. So is the
 * keyword General, whose letters are not format characters.
 */
function formatTokens(code: string): string {
  return code.replace(/"[^"]*"?|\[[^\]]*\]?|\\.|[_*]./gs, '').replace(/general/gi, '');
}

export type DateFormatKind = 'date' | 'datetime';

/**
 * 'date' when the format shows only a calendar date, 'datetime' when it shows a time of day (with
 * or without a date), null when it is not a date format. 'm' is minutes right after an hour or
 * before seconds, otherwise months; only the distinction between date and time matters here.
 */
export function dateFormatKind(numFmtId: number, formatCode: string | null): DateFormatKind | null {
  const code = formatCode ?? builtInFormatCode(numFmtId);
  if (code === null) return isBuiltInDate(numFmtId) ? 'date' : null;
  const tokens = formatTokens(code).toLowerCase();
  const hasDatePart = /[dmy]/.test(tokens);
  const hasTimePart = /[hs]/.test(tokens) || /am\/pm|a\/p/.test(tokens);
  if (hasTimePart) return 'datetime';
  if (hasDatePart) return 'date';
  return isBuiltInDate(numFmtId) ? 'date' : null;
}

/**
 * True for the built-in date formats 14–22 and 45–47 and for any format code that has d, m, y, h
 * or s outside quotes and brackets.
 */
export function isDateFormat(numFmtId: number, formatCode: string | null): boolean {
  return isBuiltInDate(numFmtId) || (formatCode !== null && dateFormatKind(numFmtId, formatCode) !== null);
}
