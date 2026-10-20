/**
 * Canonical encodings (SAD section 9.4, normative). Audit hashes, column and view digests, export
 * read-back and `.twp` replay all compare these strings, and the Python oracle
 * (tests/oracle/canonical.py) reimplements them, so any change here is a format change.
 */
import { EngineError } from './errors';
import type { JsonValue } from './ids';
import { isPlainObject } from './json';
import { DATE_TEXT, DATETIME_TEXT, isDateCell, isDateTimeCell, isGeometryCell, type CellValue } from './values';

/** The canonical null cell: a NUL character then 'N', which no string cell can produce. */
const NULL_CELL = '\u0000N';

const encoder = new TextEncoder();

const ENCODABLE_FIX =
  'Only finite numbers, strings, booleans, null, arrays and plain objects can be encoded; correct the value first.';
const CELL_FORM_FIX =
  'Write date cells as YYYY-MM-DD and datetime cells as YYYY-MM-DDTHH:mm:ss.sssZ in UTC where the value is created.';

function invalid(message: string, detail?: JsonValue, fix: string = ENCODABLE_FIX): EngineError {
  return new EngineError('INVALID_INPUT', message, fix, detail);
}

/**
 * ECMAScript Number.prototype.toString for finite numbers, with -0 written as '0'.
 * Throws INVALID_INPUT for NaN and the infinities, which have no canonical form.
 */
export function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) throw invalid(`The number ${String(n)} has no canonical form.`);
  // String(-0) is already '0'; the explicit test documents the rule rather than relying on it.
  return Object.is(n, -0) ? '0' : String(n);
}

/**
 * JSON with object keys sorted by UTF-16 code unit, no whitespace and canonical numbers; strings
 * are escaped exactly as JSON.stringify escapes them. Object members whose value is undefined are
 * left out, as JSON.stringify does, so an entry hashes the same before and after a JSON round trip.
 */
export function canonicalJson(v: JsonValue): string {
  return encodeJson(v, new Set<object>());
}

function encodeJson(v: unknown, ancestors: Set<object>): string {
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return canonicalNumber(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'object':
      if (v === null) return 'null';
      return encodeContainer(v, ancestors);
    default:
      throw invalid(`A value of type ${typeof v} cannot be encoded as JSON.`);
  }
}

function encodeContainer(v: object, ancestors: Set<object>): string {
  if (ancestors.has(v)) throw invalid('The value contains a reference cycle and cannot be encoded as JSON.');
  ancestors.add(v);
  try {
    if (Array.isArray(v)) return encodeArray(v, ancestors);
    if (isPlainObject(v)) return encodeObject(v, ancestors);
    throw invalid(`A ${v.constructor?.name ?? 'non-plain'} object cannot be encoded as JSON.`);
  } finally {
    ancestors.delete(v);
  }
}

function encodeArray(items: readonly unknown[], ancestors: Set<object>): string {
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item: unknown = items[i];
    if (item === undefined) throw invalid(`Array element ${i} is undefined, which JSON cannot represent.`);
    parts.push(encodeJson(item, ancestors));
  }
  return `[${parts.join(',')}]`;
}

function encodeObject(obj: Record<string, unknown>, ancestors: Set<object>): string {
  // The default sort compares UTF-16 code units, which is the normative key order.
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = obj[key];
    if (value === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encodeJson(value, ancestors)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The canonical cell string used by column digests:
 * null '\u0000N', string 's:' + text (no Unicode normalisation), number 'n:' + canonical number,
 * boolean 'b:1' | 'b:0', date 'd:' + YYYY-MM-DD, datetime 't:' + ISO UTC, geometry 'g:' + canonical JSON.
 *
 * Date and datetime text must already be in that form. Encoding another spelling of the same day or
 * instant would give a digest that no other engine reproduces, so it is refused instead.
 */
export function canonicalCell(v: CellValue): string {
  if (v === null) return NULL_CELL;
  switch (typeof v) {
    case 'string':
      return `s:${v}`;
    case 'number':
      return `n:${canonicalNumber(v)}`;
    case 'boolean':
      return v ? 'b:1' : 'b:0';
  }
  if (isDateCell(v)) return `d:${inForm(v.date, DATE_TEXT, 'YYYY-MM-DD')}`;
  if (isDateTimeCell(v)) return `t:${inForm(v.datetime, DATETIME_TEXT, 'YYYY-MM-DDTHH:mm:ss.sssZ')}`;
  if (isGeometryCell(v)) return `g:${canonicalJson(v.geometry as unknown as JsonValue)}`;
  throw invalid('The value is not a cell value (null, string, number, boolean, date, datetime or geometry).');
}

function inForm(text: string, form: RegExp, pattern: string): string {
  if (form.test(text)) return text;
  throw invalid(`The cell text "${text}" is not written as ${pattern}.`, { text, expected: pattern }, CELL_FORM_FIX);
}

/** UTF-8 bytes of a string. Lone surrogates become U+FFFD, as with every TextEncoder. */
export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}
